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
    const user = await verifyUser(bearer(req));
    const { data: ex } = await supa.from('visitors')
      .select('visits, games').eq('device_id', device).maybeSingle();
    if (ex) {
      await supa.from('visitors').update({
        last_seen: new Date().toISOString(),
        visits: ex.visits + (game ? 0 : 1),
        games: ex.games + (game ? 1 : 0),
        ...(nick ? { last_nick: nick } : {}),
        ...(user ? { user_id: user.id } : {}),
      }).eq('device_id', device);
    } else {
      await supa.from('visitors').insert({
        device_id: device,
        last_nick: nick,
        games: game ? 1 : 0,
        user_id: user ? user.id : null,
      });
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

app.get('/admin', async (req, res) => {
  if ((req.query.key || '') !== ADMIN_KEY) return res.status(404).send('Not found');
  if (!dbEnabled) return res.send('DB is off');
  const { data: rows } = await supa.from('visitors')
    .select('first_seen, last_seen, visits, games, last_nick, user_id')
    .order('last_seen', { ascending: false }).limit(300);
  const { data: profs } = await supa.from('profiles').select('id, nick, wins, losses');
  const byId = new Map((profs || []).map(p => [p.id, p]));
  const all = rows || [];

  const played = all.filter(v => v.games > 0).length;
  const totalGames = all.reduce((s, v) => s + v.games, 0);
  const dayMs = 86400e3;
  const mskDayStart = (t) => Math.floor((t + 3 * 3600e3) / dayMs);
  const today = mskDayStart(Date.now());
  const newToday = all.filter(v => mskDayStart(new Date(v.first_seen).getTime()) === today).length;

  // new devices per day, last 14 days
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const day = today - i;
    const n = all.filter(v => mskDayStart(new Date(v.first_seen).getTime()) === day).length;
    const d = new Date((day * dayMs) - 3 * 3600e3 + 12 * 3600e3);
    days.push({ label: `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`, n });
  }
  const maxDay = Math.max(1, ...days.map(d => d.n));

  const trs = all.map(v => {
    const prof = v.user_id ? byId.get(v.user_id) : null;
    const nick = prof ? prof.nick : (v.last_nick || '—');
    const badge = prof ? '<b style="color:#21c07a">✔ рег.</b>' : '<span style="color:#8892b0">гость</span>';
    const games = v.games > 0 ? `<b>${v.games}</b>` : '<span style="color:#c0392b">0</span>';
    return `<tr><td>${esc(nick)}</td><td>${badge}</td><td>${mskFmt(v.first_seen)}</td><td>${mskFmt(v.last_seen)}</td><td>${v.visits}</td><td>${games}</td></tr>`;
  }).join('');

  const bars = days.map(d =>
    `<div class="bar"><div class="fill" style="height:${Math.round(100 * d.n / maxDay)}%"></div><small>${d.n}</small><span>${d.label}</span></div>`
  ).join('');

  res.send(`<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>WallRush — статистика</title>
<style>
  body { font-family: system-ui, sans-serif; background: #12141f; color: #e8ecf8; margin: 0; padding: 14px; }
  h1 { font-size: 19px; margin: 4px 0 12px; } h2 { font-size: 15px; margin: 20px 0 8px; color: #aab3d0; }
  .cards { display: flex; flex-wrap: wrap; gap: 8px; }
  .c { background: #1c2033; border-radius: 12px; padding: 10px 14px; min-width: 96px; }
  .c b { font-size: 22px; display: block; } .c span { font-size: 11px; color: #8892b0; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #262c42; white-space: nowrap; }
  th { color: #8892b0; font-size: 11px; position: sticky; top: 0; background: #12141f; }
  .wrap { overflow-x: auto; }
  .chart { display: flex; align-items: flex-end; gap: 5px; height: 110px; padding-top: 14px; }
  .bar { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; }
  .bar .fill { width: 100%; background: #2f6df6; border-radius: 4px 4px 0 0; min-height: 2px; }
  .bar small { font-size: 10px; color: #cfd6ee; margin: 2px 0; } .bar span { font-size: 9px; color: #667; }
</style></head><body>
<h1>🧱 WallRush — статистика <span style="font-size:11px;color:#667">(обновляется каждую минуту)</span></h1>
<div class="cards">
  <div class="c"><b>${realOnline()}</b><span>сейчас на сайте (реально)</span></div>
  <div class="c"><b>${realOnline() + fakeOnline()}</b><span>показано «онлайн»</span></div>
  <div class="c"><b>${newToday}</b><span>новых сегодня</span></div>
  <div class="c"><b>${all.length}</b><span>всего людей</span></div>
  <div class="c"><b>${played}</b><span>из них играли</span></div>
  <div class="c"><b>${(profs || []).length}</b><span>с регистрацией</span></div>
  <div class="c"><b>${totalGames}</b><span>партий всего</span></div>
</div>
<h2>Новые люди по дням (14 дней)</h2>
<div class="chart">${bars}</div>
<h2>Журнал: каждый человек (устройство), свежие сверху</h2>
<div class="wrap"><table>
<tr><th>Ник</th><th>Статус</th><th>Первый заход (МСК)</th><th>Последний</th><th>Заходов</th><th>Партий</th></tr>
${trs}
</table></div>
</body></html>`);
});

app.get('/healthz', (req, res) => res.send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
attachWs(wss);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`WallRush listening on :${PORT} (db: ${dbEnabled ? 'on' : 'off — guest mode'})`);
});
