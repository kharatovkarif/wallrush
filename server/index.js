// WallRush server: static frontend + REST API + WebSocket game server.
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { attachWs, realOnline } from './rooms.js';
import { fakeOnline } from './bots.js';
import { dbEnabled, dbStatus, dbDetail, cleanEnv, likeEscape, supa, verifyUser, getProfile, createProfile, leaderboard } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
// no-cache: browsers must revalidate every file, so deploys show up immediately
// (ETag still gives cheap 304 responses when nothing changed)
app.use(express.static(path.join(__dirname, '../public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// Frontend bootstrap config (anon key is public by design in Supabase).
app.get('/api/config', (req, res) => {
  const anon = cleanEnv(process.env.SUPABASE_ANON_KEY);
  res.json({
    auth: dbEnabled && Boolean(anon),
    dbStatus: !dbEnabled ? dbStatus : (anon ? 'ok' : 'no_anon_key'),
    dbDetail,
    supabaseUrl: cleanEnv(process.env.SUPABASE_URL),
    supabaseAnonKey: anon,
  });
});

app.get('/api/leaderboard', async (req, res) => {
  res.json({ rows: await leaderboard(50) });
});

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// Fetch own profile (after login).
app.get('/api/profile', async (req, res) => {
  const user = await verifyUser(bearer(req));
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  res.json({ profile: await getProfile(user.id) });
});

// Create profile with chosen nick (right after signup).
app.post('/api/profile', async (req, res) => {
  const user = await verifyUser(bearer(req));
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const nick = String(req.body?.nick || '').trim();
  if (!/^[A-Za-z0-9_а-яА-ЯёЁ]{3,16}$/.test(nick)) {
    return res.status(400).json({ error: 'nick_bad' });
  }
  const existing = await getProfile(user.id);
  if (existing) return res.json({ profile: existing });
  const result = await createProfile(user.id, nick);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ profile: await getProfile(user.id) });
});

// Server-side signup: creates the account already confirmed, so the game
// never depends on the "Confirm email" toggle in Supabase.
app.post('/api/register', async (req, res) => {
  if (!dbEnabled) return res.status(503).json({ error: 'db_off' });
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const nick = String(req.body?.nick || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'email_bad' });
  if (password.length < 6) return res.status(400).json({ error: 'password_short' });
  if (!/^[A-Za-z0-9_а-яА-ЯёЁ]{3,16}$/.test(nick)) return res.status(400).json({ error: 'nick_bad' });

  // nick must be free (exact, case-insensitive — escape LIKE wildcards)
  const { data: taken } = await supa.from('profiles').select('id').ilike('nick', likeEscape(nick)).maybeSingle();
  if (taken) return res.status(400).json({ error: 'nick_taken' });

  const { data: created, error } = await supa.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  let userId = created?.user?.id;
  if (error) {
    const msg = String(error.message || '').toLowerCase();
    if (msg.includes('already') || error.code === 'email_exists') {
      // the email may exist from an earlier half-finished signup — confirm it so login works
      try {
        const { data: list } = await supa.auth.admin.listUsers({ page: 1, perPage: 1000 });
        const u = list?.users?.find(x => (x.email || '').toLowerCase() === email);
        if (u && !u.email_confirmed_at) {
          await supa.auth.admin.updateUserById(u.id, { email_confirm: true });
        }
        if (u && !(await getProfile(u.id))) userId = u.id; // let them finish with this nick
        else return res.status(400).json({ error: 'email_taken' });
      } catch {
        return res.status(400).json({ error: 'email_taken' });
      }
    } else {
      console.error('register failed:', error.message);
      return res.status(400).json({ error: 'generic', detail: String(error.message || '').slice(0, 90) });
    }
  }
  const prof = await createProfile(userId, nick);
  if (prof.error) return res.status(400).json({ error: prof.error });
  res.json({ ok: true });
});

