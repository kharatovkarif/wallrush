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
import { dbEnabled, dbStatus, dbDetail, cleanEnv, likeEscape, supa, verifyUser, getProfile, createProfile, claimGuestProgress, leaderboard, clearNickNotice, restoreStreak } from './db.js';

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
// The device id as the client reports it, or '' when it is not a device id at
// all. Same shape the visitor log accepts, checked in one place so neither
// signup route has to trust the body.
const deviceOf = (req) => {
  const d = String(req.body?.device || '');
  return /^[A-Za-z0-9-]{8,64}$/.test(d) ? d : '';
};

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
  // the guest who has been playing on this device is the person who just
  // signed up: their points and streak come with them
  await claimGuestProgress(user.id, deviceOf(req));
  res.json({ profile: await getProfile(user.id) });
});

// Signups are confirmed without the address ever being checked, so a mistyped
// domain becomes a real account whose password-reset mail bounces forever.
// Supabase warns on the bounce rate and can cut off sending, so the obvious
// slips get caught here.
//
// Deliberately narrow: a false positive locks a person out of signing up over
// an address that works. Only two things are treated as typos — a domain one
// edit away from a big provider, and a hand-written list of the classics that
// sit further away. Regional domains (hotmail.fr, yahoo.co.uk) are three or
// more edits from their .com and never match.
const MAIL_HOSTS = [
  'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com',
  'icloud.com', 'live.com', 'aol.com', 'proton.me', 'protonmail.com',
  'mail.ru', 'yandex.ru', 'bk.ru', 'list.ru', 'inbox.ru', 'rambler.ru',
];
const MAIL_TYPOS = {
  'gmial.com': 'gmail.com', 'gmali.com': 'gmail.com', 'gamil.com': 'gmail.com',
  'gmaill.com': 'gmail.com', 'ggmail.com': 'gmail.com', 'gmail.comm': 'gmail.com',
  'gmail.ru': 'gmail.com', 'gmail.co.com': 'gmail.com',
  'hotmial.com': 'hotmail.com', 'hotmall.com': 'hotmail.com',
  'yahooo.com': 'yahoo.com', 'yaho.com': 'yahoo.com',
  'outlok.com': 'outlook.com', 'outloock.com': 'outlook.com',
  'iclod.com': 'icloud.com', 'icloud.co': 'icloud.com',
  'mai.ru': 'mail.ru', 'maill.ru': 'mail.ru', 'yandex.com': 'yandex.ru',
};
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2; // only "is it 0 or 1" matters
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = a[i - 1] === b[j - 1]
        ? row[j - 1]
        : 1 + Math.min(row[j - 1], row[j], next[j - 1]);
    }
    row = next;
  }
  return row[b.length];
}
function mailTypo(email) {
  const host = email.split('@')[1] || '';
  if (!host || MAIL_HOSTS.includes(host)) return '';
  if (MAIL_TYPOS[host]) return MAIL_TYPOS[host];
  for (const good of MAIL_HOSTS) {
    if (editDistance(host, good) === 1) return good;
  }
  return '';
}

