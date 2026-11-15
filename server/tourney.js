/* ---------- the wins tournament ----------

   The first one (owner's call, 15 Nov 2026): most wins from 12:00 Moscow on
   15 November to 12:00 Moscow on 25 November, and the top 100 accounts get a
   month of Premium. Only wins, not points, and only wins scored after the
   start: nothing from before counts.

   A win is the same win that goes on the day's board (rooms.js persistPoints
   passes result 'win' only for a game that was actually scored: not a private
   room, not a game decided in a handful of moves). Wins come in through the
   write queue, a few seconds late, like every other counter.

   Our bots are left out: they cannot take a prize, and a table of people
   competing for a real prize should show people. Guests' wins are counted on
   their device and follow them into an account when they sign in, but only
   accounts are on the table and only accounts can be paid, so the screen tells
   a guest to sign in. */

import { dbEnabled, supa } from './db.js';

export const TOURNEY = {
  id: '2026-11',
  start: Date.parse('2026-11-15T09:00:00Z'),   // 12:00 Moscow
  end: Date.parse('2026-11-25T09:00:00Z'),     // 12:00 Moscow
  places: 100,
  days: 30,
};

export const tourneyLive = (now = Date.now()) => now >= TOURNEY.start && now < TOURNEY.end;

// what the client needs to draw the banner and the tab
export const tourneyInfo = (now = Date.now()) => ({
  id: TOURNEY.id, start: TOURNEY.start, end: TOURNEY.end, places: TOURNEY.places,
  state: now < TOURNEY.start ? 'soon' : now < TOURNEY.end ? 'live' : 'over',
});

/* The table: accounts only, flagged ones dropped, ties to whoever got there
   first, the same order the prize is given out in (db tourney_award). */
export function shapeTourney(raw, flaggedIds = [], premiumIds = [], limit = TOURNEY.places) {
  const out = new Set(flaggedIds);
  const crown = new Set(premiumIds);
  return (raw || [])
    .filter(r => r.kind === 'user' && r.wins > 0 && !out.has(r.who.slice(2)))
    .slice(0, limit)
    .map(r => ({ nick: r.nick, wins: r.wins, ...(crown.has(r.who.slice(2)) ? { premium: true } : {}) }));
}

const TTL = 30_000;
let cache = { at: 0, rows: [] };

export async function tourneyBoard() {
  if (!dbEnabled) return [];
  if (Date.now() - cache.at < TTL) return cache.rows;
  try {
    const { data, error } = await supa.from('tourney_wins')
      .select('who, nick, kind, wins')
      .eq('tid', TOURNEY.id).eq('kind', 'user').gt('wins', 0)
      .order('wins', { ascending: false }).order('updated_at', { ascending: true })
      .limit(TOURNEY.places + 30);
    if (error) throw new Error(error.message);
    const ids = (data || []).map(r => r.who.slice(2));
    let flagged = [], premium = [];
    if (ids.length) {
      const { data: marks } = await supa.from('profiles').select('id, flagged, premium_until').in('id', ids);
      const nowIso = new Date().toISOString();
      flagged = (marks || []).filter(m => m.flagged).map(m => m.id);
      premium = (marks || []).filter(m => !m.flagged && m.premium_until && m.premium_until > nowIso).map(m => m.id);
    }
    const rows = shapeTourney(data, flagged, premium);
    cache = { at: Date.now(), rows };
    return rows;
  } catch (e) {
    console.error('tourneyBoard failed:', e.message);
    return cache.rows;
  }
}

/* My own line: wins so far and, for an account, the place they would finish
   in if it ended now. A guest gets their wins and no place. */
export async function myTourney({ userId, deviceId }) {
  if (!dbEnabled || (!userId && !deviceId)) return null;
  const who = userId ? `u:${userId}` : `d:${deviceId}`;
  try {
    const { data } = await supa.from('tourney_wins').select('wins, updated_at')
      .eq('tid', TOURNEY.id).eq('who', who).maybeSingle();
    const wins = data?.wins || 0;
    if (!userId) return { wins, rank: 0, guest: true };
    if (!wins) return { wins: 0, rank: 0 };
    const { count } = await supa.from('tourney_wins').select('who', { count: 'exact', head: true })
      .eq('tid', TOURNEY.id).eq('kind', 'user')
      .or(`wins.gt.${wins},and(wins.eq.${wins},updated_at.lt."${data.updated_at}")`);
    return { wins, rank: (count || 0) + 1 };
  } catch (e) {
    console.error('myTourney failed:', e.message);
    return null;
  }
}

// a guest signing in keeps the wins they already have
export async function claimTourneyWins(userId, deviceId, nick) {
  if (!dbEnabled || !userId || !deviceId) return;
  try {
    await supa.rpc('tourney_claim', { t: TOURNEY.id, old_who: `d:${deviceId}`, new_who: `u:${userId}`, n: String(nick || '?').slice(0, 40) });
  } catch (e) { console.error('claimTourneyWins failed:', e.message); }
}

/* The prize, after the end. The database does it in one transaction and only
   once (it checks for its own contracts first), so a second server, a restart
   or a retry cannot pay twice. Each prize is a 'manual' Premium contract, so
   it sits alongside any paid one and the longer of the two wins. */
let awarded = false;
export async function awardTourney(now = Date.now()) {
  if (!dbEnabled || awarded || now < TOURNEY.end) return;
  try {
    const { data, error } = await supa.rpc('tourney_award', { t: TOURNEY.id, places: TOURNEY.places, days: TOURNEY.days });
    if (error) throw new Error(error.message);
    awarded = true;
    console.log(data === -1 ? '[tourney] already awarded' : `[tourney] Premium given to ${data} players`);
  } catch (e) { console.error('[tourney] award failed:', e.message); }
}