// Visitor tracking: every device (guests included) is logged with first/last
// visit, visit count, games started and last known nick.
app.post('/api/visit', async (req, res) => {
  res.json({ ok: true }); // never block the client on analytics
  if (!dbEnabled) return;
  try {
    const device = String(req.body?.device || '');
    if (!/^[A-Za-z0-9-]{8,64}$/.test(device)) return;
    const nick = String(req.body?.nick || '').slice(0, 32) || null;
    const game = Boolean(req.body?.game);
    const lang = String(req.body?.lang || '').slice(0, 16) || null;
    const tz = String(req.body?.tz || '').slice(0, 48) || null;
    const installed = req.body?.installed === true;
    const user = await verifyUser(bearer(req));
    const { data: ex } = await supa.from('visitors')
      .select('visits, games, installed_at').eq('device_id', device).maybeSingle();
    if (ex) {
      await supa.from('visitors').update({
        last_seen: new Date().toISOString(),
        visits: ex.visits + (game ? 0 : 1),
        games: ex.games + (game ? 1 : 0),
        ...(nick ? { last_nick: nick } : {}),
        ...(lang ? { lang } : {}),
        ...(tz ? { tz } : {}),
        ...(user ? { user_id: user.id } : {}),
        ...(installed && !ex.installed_at ? { installed_at: new Date().toISOString() } : {}),
      }).eq('device_id', device);
    } else {
      await supa.from('visitors').insert({
        device_id: device,
        last_nick: nick,
        games: game ? 1 : 0,
        lang, tz,
        user_id: user ? user.id : null,
        installed_at: installed ? new Date().toISOString() : null,
      });
    }
    // per-event log: powers the per-person timeline on the admin page
    await supa.from('visit_log').insert({ device_id: device, kind: game ? 'game' : 'visit' });
    if (Math.random() < 0.01) { // occasional cleanup: keep 60 days
      await supa.from('visit_log').delete().lt('at', new Date(Date.now() - 60 * 86400e3).toISOString());
    }
  } catch (e) {
    console.error('visit log failed:', e.message);
  }
});

// Login by nick: resolve a nickname to the account email.
app.post('/api/resolve-login', async (req, res) => {
  if (!dbEnabled) return res.status(503).json({ error: 'db_off' });
  const nick = String(req.body?.nick || '').trim();
  if (!nick || nick.length > 32) return res.status(400).json({ error: 'not_found' });
  const { data: prof } = await supa.from('profiles').select('id').ilike('nick', likeEscape(nick)).maybeSingle();
  if (!prof) return res.status(404).json({ error: 'not_found' });
  const { data: u, error } = await supa.auth.admin.getUserById(prof.id);
  if (error || !u?.user?.email) return res.status(404).json({ error: 'not_found' });
  res.json({ email: u.user.email });
});

/* ---------- owner's private stats page ----------
   /admin?key=<ADMIN_KEY> — full visitor journal: every device, when it came,
   whether it played, how many games; plus live online and daily growth. */
