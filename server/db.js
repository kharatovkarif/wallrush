// Supabase clients. Everything degrades gracefully when env vars are absent:
// the game then runs in guest-only mode (no accounts, empty leaderboard).
import { createClient } from '@supabase/supabase-js';
import { streakState, canRestore, freeRestore, pendingStreak } from '../public/js/streak.js';
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
  const { data } = await supa.from('profiles')
    .select('id, nick, wins, losses, points, nick_notice').eq('id', userId).maybeSingle();
  return data || null;
}

// Clears the "your nickname was changed" note once the player has seen it.
export async function clearNickNotice(userId) {
  if (!dbEnabled) return;
  await supa.from('profiles').update({ nick_notice: null }).eq('id', userId);
}

/* ---- ladder points ----
   A registered player carries them on the profile; a guest carries them on the
   device row, which is the only identity 94% of players ever have. */

const BLANK = { points: 0, veteran: false, streak: 0, streakBest: 0, streakDay: null, freezeMonth: null, streakPrev: 0 };

export async function getPoints({ userId, deviceId }) {
  if (!dbEnabled) return { ...BLANK };
  const shape = (d, veteran) => ({
    points: d?.points || 0,
    veteran,
    streak: d?.streak || 0,
    streakBest: d?.streak_best || 0,
    streakDay: d?.streak_day || null,
    freezeMonth: d?.freeze_month || null,
    streakPrev: d?.streak_prev || 0,
  });
  try {
    if (userId) {
      const { data } = await supa.from('profiles')
        .select('points, streak, streak_best, streak_day, freeze_month, streak_prev').eq('id', userId).maybeSingle();
      return shape(data, false);
    }
    if (deviceId) {
      const { data } = await supa.from('visitors')
        .select('points, veteran, streak, streak_best, streak_day, freeze_month, streak_prev')
        .eq('device_id', deviceId).maybeSingle();
      return shape(data, Boolean(data?.veteran));
    }
  } catch (e) {
    console.error('getPoints failed:', e.message);
  }
  return { ...BLANK };
}

/* Puts a broken streak back. Nothing extra is stored: the row already holds
   the number and the day it stopped, so marking today as closed is the whole
   restore. The number is not increased — the button saves a streak, it does
   not grow one, or "days in a row" would come to mean days of pressing a
   button rather than days of playing.

   The first restore of a month is free and spends that month's allowance. The
   rest are earned by watching an ad, which the client handles before calling.

   Everything is decided against the stored row rather than trusted from the
   client, and calling twice is harmless: after the first one the streak is no
   longer broken. */
