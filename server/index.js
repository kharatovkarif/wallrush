// WallRush server: static frontend + REST API + WebSocket game server.
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { attachWs, realOnline } from './rooms.js';
import { fakeOnline } from './bots.js';
import { RANKS } from '../public/js/ranks.js';
import { checkNick } from '../public/js/nick.js';
import { localDay } from '../public/js/streak.js';
import { initPush, pushPublicKey, saveSub, dropSub, pushTick } from './push.js';
import { dbEnabled, dbStatus, dbDetail, cleanEnv, likeEscape, supa, verifyUser, getProfile, createProfile, leaderboard, clearNickNotice, restoreStreak } from './db.js';

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
    vapid: pushPublicKey(),
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

/* Buys back a streak that was lost, after the player watched an ad for it.
   Guests get this too — they are 94% of players, and a streak on a device is
   the only progress most of them have.

   The client is not trusted with any of it: the day comes from the browser
   only as a timezone offset, and whether the streak is really lost, and
   recently enough, is decided against the stored row. */
app.post('/api/streak/restore', async (req, res) => {
  if (!dbEnabled) return res.status(503).json({ error: 'db_off' });
  const off = Number(req.body?.tz);
  const today = localDay(Number.isFinite(off) && Math.abs(off) <= 840 ? off : 0);
  const user = await verifyUser(bearer(req));
  const device = String(req.body?.device || '');
  const deviceId = /^[A-Za-z0-9-]{8,64}$/.test(device) ? device : null;
  if (!user && !deviceId) return res.status(400).json({ error: 'no_identity' });
  const done = await restoreStreak({ userId: user?.id, deviceId }, today);
  if (!done) return res.status(400).json({ error: 'nothing_to_restore' });
  res.json({ ok: true, streak: done.streak });
});

// A nickname the rules no longer allow is replaced by hand, and the player is
// told why the next time they open the game. This marks the note as read.
app.post('/api/nick-notice/ack', async (req, res) => {
  const user = await verifyUser(bearer(req));
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  await clearNickNotice(user.id);
  res.json({ ok: true });
});

