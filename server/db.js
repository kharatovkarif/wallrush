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

const BLANK = { points: 0, veteran: false, streak: 0, streakBest: 0, streakDay: null, freezeMonth: null, streakPrev: 0, ownerId: null };

/* Read once on connect, and again on every reconnect — which on a phone that
   keeps losing signal is a great many times an hour. Everything after that
   moment comes down the socket instead, so a few seconds of staleness here is
   invisible, and the reads were a large share of what the database was doing
   when it ran out of room on 19 September. */
const POINTS_TTL = 30_000;
const POINTS_MAX = 5_000;
const pointsCache = new Map();

export function forgetPoints({ userId, deviceId }) {
  pointsCache.delete('u:' + userId);
  pointsCache.delete('d:' + deviceId);
}

export async function getPoints({ userId, deviceId }) {
  if (!dbEnabled) return { ...BLANK };
  const key = userId ? 'u:' + userId : deviceId ? 'd:' + deviceId : null;
  if (key) {
    const hit = pointsCache.get(key);
    if (hit && Date.now() - hit.at < POINTS_TTL) return { ...hit.val };
  }
  const val = await readPoints({ userId, deviceId });
  if (key && val) {
    if (pointsCache.size > POINTS_MAX) {
      const now = Date.now();
      for (const [k, v] of pointsCache) if (now - v.at >= POINTS_TTL) pointsCache.delete(k);
      if (pointsCache.size > POINTS_MAX) pointsCache.clear();
    }
    pointsCache.set(key, { at: Date.now(), val });
  }
  return { ...val };
}

async function readPoints({ userId, deviceId }) {
  if (!dbEnabled) return { ...BLANK };
  const shape = (d, veteran, ownerId = null) => ({
    points: d?.points || 0,
    veteran,
    streak: d?.streak || 0,
    streakBest: d?.streak_best || 0,
    streakDay: d?.streak_day || null,
    freezeMonth: d?.freeze_month || null,
    streakPrev: d?.streak_prev || 0,
    /* Whose device this is, when we are reading it as a guest's. The row
       remembers the account that was signed in on it, and that is the only way
       to tell a real guest from somebody whose login quietly fell off. */
    ownerId,
  });
  try {
    if (userId) {
      const { data } = await supa.from('profiles')
        .select('points, streak, streak_best, streak_day, freeze_month, streak_prev').eq('id', userId).maybeSingle();
      return shape(data, false);
    }
    if (deviceId) {
      const { data } = await supa.from('visitors')
        .select('points, veteran, streak, streak_best, streak_day, freeze_month, streak_prev, user_id')
        .eq('device_id', deviceId).maybeSingle();
      return shape(data, Boolean(data?.veteran), data?.user_id || null);
    }
  } catch (e) {
    console.error('getPoints failed:', e.message);
  }
  return { ...BLANK };
}

/* ---- the name on the device ----

   A device row remembers the account that signed in on it. When a player turns
   up with no pass at all we treated them as a plain guest and said nothing —
   and 36% of everyone who has an account was playing that way, with over half
   a million finished games counted against the device instead of the name they
   registered. A login can fall off for reasons that are nobody's fault: the
   token refresh failed while the database was down, or the browser threw its
   storage away. Either way the honest thing is to say whose device this is and
   offer the way back in.

   Cached generously: it only ever runs for a device that has an owner and no
   live session, and the answer changes about as often as people rename
   themselves. */
const OWNER_TTL = 10 * 60_000;
const OWNER_MAX = 4_000;
const ownerCache = new Map();

