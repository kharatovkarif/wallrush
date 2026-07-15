// WallRush server: static frontend + REST API + WebSocket game server.
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { attachWs } from './rooms.js';
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

app.get('/healthz', (req, res) => res.send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
attachWs(wss);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`WallRush listening on :${PORT} (db: ${dbEnabled ? 'on' : 'off — guest mode'})`);
});