// Create profile with chosen nick (right after signup).
app.post('/api/profile', async (req, res) => {
  const user = await verifyUser(bearer(req));
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const nick = String(req.body?.nick || '').trim();
  const bad = checkNick(nick);
  if (bad) return res.status(400).json({ error: bad === 'format' ? 'nick_bad' : 'nick_' + bad });
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
  const badNick = checkNick(nick);
  if (badNick) return res.status(400).json({ error: badNick === 'format' ? 'nick_bad' : 'nick_' + badNick });

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
    // Where they came from. Written once and never overwritten: the second
    // visit is almost always someone typing the address, and letting that win
    // would relabel every returning player as "direct".
    const rawSrc = String(req.body?.src || '').slice(0, 40).toLowerCase();
    const src = /^[a-z0-9_.:-]{1,40}$/.test(rawSrc) ? rawSrc : null;
    const user = await verifyUser(bearer(req));
    const { data: ex } = await supa.from('visitors')
      .select('visits, games, installed_at, source').eq('device_id', device).maybeSingle();
    if (ex) {
      await supa.from('visitors').update({
        last_seen: new Date().toISOString(),
        visits: ex.visits + (game ? 0 : 1),
        games: ex.games + (game ? 1 : 0),
        ...(nick ? { last_nick: nick } : {}),
        ...(lang ? { lang } : {}),
        ...(tz ? { tz } : {}),
        ...(user ? { user_id: user.id } : {}),
        ...(src && !ex.source ? { source: src } : {}),
        ...(installed && !ex.installed_at ? { installed_at: new Date().toISOString() } : {}),
        ...(installed ? { standalone_at: new Date().toISOString() } : {}), // every launch from the icon
      }).eq('device_id', device);
    } else {
      await supa.from('visitors').insert({
        device_id: device,
        last_nick: nick,
        games: game ? 1 : 0,
        lang, tz, source: src,
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

// Product events worth counting, written into the same journal as visits so
// they inherit its 60-day cleanup. Deliberately a closed list: this endpoint
// is public, and an open one would let anyone fill the table.
const EVENT_KINDS = new Set(['invite_share', 'invite_join']);
app.post('/api/event', async (req, res) => {
  res.json({ ok: true });                       // never block the client
  if (!dbEnabled) return;
  try {
    const device = String(req.body?.device || '');
    const kind = String(req.body?.kind || '');
    if (!EVENT_KINDS.has(kind)) return;
    if (!/^[A-Za-z0-9-]{8,64}$/.test(device)) return;
    await supa.from('visit_log').insert({ device_id: device, kind });
  } catch (e) {
    console.error('event log failed:', e.message);
  }
});

app.post('/api/push/subscribe', async (req, res) => {
  const device = String(req.body?.device || '');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(device)) return res.status(400).json({ error: 'bad_device' });
  const ok = await saveSub(req.body?.sub, {
    deviceId: device,
    tzOffset: Number(req.body?.tz),
    lang: String(req.body?.lang || '').slice(0, 8),
  });
  res.json({ ok });
});

app.post('/api/push/unsubscribe', async (req, res) => {
  await dropSub(String(req.body?.endpoint || ''));
  res.json({ ok: true });
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

// the ladder speaks six languages in the game; this page only needs one
const RANK_RU = {
  rank_rookie: 'Новичок', rank_student: 'Ученик', rank_strategist: 'Стратег',
  rank_master: 'Мастер стен', rank_pro: 'Про', rank_legend: 'Легенда', rank_goat: 'GOAT',
};

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
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; background: #0f111c; color: #e8ecf8; margin: 0; padding: 14px 14px 30px; }
  h1 { font-size: 20px; margin: 4px 0 4px; }
  h2 { font-size: 15px; margin: 22px 0 8px; color: #aab3d0; }
  .sect { font-size: 11px; letter-spacing: .8px; text-transform: uppercase; color: #6d7796; margin: 16px 0 7px; }
  a { color: #6d9bf8; text-decoration: none; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
  .c { background: #191d2e; border: 1px solid #232842; border-radius: 14px; padding: 11px 13px; }
  .c b { font-size: 23px; display: block; line-height: 1.15; }
  .c span { font-size: 11px; color: #8892b0; display: block; margin-top: 2px; }
  .c.hi b { color: #4d8dff; } .c.good b { color: #21c07a; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid #232842; white-space: nowrap; }
  th { color: #8892b0; font-size: 11px; position: sticky; top: 0; background: #0f111c; }
  tr.click { cursor: pointer; } tr.click:active { background: #191d2e; }
  .wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .chart { display: flex; align-items: flex-end; gap: 5px; height: 120px; padding-top: 14px; }
  .bar { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; }
  .bar .fill { width: 100%; background: linear-gradient(180deg, #5b8cff, #2f6df6); border-radius: 5px 5px 0 0; min-height: 2px; }
  .bar small { font-size: 10px; color: #cfd6ee; margin: 3px 0 1px; } .bar span { font-size: 9px; color: #667; }
  .tabs { display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap; }
  .tabs a { background: #191d2e; border: 1px solid #232842; border-radius: 11px; padding: 8px 13px; font-size: 13px; color: #cfd6ee; }
  .tabs a.on { background: #2f6df6; border-color: #2f6df6; color: #fff; font-weight: 600; }
  .person { background: #191d2e; border: 1px solid #232842; border-radius: 14px; padding: 14px; margin-bottom: 12px; }
  .person b.nick { font-size: 20px; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; margin-top: 10px; font-size: 13px; }
  .kv span { color: #8892b0; }
  .back { display: inline-block; margin-bottom: 10px; font-size: 14px; }
  /* day rows */
  .dayrow { display: flex; align-items: center; gap: 10px; background: #191d2e; border: 1px solid #232842;
            border-radius: 13px; padding: 12px 14px; margin-bottom: 8px; }
  .dayrow .d { font-size: 15px; font-weight: 700; min-width: 74px; }
  .dayrow .m { display: flex; gap: 16px; flex: 1; flex-wrap: wrap; }
  .dayrow .m i { font-style: normal; font-size: 11px; color: #8892b0; display: block; }
  .dayrow .m u { text-decoration: none; font-size: 15px; font-weight: 600; }
  .dayrow .go { color: #6d9bf8; font-size: 20px; }
  /* country rows */
  .geo { background: #191d2e; border: 1px solid #232842; border-radius: 13px; padding: 11px 13px; margin-bottom: 7px; }
  .geo .top { display: flex; align-items: baseline; gap: 8px; }
  .geo .name { font-size: 14px; font-weight: 600; flex: 1; }
  .geo .pct { font-size: 15px; font-weight: 700; color: #4d8dff; }
  .geo .num { font-size: 11px; color: #8892b0; margin-left: 6px; }
  .geo .track { height: 6px; background: #232842; border-radius: 4px; margin-top: 7px; overflow: hidden; }
  .geo .track i { display: block; height: 100%; background: linear-gradient(90deg, #5b8cff, #2f6df6); border-radius: 4px; }
  .note { color: #6d7796; font-size: 12px; line-height: 1.6; }`;

const nowMskHms = () => {
  const d = new Date(Date.now() + 3 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};
const adminPage = (title, body) => `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#12141f">
<meta http-equiv="refresh" content="60">
<meta http-equiv="Cache-Control" content="no-store">
<title>${title}</title><style>${ADMIN_CSS}</style></head><body>${body}
<p style="text-align:center;color:#5b6480;font-size:12px;margin:18px 0 6px">🕐 обновлено в ${nowMskHms()} МСК · страница сама обновляется раз в минуту</p>
</body></html>`;

// display name for a visitor row: 📲 = installed the game as an app
// installed but hasn't launched from the icon for a week while still visiting
// in the browser → most likely removed the app (the platform gives no direct
// uninstall signal, this is the honest best guess)
const maybeDeleted = (v) => Boolean(v.installed_at) &&
  (!v.standalone_at || (Date.now() - new Date(v.standalone_at).getTime() > 7 * dayMs &&
    new Date(v.last_seen).getTime() > new Date(v.standalone_at).getTime()));

/* The browser gives us a timezone, not a country, so map the common zones to
   a country name. Anything unknown falls back to the zone's own city. */
const COUNTRY_BY_TZ = {
  'Asia/Tehran': '🇮🇷 Иран',
  'Asia/Calcutta': '🇮🇳 Индия', 'Asia/Kolkata': '🇮🇳 Индия',
  'Asia/Tashkent': '🇺🇿 Узбекистан', 'Asia/Samarkand': '🇺🇿 Узбекистан',
  'Europe/Istanbul': '🇹🇷 Турция', 'Asia/Istanbul': '🇹🇷 Турция',
  'Asia/Dushanbe': '🇹🇯 Таджикистан',
  'Asia/Bishkek': '🇰🇬 Киргизия',
  'Asia/Ashgabat': '🇹🇲 Туркменистан',
  'Asia/Baku': '🇦🇿 Азербайджан', 'Asia/Yerevan': '🇦🇲 Армения', 'Asia/Tbilisi': '🇬🇪 Грузия',
  'Europe/Kiev': '🇺🇦 Украина', 'Europe/Kyiv': '🇺🇦 Украина', 'Europe/Uzhgorod': '🇺🇦 Украина', 'Europe/Zaporozhye': '🇺🇦 Украина',
  'Europe/Minsk': '🇧🇾 Беларусь',
  'Europe/Chisinau': '🇲🇩 Молдова', 'Europe/Tiraspol': '🇲🇩 Молдова',
  'Asia/Baghdad': '🇮🇶 Ирак', 'Asia/Kabul': '🇦🇫 Афганистан', 'Asia/Karachi': '🇵🇰 Пакистан',
  'Asia/Dhaka': '🇧🇩 Бангладеш', 'Asia/Kathmandu': '🇳🇵 Непал', 'Asia/Colombo': '🇱🇰 Шри-Ланка',
  'Asia/Dubai': '🇦🇪 ОАЭ', 'Asia/Riyadh': '🇸🇦 Саудовская Аравия', 'Asia/Qatar': '🇶🇦 Катар',
  'Asia/Kuwait': '🇰🇼 Кувейт', 'Asia/Muscat': '🇴🇲 Оман', 'Asia/Bahrain': '🇧🇭 Бахрейн',
  'Asia/Amman': '🇯🇴 Иордания', 'Asia/Beirut': '🇱🇧 Ливан', 'Asia/Damascus': '🇸🇾 Сирия',
  'Asia/Jerusalem': '🇮🇱 Израиль', 'Asia/Tel_Aviv': '🇮🇱 Израиль',
  'Asia/Tokyo': '🇯🇵 Япония', 'Asia/Seoul': '🇰🇷 Южная Корея', 'Asia/Shanghai': '🇨🇳 Китай',
  'Asia/Hong_Kong': '🇭🇰 Гонконг', 'Asia/Taipei': '🇹🇼 Тайвань',
  'Asia/Jakarta': '🇮🇩 Индонезия', 'Asia/Manila': '🇵🇭 Филиппины', 'Asia/Bangkok': '🇹🇭 Таиланд',
  'Asia/Ho_Chi_Minh': '🇻🇳 Вьетнам', 'Asia/Saigon': '🇻🇳 Вьетнам',
  'Asia/Kuala_Lumpur': '🇲🇾 Малайзия', 'Asia/Singapore': '🇸🇬 Сингапур',
  'Africa/Cairo': '🇪🇬 Египет', 'Africa/Algiers': '🇩🇿 Алжир', 'Africa/Casablanca': '🇲🇦 Марокко',
  'Africa/Tunis': '🇹🇳 Тунис', 'Africa/Tripoli': '🇱🇾 Ливия', 'Africa/Lagos': '🇳🇬 Нигерия',
  'Africa/Nairobi': '🇰🇪 Кения', 'Africa/Johannesburg': '🇿🇦 ЮАР', 'Africa/Khartoum': '🇸🇩 Судан',
  'Europe/London': '🇬🇧 Великобритания', 'Europe/Dublin': '🇮🇪 Ирландия',
  'Europe/Berlin': '🇩🇪 Германия', 'Europe/Paris': '🇫🇷 Франция', 'Europe/Madrid': '🇪🇸 Испания',
  'Europe/Rome': '🇮🇹 Италия', 'Europe/Lisbon': '🇵🇹 Португалия', 'Europe/Amsterdam': '🇳🇱 Нидерланды',
  'Europe/Brussels': '🇧🇪 Бельгия', 'Europe/Vienna': '🇦🇹 Австрия', 'Europe/Zurich': '🇨🇭 Швейцария',
  'Europe/Warsaw': '🇵🇱 Польша', 'Europe/Prague': '🇨🇿 Чехия', 'Europe/Budapest': '🇭🇺 Венгрия',
  'Europe/Bucharest': '🇷🇴 Румыния', 'Europe/Sofia': '🇧🇬 Болгария', 'Europe/Athens': '🇬🇷 Греция',
  'Europe/Stockholm': '🇸🇪 Швеция', 'Europe/Oslo': '🇳🇴 Норвегия', 'Europe/Helsinki': '🇫🇮 Финляндия',
  'Europe/Copenhagen': '🇩🇰 Дания', 'Europe/Belgrade': '🇷🇸 Сербия', 'Europe/Zagreb': '🇭🇷 Хорватия',
  'Europe/Vilnius': '🇱🇹 Литва', 'Europe/Riga': '🇱🇻 Латвия', 'Europe/Tallinn': '🇪🇪 Эстония',
  'America/Sao_Paulo': '🇧🇷 Бразилия', 'America/Bahia': '🇧🇷 Бразилия', 'America/Fortaleza': '🇧🇷 Бразилия',
  'America/Recife': '🇧🇷 Бразилия', 'America/Manaus': '🇧🇷 Бразилия', 'America/Belem': '🇧🇷 Бразилия',
  'America/Mexico_City': '🇲🇽 Мексика', 'America/Bogota': '🇨🇴 Колумбия', 'America/Lima': '🇵🇪 Перу',
  'America/Santiago': '🇨🇱 Чили', 'America/Caracas': '🇻🇪 Венесуэла',
  'America/Argentina/Buenos_Aires': '🇦🇷 Аргентина', 'America/Buenos_Aires': '🇦🇷 Аргентина',
  'America/Toronto': '🇨🇦 Канада', 'America/Vancouver': '🇨🇦 Канада', 'America/Edmonton': '🇨🇦 Канада',
  'America/Winnipeg': '🇨🇦 Канада', 'America/Halifax': '🇨🇦 Канада',
  'Australia/Sydney': '🇦🇺 Австралия', 'Australia/Melbourne': '🇦🇺 Австралия',
  'Australia/Brisbane': '🇦🇺 Австралия', 'Australia/Perth': '🇦🇺 Австралия',
  'Pacific/Auckland': '🇳🇿 Новая Зеландия',
};
// whole-country zone families that would be tedious to list one by one
const TZ_PREFIX_COUNTRY = [
  [/^Asia\/(Almaty|Qostanay|Kostanay|Aqtobe|Aktobe|Aqtau|Aktau|Atyrau|Oral|Qyzylorda|Kyzylorda)$/, '🇰🇿 Казахстан'],
  [/^America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Detroit|Anchorage|Boise|Indiana|Kentucky|Juneau|Nome|Sitka|Adak|Menominee|North_Dakota)/, '🇺🇸 США'],
  [/^Pacific\/(Honolulu)$/, '🇺🇸 США'],
  [/^Europe\/(Moscow|Kaliningrad|Samara|Volgograd|Saratov|Astrakhan|Kirov|Ulyanovsk)$/, '🇷🇺 Россия'],
  [/^Asia\/(Yekaterinburg|Omsk|Novosibirsk|Barnaul|Tomsk|Novokuznetsk|Krasnoyarsk|Irkutsk|Chita|Yakutsk|Khandyga|Vladivostok|Ust-Nera|Magadan|Sakhalin|Srednekolymsk|Kamchatka|Anadyr)$/, '🇷🇺 Россия'],
];
function countryOf(tz) {
  if (!tz) return '🏳️ Неизвестно';
  if (COUNTRY_BY_TZ[tz]) return COUNTRY_BY_TZ[tz];
  for (const [re, name] of TZ_PREFIX_COUNTRY) if (re.test(tz)) return name;
  return '🌍 ' + String(tz).split('/').pop().replace(/_/g, ' ');
}

const visName = (v, byId) => {
  const prof = v.user_id ? byId.get(v.user_id) : null;
  const base = prof ? prof.nick : (v.last_nick || '—');
  return (v.installed_at ? (maybeDeleted(v) ? '📲❓ ' : '📲 ') : '') + base;
};

app.get('/admin', async (req, res) => {
  if ((req.query.key || '') !== ADMIN_KEY) return res.status(404).send('Not found');
  if (!dbEnabled) return res.send('DB is off');
  const { data: profs } = await supa.from('profiles').select('id, nick, wins, losses');
  const byId = new Map((profs || []).map(p => [p.id, p]));

  // every headline number is counted in the DB — never from a fetched page
  const today = mskDayStart(Date.now());
  const todayStartIso = new Date(today * dayMs - 3 * 3600e3).toISOString();
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
  const [totalGames, gamesToday] = await Promise.all([
    cnt(supa.from('visit_log').select('*', { count: 'exact', head: true }).eq('kind', 'game')),
    cnt(supa.from('visit_log').select('*', { count: 'exact', head: true }).eq('kind', 'game').gte('at', todayStartIso)),
  ]);

  // ---- the three things shipped this week, none of which were measurable ----
  // A streak counts as alive if it was touched today or yesterday; anything
  // older is a broken run still sitting in the row.
  const dayAgoIso = new Date(Date.now() - dayMs).toISOString().slice(0, 10);
  const [
    streakAliveN, streak3, streak7, streakTopRow,
    invShareToday, invJoinToday, invShareWeek, invJoinWeek,
  ] = await Promise.all([
    cnt(supa.from('visitors').select('*', { count: 'exact', head: true }).gte('streak_day', dayAgoIso).gt('streak', 0)),
    cnt(supa.from('visitors').select('*', { count: 'exact', head: true }).gte('streak_day', dayAgoIso).gte('streak', 3)),
    cnt(supa.from('visitors').select('*', { count: 'exact', head: true }).gte('streak_day', dayAgoIso).gte('streak', 7)),
    supa.from('visitors').select('streak_best').order('streak_best', { ascending: false }).limit(1).maybeSingle(),
    cnt(supa.from('visit_log').select('*', { count: 'exact', head: true }).eq('kind', 'invite_share').gte('at', todayStartIso)),
    cnt(supa.from('visit_log').select('*', { count: 'exact', head: true }).eq('kind', 'invite_join').gte('at', todayStartIso)),
    cnt(supa.from('visit_log').select('*', { count: 'exact', head: true }).eq('kind', 'invite_share').gte('at', new Date(Date.now() - 7 * dayMs).toISOString())),
    cnt(supa.from('visit_log').select('*', { count: 'exact', head: true }).eq('kind', 'invite_join').gte('at', new Date(Date.now() - 7 * dayMs).toISOString())),
  ]);
  const bestStreak = streakTopRow?.data?.streak_best || 0;

  // Rank spread. The leaderboard ranks guests, registered accounts and bots
  // together, so counting only guests here made a real GOAT show up as zero.
  // Bots are counted apart: they belong on the leaderboard but not in a
  // headline about how the audience is doing.
  const rankBand = (table, r, i, extra) => {
    const next = RANKS[i + 1];
    let q = supa.from(table).select('*', { count: 'exact', head: true }).gte('points', r.min);
    if (next) q = q.lt('points', next.min);
    if (extra) q = extra(q);
    return cnt(q);
  };
  const [guestBands, accountBands, botBands] = await Promise.all([
    // guests who never played are not "Rookies", they are visitors — exclude them
    Promise.all(RANKS.map((r, i) => rankBand('visitors', r, i, (q) => q.gt('games', 0)))),
    Promise.all(RANKS.map((r, i) => rankBand('profiles', r, i))),
    Promise.all(RANKS.map((r, i) => rankBand('bot_players', r, i))),
  ]);
  const rankCounts = RANKS.map((_, i) => guestBands[i] + accountBands[i]);
  const botTotal = botBands.reduce((a, b) => a + b, 0);
  const ranked = rankCounts.reduce((a, b) => a + b, 0) - (rankCounts[0] || 0);

  // new people per MSK day, counted IN the database — the 500-row journal fetch
  // above must never be used for these numbers (it silently truncates them)
  const { data: npd } = await supa.rpc('new_per_day', {
    from_ts: new Date((today - 13) * dayMs - 3 * 3600e3).toISOString(),
  });
  const npdMap = new Map((npd || []).map(r => [Number(r.day), Number(r.n)]));

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
      const fresh = npdMap.get(day) || 0;      // exact, straight from the DB
      if (!rec && !fresh) continue;
      blocks.push(`<a class="dayrow" href="/admin/day?key=${ADMIN_KEY}&day=${day}">
        <span class="d">${mskDayLabel(day)}${day === today ? ' <span style="color:#21c07a;font-size:11px">сегодня</span>' : ''}</span>
        <span class="m">
          <span><i>Новых</i><u style="color:#4d8dff">${fresh}</u></span>
          <span><i>Заходили</i><u>${rec ? rec.people : '—'}</u></span>
          <span><i>Партий</i><u>${rec ? rec.games : '—'}</u></span>
        </span>
        <span class="go">›</span>
      </a>`);
    }
    content = `<h2>По дням — нажми на день, чтобы увидеть по часам</h2>` +
      (blocks.join('') || '<p class="note">Подневная история пишется с 19.07 — строки появятся по мере заходов.</p>');
  } else if (view === 'geo') {
    // ----- countries: share of the audience, aggregated in the DB -----
    const period = String(req.query.p || 'all');
    const fromTs = period === 'today' ? todayStartIso
      : period === 'week' ? new Date(Date.now() - 7 * dayMs).toISOString() : null;
    const { data: tzRows } = await supa.rpc('admin_timezones', { from_ts: fromTs });
    const agg = new Map();                     // country -> { people, games }
    for (const r of (tzRows || [])) {
      const name = countryOf(r.tz);
      const cur = agg.get(name) || { people: 0, games: 0 };
      cur.people += Number(r.people) || 0;
      cur.games += Number(r.games) || 0;
      agg.set(name, cur);
    }
    const list = [...agg.entries()].map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.people - a.people);
    const sum = list.reduce((s, c) => s + c.people, 0) || 1;
    const pTab = (id, label) =>
      `<a class="${period === id ? 'on' : ''}" href="/admin?key=${ADMIN_KEY}&view=geo&p=${id}">${label}</a>`;
    const rowsHtml = list.slice(0, 30).map(c => {
      const pct = (100 * c.people / sum);
      return `<div class="geo">
        <div class="top">
          <span class="name">${esc(c.name)}</span>
          <span class="pct">${pct.toFixed(1)}%</span>
        </div>
        <div class="track"><i style="width:${Math.max(1, pct).toFixed(1)}%"></i></div>
        <div class="num">${c.people.toLocaleString('ru')} чел. · ${c.games.toLocaleString('ru')} партий</div>
      </div>`;
    }).join('');
    const rest = list.slice(30).reduce((s, c) => s + c.people, 0);
    content = `<h2>Откуда игроки — ${list.length} стран</h2>
<div class="tabs">${pTab('all', 'За всё время')}${pTab('week', 'За 7 дней')}${pTab('today', 'Сегодня')}</div>
${rowsHtml || '<p class="note">Пока нет данных за этот период.</p>'}
${rest ? `<p class="note">+ ещё ${rest.toLocaleString('ru')} чел. из остальных стран</p>` : ''}
<p class="note">Страна определяется по часовому поясу устройства — это близко к правде, но не паспорт: через VPN человек может выглядеть как из другой страны.</p>`;
  } else if (view === 'src') {
    /* ----- where the traffic comes from -----
       Arrivals alone decide nothing, so each channel is shown with what
       happened after the click: how many started a game at all, and how many
       were still here the next day. A channel that lands 10 000 people who
       bounce is worth less than one that lands 500 who stay, and only these
       three columns side by side make that visible. */
    const period = String(req.query.p || 'week');
    const fromTs = period === 'today' ? todayStartIso
      : period === 'week' ? new Date(Date.now() - 7 * dayMs).toISOString() : null;
    const { data: srcRows } = await supa.rpc('admin_sources', { from_ts: fromTs });
    const list = (srcRows || []).map(r => ({
      name: r.source, people: Number(r.people) || 0,
      played: Number(r.played) || 0, kept: Number(r.kept) || 0, games: Number(r.games) || 0,
    }));
    const sum = list.reduce((s, c) => s + c.people, 0) || 1;
    const pTab = (id, label) =>
      `<a class="${period === id ? 'on' : ''}" href="/admin?key=${ADMIN_KEY}&view=src&p=${id}">${label}</a>`;
    const rowsHtml = list.map(c => {
      const pct = 100 * c.people / sum;
      const pPlayed = c.people ? Math.round(100 * c.played / c.people) : 0;
      const pKept = c.people ? Math.round(100 * c.kept / c.people) : 0;
      return `<div class="geo">
        <div class="top">
          <span class="name">${esc(c.name)}</span>
          <span class="pct">${pct.toFixed(1)}%</span>
        </div>
        <div class="track"><i style="width:${Math.max(1, pct).toFixed(1)}%"></i></div>
        <div class="num">${c.people.toLocaleString('ru')} чел. · сыграли ${pPlayed}% · вернулись ${pKept}% · ${c.games.toLocaleString('ru')} партий</div>
      </div>`;
    }).join('');
    content = `<h2>Откуда приходят игроки</h2>
<div class="tabs">${pTab('all', 'За всё время')}${pTab('week', 'За 7 дней')}${pTab('today', 'Сегодня')}</div>
${rowsHtml || '<p class="note">Пока нет данных за этот период.</p>'}
<p class="note"><b>Метки для ссылок.</b> В каждой соцсети ставь свою — тогда строки ниже перестанут быть «не размечено»:<br>
wallrush.online/?f=ig — Instagram · /?f=tt — TikTok · /?f=yt — YouTube · /?f=fb — Facebook · /?f=tg — Telegram<br>
Метка запоминается при первом заходе и больше не меняется, поэтому вернувшийся игрок остаётся за своим каналом. Без метки источник определяется по тому, кто прислал — это ловит Google и сайты, но не соцсети: они ссылку прячут.</p>
<p class="note">«Сыграли» — начали хотя бы одну партию. «Вернулись» — заходили ещё через сутки после первого раза. Смотреть надо на них, а не на количество: канал, который приводит толпу, ничего не стоит, если из неё никто не играет.</p>`;
  } else {
    // ----- people view: journal, filtered and paged IN the database so the
    // filters and counts apply to everyone, not just the first page -----
    const f = String(req.query.f || 'all');
    const q = String(req.query.q || '').trim().slice(0, 40);
    const PAGE = 100;
    const page = Math.max(1, parseInt(String(req.query.pg || '1'), 10) || 1);

    const applyFilter = (sel) => {
      let x = sel;
      if (f === 'played') x = x.gt('games', 0);
      else if (f === 'zero') x = x.eq('games', 0);
      else if (f === 'inst') x = x.not('installed_at', 'is', null);
      else if (f === 'reg') x = x.not('user_id', 'is', null);
      if (q) x = x.ilike('last_nick', `%${likeEscape(q)}%`);
      return x;
    };
    const [{ count: found }, { data: pageRows }] = await Promise.all([
      applyFilter(supa.from('visitors').select('*', { count: 'exact', head: true })),
      applyFilter(supa.from('visitors')
        .select('device_id, first_seen, last_seen, visits, games, last_nick, user_id, lang, tz, installed_at, standalone_at'))
        .order('last_seen', { ascending: false })
        .range((page - 1) * PAGE, page * PAGE - 1),
    ]);
    const total = found || 0;
    const pages = Math.max(1, Math.ceil(total / PAGE));
    const link = (o = {}) => {
      const p = { key: ADMIN_KEY, view: 'people', f, ...(q ? { q } : {}), ...o };
      return '/admin?' + Object.entries(p).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    };
    const tab = (id, label, n) =>
      `<a class="${f === id ? 'on' : ''}" href="${link({ f: id, pg: 1 })}">${label} (${Number(n).toLocaleString('ru')})</a>`;
    const trs = (pageRows || []).map(v => {
      const prof = v.user_id ? byId.get(v.user_id) : null;
      const badge = prof ? '<b style="color:#21c07a">✔ рег.</b>' : '<span style="color:#8892b0">гость</span>';
      const games = v.games > 0 ? `<b>${v.games}</b>` : '<span style="color:#c0392b">0</span>';
      const href = `/admin/v?key=${ADMIN_KEY}&d=${encodeURIComponent(v.device_id)}`;
      return `<tr class="click" onclick="location.href='${href}'"><td>${esc(visName(v, byId))} ›</td><td>${badge}</td><td>${esc(countryOf(v.tz))}</td><td>${mskFmt(v.first_seen)}</td><td>${mskFmt(v.last_seen)}</td><td>${v.visits}</td><td>${games}</td><td>${esc(v.lang || '—')}</td></tr>`;
    }).join('') || '<tr><td colspan="8" style="color:#8892b0">Никого не нашлось</td></tr>';

    const pager = pages > 1 ? `<div class="tabs" style="margin-top:12px">
      ${page > 1 ? `<a href="${link({ pg: page - 1 })}">‹ Назад</a>` : ''}
      <a class="on">${page} из ${pages}</a>
      ${page < pages ? `<a href="${link({ pg: page + 1 })}">Дальше ›</a>` : ''}
    </div>` : '';

    content = `
<h2>Люди — нажми на человека, чтобы увидеть его историю (📲 = установил приложение)</h2>
<form method="get" action="/admin" style="margin:10px 0">
  <input type="hidden" name="key" value="${ADMIN_KEY}"><input type="hidden" name="view" value="people">
  <input type="hidden" name="f" value="${esc(f)}">
  <input name="q" value="${esc(q)}" placeholder="Поиск по нику…" autocomplete="off"
    style="width:100%;max-width:340px;padding:10px 13px;border-radius:11px;border:1px solid #232842;background:#191d2e;color:#e8ecf8;font-size:14px">
</form>
<div class="tabs">
  ${tab('all', 'Все', totalPeople)}
  ${tab('played', '🎮 Играли', played)}
  ${tab('zero', '👀 Только смотрели', totalPeople - played)}
  ${tab('inst', '📲 Установили', installs)}
  ${tab('reg', '✔ Регистрация', regs)}
</div>
<p class="note">${q ? `Найдено: ${total.toLocaleString('ru')}` : `Всего в этом фильтре: ${total.toLocaleString('ru')}`} · показано по ${PAGE} на странице</p>
<div class="wrap"><table>
<tr><th>Ник</th><th>Статус</th><th>Страна</th><th>Первый заход (МСК)</th><th>Последний</th><th>Заходов</th><th>Партий</th><th>Язык</th></tr>
${trs}
</table></div>
${pager}`;
  }

  const days = [];
  for (let i = 13; i >= 0; i--) {
    const day = today - i;
    days.push({ label: mskDayLabel(day), n: npdMap.get(day) || 0 });
  }
  const maxDay = Math.max(1, ...days.map(d => d.n));
  const bars = days.map(d =>
    `<div class="bar"><div class="fill" style="height:${Math.round(100 * d.n / maxDay)}%"></div><small>${d.n}</small><span>${d.label}</span></div>`
  ).join('');

  const num = (n) => Number(n || 0).toLocaleString('ru');
  // yesterday, so today's numbers have something to be compared against
  const yesterday = npdMap.get(today - 1) || 0;
  const trend = yesterday
    ? (newToday >= yesterday
        ? `<span style="color:#21c07a">▲ +${Math.round(100 * (newToday - yesterday) / yesterday)}%</span>`
        : `<span style="color:#e06">▼ −${Math.round(100 * (yesterday - newToday) / yesterday)}%</span>`)
    : '';

  res.send(adminPage('WallRush — статистика', `
<h1>🧱 WallRush — статистика</h1>
<p class="note" style="margin:0 0 4px">Всё время московское. Страница сама обновляется.</p>

<p class="sect">🟢 Прямо сейчас</p>
<div class="cards">
  <div class="c good"><b>${num(realOnline())}</b><span>на сайте (реально)</span></div>
  <div class="c"><b>${num(realOnline() + fakeOnline())}</b><span>показано «онлайн»</span></div>
</div>

<p class="sect">📅 Сегодня ${trend ? '· к вчера ' + trend : ''}</p>
<div class="cards">
  <div class="c hi"><b>${num(newToday)}</b><span>новых людей</span></div>
  <div class="c"><b>${num(activeToday)}</b><span>заходили</span></div>
  <div class="c"><b>${num(gamesToday)}</b><span>партий сыграно</span></div>
  <div class="c"><b>${num(humansToday)}</b><span>🤝 живой vs живой</span></div>
</div>

<p class="sect">📊 За всё время</p>
<div class="cards">
  <div class="c"><b>${num(totalPeople)}</b><span>всего людей</span></div>
  <div class="c"><b>${num(totalGames)}</b><span>партий всего</span></div>
  <div class="c"><b>${num(humansTotal)}</b><span>🤝 живых матчей</span></div>
  <div class="c"><b>${num(installs)}</b><span>📲 установили</span></div>
  <div class="c"><b>${num(regs)}</b><span>✔ регистраций</span></div>
  <div class="c"><b>${num(played)}</b><span>🎮 играли хоть раз</span></div>
</div>

<p class="sect">🔥 Серии дней <span class="note" style="font-weight:400">— живая = играл сегодня или вчера</span></p>
<div class="cards">
  <div class="c hi"><b>${num(streakAliveN)}</b><span>живых серий</span></div>
  <div class="c"><b>${num(streak3)}</b><span>3 дня и больше</span></div>
  <div class="c"><b>${num(streak7)}</b><span>неделя и больше</span></div>
  <div class="c"><b>${num(bestStreak)}</b><span>рекорд серии</span></div>
</div>

<p class="sect">🔗 Приглашения по ссылке</p>
<div class="cards">
  <div class="c hi"><b>${num(invShareToday)}</b><span>позвали сегодня</span></div>
  <div class="c good"><b>${num(invJoinToday)}</b><span>пришли сегодня</span></div>
  <div class="c"><b>${num(invShareWeek)}</b><span>позвали за неделю</span></div>
  <div class="c"><b>${num(invJoinWeek)}</b><span>пришли за неделю</span></div>
</div>
<p class="note">${invShareWeek
  ? `За неделю: ${num(invShareWeek)} отправлено · ${num(invJoinWeek)} переходов по ссылкам — ${(invJoinWeek / invShareWeek).toFixed(1)} перехода на приглашение. Одну ссылку могут открыть несколько человек, поэтому переходов бывает больше, чем приглашений.`
  : 'Пока никто не отправлял приглашений.'}</p>

<p class="sect">🏆 Звания <span class="note" style="font-weight:400">— ${num(ranked)} человек выбрались из Новичка</span></p>
<div class="cards">
  ${RANKS.map((r, i) => `<div class="c"><b>${num(rankCounts[i])}</b><span>${r.icon} ${RANK_RU[r.key] || r.key}</span></div>`).join('')}
</div>
<p class="note">Считаются живые игроки — гости, сыгравшие хотя бы раз, и владельцы аккаунтов. В таблице лидеров вместе с ними стоят ${num(botTotal)} ботов, здесь они не учтены.</p>

<h2>Новые люди по дням (14 дней)</h2>
<div class="chart">${bars}</div>

<div class="tabs" style="margin-top:18px">
  ${viewTab('people', '👥 Люди')}
  ${viewTab('days', '📅 По дням')}
  ${viewTab('geo', '🌍 Страны')}
  ${viewTab('src', '📈 Источники')}
</div>
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
  // day totals and new-people count come from DB aggregates — counting fetched
  // rows here silently truncated the numbers (11 355 visitors showed as ~500)
  const [{ data: dayBk }, { data: npdDay }] = await Promise.all([
    supa.rpc('admin_buckets', { from_ts: startIso, to_ts: endIso, bucket_secs: 86400, offset_secs: 10800 }),
    supa.rpc('new_per_day', { from_ts: startIso }),
  ]);
  const dayDevices = Number(dayBk?.[0]?.people || 0);
  const fresh = Number((npdDay || []).find(r => Number(r.day) === day)?.n || 0);

  const hours = Array.from({ length: 24 }, () => ({ people: 0, games: 0 }));
  let dayGames = 0;
  for (const b of (hbk || [])) {
    const h = Number(b.bucket) % 24;
    hours[h] = { people: Number(b.people), games: Number(b.games) };
    dayGames += Number(b.games);
  }
  const peakHour = hours.reduce((best, x, h) => (x.people > hours[best].people ? h : best), 0);
  const trs = hours.map((x, h) => {
    const dim = x.people === 0 && x.games === 0;
    const href = `/admin/hour?key=${ADMIN_KEY}&day=${day}&h=${h}`;
    return `<tr class="click"${dim ? ' style="opacity:.35"' : ''} onclick="location.href='${href}'"><td>${String(h).padStart(2, '0')}:00 ›</td><td>${x.people ? `<b>${x.people}</b>` : 0}</td><td>${x.games ? `<b>${x.games}</b>` : 0}</td></tr>`;
  }).join('');
  const n = (x) => Number(x || 0).toLocaleString('ru');
  res.send(adminPage(`${mskDayLabel(day)} — WallRush`, `
<a class="back" href="/admin?key=${ADMIN_KEY}&view=days">‹ Назад к дням</a>
<h1>${mskDayLabel(day)}${day === mskDayStart(Date.now()) ? ' — сегодня' : ''}</h1>
<div class="cards">
  <div class="c hi"><b>${n(fresh)}</b><span>новых людей</span></div>
  <div class="c"><b>${n(dayDevices)}</b><span>заходили</span></div>
  <div class="c"><b>${n(dayGames)}</b><span>партий</span></div>
  <div class="c"><b>${String(peakHour).padStart(2, '0')}:00</b><span>пик посещений</span></div>
</div>
<h2>По часам (МСК) — нажми на час, чтобы увидеть людей</h2>
<div class="wrap"><table><tr><th>Час</th><th>Людей</th><th>Партий</th></tr>${trs}</table></div>`));
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
  // exact hour total from the DB aggregate; the device list below is only for
  // showing who was here and is deliberately capped
  const [{ data: hourBk }, { data: devs }] = await Promise.all([
    supa.rpc('admin_buckets', { from_ts: startIso, to_ts: endIso, bucket_secs: 3600, offset_secs: 10800 }),
    supa.rpc('admin_devices', { from_ts: startIso, to_ts: endIso }),
  ]);
  const hourDevices = Number(hourBk?.[0]?.people || 0);
  const shownDevs = (devs || []).slice(0, 150).map(d => d.device_id);
  const { data: rows } = shownDevs.length
    ? await supa.from('visitors')
        .select('device_id, last_nick, user_id, installed_at, standalone_at').in('device_id', shownDevs)
    : { data: [] };
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
  const hh = String(h).padStart(2, '0');
  const trs = mins.map((x, m) => {
    const dim = x.people === 0 && x.games === 0;
    return `<tr${dim ? ' style="opacity:.3"' : ''}><td>${hh}:${String(m).padStart(2, '0')}</td><td>${x.people ? `<b>${x.people}</b>` : 0}</td><td>${x.games ? `<b>${x.games}</b>` : 0}</td></tr>`;
  }).join('');
  const people = shownDevs.map(id => byDevice.get(id)).filter(Boolean).map(v =>
    `<a href="/admin/v?key=${ADMIN_KEY}&d=${encodeURIComponent(v.device_id)}">${esc(visName(v, byId))}</a>`).join(', ') || '—';

  res.send(adminPage(`${mskDayLabel(day)} ${hh}:00 — WallRush`, `
<a class="back" href="/admin/day?key=${ADMIN_KEY}&day=${day}">‹ Назад ко дню ${mskDayLabel(day)}</a>
<div class="person">
  <b>${mskDayLabel(day)}, час ${hh}:00–${hh}:59 (МСК)</b>
  <div class="kv">
    <span>Людей за час</span><b>${hourDevices.toLocaleString('ru')}</b>
    <span>Партий за час</span><b>${hourGames.toLocaleString('ru')}</b>
  </div>
</div>
<h2>По минутам</h2>
<div class="wrap"><table><tr><th>Минута</th><th>Людей</th><th>Партий</th></tr>${trs}</table></div>
<h2>Кто был в этот час (нажми на ник)</h2>
<p style="font-size:13px;line-height:1.9">${people}</p>
${hourDevices > shownDevs.length ? `<p class="note">Показаны первые ${shownDevs.length} из ${hourDevices.toLocaleString('ru')} — полный список ищи во вкладке «Люди».</p>` : ''}`));
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
  initPush();
  // Hourly, so every timezone gets its own evening. The tick decides who is
  // due; most hours it finds nobody and does nothing.
  setInterval(() => pushTick(realOnline() + fakeOnline()), 60 * 60 * 1000);
});
