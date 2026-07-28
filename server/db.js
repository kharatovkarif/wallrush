// Supabase clients. Everything degrades gracefully when env vars are absent:
// the game then runs in guest-only mode (no accounts, empty leaderboard).
import { createClient } from '@supabase/supabase-js';
import { WebSocket as WsImpl } from 'ws'; // realtime transport for Node < 22 (no native WebSocket)

// Values pasted from a phone often carry invisible junk (line breaks inside
// the key, surrounding quotes, zero-width chars) — scrub it all out.
export const cleanEnv = (v) => (v || '')
  .replace(/[\s\u200B-\u200D\uFEFF]+/g, '')
  .replace(/^["']+|["']+$/g, '');

// Escape LIKE/ILIKE wildcards so a nick is matched literally, not as a pattern.
// Without this, an underscore or % in a nick behaves as a wildcard and can
// resolve to the wrong account (breaking login by nick).
export const likeEscape = (s) => String(s).replace(/[\\%_]/g, (m) => '\\' + m);

const url = cleanEnv(process.env.SUPABASE_URL);
const serviceKey = cleanEnv(process.env.SUPABASE_SERVICE_KEY);

// Never crash the game because of bad credentials: fall back to guest mode.
// dbStatus tells the frontend WHY accounts are off, so it's debuggable from a phone.
let client = null;
let status = 'ok';
let detail = '';
if (!url && !serviceKey) status = 'no_env';
else if (!url) status = 'no_url';
else if (!serviceKey) status = 'no_service_key';
else if (!/^https:\/\/.+\.supabase\.co\/?$/i.test(url)) status = 'bad_url';
else if (!serviceKey.startsWith('eyJ') && !serviceKey.startsWith('sb_secret_')) status = 'bad_service_key';
else {
  try {
    client = createClient(url, serviceKey, {
      auth: { persistSession: false },
      realtime: { transport: WsImpl },
    });
  } catch (e) {
    console.error('Supabase init failed:', e.message);
    status = 'init_failed';
    detail = String(e.message || '').slice(0, 90);
  }
}
if (status !== 'ok') console.error(`Supabase disabled (${status}) — running in guest mode.`);

export const dbEnabled = Boolean(client);
export const dbStatus = status;
export const dbDetail = detail;
export const supa = client;

// Verify a Supabase Auth JWT; returns { id } or null.
export async function verifyUser(jwt) {
  if (!dbEnabled || !jwt) return null;
  try {
    const { data, error } = await supa.auth.getUser(jwt);
    if (error || !data?.user) return null;
    return { id: data.user.id };
  } catch {
    return null;
  }
}

export async function getProfile(userId) {
  if (!dbEnabled) return null;
  const { data } = await supa.from('profiles').select('id, nick, wins, losses, points').eq('id', userId).maybeSingle();
  return data || null;
}

/* ---- ladder points ----
   A registered player carries them on the profile; a guest carries them on the
   device row, which is the only identity 94% of players ever have. */

const BLANK = { points: 0, veteran: false, streak: 0, streakBest: 0, streakDay: null, freezeMonth: null };

export async function getPoints({ userId, deviceId }) {
  if (!dbEnabled) return { ...BLANK };
  const shape = (d, veteran) => ({
    points: d?.points || 0,
    veteran,
    streak: d?.streak || 0,
    streakBest: d?.streak_best || 0,
    streakDay: d?.streak_day || null,
    freezeMonth: d?.freeze_month || null,
  });
  try {
    if (userId) {
      const { data } = await supa.from('profiles')
        .select('points, streak, streak_best, streak_day, freeze_month').eq('id', userId).maybeSingle();
      return shape(data, false);
    }
    if (deviceId) {
      const { data } = await supa.from('visitors')
        .select('points, veteran, streak, streak_best, streak_day, freeze_month')
        .eq('device_id', deviceId).maybeSingle();
      return shape(data, Boolean(data?.veteran));
    }
  } catch (e) {
    console.error('getPoints failed:', e.message);
  }
  return { ...BLANK };
}

// Marks the player's local day as played. Returns the streak after the update,
// or null when there is nothing to write to.
export async function touchStreak({ userId, deviceId }, today) {
  if (!dbEnabled || !today) return null;
  try {
    const { data } = userId
      ? await supa.rpc('touch_streak_user', { uid: userId, today })
      : deviceId
        ? await supa.rpc('touch_streak_device', { dev: deviceId, today })
        : { data: null };
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    return {
      streak: row.streak || 0,
      best: row.best || 0,
      advanced: Boolean(row.advanced),
      froze: Boolean(row.froze),
    };
  } catch (e) {
    console.error('touchStreak failed:', e.message);
    return null;
  }
}

// Returns the new total, or null when there is nothing to write it to.
export async function addPoints({ userId, deviceId }, delta) {
  if (!dbEnabled || !delta) return null;
  try {
    if (userId) {
      const { data } = await supa.rpc('add_points_user', { uid: userId, delta });
      return typeof data === 'number' ? data : null;
    }
    if (deviceId) {
      const { data } = await supa.rpc('add_points_device', { dev: deviceId, delta });
      return typeof data === 'number' ? data : null;
    }
  } catch (e) {
    console.error('addPoints failed:', e.message);
  }
  return null;
}

export async function addBotPoints(nick, delta) {
  if (!dbEnabled || !delta) return null;
  try {
    const { data } = await supa.rpc('add_points_bot', { bnick: nick, delta });
    return typeof data === 'number' ? data : null;
  } catch (e) {
    console.error('addBotPoints failed:', e.message);
    return null;
  }
}

export async function botPoints() {
  if (!dbEnabled) return new Map();
  try {
    const { data } = await supa.from('bot_players').select('nick, points');
    return new Map((data || []).map(b => [b.nick, b.points || 0]));
  } catch {
    return new Map();
  }
}

export async function createProfile(userId, nick) {
  const { error } = await supa.from('profiles').insert({ id: userId, nick });
  if (error) {
    if (error.code === '23505') return { error: 'nick_taken' };
    return { error: 'generic' };
  }
  return { ok: true };
}

// count a finished game between two real humans (for the owner's stats)
export async function recordHumanMatch(mode) {
  if (!dbEnabled) return;
  try {
    await supa.from('human_matches').insert({ mode: mode === 'race' ? 'race' : 'duel' });
  } catch (e) {
    console.error('recordHumanMatch failed:', e.message);
  }
}

export async function recordResult(winnerUserId, loserUserId) {
  if (!dbEnabled) return;
  try {
    if (winnerUserId) await supa.rpc('add_result', { uid: winnerUserId, is_win: true });
    if (loserUserId) await supa.rpc('add_result', { uid: loserUserId, is_win: false });
  } catch (e) {
    console.error('recordResult failed:', e.message);
  }
}

// Ranked by ladder points, not by raw wins: the old order simply put whoever
// played the most on top, which is what the ladder exists to fix.
export async function leaderboard(limit = 50) {
  if (!dbEnabled) return [];
  const [{ data: people }, { data: bots }] = await Promise.all([
    supa.from('profiles').select('nick, wins, losses, points').order('points', { ascending: false }).limit(200),
    supa.from('bot_players').select('nick, wins, losses, points').order('points', { ascending: false }).limit(200),
  ]);
  const all = [...(people || []), ...(bots || [])].map(r => ({ ...r, points: r.points || 0 }));
  all.sort((a, b) => (b.points - a.points) || (b.wins - a.wins) || (a.losses - b.losses));
  return all.slice(0, limit);
}

// ---- bot players (kept in their own table so real stats stay clean) ----

// One-time seed: insert missing bots with a believable starting record.
export async function seedBots(nicks) {
  if (!dbEnabled) return;
  try {
    const rows = nicks.map((nick) => {
      const games = 5 + Math.floor(Math.random() * 60);
      const wins = Math.floor(games * (0.25 + Math.random() * 0.5));
      return { nick, wins, losses: games - wins };
    });
    await supa.from('bot_players').upsert(rows, { onConflict: 'nick', ignoreDuplicates: true });
  } catch (e) {
    console.error('seedBots failed:', e.message);
  }
}

export async function recordBotResult(nick, won) {
  if (!dbEnabled) return;
  try {
    const { data } = await supa.from('bot_players').select('wins, losses').eq('nick', nick).maybeSingle();
    if (!data) return;
    await supa.from('bot_players').update(
      won ? { wins: data.wins + 1 } : { losses: data.losses + 1 }
    ).eq('nick', nick);
  } catch (e) {
    console.error('recordBotResult failed:', e.message);
  }
}

// Background life for the leaderboard: each call, a slice of bots plays a
// "session" of 1–4 games. Called hourly with a day-curve chance, so most of
// the roster visibly climbs every single day, like real regulars would.
export async function growBots(botWinChance, activeChance = 0.07) {
  if (!dbEnabled) return;
  try {
    const { data: bots } = await supa.from('bot_players').select('nick, wins, losses, points');
    if (!bots) return;
    for (const b of bots) {
      if (Math.random() > activeChance) continue;
      const p = botWinChance.get(b.nick) ?? 0.5;
      const games = 1 + Math.floor(Math.random() * 4); // a session: 1–4 games
      let w = 0;
      for (let i = 0; i < games; i++) if (Math.random() < p) w++;
      // points move with the wins, at the same rate a person would earn them,
      // so a bot's badge always matches its record on the leaderboard
      const gained = w * 25 - (games - w) * 10;
      await supa.from('bot_players').update({
        wins: b.wins + w,
        losses: b.losses + (games - w),
        points: Math.max(0, (b.points || 0) + gained),
      }).eq('nick', b.nick);
    }
  } catch (e) {
    console.error('growBots failed:', e.message);
  }
}