const ADMIN_KEY = cleanEnv(process.env.ADMIN_KEY) || 'karoboev777';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const mskFmt = (iso) => {
  const d = new Date(new Date(iso).getTime() + 3 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

const dayMs = 86400e3;
const mskDayStart = (t) => Math.floor((t + 3 * 3600e3) / dayMs);
const mskDayLabel = (dayIdx) => {
  const d = new Date(dayIdx * dayMs - 3 * 3600e3 + 12 * 3600e3);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

// UI in the style of modern analytics (Plausible/Umami): live badge on top,
// one big visitors chart, then breakdown panels with horizontal bars.
const ADMIN_CSS = `
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #0e1015; color: #e9edf5; margin: 0; }
  a { color: #7aa5f8; text-decoration: none; }
  .top {
    position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 12px;
    padding: 12px 16px; background: rgba(14,16,21,.95); border-bottom: 1px solid #1d212c; backdrop-filter: blur(6px);
  }
  .top b { font-size: 16px; }
  .live { display: flex; align-items: center; gap: 6px; font-size: 13px; color: #9aa3b8; margin-left: auto; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; animation: pulse 1.6s infinite; }
  @keyframes pulse { 50% { opacity: .35; } }
  .page { max-width: 860px; margin: 0 auto; padding: 14px 14px 40px; }
  .nav { display: flex; gap: 8px; margin: 10px 0 4px; flex-wrap: wrap; }
  .nav a { background: #171b26; border: 1px solid #232937; border-radius: 10px; padding: 7px 13px; font-size: 13px; color: #cbd3e3; }
  .nav a.on { background: #2f6df6; border-color: #2f6df6; color: #fff; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(105px, 1fr)); gap: 8px; margin: 12px 0; }
  .kpi { background: #171b26; border: 1px solid #232937; border-radius: 12px; padding: 10px 12px; }
  .kpi b { display: block; font-size: 22px; }
  .kpi span { font-size: 11px; color: #9aa3b8; }
  .panel { background: #171b26; border: 1px solid #232937; border-radius: 14px; padding: 14px; margin-top: 12px; }
  .panel h3 { margin: 0 0 10px; font-size: 13px; color: #9aa3b8; font-weight: 600; text-transform: uppercase; letter-spacing: .4px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
  .row { position: relative; display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 8px; margin-bottom: 4px; overflow: hidden; font-size: 13.5px; color: inherit; }
  .row .fillbg { position: absolute; left: 0; top: 0; bottom: 0; background: rgba(76,139,245,.16); border-radius: 8px; }
  .row .lab { position: relative; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row .num { position: relative; font-weight: 700; }
  .row small { position: relative; color: #9aa3b8; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #232937; white-space: nowrap; }
  th { color: #9aa3b8; font-size: 11px; }
  tr.click { cursor: pointer; } tr.click:active { background: #1d2230; }
  .wrap { overflow-x: auto; }
  .back { display: inline-block; margin: 10px 0; font-size: 14px; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 5px 14px; margin-top: 10px; font-size: 13.5px; }
  .kv span { color: #9aa3b8; }
  .bignick { font-size: 21px; }`;

const adminPage = (title, live, body) => `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0e1015">
<meta http-equiv="refresh" content="60">
<title>${title}</title><style>${ADMIN_CSS}</style></head><body>
<div class="top"><b>🧱 WallRush</b><div class="live"><span class="dot"></span>${live} сейчас в игре</div></div>
<div class="page">${body}</div></body></html>`;

// timezone city → country flag (for the Regions panel)
const FLAGS = {
  Moscow: '🇷🇺', Kaliningrad: '🇷🇺', Samara: '🇷🇺', Volgograd: '🇷🇺', Saratov: '🇷🇺', Yekaterinburg: '🇷🇺', Omsk: '🇷🇺', Novosibirsk: '🇷🇺', Krasnoyarsk: '🇷🇺', Irkutsk: '🇷🇺', Vladivostok: '🇷🇺',
  Kiev: '🇺🇦', Kyiv: '🇺🇦', Minsk: '🇧🇾', Chisinau: '🇲🇩', Dushanbe: '🇹🇯', Tashkent: '🇺🇿', Samarkand: '🇺🇿', Almaty: '🇰🇿', Astana: '🇰🇿', Bishkek: '🇰🇬', Ashgabat: '🇹🇲', Baku: '🇦🇿', Yerevan: '🇦🇲', Tbilisi: '🇬🇪',
  Tehran: '🇮🇷', Istanbul: '🇹🇷', Calcutta: '🇮🇳', Kolkata: '🇮🇳', Karachi: '🇵🇰', Dhaka: '🇧🇩', Dubai: '🇦🇪', Riyadh: '🇸🇦', Baghdad: '🇮🇶', Kabul: '🇦🇫', Jerusalem: '🇮🇱',
  Paris: '🇫🇷', Berlin: '🇩🇪', London: '🇬🇧', Madrid: '🇪🇸', Rome: '🇮🇹', Zagreb: '🇭🇷', Warsaw: '🇵🇱', Amsterdam: '🇳🇱', Prague: '🇨🇿', Vienna: '🇦🇹', Stockholm: '🇸🇪', Helsinki: '🇫🇮', Lisbon: '🇵🇹', Athens: '🇬🇷', Bucharest: '🇷🇴', Sofia: '🇧🇬', Belgrade: '🇷🇸',
  Algiers: '🇩🇿', Cairo: '🇪🇬', Casablanca: '🇲🇦', Lagos: '🇳🇬', Nairobi: '🇰🇪', Johannesburg: '🇿🇦', Tunis: '🇹🇳',
  Manila: '🇵🇭', Jakarta: '🇮🇩', Bangkok: '🇹🇭', Tokyo: '🇯🇵', Seoul: '🇰🇷', Shanghai: '🇨🇳', Hong_Kong: '🇭🇰', Singapore: '🇸🇬', Ho_Chi_Minh: '🇻🇳', Kuala_Lumpur: '🇲🇾',
  New_York: '🇺🇸', Los_Angeles: '🇺🇸', Chicago: '🇺🇸', Denver: '🇺🇸', Phoenix: '🇺🇸', Toronto: '🇨🇦', Vancouver: '🇨🇦', Sao_Paulo: '🇧🇷', Mexico_City: '🇲🇽', Buenos_Aires: '🇦🇷', Bogota: '🇨🇴', Lima: '🇵🇪', Santiago: '🇨🇱',
  Auckland: '🇳🇿', Sydney: '🇦🇺', Melbourne: '🇦🇺', Brisbane: '🇦🇺',
};
const regionCity = (tz) => tz ? tz.split('/').pop() : '';
const flagOf = (tz) => FLAGS[regionCity(tz)] || '🌍';

// SVG area chart, Plausible-style: gradient fill, line, value labels
function areaChart(values, labels) {
  const w = 720, h = 150, pad = 10;
  const max = Math.max(1, ...values);
  const n = Math.max(2, values.length);
  const step = (w - pad * 2) / (n - 1);
  const pts = values.map((v, i) => [pad + i * step, h - pad - (h - pad * 2) * (v / max)]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = `${line} L ${pts[pts.length - 1][0].toFixed(1)} ${h - pad} L ${pad} ${h - pad} Z`;
  const every = Math.max(1, Math.ceil(labels.length / 8));
  const labs = labels.map((l, i) => (i % every === 0 || i === labels.length - 1)
    ? `<text x="${(pad + i * step).toFixed(1)}" y="${h + 12}" font-size="9" fill="#9aa3b8" text-anchor="middle">${l}</text>` : '').join('');
  const vals = values.map((v, i) => v > 0
    ? `<text x="${(pad + i * step).toFixed(1)}" y="${(pts[i][1] - 6).toFixed(1)}" font-size="9" fill="#cbd3e3" text-anchor="middle">${v}</text>` : '').join('');
  const dots = pts.map((p, i) => values[i] > 0 ? `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.6" fill="#4c8bf5"/>` : '').join('');
  return `<svg viewBox="0 0 ${w} ${h + 18}" style="width:100%;height:auto;display:block">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#4c8bf5" stop-opacity=".34"/><stop offset="1" stop-color="#4c8bf5" stop-opacity="0"/>
</linearGradient></defs>
<path d="${area}" fill="url(#g)"/><path d="${line}" fill="none" stroke="#4c8bf5" stroke-width="2.2" stroke-linejoin="round"/>${dots}${vals}${labs}</svg>`;
}

// horizontal bar row (the signature analytics look)
const barRow = (label, count, max, href, extra = '') =>
  `<a class="row" ${href ? `href="${href}"` : ''}>
     <span class="fillbg" style="width:${Math.max(3, Math.round(100 * count / Math.max(1, max)))}%"></span>
     <span class="lab">${label}</span>${extra}<span class="num">${count}</span>
   </a>`;

// display name for a visitor row: 📲 = installed the game as an app
const visName = (v, byId) => {
  const prof = v.user_id ? byId.get(v.user_id) : null;
  const base = prof ? prof.nick : (v.last_nick || '—');
  return (v.installed_at ? '📲 ' : '') + base;
};

async function loadAdminData(daysBack) {
  const { data: rows } = await supa.from('visitors')
    .select('device_id, first_seen, last_seen, visits, games, last_nick, user_id, lang, tz, installed_at')
    .order('last_seen', { ascending: false }).limit(500);
  const { data: profs } = await supa.from('profiles').select('id, nick, wins, losses');
  const { data: log } = await supa.from('visit_log')
    .select('device_id, kind, at')
    .gt('at', new Date(Date.now() - daysBack * dayMs).toISOString())
    .limit(20000);
  return { all: rows || [], byId: new Map((profs || []).map(p => [p.id, p])), log: log || [] };
}

// ---- main dashboard: live badge, KPIs, big visitors chart, breakdown panels ----
app.get('/admin', async (req, res) => {
  if ((req.query.key || '') !== ADMIN_KEY) return res.status(404).send('Not found');
  if (!dbEnabled) return res.send('DB is off');
  const p = ['today', '7d', '30d'].includes(String(req.query.p)) ? String(req.query.p) : '7d';
  const nDays = p === 'today' ? 1 : p === '7d' ? 7 : 30;
  const { all, byId, log } = await loadAdminData(nDays);
  const today = mskDayStart(Date.now());
  const startDay = today - (nDays - 1);
  const startMs = startDay * dayMs - 3 * 3600e3;

  // per-day / per-hour activity from the event log
  const dayAct = new Map(); // day -> { set, games }
  const hourAct = new Map(); // msk hour -> set (today only)
  for (const e of log) {
    const t = new Date(e.at).getTime();
    const day = mskDayStart(t);
    const rec = dayAct.get(day) || { set: new Set(), games: 0 };
    rec.set.add(e.device_id);
    if (e.kind === 'game') rec.games++;
    dayAct.set(day, rec);
    if (day === today) {
      const h = Math.floor(((t + 3 * 3600e3) % dayMs) / 3600e3);
      (hourAct.get(h) || hourAct.set(h, new Set()).get(h)).add(e.device_id);
    }
  }

  // KPIs for the chosen period
  const inPeriod = (iso) => iso && new Date(iso).getTime() >= startMs;
  const visitors = all.filter(v => inPeriod(v.last_seen)).length;
  const fresh = all.filter(v => inPeriod(v.first_seen)).length;
  const games = log.filter(e => e.kind === 'game').length;
  const installsP = all.filter(v => inPeriod(v.installed_at)).length;
  const installsAll = all.filter(v => v.installed_at).length;

  // chart: hours for "today", days otherwise (old days fall back to new-people counts)
  let values, labels;
  if (p === 'today') {
    const nowH = Math.floor(((Date.now() + 3 * 3600e3) % dayMs) / 3600e3);
    values = []; labels = [];
    for (let h = 0; h <= nowH; h++) { values.push(hourAct.get(h)?.size || 0); labels.push(h + ':00'); }
  } else {
    values = []; labels = [];
    for (let day = startDay; day <= today; day++) {
      const act = dayAct.get(day)?.set.size || 0;
      const fresh2 = all.filter(v => mskDayStart(new Date(v.first_seen).getTime()) === day).length;
      values.push(Math.max(act, fresh2));
      labels.push(mskDayLabel(day));
    }
  }

  // breakdown panels (people active in the period)
  const act = all.filter(v => inPeriod(v.last_seen));
  const group = (keyFn) => {
    const m = new Map();
    for (const v of act) { const k = keyFn(v); if (!k) continue; m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  };
  const regions = group(v => v.tz ? `${flagOf(v.tz)} ${regionCity(v.tz).replace(/_/g, ' ')}` : null);
  const langs = group(v => v.lang ? v.lang.split('-')[0].toLowerCase() : null);
  const maxR = Math.max(1, ...regions.map(r => r[1]));
  const maxL = Math.max(1, ...langs.map(r => r[1]));
  const pHref = (v) => `/admin/v?key=${ADMIN_KEY}&d=${encodeURIComponent(v.device_id)}`;
  const recent = all.slice(0, 8).map(v =>
    barRow(esc(visName(v, byId)), v.games, Math.max(1, ...all.slice(0, 8).map(x => x.games)), pHref(v),
      `<small>${mskFmt(v.last_seen)}</small>`)).join('');
  const topPlayers = [...all].sort((a, b) => b.games - a.games).slice(0, 8);
  const top = topPlayers.map(v =>
    barRow(esc(visName(v, byId)), v.games, Math.max(1, topPlayers[0]?.games || 1), pHref(v))).join('');

  const per = (id, label) => `<a class="${p === id ? 'on' : ''}" href="/admin?key=${ADMIN_KEY}&p=${id}">${label}</a>`;

  res.send(adminPage('WallRush — статистика', realOnline(), `
<div class="nav">
  ${per('today', 'Сегодня')}${per('7d', '7 дней')}${per('30d', '30 дней')}
  <a href="/admin/all?key=${ADMIN_KEY}" style="margin-left:auto">Все люди →</a>
</div>
<div class="kpis">
  <div class="kpi"><b>${visitors}</b><span>посетители</span></div>
  <div class="kpi"><b>${fresh}</b><span>новых</span></div>
  <div class="kpi"><b>${games}</b><span>партий</span></div>
  <div class="kpi"><b>${installsP}</b><span>📲 установили (всего ${installsAll})</span></div>
  <div class="kpi"><b>${(byId.size)}</b><span>✔ аккаунтов</span></div>
</div>
<div class="panel"><h3>Посетители ${p === 'today' ? 'по часам (МСК)' : 'по дням'}</h3>${areaChart(values, labels)}</div>
<div class="grid">
  <div class="panel"><h3>🌍 Регионы</h3>${regions.map(([k, n]) => barRow(k, n, maxR)).join('') || '<small style="color:#9aa3b8">пока пусто</small>'}</div>
  <div class="panel"><h3>🗣 Языки</h3>${langs.map(([k, n]) => barRow(k, n, maxL)).join('') || '<small style="color:#9aa3b8">пока пусто</small>'}</div>
  <div class="panel"><h3>🕐 Последние посетители · партий</h3>${recent}</div>
  <div class="panel"><h3>🏆 Самые активные · партий</h3>${top}</div>
</div>`));
});

// ---- full journal: every person, filterable, click → person page ----
app.get('/admin/all', async (req, res) => {
  if ((req.query.key || '') !== ADMIN_KEY) return res.status(404).send('Not found');
  if (!dbEnabled) return res.send('DB is off');
  const { all, byId } = await loadAdminData(1);
  const played = all.filter(v => v.games > 0).length;
  const regs = all.filter(v => v.user_id).length;
  const installs = all.filter(v => v.installed_at).length;
  const f = String(req.query.f || 'all');
  const shown = all.filter(v =>
    f === 'played' ? v.games > 0 :
    f === 'zero' ? v.games === 0 :
    f === 'inst' ? Boolean(v.installed_at) :
    f === 'reg' ? Boolean(v.user_id) : true);
  const tab = (id, label, n) =>
    `<a class="${f === id ? 'on' : ''}" href="/admin/all?key=${ADMIN_KEY}&f=${id}">${label} (${n})</a>`;
  const trs = shown.map(v => {
    const prof = v.user_id ? byId.get(v.user_id) : null;
    const badge = prof ? '<b style="color:#22c55e">✔</b>' : '<span style="color:#9aa3b8">гость</span>';
    const games = v.games > 0 ? `<b>${v.games}</b>` : '<span style="color:#e0455e">0</span>';
    const region = v.tz ? `${flagOf(v.tz)} ${regionCity(v.tz).replace(/_/g, ' ')}` : '—';
    return `<tr class="click" onclick="location.href='/admin/v?key=${ADMIN_KEY}&d=${encodeURIComponent(v.device_id)}'">
      <td>${esc(visName(v, byId))} ›</td><td>${badge}</td><td>${mskFmt(v.first_seen)}</td><td>${mskFmt(v.last_seen)}</td><td>${v.visits}</td><td>${games}</td><td>${esc(v.lang || '—')}</td><td>${region}</td></tr>`;
  }).join('');
  res.send(adminPage('Все люди — WallRush', realOnline(), `
<a class="back" href="/admin?key=${ADMIN_KEY}">‹ Обзор</a>
<div class="nav">
  ${tab('all', 'Все', all.length)}
  ${tab('played', '🎮 Играли', played)}
  ${tab('zero', '👀 Смотрели', all.length - played)}
  ${tab('inst', '📲 Установили', installs)}
  ${tab('reg', '✔ Аккаунт', regs)}
</div>
<div class="panel wrap"><table>
<tr><th>Ник</th><th></th><th>Пришёл</th><th>Был</th><th>Визитов</th><th>Партий</th><th>Язык</th><th>Регион</th></tr>
${trs}
</table></div>`));
});

// one person's page: everything about a single device + day-by-day timeline
app.get('/admin/v', async (req, res) => {
  if ((req.query.key || '') !== ADMIN_KEY) return res.status(404).send('Not found');
  if (!dbEnabled) return res.send('DB is off');
  const device = String(req.query.d || '');
  const { data: v } = await supa.from('visitors')
    .select('device_id, first_seen, last_seen, visits, games, last_nick, user_id, lang, tz, installed_at')
    .eq('device_id', device).maybeSingle();
  if (!v) return res.send(adminPage('Не найден', realOnline(), `<a class="back" href="/admin?key=${ADMIN_KEY}">‹ Назад</a><p>Человек не найден.</p>`));
  const prof = v.user_id ? (await supa.from('profiles').select('nick, wins, losses').eq('id', v.user_id).maybeSingle()).data : null;
  const { data: log } = await supa.from('visit_log')
    .select('kind, at').eq('device_id', device).order('at', { ascending: false }).limit(1000);

  // group events by MSK day
  const byDay = new Map();
  for (const e of (log || [])) {
    const day = mskDayStart(new Date(e.at).getTime());
    const rec = byDay.get(day) || { visits: 0, games: 0, last: e.at };
    if (e.kind === 'game') rec.games++; else rec.visits++;
    byDay.set(day, rec);
  }
  const dayRows = [...byDay.entries()].sort((a, b) => b[0] - a[0]).map(([day, r]) =>
    `<tr><td>${mskDayLabel(day)}</td><td>${r.visits}</td><td>${r.games > 0 ? `<b>${r.games}</b>` : '<span style="color:#c0392b">0</span>'}</td></tr>`
  ).join('');

  const nick = prof ? prof.nick : (v.last_nick || '—');
  const region = v.tz ? `${flagOf(v.tz)} ${regionCity(v.tz).replace(/_/g, ' ')}` : '—';
  res.send(adminPage(`${nick} — WallRush`, realOnline(), `
<a class="back" href="/admin/all?key=${ADMIN_KEY}">‹ Все люди</a>
<div class="panel">
  <b class="bignick">${esc(nick)}</b>
  ${prof ? '<b style="color:#22c55e"> ✔ зарегистрирован</b>' : '<span style="color:#9aa3b8"> · гость</span>'}
  <div class="kv">
    <span>Первый заход</span><b>${mskFmt(v.first_seen)} (МСК)</b>
    <span>Последний раз</span><b>${mskFmt(v.last_seen)}</b>
    <span>Всего заходов</span><b>${v.visits}</b>
    <span>Всего партий</span><b>${v.games}</b>
    <span>Язык устройства</span><b>${esc(v.lang || 'неизвестно')}</b>
    <span>Регион</span><b>${region}</b>
    <span>Приложение</span><b>${v.installed_at ? `📲 установил (${mskFmt(v.installed_at)})` : 'не устанавливал'}</b>
    ${prof ? `<span>Побед / поражений</span><b>${prof.wins} / ${prof.losses} (против живых)</b>` : ''}
  </div>
</div>
<div class="panel"><h3>По дням: когда заходил и сколько играл</h3>
${dayRows
    ? `<div class="wrap"><table><tr><th>День</th><th>Заходов</th><th>Партий</th></tr>${dayRows}</table></div>`
    : '<small style="color:#9aa3b8">Подробная история пишется с 19.07 — записи появятся при следующем заходе этого человека.</small>'}
</div>`));
});

app.get('/healthz', (req, res) => res.send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
attachWs(wss);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`WallRush listening on :${PORT} (db: ${dbEnabled ? 'on' : 'off — guest mode'})`);
});