// Server-side signup: creates the account already confirmed, so the game
// never depends on the "Confirm email" toggle in Supabase.
app.post('/api/register', async (req, res) => {
  if (!dbEnabled) return res.status(503).json({ error: 'db_off' });
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const nick = String(req.body?.nick || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'email_bad' });
  const typo = mailTypo(email);
  if (typo) return res.status(400).json({ error: 'email_typo', suggest: typo });
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
      // The email may exist from an earlier half-finished signup — confirm it so
      // login works. This used to fetch a page of a thousand full user records
      // and scan it in JavaScript for one address: fat rows, every attempt, and
      // over a gigabyte of egress by itself. find_auth_user answers with the
      // two fields below, for the one address asked about.
      try {
        const { data: found } = await supa.rpc('find_auth_user', { p_email: email });
        const u = found?.[0];
        if (u && !u.confirmed) {
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
  await claimGuestProgress(userId, deviceOf(req));
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
    // Keep 7 days of raw events. At ~90k games a day, 60 days of them filled
    // the whole 500 MB database — it reached 97% and was hours from going
    // read-only, which would have stopped new players and points being saved.
    // The per-day totals live in visitor_days for good, so trimming the log
    // costs only the hour-by-hour detail of older days. Invites are small and
    // worth keeping whole.
    if (Math.random() < 0.01) {
      await supa.from('visit_log').delete()
        .in('kind', ['game', 'visit'])
        .lt('at', new Date(Date.now() - 7 * 86400e3).toISOString());
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
// '2026-07-19' -> '19.07'
const mskDdMm = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  return m ? `${m[3]}.${m[2]}` : '—';
};

const ADMIN_CSS = `
  :root {
    --bg: #0b0d16; --card: #151827; --line: #23273d;
    --ink: #e8ecf8; --dim: #8892b0; --faint: #6b7391;
    --accent: #7c4dff; --accent-soft: rgba(124, 77, 255, .16);
    --up: #21c07a; --down: #e35d6a;
  }
  * { box-sizing: border-box; }
  /* an admin page you hold in your hand: no text selection lag on tap, no
     grey flash box on the buttons, no rubber-band overscroll at the edges */
  html { -webkit-text-size-adjust: 100%; overscroll-behavior-y: none; }
  a, button, .card2, .dayrow, .geo, .pcard, .an-btn, .tabs a { -webkit-tap-highlight-color: transparent; }
  a, button { touch-action: manipulation; }
  body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--ink); margin: 0; padding: 14px 14px 30px; }
  h1 { font-size: 20px; margin: 4px 0 4px; }
  h2 { font-size: 15px; margin: 22px 0 8px; color: #aab3d0; }
  .sect { font-size: 11px; letter-spacing: .8px; text-transform: uppercase; color: var(--faint); margin: 16px 0 7px; }
  a { color: var(--accent); text-decoration: none; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
  .c { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 11px 13px; }
  .c b { font-size: 23px; display: block; line-height: 1.15; }
  .c span { font-size: 11px; color: var(--dim); display: block; margin-top: 2px; }
  .c.hi b { color: var(--accent); } .c.good b { color: var(--up); }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: var(--dim); font-size: 11px; position: sticky; top: 0; background: var(--bg); }
  tr.click { cursor: pointer; } tr.click:active { background: var(--card); }
  .wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .chart { display: flex; align-items: flex-end; gap: 5px; height: 120px; padding-top: 14px; }
  .bar { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; }
  .bar .fill { width: 100%; background: linear-gradient(180deg, #9b7bff, var(--accent)); border-radius: 5px 5px 0 0; min-height: 2px; }
  .bar small { font-size: 10px; color: #cfd6ee; margin: 3px 0 1px; } .bar span { font-size: 9px; color: #667; }
  .tabs { display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap; }
  .tabs a { background: var(--card); border: 1px solid var(--line); border-radius: 11px; padding: 8px 13px; font-size: 13px; color: #cfd6ee; }
  .tabs a.on { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  .person { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px; margin-bottom: 12px; }
  .person b.nick { font-size: 20px; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; margin-top: 10px; font-size: 13px; }
  .kv span { color: var(--dim); }
  .back { display: inline-block; margin-bottom: 10px; font-size: 14px; }
  /* day rows */
  .dayrow { display: flex; align-items: center; gap: 10px; background: var(--card); border: 1px solid var(--line);
            border-radius: 13px; padding: 12px 14px; margin-bottom: 8px; }
  .dayrow .d { font-size: 15px; font-weight: 700; min-width: 74px; }
  .dayrow .m { display: flex; gap: 16px; flex: 1; flex-wrap: wrap; }
  .dayrow .m i { font-style: normal; font-size: 11px; color: var(--dim); display: block; }
  .dayrow .m u { text-decoration: none; font-size: 15px; font-weight: 600; }
  .dayrow .go { color: var(--accent); font-size: 20px; }
  /* country rows */
  .geo { background: var(--card); border: 1px solid var(--line); border-radius: 13px; padding: 11px 13px; margin-bottom: 7px; }
  .geo .top { display: flex; align-items: baseline; gap: 8px; }
  .geo .name { font-size: 14px; font-weight: 600; flex: 1; }
  .geo .pct { font-size: 15px; font-weight: 700; color: var(--accent); }
  .geo .num { font-size: 11px; color: var(--dim); margin-left: 6px; }
  .geo .track { height: 6px; background: var(--line); border-radius: 4px; margin-top: 7px; overflow: hidden; }
  .geo .track i { display: block; height: 100%; background: linear-gradient(90deg, #9b7bff, var(--accent)); border-radius: 4px; }
  .note { color: var(--faint); font-size: 12px; line-height: 1.6; }
  /* ---------- new: bottom nav + card dashboard ---------- */
  .adm-body { padding-bottom: 76px; }
  .adm-nav {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 50;
    display: flex; background: rgba(11, 13, 22, .92); backdrop-filter: blur(10px);
    border-top: 1px solid var(--line); padding: 6px 2px calc(6px + env(safe-area-inset-bottom));
  }
  .an-btn {
    flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px;
    padding: 6px 2px; font-size: 10.5px; font-weight: 600; color: var(--faint);
  }
  .an-ic { font-size: 19px; filter: grayscale(1) opacity(.6); }
  .an-btn.on { color: var(--accent); }
  .an-btn.on .an-ic { filter: none; }
  .live-strip {
    display: flex; align-items: center; gap: 9px; background: var(--card); border: 1px solid var(--line);
    border-radius: 13px; padding: 11px 14px; margin-bottom: 12px; flex-wrap: wrap;
  }
  .live-strip .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--up); flex: none; animation: lpulse 2s infinite; }
  .live-strip .ls-main { font-size: 13.5px; }
  .live-strip .ls-main b { font-size: 17px; margin-right: 3px; }
  .live-strip .ls-sub { font-size: 11.5px; color: var(--faint); flex-basis: 100%; margin: -4px 0 0 17px; }
  @keyframes lpulse { 50% { opacity: .35; } }
  .cmp-note { font-size: 11.5px; line-height: 1.5; color: #7c86a6; background: #15182a; border: 1px solid var(--line);
              border-radius: 11px; padding: 8px 12px; margin: 0 0 10px; }
  .cmp-note b { color: #aab3d0; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .card2 { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 13px 14px 12px;
           display: flex; flex-direction: column; min-width: 0; }
  .c2-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .c2-ic { font-size: 14px; opacity: .9; flex: none; }
  .c2-label { font-size: 11.5px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .c2-val { font-size: 27px; font-weight: 800; margin: 5px 0 0; line-height: 1.1; letter-spacing: -.5px; }
  .c2-foot { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; margin-top: 9px; }
  .c2-was { font-size: 10.5px; color: var(--faint); white-space: nowrap; }
  .delta { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 999px; }
  .delta.up { color: var(--up); background: rgba(33, 192, 122, .15); }
  .delta.down { color: var(--down); background: rgba(227, 61, 82, .15); }
  .delta.flat { color: var(--dim); background: var(--line); font-weight: 600; }
  /* six tracks so 3-up then 2-up fills the block exactly — no orphan cell */
  .totals-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 1px;
                 background: var(--line); border: 1px solid var(--line); border-radius: 13px; overflow: hidden; }
  .totals-grid > div { background: var(--card); padding: 11px 12px; }
  .totals-grid .t2 { grid-column: span 2; } .totals-grid .t3 { grid-column: span 3; }
  .totals-grid b { display: block; font-size: 17px; font-weight: 800; line-height: 1.2; }
  .totals-grid i { display: block; font-style: normal; font-size: 10.5px; color: var(--dim); margin-top: 3px; }
  .pcard { display: flex; align-items: center; gap: 12px; background: var(--card); border: 1px solid var(--line); border-radius: 15px; padding: 11px 13px; margin-bottom: 8px; }
  .pcard:active { background: #1f2438; }
  .pc-avatar { width: 38px; height: 38px; border-radius: 50%; flex: none; background: linear-gradient(135deg, #9b7bff, var(--accent)); display: grid; place-items: center; font-weight: 700; color: #fff; }
  .pc-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .pc-info b { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 5px; }
  .pc-info small { font-size: 11.5px; color: var(--dim); }
  .pc-right { text-align: right; flex: none; }
  .pc-right b { font-size: 16px; display: block; }
  .pc-right small { font-size: 10px; color: var(--dim); }
  .badge-reg { color: var(--up); font-size: 12px; }
  .pc-go { color: var(--faint); font-size: 18px; flex: none; }
  .search-box { width: 100%; padding: 11px 14px; border-radius: 12px; border: 1px solid var(--line); background: var(--card); color: var(--ink); font-size: 14px; margin-bottom: 10px; }
  .subsect { font-size: 13px; font-weight: 700; color: #cfd6ee; margin: 20px 0 8px; }
  .refresh-bar { display: flex; align-items: center; justify-content: center; flex-wrap: wrap;
                 gap: 10px 14px; margin: 20px 0 6px; font-size: 12px; color: var(--faint); }
  .rb-btn { background: var(--card); border: 1px solid var(--line); border-radius: 11px; color: #cfd6ee;
            font: inherit; font-size: 13px; padding: 9px 16px; cursor: pointer; }
  .rb-btn:active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .rb-auto { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
  .rb-auto input { width: 15px; height: 15px; accent-color: var(--accent); }
  .rb-time { flex-basis: 100%; text-align: center; }

  /* ---------- the part you feel ----------
     Anything tappable dips under the finger and springs back. The dip is a
     transform, so it costs nothing and never reflows the page. */
  .card2, .dayrow, .geo, .pcard, .tabs a, .rb-btn, .an-btn, .c {
    transition: transform .12s cubic-bezier(.2,.7,.3,1), background-color .16s, border-color .16s;
  }
  .dayrow:active, .geo:active, .pcard:active, .c:active { transform: scale(.978); background: #1b1f31; }
  .card2:active { transform: scale(.978); }
  .tabs a:active, .rb-btn:active { transform: scale(.94); }
  .an-btn:active { transform: scale(.9); }
  .tabs a.on { box-shadow: 0 4px 14px -4px var(--accent); }

  /* section swap: content fades in rather than the page blinking white */
  .adm-body { animation: sectionIn .26s cubic-bezier(.2,.7,.3,1); }
  @keyframes sectionIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  .adm-body.leaving { opacity: .32; transition: opacity .12s; }
  /* thin bar across the top while the next section is on its way */
  #admProg {
    position: fixed; top: 0; left: 0; height: 2.5px; width: 0; z-index: 90; opacity: 0;
    background: linear-gradient(90deg, #9b7bff, var(--accent)); box-shadow: 0 0 8px var(--accent);
    transition: width .2s ease-out, opacity .2s;
  }
  #admProg.on { opacity: 1; }

  /* ---------- 14-day chart you can drag your finger across ---------- */
  .tchart { position: relative; margin: 4px 0 2px; touch-action: pan-y; user-select: none; -webkit-user-select: none; }
  .tchart { padding-top: 46px; }
  .tchart svg { display: block; width: 100%; height: 170px; overflow: visible; }
  .tc-line { fill: none; stroke: #b9a3ff; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
  .tc-grid { stroke: var(--line); stroke-width: 1; }
  .tc-ax { fill: var(--faint); font-size: 9.5px; }
  .tc-cross { stroke: #cfc4ff; stroke-width: 1; opacity: 0; }
  .tc-dot { fill: #fff; stroke: var(--accent); stroke-width: 3; opacity: 0; }
  .tchart.live .tc-cross, .tchart.live .tc-dot { opacity: 1; }
  /* the bubble sits in its own strip above the plot, so it never covers the
     line you are trying to read */
  .tc-tip {
    position: absolute; top: 0; pointer-events: none; opacity: 0; transform: translateX(-50%);
    background: #232842; border: 1px solid #34395a; border-radius: 10px; padding: 5px 10px;
    font-size: 11.5px; white-space: nowrap; line-height: 1.35;
    box-shadow: 0 8px 20px -8px #000; transition: opacity .14s;
  }
  .tchart.live .tc-tip { opacity: 1; }
  .tc-tip b { font-size: 14px; font-weight: 800; margin-left: 5px; }
  .tc-tip i { font-style: normal; color: var(--dim); }
  .tc-tip u { display: block; text-decoration: none; color: var(--faint); font-size: 10.5px; }
  .tc-hint { font-size: 11px; color: var(--faint); text-align: center; margin: 4px 0 0; }
  @media (prefers-reduced-motion: reduce) {
    .adm-body { animation: none; }
    .card2, .dayrow, .geo, .pcard, .tabs a, .rb-btn, .an-btn, .c { transition: none; }
  }`;

const nowMskHms = () => {
  const d = new Date(Date.now() + 3 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};
const nowMskHm = () => nowMskHms().slice(0, 5);
// The five sections the owner actually checks, reached from a fixed bottom
// bar instead of scrolling past everything else to get to one of them.
const NAV_ITEMS = [
  ['obzor', '📊', 'Обзор'],
  ['people', '👥', 'Люди'],
  ['audience', '🌍', 'Аудитория'],
  ['sources', '📈', 'Источники'],
  ['days', '📅', 'Дни'],
];
const bottomNav = (active) => `<nav class="adm-nav">${NAV_ITEMS.map(([id, ic, label]) =>
  `<a class="an-btn ${active === id ? 'on' : ''}" href="/admin?key=${ADMIN_KEY}&view=${id}"><span class="an-ic">${ic}</span>${label}</a>`
).join('')}</nav>`;

// The page used to carry <meta http-equiv="refresh" content="60">, which
// reloaded it out from under whoever was reading — mid-scroll, mid-tap, every
// minute, on every section. Refreshing is now a button. Auto-refresh is still
// available for leaving the dashboard up on a screen, but it is off unless
// asked for, it holds its place on the page, and it stops while the tab is in
// the background.
const adminPage = (title, body, active = 'obzor') => `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#12141f">
<meta http-equiv="Cache-Control" content="no-store">
<title>${title}</title><style>${ADMIN_CSS}</style></head><body>
<div id="admProg"></div>
<div class="adm-body">${body}
<div class="refresh-bar">
  <button type="button" class="rb-btn" onclick="admReload()">↻ Обновить</button>
  <label class="rb-auto"><input type="checkbox" id="admAuto"> каждую минуту</label>
  <span class="rb-time">данные на ${nowMskHms()} МСК</span>
</div>
</div>
${bottomNav(active)}
<script>
(function () {
'use strict';
var KEY = 'adm-auto', POS = 'adm-scroll';
var prog = document.getElementById('admProg');
var timer = null;

/* ---------- scroll position across a manual refresh ---------- */
var saved = sessionStorage.getItem(POS);
if (saved) {
  sessionStorage.removeItem(POS);
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  var y0 = parseInt(saved, 10) || 0;
  window.scrollTo(0, y0);
  requestAnimationFrame(function () { window.scrollTo(0, y0); });
}
window.admReload = function () {
  sessionStorage.setItem(POS, String(window.scrollY));
  location.reload();
};

/* ---------- numbers count up when they come into view ---------- */
function countUp(root) {
  var els = root.querySelectorAll('.c2-val, .totals-grid b');
  if (!window.IntersectionObserver) return;
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      io.unobserve(e.target);
      run(e.target);
    });
  }, { threshold: .25 });
  for (var i = 0; i < els.length; i++) {
    var target = parseInt(els[i].textContent.replace(/[^0-9]/g, ''), 10);
    if (!target || target < 2) continue;
    els[i].dataset.to = target;
    io.observe(els[i]);
  }
  function run(el) {
    var to = parseInt(el.dataset.to, 10), t0 = 0;
    var dur = 620;
    function step(ts) {
      if (!t0) t0 = ts;
      var k = Math.min(1, (ts - t0) / dur);
      k = 1 - Math.pow(1 - k, 3);                       // ease out, lands softly
      el.textContent = Math.round(to * k).toLocaleString('ru');
      if (k < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
}

/* ---------- the 14-day chart, drawn to the real pixel width so the
     finger lands exactly where the eye says it should ---------- */
function chart(root) {
  var box = root.querySelector('.tchart');
  if (!box) return;
  var data;
  try { data = JSON.parse(box.getAttribute('data-series') || '[]'); } catch (e) { return; }
  if (!data.length) return;
  var NS = 'http://www.w3.org/2000/svg';
  var tip = document.createElement('div');
  tip.className = 'tc-tip';
  var svg, pts, dot, cross, W, H = 170, PADL = 30, PADR = 8, PADT = 14, PADB = 20;

  function draw() {
    W = box.clientWidth || 340;
    box.textContent = '';
    svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    var max = 1;
    for (var i = 0; i < data.length; i++) max = Math.max(max, data[i][1]);
    // round the scale top to a step a human would pick (1/2/2.5/5 x 10^n).
    // ceil(max/4)*4 gave gridlines like 605 and 1815, which both printed "2k".
    var raw = max / 4, mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = mag * (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10);
    step = Math.max(1, step);   // these are counts of people, never fractions
    var nice = step * 4;
    var axLabel = function (v) {
      if (v >= 1000) { var k = v / 1000; return (k === Math.round(k) ? k : k.toFixed(1)) + 'k'; }
      return String(Math.round(v));
    };
    var x = function (i) { return PADL + (W - PADL - PADR) * (data.length < 2 ? .5 : i / (data.length - 1)); };
    var yv = function (v) { return PADT + (H - PADT - PADB) * (1 - v / nice); };

    for (var g = 0; g <= 4; g++) {
      var gv = nice * g / 4, gy = yv(gv);
      var ln = document.createElementNS(NS, 'line');
      ln.setAttribute('class', 'tc-grid');
      ln.setAttribute('x1', PADL); ln.setAttribute('x2', W - PADR);
      ln.setAttribute('y1', gy); ln.setAttribute('y2', gy);
      svg.appendChild(ln);
      var tx = document.createElementNS(NS, 'text');
      tx.setAttribute('class', 'tc-ax'); tx.setAttribute('x', 0); tx.setAttribute('y', gy + 3);
      tx.textContent = axLabel(gv);
      svg.appendChild(tx);
    }
    pts = [];
    var d = '', a = '';
    for (var j = 0; j < data.length; j++) {
      var px = x(j), py = yv(data[j][1]);
      pts.push([px, py]);
      d += (j ? 'L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1);
    }
    a = d + 'L' + x(data.length - 1).toFixed(1) + ' ' + yv(0) + 'L' + x(0).toFixed(1) + ' ' + yv(0) + 'Z';
    var grad = document.createElementNS(NS, 'linearGradient');
    grad.setAttribute('id', 'tcFill'); grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
    grad.innerHTML = '<stop offset="0" stop-color="#7c4dff" stop-opacity=".38"/>' +
                     '<stop offset="1" stop-color="#7c4dff" stop-opacity="0"/>';
    svg.appendChild(grad);
    var area = document.createElementNS(NS, 'path');
    area.setAttribute('d', a); area.setAttribute('fill', 'url(#tcFill)');
    svg.appendChild(area);
    var line = document.createElementNS(NS, 'path');
    line.setAttribute('d', d); line.setAttribute('class', 'tc-line');
    svg.appendChild(line);
    // the line draws itself in, left to right
    try {
      var len = line.getTotalLength();
      line.style.strokeDasharray = len; line.style.strokeDashoffset = len;
      line.style.transition = 'stroke-dashoffset .9s ease-out';
      requestAnimationFrame(function () { line.style.strokeDashoffset = 0; });
    } catch (e) {}

    for (var k2 = 0; k2 < data.length; k2++) {
      if (data.length > 7 && k2 % 2) continue;
      var lb = document.createElementNS(NS, 'text');
      lb.setAttribute('class', 'tc-ax'); lb.setAttribute('text-anchor', 'middle');
      lb.setAttribute('x', x(k2)); lb.setAttribute('y', H - 4);
      lb.textContent = data[k2][0];
      svg.appendChild(lb);
    }
    cross = document.createElementNS(NS, 'line');
    cross.setAttribute('class', 'tc-cross');
    cross.setAttribute('y1', PADT - 6); cross.setAttribute('y2', H - PADB);
    svg.appendChild(cross);
    dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('class', 'tc-dot'); dot.setAttribute('r', 4.5);
    svg.appendChild(dot);
    box.appendChild(svg);
    box.appendChild(tip);
  }

  function at(clientX) {
    var r = svg.getBoundingClientRect();
    var px = clientX - r.left, best = 0, bd = 1e9;
    for (var i = 0; i < pts.length; i++) {
      var d2 = Math.abs(pts[i][0] - px);
      if (d2 < bd) { bd = d2; best = i; }
    }
    return best;
  }
  function show(i) {
    box.classList.add('live');
    cross.setAttribute('x1', pts[i][0]); cross.setAttribute('x2', pts[i][0]);
    dot.setAttribute('cx', pts[i][0]); dot.setAttribute('cy', pts[i][1]);
    var row = data[i];
    tip.innerHTML = '<i>' + row[0] + '</i><b>' + Number(row[1]).toLocaleString('ru') + '</b>' +
      (row[2] === undefined ? '' : '<u>' + row[2] + '</u>');
    // keep the bubble inside the card
    var half = tip.offsetWidth / 2 + 6;
    tip.style.left = Math.max(half, Math.min(W - half, pts[i][0])) + 'px';
  }
  function hide() { box.classList.remove('live'); }

  draw();
  box.addEventListener('pointerdown', function (e) { show(at(e.clientX)); box.setPointerCapture(e.pointerId); });
  box.addEventListener('pointermove', function (e) { if (box.classList.contains('live')) show(at(e.clientX)); });
  box.addEventListener('pointerup', hide);
  box.addEventListener('pointercancel', hide);
  box.addEventListener('pointerleave', hide);
  var rt = null;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { if (document.body.contains(box)) draw(); }, 150);
  });
}

/* ---------- auto-refresh switch (lives inside the swapped section) ---------- */
function wireRefresh(root) {
  var box = root.querySelector('#admAuto');
  if (!box) return;
  box.checked = localStorage.getItem(KEY) === '1';
  box.addEventListener('change', function () {
    localStorage.setItem(KEY, box.checked ? '1' : '0');
    schedule();
  });
  schedule();
}
function schedule() {
  clearTimeout(timer);
  var box = document.getElementById('admAuto');
  if (!box || !box.checked) return;
  timer = setTimeout(function () {
    if (document.visibilityState === 'visible') admReload(); else schedule();
  }, 60000);
}
document.addEventListener('visibilitychange', schedule);

function enhance(root) { wireRefresh(root); countUp(root); chart(root); }

/* ---------- section switching without the white blink ---------- */
var busy = false;
function go(url, push) {
  if (busy) return;
  busy = true;
  var old = document.querySelector('.adm-body');
  old.classList.add('leaving');
  prog.classList.add('on'); prog.style.width = '45%';
  fetch(url, { headers: { 'X-Requested-With': 'adm' }, credentials: 'same-origin' })
    .then(function (r) { if (!r.ok) throw 0; return r.text(); })
    .then(function (html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var fresh = doc.querySelector('.adm-body');
      var nav = doc.querySelector('.adm-nav');
      if (!fresh) throw 0;
      prog.style.width = '100%';
      old.replaceWith(fresh);
      if (nav) document.querySelector('.adm-nav').replaceWith(nav);
      if (doc.title) document.title = doc.title;
      if (push) history.pushState({}, '', url);
      window.scrollTo(0, 0);
      enhance(fresh);
      busy = false;
      setTimeout(function () { prog.classList.remove('on'); prog.style.width = '0'; }, 220);
    })
    .catch(function () { busy = false; location.href = url; });   // fall back to a plain load
}

document.addEventListener('click', function (e) {
  var a = e.target.closest && e.target.closest('a[href]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target) return;
  var href = a.getAttribute('href') || '';
  if (href.indexOf('/admin') !== 0) return;
  e.preventDefault();
  go(href, true);
});
document.addEventListener('submit', function (e) {
  var f = e.target;
  if (!f.action || f.action.indexOf('/admin') === -1) return;
  e.preventDefault();
  var q = new URLSearchParams(new FormData(f)).toString();
  go(f.getAttribute('action') + '?' + q, true);
});
window.addEventListener('popstate', function () { go(location.pathname + location.search, false); });

enhance(document);
})();
</script>
</body></html>`;

// ---- period ranges for the Обзор dashboard: today / yesterday / 7d / 30d.
//
// The rule that makes a percentage mean anything: the two windows must cover
// the same amount of clock. "Today" is only a few hours old, so it is compared
// against yesterday CUT AT THE SAME TIME OF DAY, not against all 24 hours of
// it — that mistake made every morning look like a collapse. The multi-day
// windows use whole finished days and leave today out, because half a day
// dropped into a 7-day total drags it down for no real reason.
const mskMidnightIso = (dayIndex) => new Date(dayIndex * dayMs - 3 * 3600e3).toISOString();
function periodRange(p) {
  const now = Date.now();            // read once, so "now" and "now − 24h" line up exactly
  const today = mskDayStart(now);
  const nowIso = new Date(now).toISOString();
  if (p === 'yesterday') {
    return {
      from: mskMidnightIso(today - 1), to: mskMidnightIso(today),
      prevFrom: mskMidnightIso(today - 2), prevTo: mskMidnightIso(today - 1),
      label: 'вчера', vs: 'позавчера',
    };
  }
  if (p === 'week' || p === 'month') {
    const days = p === 'week' ? 7 : 30;
    return {
      from: mskMidnightIso(today - days), to: mskMidnightIso(today),
      prevFrom: mskMidnightIso(today - 2 * days), prevTo: mskMidnightIso(today - days),
      label: `${days} полных дней (без сегодня)`, vs: `прошлые ${days} дней`,
    };
  }
  return {
    from: mskMidnightIso(today), to: nowIso,
    // yesterday, same midnight-to-now slice of the day
    prevFrom: mskMidnightIso(today - 1), prevTo: new Date(now - dayMs).toISOString(),
    label: 'сегодня', vs: `вчера к ${nowMskHm()}`,
  };
}
async function periodStats(from, to) {
  const { data } = await supa.rpc('admin_period_stats', { from_ts: from, to_ts: to });
  const r = data?.[0] || {};
  return {
    newPeople: Number(r.new_people || 0), active: Number(r.active || 0),
    games: Number(r.games || 0), humans: Number(r.humans || 0),
  };
}
// null = refuse to print a number (nothing to compare against) rather than
// invent "+100%" out of a previous window that was empty.
const pct = (cur, prev) => prev ? Math.round(100 * (cur - prev) / prev) : null;
// The previous value is printed next to the arrow on purpose: a percentage
// nobody can check is a percentage nobody should trust.
const deltaHtml = (p, was, vs) => {
  if (was === undefined) return '';                       // card with nothing to compare to
  if (p === null) return `<div class="c2-foot"><span class="delta flat">нет данных за тот период</span></div>`;
  const cls = p > 0 ? 'up' : p < 0 ? 'down' : 'flat';
  const arrow = p > 0 ? '▲' : p < 0 ? '▼' : '=';
  // Name the period the number belongs to. It used to just say "было 29 449",
  // which reads as yesterday's total — while the Дни page showed 32 097 for
  // the same day, because that one counts the whole 24 hours and this one
  // stops at the same time of day as now.
  return `<div class="c2-foot"><span class="delta ${cls}">${arrow} ${Math.abs(p)}%</span>` +
    `<span class="c2-was">${vs ? esc(vs) + ' — ' : 'было '}${was}</span></div>`;
};
const statCard = (icon, label, value, p, was, vs) =>
  `<div class="card2"><div class="c2-top"><span class="c2-ic">${icon}</span><span class="c2-label">${esc(label)}</span></div>` +
  `<div class="c2-val">${value}</div>${deltaHtml(p, was, vs)}</div>`;

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

  const num = (n) => Number(n || 0).toLocaleString('ru');
  const cnt = async (q) => (await q).count || 0;
  const today = mskDayStart(Date.now());
  const todayStartIso = new Date(today * dayMs - 3 * 3600e3).toISOString();
  const view = ['obzor', 'people', 'audience', 'sources', 'days'].includes(String(req.query.view))
    ? String(req.query.view) : 'obzor';

  let content = '';

  if (view === 'people') {
    // ----- journal: filtered and paged IN the database so the filters and
    // counts apply to everyone, not just the first page -----
    const [totalPeople, played, installs, regs] = await Promise.all([
      cnt(supa.from('visitors').select('*', { count: 'exact', head: true })),
      cnt(supa.from('visitors').select('*', { count: 'exact', head: true }).gt('games', 0)),
      cnt(supa.from('visitors').select('*', { count: 'exact', head: true }).not('installed_at', 'is', null)),
      cnt(supa.from('visitors').select('*', { count: 'exact', head: true }).not('user_id', 'is', null)),
    ]);

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
    // Only the nicknames for the rows actually on screen. This used to pull
    // every profile in the database (4000+ rows) on every single page view,
    // just to look up a hundred names.
    const pageUserIds = [...new Set((pageRows || []).map(v => v.user_id).filter(Boolean))];
    const { data: profs } = pageUserIds.length
      ? await supa.from('profiles').select('id, nick, wins, losses').in('id', pageUserIds)
      : { data: [] };
    const byId = new Map((profs || []).map(p => [p.id, p]));
    const total = found || 0;
    const pages = Math.max(1, Math.ceil(total / PAGE));
    const link = (o = {}) => {
      const p = { key: ADMIN_KEY, view: 'people', f, ...(q ? { q } : {}), ...o };
      return '/admin?' + Object.entries(p).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    };
    const tab = (id, label, n) =>
      `<a class="${f === id ? 'on' : ''}" href="${link({ f: id, pg: 1 })}">${label} (${num(n)})</a>`;
    const cardsHtml = (pageRows || []).map(v => {
      const prof = v.user_id ? byId.get(v.user_id) : null;
      const href = `/admin/v?key=${ADMIN_KEY}&d=${encodeURIComponent(v.device_id)}`;
      return `<a class="pcard" href="${href}">
        <div class="pc-avatar">${esc((v.last_nick || '?')[0].toUpperCase())}</div>
        <div class="pc-info">
          <b>${esc(visName(v, byId))}${prof ? ' <span class="badge-reg">✔</span>' : ''}</b>
          <small>${esc(countryOf(v.tz))} · заходил ${mskFmt(v.last_seen)}</small>
        </div>
        <div class="pc-right"><b${v.games > 0 ? '' : ' style="color:#c0392b"'}>${v.games}</b><small>партий</small></div>
        <span class="pc-go">›</span>
      </a>`;
    }).join('') || '<p class="note">Никого не нашлось</p>';
    const pager = pages > 1 ? `<div class="tabs" style="margin-top:12px">
      ${page > 1 ? `<a href="${link({ pg: page - 1 })}">‹ Назад</a>` : ''}
      <a class="on">${page} из ${pages}</a>
      ${page < pages ? `<a href="${link({ pg: page + 1 })}">Дальше ›</a>` : ''}
    </div>` : '';

    content = `
<h2>Люди (📲 = установил приложение)</h2>
<form method="get" action="/admin">
  <input type="hidden" name="key" value="${ADMIN_KEY}"><input type="hidden" name="view" value="people">
  <input type="hidden" name="f" value="${esc(f)}">
  <input class="search-box" name="q" value="${esc(q)}" placeholder="Поиск по нику…" autocomplete="off">
</form>
<div class="tabs">
  ${tab('all', 'Все', totalPeople)}
  ${tab('played', '🎮 Играли', played)}
  ${tab('zero', '👀 Только смотрели', totalPeople - played)}
  ${tab('inst', '📲 Установили', installs)}
  ${tab('reg', '✔ Регистрация', regs)}
</div>
<p class="note">${q ? `Найдено: ${num(total)}` : `Всего в этом фильтре: ${num(total)}`} · показано по ${PAGE} на странице</p>
${pager}
${cardsHtml}
${pager}`;
  } else if (view === 'audience') {
    // ----- who the audience is: countries, ranks, streaks -----
    const geoPeriod = String(req.query.p || 'all');
    const geoFromTs = geoPeriod === 'today' ? todayStartIso
      : geoPeriod === 'week' ? new Date(Date.now() - 7 * dayMs).toISOString() : null;

    const dayAgoIso = new Date(Date.now() - dayMs).toISOString().slice(0, 10);
    const rankBand = (table, r, i, extra) => {
      const next = RANKS[i + 1];
      let q = supa.from(table).select('*', { count: 'exact', head: true }).gte('points', r.min);
      if (next) q = q.lt('points', next.min);
      if (extra) q = extra(q);
      return cnt(q);
    };
    const [tzRes, streakAliveN, streak3, streak7, streakTopRow, guestBands, accountBands, botBands] = await Promise.all([
      supa.rpc('admin_timezones', { from_ts: geoFromTs }),
      cnt(supa.from('visitors').select('*', { count: 'exact', head: true }).gte('streak_day', dayAgoIso).gt('streak', 0)),
      cnt(supa.from('visitors').select('*', { count: 'exact', head: true }).gte('streak_day', dayAgoIso).gte('streak', 3)),
      cnt(supa.from('visitors').select('*', { count: 'exact', head: true }).gte('streak_day', dayAgoIso).gte('streak', 7)),
      supa.from('visitors').select('streak_best').order('streak_best', { ascending: false }).limit(1).maybeSingle(),
      // guests who never played are not "Rookies", they are visitors — exclude them
      Promise.all(RANKS.map((r, i) => rankBand('visitors', r, i, (q) => q.gt('games', 0)))),
      Promise.all(RANKS.map((r, i) => rankBand('profiles', r, i))),
      Promise.all(RANKS.map((r, i) => rankBand('bot_players', r, i))),
    ]);
    const bestStreak = streakTopRow?.data?.streak_best || 0;
    const rankCounts = RANKS.map((_, i) => guestBands[i] + accountBands[i]);
    const botTotal = botBands.reduce((a, b) => a + b, 0);
    const ranked = rankCounts.reduce((a, b) => a + b, 0) - (rankCounts[0] || 0);

    const agg = new Map(); // country -> { people, games }
    for (const r of (tzRes?.data || [])) {
      const name = countryOf(r.tz);
      const c = agg.get(name) || { people: 0, games: 0 };
      c.people += Number(r.people) || 0;
      c.games += Number(r.games) || 0;
      agg.set(name, c);
    }
    const list = [...agg.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.people - a.people);
    const sum = list.reduce((s, c) => s + c.people, 0) || 1;
    const pTab = (id, label) =>
      `<a class="${geoPeriod === id ? 'on' : ''}" href="/admin?key=${ADMIN_KEY}&view=audience&p=${id}">${label}</a>`;
    const geoRows = list.slice(0, 30).map(c => {
      const p = 100 * c.people / sum;
      return `<div class="geo">
        <div class="top"><span class="name">${esc(c.name)}</span><span class="pct">${p.toFixed(1)}%</span></div>
        <div class="track"><i style="width:${Math.max(1, p).toFixed(1)}%"></i></div>
        <div class="num">${num(c.people)} чел. · ${num(c.games)} партий</div>
      </div>`;
    }).join('');
    const rest = list.slice(30).reduce((s, c) => s + c.people, 0);

    content = `
<p class="sect">🔥 Серии дней <span class="note" style="font-weight:400">— живая = играл сегодня или вчера</span></p>
<div class="grid2">
  ${statCard('🔥', 'Живых серий', num(streakAliveN), null)}
  ${statCard('📈', '3 дня и больше', num(streak3), null)}
  ${statCard('🗓️', 'Неделя и больше', num(streak7), null)}
  ${statCard('🏅', 'Рекорд серии', num(bestStreak), null)}
</div>

<p class="sect" style="margin-top:22px">🏆 Звания <span class="note" style="font-weight:400">— ${num(ranked)} выбрались из Новичка · ${num(botTotal)} ботов в таблице лидеров не учтены</span></p>
<div class="grid2">
  ${RANKS.map((r, i) => statCard(r.icon, RANK_RU[r.key] || r.key, num(rankCounts[i]), null)).join('')}
</div>

<p class="sect" style="margin-top:22px">🌍 Страны — ${list.length}</p>
<div class="tabs">${pTab('all', 'За всё время')}${pTab('week', '7 дней')}${pTab('today', 'Сегодня')}</div>
${geoRows || '<p class="note">Пока нет данных за этот период.</p>'}
${rest ? `<p class="note">+ ещё ${num(rest)} чел. из остальных стран</p>` : ''}
<p class="note">Страна определяется по часовому поясу устройства — это близко к правде, но не паспорт: через VPN человек может выглядеть как из другой страны.</p>`;
  } else if (view === 'sources') {
    /* ----- where the traffic comes from -----
       Arrivals alone decide nothing, so each channel is shown with what
       happened after the click: how many started a game at all, and how many
       were still here the next day. */
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
      `<a class="${period === id ? 'on' : ''}" href="/admin?key=${ADMIN_KEY}&view=sources&p=${id}">${label}</a>`;
    const rowsHtml = list.map(c => {
      const p = 100 * c.people / sum;
      const pPlayed = c.people ? Math.round(100 * c.played / c.people) : 0;
      const pKept = c.people ? Math.round(100 * c.kept / c.people) : 0;
      return `<div class="geo">
        <div class="top"><span class="name">${esc(c.name)}</span><span class="pct">${p.toFixed(1)}%</span></div>
        <div class="track"><i style="width:${Math.max(1, p).toFixed(1)}%"></i></div>
        <div class="num">${num(c.people)} чел. · сыграли ${pPlayed}% · вернулись ${pKept}% · ${num(c.games)} партий</div>
      </div>`;
    }).join('');
    content = `<h2>Откуда приходят игроки</h2>
<div class="tabs">${pTab('all', 'За всё время')}${pTab('week', 'За 7 дней')}${pTab('today', 'Сегодня')}</div>
${rowsHtml || '<p class="note">Пока нет данных за этот период.</p>'}
<p class="note"><b>Определяется само.</b> Instagram, TikTok, Facebook и Telegram открывают ссылки во встроенном браузере, который называет себя по имени — такие заходы распознаются без всяких меток. Google, Яндекс, Reddit и обычные сайты видно по переходу. «Прямые» — это те, кто набрал адрес руками с экрана видео: их не определить никак.</p>
<p class="note"><b>Метки нужны только для мелочей.</b> Отличить один ролик от другого или проверить платный посев: <code>wallrush.online/?f=reels_walls</code>, <code>/?f=tg_kanal1</code>. Метка сильнее автоопределения и запоминается при первом заходе навсегда.</p>
<p class="note">«Сыграли» — начали хотя бы одну партию. «Вернулись» — заходили ещё через сутки после первого раза.</p>`;
  } else if (view === 'days') {
    // ----- days: each day a block with its own numbers, plus a 14-day chart -----
    const fromTs = new Date((today - 13) * dayMs - 3 * 3600e3).toISOString();
    const dayStr = (d) => new Date(d * dayMs).toISOString().slice(0, 10);
    const [{ data: buckets }, { data: npd }, invites] = await Promise.all([
      // per-day totals come from the permanent rollup, not the raw log — the log
      // only keeps the last 7 days now, the rollup keeps every day for good
      supa.rpc('admin_days', { from_day: dayStr(today - 13), to_day: dayStr(today) }),
      supa.rpc('new_per_day', { from_ts: fromTs }),
      Promise.all([
        cnt(supa.from('visit_log').select('*', { count: 'exact', head: true }).eq('kind', 'invite_share').gte('at', todayStartIso)),
        cnt(supa.from('visit_log').select('*', { count: 'exact', head: true }).eq('kind', 'invite_join').gte('at', todayStartIso)),
        cnt(supa.from('visit_log').select('*', { count: 'exact', head: true }).eq('kind', 'invite_share').gte('at', new Date(Date.now() - 7 * dayMs).toISOString())),
        cnt(supa.from('visit_log').select('*', { count: 'exact', head: true }).eq('kind', 'invite_join').gte('at', new Date(Date.now() - 7 * dayMs).toISOString())),
      ]),
    ]);
    const [invShareToday, invJoinToday, invShareWeek, invJoinWeek] = invites;
    const npdMap = new Map((npd || []).map(r => [Number(r.day), Number(r.n)]));
    const dmap = new Map();
    for (const b of (buckets || [])) dmap.set(Number(b.bucket), { people: Number(b.people), games: Number(b.games) });

    // [label, new people, the rest of the day in the bubble]
    const series = [];
    for (let i = 13; i >= 0; i--) {
      const d = today - i;
      const rec = dmap.get(d);
      series.push([
        mskDayLabel(d), npdMap.get(d) || 0,
        `${rec ? num(rec.people) : '—'} заходили · ${rec ? num(rec.games) : '—'} партий`,
      ]);
    }
    const bars = `<div class="tchart" data-series='${esc(JSON.stringify(series))}'></div>
<p class="tc-hint">Веди пальцем по графику</p>`;

    const blocks = [];
    for (let day = today; day > today - 14; day--) {
      const rec = dmap.get(day);
      const fresh = npdMap.get(day) || 0;
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

    content = `
<h2>Новые люди по дням (14 дней)</h2>
${bars}
<p class="sect" style="margin-top:20px">🔗 Приглашения по ссылке</p>
<div class="grid2">
  ${statCard('📨', 'Позвали сегодня', num(invShareToday), null)}
  ${statCard('✅', 'Пришли сегодня', num(invJoinToday), null)}
  ${statCard('📨', 'Позвали за неделю', num(invShareWeek), null)}
  ${statCard('✅', 'Пришли за неделю', num(invJoinWeek), null)}
</div>
<p class="subsect">По дням — нажми на день, чтобы увидеть по часам</p>
${blocks.join('') || '<p class="note">Подневная история пишется с 19.07 — строки появятся по мере заходов.</p>'}`;
  } else {
    // ----- obzor: the dashboard landing tab — live now, a period pick, and lifetime totals -----
    const period = ['today', 'yesterday', 'week', 'month'].includes(String(req.query.p)) ? String(req.query.p) : 'today';
    const range = periodRange(period);
    const [cur, prev, dataStart, totalPeople, totalGames, installs, regs, humansTotal] = await Promise.all([
      periodStats(range.from, range.to),
      periodStats(range.prevFrom, range.prevTo),
      supa.rpc('admin_data_start').then(r => r.data || null),
      cnt(supa.from('visitors').select('*', { count: 'exact', head: true })),
      cnt(supa.from('visit_log').select('*', { count: 'exact', head: true }).eq('kind', 'game')),
      cnt(supa.from('visitors').select('*', { count: 'exact', head: true }).not('installed_at', 'is', null)),
      cnt(supa.from('visitors').select('*', { count: 'exact', head: true }).not('user_id', 'is', null)),
      cnt(supa.from('human_matches').select('*', { count: 'exact', head: true })),
    ]);
    // A window that reaches back further than the statistics themselves cannot
    // be compared to anything, so say so instead of printing a made-up number.
    // When there is nothing to compare against, the note below the tabs says so
    // once; the cards just drop their footer rather than repeating it four times.
    const short = dataStart && new Date(range.prevFrom) < new Date(`${dataStart}T00:00:00+03:00`);
    const cmp = (c, p) => short ? null : pct(c, p);
    const was = (p) => short ? undefined : num(p);
    const pTab = (id, label) => `<a class="${period === id ? 'on' : ''}" href="/admin?key=${ADMIN_KEY}&view=obzor&p=${id}">${label}</a>`;

    content = `
<div class="live-strip">
  <span class="dot"></span>
  <span class="ls-main"><b>${num(realOnline())}</b> реально на сайте</span>
  <span class="ls-sub">на витрине «онлайн ${num(realOnline() + fakeOnline())}»</span>
</div>
<div class="tabs">${pTab('today', 'Сегодня')}${pTab('yesterday', 'Вчера')}${pTab('week', '7 дней')}${pTab('month', '30 дней')}</div>
<p class="cmp-note">${short
      ? `📅 ${esc(range.label)} · сравнивать не с чем — статистика ведётся с ${dataStart ? mskDdMm(dataStart) : '—'}`
      : period === 'today'
        ? `📅 День ещё идёт — прожито до <b>${nowMskHm()}</b>. Поэтому сравниваем со <b>вчера к ${nowMskHm()}</b>, а не с целыми вчерашними сутками. В разделе «Дни» у вчера стоит цифра за все 24 часа — она будет больше, и это нормально.`
        : `📅 ${esc(range.label)} · проценты — против того же отрезка: <b>${esc(range.vs)}</b>`}</p>
<div class="grid2">
  ${statCard('🆕', 'Новых людей', num(cur.newPeople), cmp(cur.newPeople, prev.newPeople), was(prev.newPeople), range.vs)}
  ${statCard('👋', 'Заходили', num(cur.active), cmp(cur.active, prev.active), was(prev.active), range.vs)}
  ${statCard('🎮', 'Партий сыграно', num(cur.games), cmp(cur.games, prev.games), was(prev.games), range.vs)}
  ${statCard('🤝', 'Живых матчей', num(cur.humans), cmp(cur.humans, prev.humans), was(prev.humans), range.vs)}
</div>
<p class="subsect">За всё время</p>
<div class="totals-grid">
  <div class="t2"><b>${num(totalPeople)}</b><i>людей</i></div>
  <div class="t2"><b>${num(totalGames)}</b><i>партий</i></div>
  <div class="t2"><b>${num(humansTotal)}</b><i>🤝 живых</i></div>
  <div class="t3"><b>${num(installs)}</b><i>📲 установили</i></div>
  <div class="t3"><b>${num(regs)}</b><i>✔ регистраций</i></div>
</div>`;
  }

  res.send(adminPage('WallRush — статистика', `
<h1>🧱 WallRush — статистика</h1>
<p class="note" style="margin:0 0 14px">Всё время московское.</p>
${content}`, view));
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
  const dayIso = new Date(day * dayMs).toISOString().slice(0, 10);
  const [{ data: dayBk }, { data: npdDay }] = await Promise.all([
    supa.rpc('admin_days', { from_day: dayIso, to_day: dayIso }),
    supa.rpc('new_per_day', { from_ts: startIso }),
  ]);
  const dayDevices = Number(dayBk?.[0]?.people || 0);
  const dayGamesTotal = Number(dayBk?.[0]?.games || 0);
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
  <div class="c"><b>${n(dayGamesTotal || dayGames)}</b><span>партий</span></div>
  <div class="c"><b>${String(peakHour).padStart(2, '0')}:00</b><span>пик посещений</span></div>
</div>
<h2>По часам (МСК) — нажми на час, чтобы увидеть людей</h2>
${day < mskDayStart(Date.now()) - 7
    ? '<p class="note">Разбивка по часам хранится 7 дней, для этого дня её уже нет. Итоги дня выше — они сохраняются навсегда.</p>'
    : ''}
<div class="wrap"><table><tr><th>Час</th><th>Людей</th><th>Партий</th></tr>${trs}</table></div>`, 'days'));
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
  // names only for the visitors listed on this page, not the whole table
  const hourUserIds = [...new Set((rows || []).map(v => v.user_id).filter(Boolean))];
  const { data: profs } = hourUserIds.length
    ? await supa.from('profiles').select('id, nick').in('id', hourUserIds)
    : { data: [] };
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
${hourDevices > shownDevs.length ? `<p class="note">Показаны первые ${shownDevs.length} из ${hourDevices.toLocaleString('ru')} — полный список ищи во вкладке «Люди».</p>` : ''}`, 'days'));
});

// one person's page: everything about a single device + day-by-day timeline
app.get('/admin/v', async (req, res) => {
  if ((req.query.key || '') !== ADMIN_KEY) return res.status(404).send('Not found');
  if (!dbEnabled) return res.send('DB is off');
  const device = String(req.query.d || '');
  const { data: v } = await supa.from('visitors')
    .select('device_id, first_seen, last_seen, visits, games, last_nick, user_id, lang, tz, installed_at, standalone_at')
    .eq('device_id', device).maybeSingle();
  if (!v) return res.send(adminPage('Не найден', `<a class="back" href="/admin?key=${ADMIN_KEY}&view=people">‹ Назад</a><p>Человек не найден.</p>`, 'people'));
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
<a class="back" href="/admin?key=${ADMIN_KEY}&view=people">‹ Назад к списку</a>
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
    : '<p style="color:#8892b0;font-size:13px">Подробная история пишется с 19.07 — у этого человека записей пока нет. Появятся при следующем его заходе.</p>'}`, 'people'));
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
