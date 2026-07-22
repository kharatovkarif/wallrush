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
        ...(installed ? { standalone_at: new Date().toISOString() } : {}), // every launch from the icon
      }).eq('device_id', device);
    } else {
      await supa.from('visitors').insert({
        device_id: device,
        last_nick: nick,
        games: game ? 1 : 0,
        lang, tz,
        user_id: user ? user.id : null,
        installed_at: installed ? new Date().toISOString() : null,
        standalone_at: installed ? new Date().toISOString() : null,
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

// never cache admin pages — the browser was showing hours-old stats
app.use('/admin', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
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

const ADMIN_CSS = `
  body { font-family: system-ui, sans-serif; background: #12141f; color: #e8ecf8; margin: 0; padding: 14px; }
  h1 { font-size: 19px; margin: 4px 0 12px; } h2 { font-size: 15px; margin: 20px 0 8px; color: #aab3d0; }
  a { color: #6d9bf8; text-decoration: none; }
  .cards { display: flex; flex-wrap: wrap; gap: 8px; }
  .c { background: #1c2033; border-radius: 12px; padding: 10px 14px; min-width: 96px; }
  .c b { font-size: 22px; display: block; } .c span { font-size: 11px; color: #8892b0; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #262c42; white-space: nowrap; }
  th { color: #8892b0; font-size: 11px; position: sticky; top: 0; background: #12141f; }
  tr.click { cursor: pointer; } tr.click:active { background: #1c2033; }
  .wrap { overflow-x: auto; }
  .chart { display: flex; align-items: flex-end; gap: 5px; height: 110px; padding-top: 14px; }
  .bar { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; }
  .bar .fill { width: 100%; background: #2f6df6; border-radius: 4px 4px 0 0; min-height: 2px; }
  .bar small { font-size: 10px; color: #cfd6ee; margin: 2px 0; } .bar span { font-size: 9px; color: #667; }
  .tabs { display: flex; gap: 8px; margin: 10px 0; flex-wrap: wrap; }
  .tabs a { background: #1c2033; border-radius: 10px; padding: 7px 12px; font-size: 13px; color: #cfd6ee; }
  .tabs a.on { background: #2f6df6; color: #fff; }
  .person { background: #1c2033; border-radius: 14px; padding: 14px; margin-bottom: 14px; }
  .person b.nick { font-size: 20px; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; margin-top: 10px; font-size: 13px; }
  .kv span { color: #8892b0; }
  .back { display: inline-block; margin-bottom: 10px; font-size: 14px; }`;

const nowMskHms = () => {
  const d = new Date(Date.now() + 3 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};
const adminPage = (title, body) => `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#12141f">
<meta http-equiv="refresh" content="30">
<meta http-equiv="Cache-Control" content="no-store">
<title>${title}</title><style>${ADMIN_CSS}</style></head><body>${body}
<p style="text-align:center;color:#5b6480;font-size:12px;margin:18px 0 6px">🕐 обновлено в ${nowMskHms()} МСК · страница сама обновляется каждые 30 сек</p>
</body></html>`;

// display name for a visitor row: 📲 = installed the game as an app
// installed but hasn't launched from the icon for a week while still visiting
// in the browser → most likely removed the app (the platform gives no direct
// uninstall signal, this is the honest best guess)
const maybeDeleted = (v) => Boolean(v.installed_at) &&
  (!v.standalone_at || (Date.now() - new Date(v.standalone_at).getTime() > 7 * dayMs &&
    new Date(v.last_seen).getTime() > new Date(v.standalone_at).getTime()));

const visName = (v, byId) => {
  const prof = v.user_id ? byId.get(v.user_id) : null;
  const base = prof ? prof.nick : (v.last_nick || '—');
  return (v.installed_at ? (maybeDeleted(v) ? '📲❓ ' : '📲 ') : '') + base;
};

app.get('/admin', async (req, res) => {
  if ((req.query.key || '') !== ADMIN_KEY) return res.status(404).send('Not found');
  if (!dbEnabled) return res.send('DB is off');
  const { data: rows } = await supa.from('visitors')
    .select('device_id, first_seen, last_seen, visits, games, last_nick, user_id, lang, tz, installed_at, standalone_at')
    .order('last_seen', { ascending: false }).limit(500);
  const { data: profs } = await supa.from('profiles').select('id, nick, wins, losses');
  const byId = new Map((profs || []).map(p => [p.id, p]));
  const all = rows || [];

  // exact counts via the DB (the 500-row fetch above is only for the journal list)
  const today = mskDayStart(Date.now());
  const todayStartIso = new Date(today * dayMs - 3 * 3600e3).toISOString();
  const yStartIso = new Date((today - 1) * dayMs - 3 * 3600e3).toISOString();
  const cnt = async (q) => (await q).count || 0;
  const [totalPeople, played, regs, installs, newToday, activeToday, humansToday, humansTotal] = await Promise.all([
    cnt(supa.from('visitors').select('*', { count: 'exact', head: true })),
    cnt(supa.from('visitors').select('*', { count: 'exact', head: true }).gt('games', 0)),
    cnt(supa.from('visitors').select('*', { count: 'exact', head: true }).not('user_id', 'is', null)),
    cnt(supa.from('visitors').select('*', { count: 'exact', head: true }).not('installed_at', 'is', null)),
    cnt(supa.from('visitors').select('*', { count: 'exact', head: true }).gte('first_seen', todayStartIso)),
    cnt(supa.from('visitors').select('*', { count: 'exact', head: true }).gte('last_seen', todayStartIso)),
    cnt(supa.from('human_matches').select('*', { count: 'exact', head: true }).gte('at', todayStartIso)),
    cnt(supa.from('human_matches').select('*', { count: 'exact', head: true })),
  ]);
  const totalGames = await cnt(supa.from('visit_log').select('*', { count: 'exact', head: true }).eq('kind', 'game'));

  const view = String(req.query.view || 'people');
  const viewTab = (id, label) =>
    `<a class="${view === id ? 'on' : ''}" href="/admin?key=${ADMIN_KEY}&view=${id}">${label}</a>`;

  let content = '';
  if (view === 'days') {
    // ----- days view: each day = a block with its own numbers and people -----
    // aggregate per MSK day IN the database (no 1000-row truncation)
    const fromTs = new Date((today - 13) * dayMs - 3 * 3600e3).toISOString();
    const { data: buckets } = await supa.rpc('admin_buckets', {
      from_ts: fromTs, to_ts: new Date().toISOString(), bucket_secs: 86400, offset_secs: 10800,
    });
    const dmap = new Map(); // MSK day index -> { people, games }
    for (const b of (buckets || [])) dmap.set(Number(b.bucket), { people: Number(b.people), games: Number(b.games) });

    const blocks = [];
    for (let day = today; day > today - 14; day--) {
      const rec = dmap.get(day);
      const fresh = all.filter(v => mskDayStart(new Date(v.first_seen).getTime()) === day);
      if (!rec && !fresh.length) continue;
      // list of who was active that day (distinct devices, small result)
      const { data: devs } = await supa.rpc('admin_devices', {
        from_ts: new Date(day * dayMs - 3 * 3600e3).toISOString(),
        to_ts: new Date((day + 1) * dayMs - 3 * 3600e3).toISOString(),
      });
      const byDevice = new Map(all.map(v => [v.device_id, v]));
      const people = (devs || []).map(d => byDevice.get(d.device_id)).filter(Boolean);
      const list = (people.length ? people : fresh).map(v =>
        `<a href="/admin/v?key=${ADMIN_KEY}&d=${encodeURIComponent(v.device_id)}">${esc(visName(v, byId))}</a>`
      ).join(', ') || '—';
      blocks.push(`<div class="person">
        <b><a href="/admin/day?key=${ADMIN_KEY}&day=${day}">${mskDayLabel(day)}${day === today ? ' — сегодня' : ''} · по часам →</a></b>
        <div class="kv">
          <span>Новых</span><b>${fresh.length}</b>
          <span>Заходили</span><b>${rec ? rec.people : fresh.length}</b>
          <span>Партий</span><b>${rec ? rec.games : '—'}</b>
        </div>
        <p style="font-size:13px;line-height:1.8;margin:8px 0 0">${list}</p>
      </div>`);
    }
    content = `<h2>Каждый день отдельно (нажми на ник — вся история человека)</h2>` +
      (blocks.join('') || '<p style="color:#8892b0">Подневная история пишется с 19.07 — блоки появятся по мере заходов.</p>');
  } else {
    // ----- people view: the journal with filters -----
    const f = String(req.query.f || 'all');
    const shown = all.filter(v =>
      f === 'played' ? v.games > 0 :
      f === 'zero' ? v.games === 0 :
      f === 'inst' ? Boolean(v.installed_at) :
      f === 'reg' ? Boolean(v.user_id) : true);
    const tab = (id, label, n) =>
      `<a class="${f === id ? 'on' : ''}" href="/admin?key=${ADMIN_KEY}&view=people&f=${id}">${label} (${n})</a>`;
    const trs = shown.map(v => {
      const prof = v.user_id ? byId.get(v.user_id) : null;
      const badge = prof ? '<b style="color:#21c07a">✔ рег.</b>' : '<span style="color:#8892b0">гость</span>';
      const games = v.games > 0 ? `<b>${v.games}</b>` : '<span style="color:#c0392b">0</span>';
      const region = v.tz ? v.tz.split('/').pop().replace(/_/g, ' ') : '—';
      const href = `/admin/v?key=${ADMIN_KEY}&d=${encodeURIComponent(v.device_id)}`;
      return `<tr class="click" onclick="location.href='${href}'"><td>${esc(visName(v, byId))} ›</td><td>${badge}</td><td>${mskFmt(v.first_seen)}</td><td>${mskFmt(v.last_seen)}</td><td>${v.visits}</td><td>${games}</td><td>${esc(v.lang || '—')}</td><td>${esc(region)}</td></tr>`;
    }).join('');
    content = `
<h2>Журнал — последние 500, нажми на человека (📲 = установил приложение)</h2>
<div class="tabs">
  ${tab('all', 'Все', totalPeople)}
  ${tab('played', '🎮 Играли', played)}
  ${tab('zero', '👀 Только смотрели', totalPeople - played)}
  ${tab('inst', '📲 Установили', installs)}
  ${tab('reg', '✔ Регистрация', regs)}
</div>
<div class="wrap"><table>
<tr><th>Ник</th><th>Статус</th><th>Первый заход (МСК)</th><th>Последний</th><th>Заходов</th><th>Партий</th><th>Язык</th><th>Регион</th></tr>
${trs}
</table></div>`;
  }

  // new devices per day, last 14 days — counted in the DB (no 500-row cap)
  const { data: npd } = await supa.rpc('new_per_day', {
    from_ts: new Date((today - 13) * dayMs - 3 * 3600e3).toISOString(),
  });
  const npdMap = new Map((npd || []).map(r => [Number(r.day), Number(r.n)]));
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const day = today - i;
    days.push({ label: mskDayLabel(day), n: npdMap.get(day) || 0 });
  }
  const maxDay = Math.max(1, ...days.map(d => d.n));
  const bars = days.map(d =>
    `<div class="bar"><div class="fill" style="height:${Math.round(100 * d.n / maxDay)}%"></div><small>${d.n}</small><span>${d.label}</span></div>`
  ).join('');

  res.send(adminPage('WallRush — статистика', `
<h1>🧱 WallRush — статистика <span style="font-size:11px;color:#667">(обновляется каждую минуту)</span></h1>
<div class="cards">
  <div class="c"><b>${realOnline()}</b><span>сейчас на сайте (реально)</span></div>
  <div class="c"><b>${realOnline() + fakeOnline()}</b><span>показано «онлайн»</span></div>
  <div class="c"><b>${newToday}</b><span>новых сегодня</span></div>
  <div class="c"><b>${activeToday}</b><span>заходили сегодня</span></div>
  <div class="c"><b>${humansToday}</b><span>🤝 живой vs живой (сегодня)</span></div>
  <div class="c"><b>${humansTotal}</b><span>🤝 живых матчей всего</span></div>
  <div class="c"><b>${installs}</b><span>📲 установили приложение</span></div>
  <div class="c"><b>${totalPeople}</b><span>всего людей</span></div>
  <div class="c"><b>${totalGames}</b><span>партий всего</span></div>
</div>
<div class="tabs" style="margin-top:14px">
  ${viewTab('people', '👥 Люди')}
  ${viewTab('days', '📅 По дням')}
</div>
<h2>Новые люди по дням (14 дней)</h2>
<div class="chart">${bars}</div>
${content}`));
});

// one day's page: hour-by-hour breakdown (people + games per MSK hour)
app.get('/admin/day', async (req, res) => {
  if ((req.query.key || '') !== ADMIN_KEY) return res.status(404).send('Not found');
  if (!dbEnabled) return res.send('DB is off');
  const day = parseInt(String(req.query.day || ''), 10);
  if (!Number.isFinite(day)) return res.redirect(`/admin?key=${ADMIN_KEY}`);
  const startIso = new Date(day * dayMs - 3 * 3600e3).toISOString();
  const endIso = new Date((day + 1) * dayMs - 3 * 3600e3).toISOString();
  // per-hour counts aggregated in the DB (immune to the 1000-row API limit)
  const { data: hbk } = await supa.rpc('admin_buckets', {
    from_ts: startIso, to_ts: endIso, bucket_secs: 3600, offset_secs: 10800,
  });
  const { data: devs } = await supa.rpc('admin_devices', { from_ts: startIso, to_ts: endIso });
  const { data: rows } = await supa.from('visitors')
    .select('device_id, first_seen, last_nick, user_id, installed_at, standalone_at')
    .limit(500);
  const { data: profs } = await supa.from('profiles').select('id, nick');
  const byId = new Map((profs || []).map(p => [p.id, p]));
  const byDevice = new Map((rows || []).map(v => [v.device_id, v]));

  const hours = Array.from({ length: 24 }, () => ({ people: 0, games: 0 }));
  let dayGames = 0;
  for (const b of (hbk || [])) {
    const h = Number(b.bucket) % 24;
    hours[h] = { people: Number(b.people), games: Number(b.games) };
    dayGames += Number(b.games);
  }
  const dayDevices = (devs || []).length;
  const fresh = (rows || []).filter(v => mskDayStart(new Date(v.first_seen).getTime()) === day).length;
  const trs = hours.map((x, h) => {
    const dim = x.people === 0 && x.games === 0;
    const href = `/admin/hour?key=${ADMIN_KEY}&day=${day}&h=${h}`;
    return `<tr class="click"${dim ? ' style="opacity:.35"' : ''} onclick="location.href='${href}'"><td>${String(h).padStart(2, '0')}:00 ›</td><td>${x.people ? `<b>${x.people}</b>` : 0}</td><td>${x.games ? `<b>${x.games}</b>` : 0}</td></tr>`;
  }).join('');
  const people = (devs || []).map(d => byDevice.get(d.device_id)).filter(Boolean).map(v =>
    `<a href="/admin/v?key=${ADMIN_KEY}&d=${encodeURIComponent(v.device_id)}">${esc(visName(v, byId))}</a>`).join(', ') || '—';

  res.send(adminPage(`${mskDayLabel(day)} — WallRush`, `
<a class="back" href="/admin?key=${ADMIN_KEY}&view=days">‹ Назад к дням</a>
<div class="person">
  <b>${mskDayLabel(day)}${day === mskDayStart(Date.now()) ? ' — сегодня' : ''}</b>
  <div class="kv">
    <span>Заходили</span><b>${dayDevices}</b>
    <span>Новых</span><b>${fresh}</b>
    <span>Партий</span><b>${dayGames}</b>
  </div>
</div>
<h2>По часам (МСК)</h2>
<div class="wrap"><table><tr><th>Час</th><th>Людей</th><th>Партий</th></tr>${trs}</table></div>
<h2>Кто был в этот день (нажми на ник)</h2>
<p style="font-size:13px;line-height:1.9">${people}</p>`));
});

// one hour's page: minute-by-minute breakdown inside a chosen hour
app.get('/admin/hour', async (req, res) => {
  if ((req.query.key || '') !== ADMIN_KEY) return res.status(404).send('Not found');
  if (!dbEnabled) return res.send('DB is off');
  const day = parseInt(String(req.query.day || ''), 10);
  const h = parseInt(String(req.query.h || ''), 10);
  if (!Number.isFinite(day) || !Number.isFinite(h) || h < 0 || h > 23) {
    return res.redirect(`/admin?key=${ADMIN_KEY}`);
  }
  const startMs = day * dayMs - 3 * 3600e3 + h * 3600e3;
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(startMs + 3600e3).toISOString();
  // per-minute counts aggregated in the DB
  const { data: mbk } = await supa.rpc('admin_buckets', {
    from_ts: startIso, to_ts: endIso, bucket_secs: 60, offset_secs: 10800,
  });
  const { data: devs } = await supa.rpc('admin_devices', { from_ts: startIso, to_ts: endIso });
  const { data: rows } = await supa.from('visitors')
    .select('device_id, last_nick, user_id, installed_at, standalone_at').limit(500);
  const { data: profs } = await supa.from('profiles').select('id, nick');
  const byId = new Map((profs || []).map(p => [p.id, p]));
  const byDevice = new Map((rows || []).map(v => [v.device_id, v]));

  const mins = Array.from({ length: 60 }, () => ({ people: 0, games: 0 }));
  let hourGames = 0;
  for (const b of (mbk || [])) {
    const m = Number(b.bucket) % 60;
    mins[m] = { people: Number(b.people), games: Number(b.games) };
    hourGames += Number(b.games);
  }
  const hourDevices = (devs || []).length;
  const hh = String(h).padStart(2, '0');
  const trs = mins.map((x, m) => {
    const dim = x.people === 0 && x.games === 0;
    return `<tr${dim ? ' style="opacity:.3"' : ''}><td>${hh}:${String(m).padStart(2, '0')}</td><td>${x.people ? `<b>${x.people}</b>` : 0}</td><td>${x.games ? `<b>${x.games}</b>` : 0}</td></tr>`;
  }).join('');
  const people = (devs || []).map(d => byDevice.get(d.device_id)).filter(Boolean).map(v =>
    `<a href="/admin/v?key=${ADMIN_KEY}&d=${encodeURIComponent(v.device_id)}">${esc(visName(v, byId))}</a>`).join(', ') || '—';

  res.send(adminPage(`${mskDayLabel(day)} ${hh}:00 — WallRush`, `
<a class="back" href="/admin/day?key=${ADMIN_KEY}&day=${day}">‹ Назад ко дню ${mskDayLabel(day)}</a>
<div class="person">
  <b>${mskDayLabel(day)}, час ${hh}:00–${hh}:59 (МСК)</b>
  <div class="kv">
    <span>Людей за час</span><b>${hourDevices}</b>
    <span>Партий за час</span><b>${hourGames}</b>
  </div>
</div>
<h2>По минутам</h2>
<div class="wrap"><table><tr><th>Минута</th><th>Людей</th><th>Партий</th></tr>${trs}</table></div>
<h2>Кто был в этот час (нажми на ник)</h2>
<p style="font-size:13px;line-height:1.9">${people}</p>`));
});

// one person's page: everything about a single device + day-by-day timeline
app.get('/admin/v', async (req, res) => {
  if ((req.query.key || '') !== ADMIN_KEY) return res.status(404).send('Not found');
  if (!dbEnabled) return res.send('DB is off');
  const device = String(req.query.d || '');
  const { data: v } = await supa.from('visitors')
    .select('device_id, first_seen, last_seen, visits, games, last_nick, user_id, lang, tz, installed_at, standalone_at')
    .eq('device_id', device).maybeSingle();
  if (!v) return res.send(adminPage('Не найден', `<a class="back" href="/admin?key=${ADMIN_KEY}">‹ Назад</a><p>Человек не найден.</p>`));
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
  const region = v.tz ? v.tz.split('/').pop().replace(/_/g, ' ') : '—';
  res.send(adminPage(`${nick} — WallRush`, `
<a class="back" href="/admin?key=${ADMIN_KEY}">‹ Назад к списку</a>
<div class="person">
  <b class="nick">${esc(nick)}</b>
  ${prof ? '<b style="color:#21c07a"> ✔ зарегистрирован</b>' : '<span style="color:#8892b0"> · гость</span>'}
  <div class="kv">
    <span>Первый заход</span><b>${mskFmt(v.first_seen)} (МСК)</b>
    <span>Последний раз</span><b>${mskFmt(v.last_seen)}</b>
    <span>Всего заходов</span><b>${v.visits}</b>
    <span>Всего партий</span><b>${v.games}</b>
    <span>Язык устройства</span><b>${esc(v.lang || 'неизвестно')}</b>
    <span>Регион</span><b>${esc(region)}</b>
    <span>Приложение</span><b>${!v.installed_at ? 'не устанавливал'
      : maybeDeleted(v) ? `📲❓ установил ${mskFmt(v.installed_at)}, но с иконки давно не заходил — возможно удалил`
      : `📲 установил (${mskFmt(v.installed_at)})${v.standalone_at ? `, запуск с иконки: ${mskFmt(v.standalone_at)}` : ''}`}</b>
    ${prof ? `<span>Побед / поражений</span><b>${prof.wins} / ${prof.losses} (против живых)</b>` : ''}
  </div>
</div>
<h2>По дням: когда заходил и сколько играл</h2>
${dayRows
    ? `<div class="wrap"><table><tr><th>День</th><th>Заходов</th><th>Партий</th></tr>${dayRows}</table></div>`
    : '<p style="color:#8892b0;font-size:13px">Подробная история пишется с 19.07 — у этого человека записей пока нет. Появятся при следующем его заходе.</p>'}`));
});

app.get('/healthz', (req, res) => res.send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
attachWs(wss);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`WallRush listening on :${PORT} (db: ${dbEnabled ? 'on' : 'off — guest mode'})`);
});