export async function deviceOwnerNick(userId) {
  if (!dbEnabled || !userId) return null;
  const hit = ownerCache.get(userId);
  if (hit && Date.now() - hit.at < OWNER_TTL) return hit.nick;
  try {
    const { data } = await supa.from('profiles').select('nick').eq('id', userId).maybeSingle();
    const nick = data?.nick || null;
    if (ownerCache.size > OWNER_MAX) ownerCache.clear();
    ownerCache.set(userId, { at: Date.now(), nick });
    return nick;
  } catch (e) {
    console.error('deviceOwnerNick failed:', e.message);
    return null;
  }
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
  forgetPoints({ userId, deviceId });
  forgetStreak({ userId, deviceId });
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
/* The flame says "played today", and it changes once in a day. It was asked
   about after every single game: twenty games in an evening meant twenty calls
   to the database, nineteen of which could only answer what the first one
   already had.

   So the first game of a player's day goes through and the answer is kept; the
   rest of that day are answered from here. `advanced` and `froze` are forced
   off on the way out, because those two mean "it grew just now" and "it was
   saved just now" — the celebration belongs to the game that earned it, not to
   every game after.

   Keyed on the player's own day, not the server's, so it rolls over at their
   midnight. A restart forgets it, which costs one extra call per player. */
const streakDone = new Map();
const STREAK_MAX = 8_000;

const streakKey = ({ userId, deviceId }) =>
  (userId ? 'u:' + userId : deviceId ? 'd:' + deviceId : null);

export function forgetStreak(who) {
  const k = streakKey(who);
  if (k) streakDone.delete(k);
}

export async function touchStreak({ userId, deviceId }, today) {
  const key = streakKey({ userId, deviceId });
  const hit = key && streakDone.get(key);
  if (hit && hit.day === today) {
    return { streak: hit.streak, best: hit.best, advanced: false, froze: false };
  }
  forgetPoints({ userId, deviceId });
  if (!dbEnabled || !today) return null;
  try {
    const { data } = userId
      ? await supa.rpc('touch_streak_user', { uid: userId, today })
      : deviceId
        ? await supa.rpc('touch_streak_device', { dev: deviceId, today })
        : { data: null };
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    const out = {
      streak: row.streak || 0,
      best: row.best || 0,
      advanced: Boolean(row.advanced),
      froze: Boolean(row.froze),
    };
    if (key) {
      if (streakDone.size > STREAK_MAX) {
        for (const [k, v] of streakDone) if (v.day !== today) streakDone.delete(k);
        if (streakDone.size > STREAK_MAX) streakDone.clear();
      }
      streakDone.set(key, { day: today, streak: out.streak, best: out.best });
    }
    return out;
  } catch (e) {
    console.error('touchStreak failed:', e.message);
    return null;
  }
}

// Returns the new total, or null when there is nothing to write it to.
export async function addPoints({ userId, deviceId }, delta) {
  if (!dbEnabled || !delta) return null;
  forgetPoints({ userId, deviceId });   // the cached figure is now the old one
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
/* A tally of games, and a tally can wait. Handed to the write queue instead
   of going out on its own — one insert for a whole flush rather than one per
   finished game. */
export async function recordHumanMatch(mode) {
  if (!dbEnabled) return;
  const { noteMatchLater } = await import('./queue.js');
  noteMatchLater(mode);
}

/* One four-handed game is one win and three losses, written once per person.
   Feeding it through recordResult as three separate duels would have credited
   the winner with three wins for a single game. */
/* Erase an account, for real.

   The privacy policy promises that a player can have their account deleted,
   and until now the only way to exercise that was to message somebody on
   Telegram and hope. A promise a person cannot act on themselves is not a
   right, and both app stores treat it as a requirement rather than a courtesy.

   What goes: the profile and everything hanging off it — the friendships in
   both directions, pending requests either way, their review and the likes on
   it, the daily-task row — and finally the sign-in itself, so the address can
   never be used to get back in.

   What stays: the anonymous visit counts, with the link to this person cut.
   Those rows carry no name and no address once user_id is gone, and they are
   how the game knows whether anybody is playing at all. Finished games stay
   too: they are somebody else's history as much as this player's, and a
   leaderboard that silently rewrites itself is worse for everyone. */
export async function deleteAccount(userId) {
  if (!dbEnabled || !userId) return false;
  try {
    // reviews first: the likes point at them
    const { data: mine } = await supa.from('reviews').select('id').eq('user_id', userId);
    for (const r of mine || []) {
      await supa.from('review_likes').delete().eq('review_id', r.id);
    }
    await supa.from('reviews').delete().eq('user_id', userId);
    await supa.from('friends').delete().eq('user_id', userId);
    await supa.from('friends').delete().eq('friend_id', userId);
    await supa.from('friend_requests').delete().eq('from_id', userId);
    await supa.from('friend_requests').delete().eq('to_id', userId);
    await supa.from('daily_progress').delete().eq('key', 'u:' + userId);
    // Push subscriptions are filed under the device, not the account, and a
    // subscription is a way to reach this person on their phone. Look up the
    // devices this account signed in from and take those with it.
    const { data: devs } = await supa.from('visitors').select('device_id').eq('user_id', userId);
    for (const d of devs || []) {
      if (d.device_id) await supa.from('push_subs').delete().eq('device_id', d.device_id);
    }
    // the device rows lose the person, and keep the counting
    await supa.from('visitors').update({ user_id: null, last_nick: null }).eq('user_id', userId);
    await supa.from('profiles').delete().eq('id', userId);
    const { error } = await supa.auth.admin.deleteUser(userId);
    if (error) {
      console.error('deleteAccount: auth user survived:', error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.error('deleteAccount failed:', e.message);
    return false;
  }
}

export async function recordQuadResult(winnerUserId, loserUserIds = []) {
  if (!dbEnabled) return;
  try {
    if (winnerUserId) await supa.rpc('add_result', { uid: winnerUserId, is_win: true });
    for (const uid of loserUserIds) {
      if (uid) await supa.rpc('add_result', { uid, is_win: false });
    }
  } catch (e) {
    console.error('recordQuadResult failed:', e.message);
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
/* ---------- today's table ----------

   The all-time board rewards having been here longest, which is a closed shop
   to anybody who arrived this week. This is the one a single good evening can
   reach: points earned since midnight, emptied and started again every day.

   Midnight Moscow for everyone, not each player's own midnight. A shared board
   has to have a shared day — if it ended at a different hour for each reader,
   two people looking at the same page would be looking at different contests.
   Moscow because that is where most of the players are; the screen says so, so
   nobody in Tehran or Dushanbe has to work it out. */

export const mskDay = (now = Date.now()) =>
  new Date(now + 3 * 3600_000).toISOString().slice(0, 10);

// Who the row belongs to. An account keeps its place across devices, a guest
// keeps it on the one they play from, and ours are named.
export const dayKeyOf = (pl) =>
  pl.isBot ? `b:${pl.nick}` : pl.userId ? `u:${pl.userId}` : pl.deviceId ? `d:${pl.deviceId}` : null;

/* Every point that moves, on the day it moved. Called from the one place in
   the server that changes a score, so there is no second path to forget.

   Points can go down — losing costs you — and the day's total can go negative
   for somebody having a bad evening. That is left alone rather than clamped:
   the board only shows the positive end of it, and a floor of zero would let
   a player lose all evening with nothing to show for it. */
/* The day's board, through the write queue. Five games in eight seconds
   become one row written instead of five, which matters because it is the
   same few hundred people playing continuously. */
export async function addDayPoints(pl, delta, result = null) {
  if (!dbEnabled) return;
  const { bumpDayLater } = await import('./queue.js');
  bumpDayLater(pl, delta, result);
}

const DAY_TTL = 60_000;
let dayCache = { at: 0, day: '', size: 0, rows: [] };

/* The top of today. Read in board order straight out of the index, then the
   accounts among them checked against the anti-cheat marker in one go — the
   day table does not carry that marker, because it would go stale the moment
   somebody was flagged mid-day.

   A few more rows are asked for than are shown, so that dropping a flagged
   player does not leave the list one short. */
export async function dailyLeaderboard(limit = 100) {
  if (!dbEnabled) return [];
  const day = mskDay();
  const fresh = dayCache.day === day && Date.now() - dayCache.at < DAY_TTL && dayCache.size >= limit;
  if (fresh) return dayCache.rows.slice(0, limit);

  try {
    const { data, error } = await supa.from('points_days')
      .select('who, nick, kind, points, wins, losses')
      .eq('day', day)
      .gt('points', 0)
      .order('points', { ascending: false })
      .order('wins', { ascending: false })
      .order('losses', { ascending: true })
      .limit(Math.ceil(limit * 1.3) + 10);
    if (error) throw new Error(error.message);

    const raw = data || [];
    const userIds = raw.filter(r => r.kind === 'user').map(r => r.who.slice(2));
    let flaggedIds = [];
    if (userIds.length) {
      const { data: bad } = await supa.from('profiles')
        .select('id').in('id', userIds).is('flagged', true);
      flaggedIds = (bad || []).map(f => f.id);
    }
    const rows = shapeDayBoard(raw, flaggedIds, limit);
    dayCache = { at: Date.now(), day, size: limit, rows };
    return rows;
  } catch (e) {
    console.error('dailyLeaderboard failed:', e.message);
    // a failed round trip must not be cached as an empty day
    return dayCache.day === day ? dayCache.rows.slice(0, limit) : [];
  }
}

/* What comes back from the query turned into what the screen gets: flagged
   accounts dropped, the list cut to length, and only the columns a board needs.
   Pulled out on its own because it is the part with a decision in it, and the
   part a test can hold without a database. */
export function shapeDayBoard(raw, flaggedIds = [], limit = 100) {
  const out = new Set(flaggedIds.map(id => `u:${id}`));
  return (raw || [])
    .filter(r => !out.has(r.who))
    .slice(0, limit)
    .map(r => ({ nick: r.nick, points: r.points, wins: r.wins, losses: r.losses, kind: r.kind }));
}

/* ---------- where you are on it ----------

   A board that shows fifty names and stops is a board most people are not on.
   Being told you are 886th is worth more than being told nothing: it is a
   position, it moves, and it is the only number on the screen that is yours.

   Rank counts how many are strictly ahead, so people level on points share a
   place — 886th and 886th, then 888th. That is how a league table reads, and
   it avoids inventing an order between two players the board itself cannot
   separate.

   For a guest the all-time number is honest but hypothetical: their points are
   real and counted the same way, but the list they are being measured against
   does not include them, because it never has. The screen says so rather than
   pretending otherwise. */

const aheadOf = async (q) => {
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count || 0;
};

/* A place on the board costs a counting pass over every profile, and these are
   asked for on the hottest paths there are: the ranking screen, and every tap
   on a name in it. Uncached, that was a full scan of nine thousand rows per
   open — which took the database down on 17 September, with the game still
   running from memory while every counter on the admin page read zero.

   A place does not move in a minute, so it is remembered for one. The map is
   swept when it grows, because it is keyed by player and there are a lot of
   players. */
const RANK_TTL = 60_000;
const RANK_MAX = 4000;
const rankCache = new Map();

function cachedRank(key) {
  const hit = rankCache.get(key);
  if (hit && Date.now() - hit.at < RANK_TTL) return hit.val;
  return undefined;
}
function keepRank(key, val) {
  if (rankCache.size > RANK_MAX) {
    const now = Date.now();
    for (const [k, v] of rankCache) if (now - v.at >= RANK_TTL) rankCache.delete(k);
    if (rankCache.size > RANK_MAX) rankCache.clear();
  }
  rankCache.set(key, { at: Date.now(), val });
  return val;
}

export async function myRank({ userId, deviceId }) {
  if (!dbEnabled) return null;
  const key = 'r:' + (userId || 'd:' + deviceId);
  const hit = cachedRank(key);
  if (hit !== undefined) return hit;
  try {
    const me = await getPoints({ userId, deviceId });
    const points = me.points || 0;
    const [people, bots] = await Promise.all([
      aheadOf(supa.from('profiles').select('id', { count: 'exact', head: true })
        .gt('points', points).not('flagged', 'is', true)),
      aheadOf(supa.from('bot_players').select('nick', { count: 'exact', head: true })
        .gt('points', points)),
    ]);
    return keepRank(key, { rank: people + bots + 1, points, listed: Boolean(userId) });
  } catch (e) {
    console.error('myRank failed:', e.message);
    return null;
  }
}

export async function myDayRank(pl) {
  if (!dbEnabled) return null;
  const who = dayKeyOf(pl);
  if (!who) return null;
  const key = 'd:' + who;
  const hit = cachedRank(key);
  if (hit !== undefined) return hit;
  try {
    const day = mskDay();
    const { data } = await supa.from('points_days')
      .select('points, wins, losses').eq('day', day).eq('who', who).maybeSingle();
    const points = data?.points || 0;
    // Nothing won today is not a place on today's board, it is no place at all.
    if (points <= 0) return keepRank(key, { rank: 0, points, wins: data?.wins || 0, listed: true });
    const ahead = await aheadOf(supa.from('points_days').select('who', { count: 'exact', head: true })
      .eq('day', day).gt('points', points));
    return keepRank(key, { rank: ahead + 1, points, wins: data?.wins || 0, listed: true });
  } catch (e) {
    console.error('myDayRank failed:', e.message);
    return null;
  }
}

/* ---------- one player, looked up by the name on the screen ----------

   Every list in the game shows a nickname: the friends list, the search, an
   incoming request, both leaderboards. So the card behind all of them is
   fetched by nickname, and there is exactly one of it — tap a name anywhere
   and the same card opens, with the same numbers, read fresh rather than
   pieced together from whatever that particular list happened to carry. The
   day's board carries today's points, not a lifetime of them, and a card that
   showed one as the other would be wrong in a way nobody could catch.

   The lookup itself is one call into the database (player_card), which settles
   account / one of ours / guest in the right order and works out the place on
   the board while it is there. Written as a function rather than as queries
   from here for one reason: a nickname may contain an underscore, and to LIKE
   an underscore means "any character", so a search for Ma_rat would have found
   Marrat and handed back a stranger's card. Nearly a thousand accounts have
   one. An exact comparison in SQL has nothing to escape. */
export async function publicProfile(nick, viewerId = null) {
  if (!dbEnabled) return null;
  const key = 'c:' + String(nick || '').toLowerCase();
  try {
    let row = cachedRank(key);
    if (row === undefined) {
      const { data, error } = await supa.rpc('player_card', { q: String(nick || '') });
      if (error) throw new Error(error.message);
      row = keepRank(key, (Array.isArray(data) ? data[0] : data) || null);
    }
    if (!row) return null;

    const out = {
      nick: row.nick,
      kind: row.kind,
      points: row.points || 0,
      // A guest's games are counted on their device rather than per result, so
      // the card only claims the numbers it actually has.
      wins: Number.isInteger(row.wins) ? row.wins : null,
      losses: Number.isInteger(row.losses) ? row.losses : null,
      streak: row.streak || 0,
      streakBest: row.streak_best || 0,
      since: row.since || null,
      // Only an account can be sent a friend request, and only an account has
      // an id worth handing out.
      id: row.kind === 'user' ? row.id : null,
      place: row.place || null,
      already: false,
      pending: false,
    };

    if (viewerId && out.id && viewerId !== out.id) {
      const [{ count: f }, { count: r }] = await Promise.all([
        supa.from('friends').select('user_id', { count: 'exact', head: true })
          .eq('user_id', viewerId).eq('friend_id', out.id),
        supa.from('friend_requests').select('from_id', { count: 'exact', head: true })
          .or(`and(from_id.eq.${viewerId},to_id.eq.${out.id}),and(from_id.eq.${out.id},to_id.eq.${viewerId})`),
      ]);
      out.already = (f || 0) > 0;
      out.pending = (r || 0) > 0;
    }
    return out;
  } catch (e) {
    console.error('publicProfile failed:', e.message);
    return null;
  }
}

// Old days, swept once a day rather than on a schedule of their own: the first
// read after midnight pays for it, and it is a delete of a few thousand rows.
let sweptOn = '';
export async function sweepDayPoints() {
  if (!dbEnabled) return;
  const day = mskDay();
  if (sweptOn === day) return;
  sweptOn = day;
  try { await supa.rpc('day_points_sweep', { keep_days: 14 }); }
  catch (e) { console.error('day sweep failed:', e.message); }
}

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
    // Points come with the record, or three hundred new names all arrive as
    // Rookies on zero and the lobby is suddenly full of obvious newcomers who
    // play like veterans. Existing rows are left alone (ignoreDuplicates), so
    // the originals keep the history they actually earned.
    const rows = nicks.map((nick) => {
      const games = 5 + Math.floor(Math.random() * 60);
      const wins = Math.floor(games * (0.25 + Math.random() * 0.5));
      const losses = games - wins;
      return { nick, wins, losses, points: Math.max(0, wins * 25 - losses * 10) };
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

export async function friendFind(nick, me) {
  if (!client || !nick || !me) return null;
  const { data, error } = await client.rpc('friend_find', { q: nick, me });
  if (error) { console.error('friendFind failed:', error.message); return null; }
  const row = Array.isArray(data) ? data[0] : data;
  return row || null;
}

export async function friendCount(me) {
  if (!client || !me) return 0;
  const { data } = await client.rpc('friend_count', { me });
  return typeof data === 'number' ? data : 0;
}

export async function friendRequestAdd(a, b) {
  if (!client || !a || !b || a === b) return false;
  const { error } = await client.rpc('friend_request_add', { a, b });
  if (error) { console.error('friendRequestAdd failed:', error.message); return false; }
  return true;
}

export async function friendRequestAccept(me, other) {
  if (!client || !me || !other) return false;
  const { error } = await client.rpc('friend_request_accept', { me, other });
  if (error) { console.error('friendRequestAccept failed:', error.message); return false; }
  return true;
}

export async function friendRequestDecline(me, other) {
  if (!client || !me || !other) return false;
  const { error } = await client.rpc('friend_request_decline', { me, other });
  if (error) { console.error('friendRequestDecline failed:', error.message); return false; }
  return true;
}

export async function friendRequestsIn(me) {
  if (!client || !me) return [];
  const { data, error } = await client.rpc('friend_requests_in', { me });
  if (error) { console.error('friendRequestsIn failed:', error.message); return []; }
  return data || [];
}

export async function friendList(a) {
  if (!client || !a) return [];
  const { data, error } = await client.rpc('friend_list', { a });
  if (error) { console.error('friendList failed:', error.message); return []; }
  return data || [];
}
