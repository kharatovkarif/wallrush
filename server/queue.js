/* ---------- writes that can wait a few seconds ----------

   On 17 September the database stopped answering for three and a half hours,
   in the middle of the evening peak. It was not one bad query: the logs showed
   thirty-five to forty-six thousand requests an hour, flat, all day — eleven a
   second, around the clock — and at nine in the evening it simply gave out.

   The shape of the problem is that the game writes to the database on every
   single event. A visit is three requests, a finished game is six. Sixty-eight
   thousand games in a day makes half a million requests, and every one of them
   is a separate round trip to Frankfurt.

   Most of those writes are counters, and a counter does not care whether it is
   written now or in eight seconds. So they are collected here and sent as one
   request per kind per flush. Three of them — the visit log, the match counter
   and the day's points — were forty per cent of all traffic on their own.

   What this trades away: a server that dies between flushes loses up to eight
   seconds of counters. Nobody's points, nobody's account, nobody's game —
   those still go straight through, because they are the things a player would
   notice losing. Only the tallies. That is a good trade for staying up. */

import * as realDb from './db.js';

/* The database this queue writes to. A seam, in the same spirit as the clock's:
   the suite cannot reach Frankfurt, and what needs proving here — that nothing
   is sent twice, that a flush in flight loses nothing, that one player's games
   add up into one row — is exactly the part worth holding. Nothing in the
   running server calls this. */
let db = realDb;
export function _setDbForTest(next) { db = next || realDb; }

const FLUSH_MS = 8_000;
// A cap, so a database that is away for an hour cannot turn into a burst that
// knocks it over again the moment it comes back — which is exactly what
// happened at 22:12, one minute after the restart.
const MAX_HELD = 4_000;

let visits = [];          // { device_id, kind }
let matches = [];         // mode
const days = new Map();   // who -> { day, who, nick, kind, points, wins, losses }
let dropped = 0;
let lastError = '';

export function logVisitLater(deviceId, kind = 'visit') {
  if (!db.dbEnabled || !deviceId) return;
  if (visits.length >= MAX_HELD) { dropped++; return; }
  visits.push({ device_id: deviceId, kind });
}

export function noteMatchLater(mode) {
  if (!db.dbEnabled) return;
  if (matches.length >= MAX_HELD) { dropped++; return; }
  matches.push(mode === 'race' || mode === 'quad' ? mode : 'duel');
}

/* Points for the day's board, added up per player before they are sent. Five
   games in eight seconds is one row written instead of five — which is where
   most of the saving is, because the same few hundred people are playing
   continuously. */
export function bumpDayLater(pl, delta, result = null) {
  if (!db.dbEnabled) return;
  const who = db.dayKeyOf(pl);
  if (!who || (!delta && !result)) return;
  const day = db.mskDay();
  const key = day + '|' + who;
  const row = days.get(key) || {
    d: day, w: who, n: String(pl.nick || '?').slice(0, 40),
    k: pl.isBot ? 'bot' : pl.userId ? 'user' : 'guest',
    dp: 0, win: 0, loss: 0,
  };
  row.n = String(pl.nick || row.n).slice(0, 40);   // a name changed mid-day follows the player
  row.dp += Math.round(delta || 0);
  if (result === 'win') row.win++;
  if (result === 'loss') row.loss++;
  days.set(key, row);
}

let flushing = false;

export async function flushWrites() {
  if (!db.dbEnabled || flushing) return;
  flushing = true;
  // Taken off the buffers first, so anything that arrives while this is in
  // flight lands in the next batch rather than being sent twice or lost.
  const v = visits; visits = [];
  const m = matches; matches = [];
  const d = [...days.values()]; days.clear();
  try {
    if (v.length) await db.supa.from('visit_log').insert(v);
    if (m.length) await db.supa.from('human_matches').insert(m.map(mode => ({ mode })));
    // One call each, still: the upsert has to add to what is already there,
    // which a bulk insert cannot do. Coalescing above is what makes this small.
    for (const r of d) await db.supa.rpc('day_points', r);
    lastError = '';
  } catch (e) {
    lastError = e.message || String(e);
    console.error('[flush]', lastError);
    // Not put back. A failed flush is a few seconds of counters; retrying into
    // a database that is already struggling is how the pile-up starts.
  } finally {
    flushing = false;
  }
}

export function startWriteQueue() {
  setInterval(() => { flushWrites().catch(() => {}); }, FLUSH_MS);
  // A last flush on the way out, so an ordinary restart keeps its counters.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { flushWrites().finally(() => process.exit(0)); });
  }
}

export const queueStatus = () => ({
  visitsHeld: visits.length,
  matchesHeld: matches.length,
  dayRowsHeld: days.size,
  dropped,
  lastError,
});