export async function restoreStreak({ userId, deviceId }, today) {
  if (!dbEnabled || !today) return null;
  const table = userId ? 'profiles' : 'visitors';
  const col = userId ? 'id' : 'device_id';
  const key = userId || deviceId;
  if (!key) return null;
  try {
    const { data } = await supa.from(table)
      .select('streak, streak_prev, streak_day, freeze_month').eq(col, key).maybeSingle();
    if (!data) return null;
    const offer = pendingStreak(data, today);
    if (!offer) return null;
    if (!canRestore(data.streak_day, today, offer)) return null;
    const wasFree = freeRestore(data.freeze_month, today);
    await supa.from(table).update({
      streak: offer,
      streak_prev: 0,
      streak_day: today,
      ...(wasFree ? { freeze_month: today.slice(0, 7) } : {}),
    }).eq(col, key);
    return { streak: offer, wasFree };
  } catch (e) {
    console.error('restoreStreak failed:', e.message);
    return null;
  }
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

/* Carry a guest's progress into the account they have just made.

   Everyone plays as a guest first, and their points and streak are kept
   against the device. Signing up created an empty profile beside all of that
   and started the player from zero — while the very screen they signed up
   from promised the opposite: "your points live on this device, sign up so
   you never lose them". A player at four thousand points and ten days running
   had no safe move in either direction.

   Guarded so that one device cannot be spent twice:

     only for a profile created a moment ago — an existing account is never
     topped up, or a single strong device could feed one account after another;

     only from a device no other account has already claimed;

     and the device is marked as claimed here, so a second signup from it
     carries nothing.

   Wins and losses stay behind — they are only ever counted for accounts, so
   there is nothing on the guest side to move. A cheating flag does come
   across: a fresh email should not wash it off. */
export async function claimGuestProgress(userId, deviceId) {
  if (!dbEnabled || !userId || !deviceId) return null;
  try {
    const { data: v } = await supa.from('visitors')
      .select('user_id, points, streak, streak_best, streak_day, freeze_month, streak_prev, points_day, points_today, flagged')
      .eq('device_id', deviceId).maybeSingle();
    if (!v) return null;
    if (v.user_id && v.user_id !== userId) return null;   // somebody else's device

    const points = v.points || 0;
    const streak = v.streak || 0;
    if (points > 0 || streak > 0 || (v.streak_best || 0) > 0) {
      await supa.from('profiles').update({
        points,
        streak,
        streak_best: v.streak_best || 0,
        streak_day: v.streak_day,
        freeze_month: v.freeze_month,
        streak_prev: v.streak_prev || 0,
        points_day: v.points_day,
        points_today: v.points_today || 0,
        ...(v.flagged ? { flagged: true } : {}),
      }).eq('id', userId);
    }
    /* Claimed either way: an empty device must not stay open for a second
       account either. The row keeps its own numbers — the leaderboard is built
       from profiles alone so nothing is counted twice, and a player who signs
       out still finds their guest progress where they left it. */
    await supa.from('visitors').update({ user_id: userId }).eq('device_id', deviceId);
    return { points, streak };
  } catch (e) {
    console.error('claimGuestProgress failed:', e.message);
    return null;
  }
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

// Every open of the Ranking tab used to pull 400 rows out of Postgres to show
// 50 of them, thousands of times a day, for a list that barely moves. That was
// the bulk of the project's egress, and the free plan's 5 GB was nearly spent.
//
// Two changes: ask each table for only as many rows as can possibly place —
// the merged top N cannot contain a row that was not in the top N of its own
// table — and hold the answer for a spell. A ranking a minute out of date is
// not a ranking anyone notices.
const LB_TTL = 60_000;
let lbCache = { at: 0, size: 0, rows: [] };

export async function leaderboard(limit = 50) {
  if (!dbEnabled) return [];
  const fresh = Date.now() - lbCache.at < LB_TTL && lbCache.size >= limit;
  if (fresh) return lbCache.rows.slice(0, limit);

  // Ordered on all three keys, the same ones the merge below uses. Points alone
  // would leave ties to the database's whim, and asking for exactly `limit`
  // rows means a tie broken differently there than here drops somebody off the
  // last line who belonged on it. With the orders matching, the row each table
  // withholds is one the merge would have discarded anyway.
  const top = (q) => q.order('points', { ascending: false })
    .order('wins', { ascending: false })
    .order('losses', { ascending: true })
    .limit(limit);
  const [{ data: people }, { data: bots }] = await Promise.all([
    // an account caught farming keeps its history but leaves the table
    top(supa.from('profiles').select('nick, wins, losses, points').not('flagged', 'is', true)),
    top(supa.from('bot_players').select('nick, wins, losses, points')),
  ]);
  // a failed round-trip must not be cached as an empty ranking for a minute
  if (!people && !bots) return lbCache.rows.slice(0, limit);

  const all = [...(people || []), ...(bots || [])].map(r => ({ ...r, points: r.points || 0 }));
  all.sort((a, b) => (b.points - a.points) || (b.wins - a.wins) || (a.losses - b.losses));
  const rows = all.slice(0, limit);
  lbCache = { at: Date.now(), size: limit, rows };
  return rows;
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

/* ---------- friends ----------
   Mutual on add, no confirmation step: a request nobody answers is a friend
   nobody plays. The game server adds who is online — it is the only thing
   that knows. */
/* ---------- task of the day ----------
   Progress is counted in the database rather than in memory: a player can
   finish one match on a phone and the next on a laptop, and a restart of the
   server must not wipe a day's work. The RPC also reports whether this call
   was the one that finished the task, so the reward is paid exactly once even
   if two matches land in the same instant. */

const dailyKey = ({ userId, deviceId }) => (userId ? 'u:' + userId : deviceId ? 'd:' + deviceId : null);

export async function dailyState({ userId, deviceId }, day) {
  const key = dailyKey({ userId, deviceId });
  if (!dbEnabled || !key || !day) return null;
  try {
    const { data } = await supa.from('daily_progress')
      .select('task_id, progress, done').eq('key', key).eq('day', day).maybeSingle();
    return data ? { taskId: data.task_id, progress: data.progress || 0, done: Boolean(data.done) } : null;
  } catch (e) {
    console.error('dailyState failed:', e.message);
    return null;
  }
}

export async function dailyBump({ userId, deviceId }, day, taskId, inc, target) {
  const key = dailyKey({ userId, deviceId });
  if (!dbEnabled || !key || !day || !inc) return null;
  try {
    const { data } = await supa.rpc('daily_bump', { k: key, d: day, tid: taskId, inc, tgt: target });
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    // Yesterday's rows are read by nobody. Kept for a few days so a player
    // crossing midnight mid-session still sees a sane card, then dropped:
    // this table gains a row per player per day and the database has a ceiling.
    if (Math.random() < 0.005) {
      await supa.from('daily_progress').delete()
        .lt('day', new Date(Date.now() - 4 * 86400e3).toISOString().slice(0, 10));
    }
    return { progress: row.progress || 0, done: Boolean(row.done), awardedNow: Boolean(row.awarded_now) };
  } catch (e) {
    console.error('dailyBump failed:', e.message);
    return null;
  }
}

export async function friendAdd(a, b) {
  if (!client || !a || !b || a === b) return false;
  const { error } = await client.rpc('friend_add', { a, b });
  if (error) { console.error('friendAdd failed:', error.message); return false; }
  return true;
}

export async function friendRemove(a, b) {
  if (!client || !a || !b) return false;
  const { error } = await client.rpc('friend_remove', { a, b });
  if (error) { console.error('friendRemove failed:', error.message); return false; }
  return true;
}

export async function friendList(a) {
  if (!client || !a) return [];
  const { data, error } = await client.rpc('friend_list', { a });
  if (error) { console.error('friendList failed:', error.message); return []; }
  return data || [];
}
