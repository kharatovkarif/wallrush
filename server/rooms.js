// WallRush online rooms: lobby, matches, clocks, reconnect, rematch, emoji.
// Server is authoritative: it validates every move with the shared engine.
import { initialState, applyMove, eliminate, isAlive, aliveCount, playersIn } from '../public/js/engine.js';
import { pointsDelta, quadPointsDelta } from '../public/js/ranks.js';
import { streakState, canRestore, pendingStreak, freeRestore, localDay } from '../public/js/streak.js';
import { checkNick, randomNick } from '../public/js/nick.js';
import {
  verifyUser, getProfile, recordResult, recordBotResult, recordHumanMatch,
  getPoints, addPoints, addBotPoints, touchStreak,
  friendAdd, friendRemove, friendList, dailyState, dailyBump,
  friendFind, friendCount, friendRequestAdd, friendRequestAccept, friendRequestDecline, friendRequestsIn,
  recordQuadResult,
} from './db.js';
import { taskForDay, matchProgress } from '../public/js/daily.js';
import { initBots, fakeOnline, notifyUserWaiting, fillQuadRoom } from './bots.js';
import crypto from 'crypto';

const BANK_MS = 300_000;      // 5:00 per player per game
const MOVE_MS = 30_000;       // max per move
const GRACE_MS = 30_000;      // reconnect window

// The four-handed table. Everything about it is fixed: an 11x11 board, four
// seats, seven walls each, the same clock as everywhere else. There is nothing
// to choose, so the room has no settings.
const QUAD_SEATS = 4;
const isQuad = (room) => (room?.mode || 'duel') === 'quad';
const seatsOf = (room) => (isQuad(room) ? QUAD_SEATS : 2);
// Who else is at the table — one person in a duel, three in the four-handed
// game. Written this way so every broadcast reads the same in both.
const others = (room, idx) => room.players.filter((_, i) => i !== idx);
// A ceiling rather than a price: a list nobody can scroll is no use to
// anyone, and past a hundred names it is a directory, not friends.
const FRIEND_MAX = 100;
const EMOJIS = ['😂', '🫡', '🤝', '😡'];

const clients = new Map();   // ws -> client {ws, token, nick, userId, roomId, inLobby}
const byToken = new Map();   // token -> client

// A result the player never saw. If their socket was already dead when the
// match ended, game_over went nowhere and the board stayed frozen on their
// screen for as long as they were willing to look at it. Keep the result by
// token for a few minutes so a reconnect can still be told how it finished.
const lastResults = new Map();   // token -> { msg, at }
const RESULT_KEEP_MS = 5 * 60_000;

function keepResult(token, msg) {
  if (!token) return;
  lastResults.set(token, { msg, at: Date.now() });
  if (lastResults.size > 500) {
    const cut = Date.now() - RESULT_KEEP_MS;
    for (const [k, v] of lastResults) if (v.at < cut) lastResults.delete(k);
  }
}

// One-shot: a result is handed over once and then forgotten.
function takeResult(token) {
  const r = token ? lastResults.get(token) : null;
  if (!r) return null;
  lastResults.delete(token);
  return Date.now() - r.at > RESULT_KEEP_MS ? null : r.msg;
}
const rooms = new Map();     // roomId -> room

function rid() { return crypto.randomBytes(8).toString('hex'); }
function roomCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += abc[crypto.randomInt(abc.length)];
  return s;
}

function send(client, msg) {
  if (client.ws && client.ws.readyState === 1) {
    client.ws.send(JSON.stringify(msg));
  }
}

/* A table's news goes only to the people still sitting at it.

   Leaving a four-handed game does not take you out of room.players — the seat
   numbers are positions in that array, and the game is still being played by
   the others, so nothing may shift. But the player who walked away kept being
   sent everything that happened afterwards: the other three's moves, who else
   dropped out, and finally the result of a game they were no longer in. On
   their screen, sitting at a NEW table, that arrived as somebody else's
   opponent disconnecting and somebody else's defeat.

   Membership is the test, not presence in the array. */
const stillHere = (room, pl) => Boolean(pl) && pl.roomId === room.id;
function tell(room, pl, msg) {
  if (!stillHere(room, pl)) return;
  send(pl, msg);
}

/* Work that runs on a timer has nobody to report to. Left bare, one throw
   inside a setTimeout takes the whole game server with it and every live match
   in memory goes with it. These two say what happened and let the rest keep
   playing. */
export function guard(what, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      out.catch(e => console.error(`[${what}]`, e && e.stack ? e.stack : e));
    }
    return out;
  } catch (e) {
    console.error(`[${what}]`, e && e.stack ? e.stack : e);
    return null;
  }
}

function lobbyRooms() {
  const list = [];
  for (const room of rooms.values()) {
    if (room.status === 'open' && !room.code) {
      list.push({
        id: room.id, nick: room.players[0].nick, points: room.players[0].points || 0,
        mode: room.mode || 'duel', walls: room.walls || 10, time: room.time || '5',
        // a four-handed room is worth joining at 3/4 and pointless at 4/4, so
        // the list has to say which it is
        seats: seatsOf(room), taken: room.players.length,
      });
    }
  }
  return list;
}

// bots inflate the visible counter so the lobby always feels populated
function onlineCount() { return clients.size + fakeOnline(); }
// Who is signed in and connected right now. The evening notification uses it
// to say "your friend is playing" only when they actually are.
export function onlineUserIds() {
  const ids = new Set();
  for (const c of clients.values()) if (c.userId) ids.add(c.userId);
  return ids;
}

export function realOnline() { return clients.size; } // for the owner's admin page

function broadcastLobby() {
  const msg = { t: 'lobby', rooms: lobbyRooms(), online: onlineCount() };
  for (const c of clients.values()) if (c.inLobby) send(c, msg);
}

function clockPayload(room) {
  return {
    bank: room.bank,
    turn: room.state.turn,
    moveLimit: MOVE_MS,
    turnStarted: room.turnStarted,
    serverNow: Date.now(),
    noTime: Boolean(room.noTime), // no bank — only the 30s per-move rule
    paused: Boolean(room.paused), // waiting for a disconnected opponent
  };
}

// The clock must not run down the player who stayed. The reconnect window and
// the per-move limit are both thirty seconds, so waiting out an opponent's
// disconnect cost exactly one move — and with any of that move already spent,
// the one who waited lost on time before the other's window had even closed.
// Losing points for being the one who stayed is the wrong way round.
//
// Time already spent on this turn is charged to the bank first, so dropping
// the connection cannot win a move back for free. The turn then restarts, so
// whoever is on move gets a whole one once both are present again.
function pauseClock(room) {
  if (room.status !== 'playing' || room.paused) return;
  clearTimeout(room.moveTimer);
  const p = room.state.turn;
  room.bank[p] = Math.max(0, room.bank[p] - (Date.now() - room.turnStarted));
  room.turnStarted = Date.now();   // a move made while paused is charged from here
  room.paused = true;
}

function resumeClock(room) {
  if (room.status !== 'playing' || !room.paused) return;
  room.paused = false;
  room.turnStarted = Date.now();
  armMoveTimer(room);
}

function stateMsg(room) {
  return { t: 'state', room: room.id, state: room.state, clocks: clockPayload(room) };
}

// Who is at the table, in seat order. The duel keeps its `opp` field so that
// nothing on the two-player path had to change; the four-handed screen draws
// itself from this list.
function seatList(room) {
  return room.players.map((pl, i) => ({
    seat: i,
    nick: pl.nick,
    points: pl.points || 0,
    id: pl.userId || null,
    bot: Boolean(pl.isBot),
  }));
}

function startMsg(room, i, extra = {}) {
  const pl = room.players[i];
  const msg = {
    t: 'game_start',
    room: room.id,
    you: i,
    state: room.state,
    clocks: clockPayload(room),
    players: seatList(room),
    me: { points: pl.points || 0, veteran: Boolean(pl.veteran) },
    ranked: isRanked(room),
    ...extra,
  };
  if (!isQuad(room)) {
    const o = room.players[1 - i];
    // so the winner can offer to add them as a friend
    msg.opp = { nick: o.nick, points: o.points || 0, id: o.userId || null };
  }
  return msg;
}

function startGame(room) {
  const n = seatsOf(room);
  room.state = initialState(room.mode || 'duel', { walls: room.walls });
  room.state.turn = crypto.randomInt(n); // random first move
  // no-time rooms get a huge bank that never runs out — only the 30s move cap
  const bankMs = room.noTime ? 8_640_000_000 : (room.bankMs || BANK_MS);
  room.bank = new Array(n).fill(bankMs);
  room.status = 'playing';
  room.played = (room.played || 0) + 1;
  room.moves = 0;
  room.out = {};            // seat -> why they are no longer playing
  room.rematch = new Array(n).fill(false);
  room.turnStarted = Date.now();
  armMoveTimer(room);
  room.players.forEach((pl, i) => send(pl, startMsg(room, i)));
  broadcastLobby();
}

/* How long the server waits past the limit before calling a move too late.

   A player is charged for their connection twice. The message saying it is
   their turn takes time to reach them, and their move takes the same time to
   travel back — so someone who presses with a second still on their screen can
   arrive after the deadline. The clock they see is honest about the first half
   of that trip; nothing gave them back the second.

   It used to be a flat 250ms, which is nothing on a mobile network. Now each
   player gets their own round trip back, measured from the heartbeat, up to
   two seconds. A fast connection sees no change. A slow one stops losing
   games it played in time. Two extra seconds win nobody a match, so there is
   nothing here to abuse. */
const MOVE_GRACE_MIN = 250;
const MOVE_GRACE_MAX = 2000;
export const moveGrace = (rtt) =>
  Math.min(MOVE_GRACE_MAX, Math.max(MOVE_GRACE_MIN, Math.round(rtt) || 0));

function armMoveTimer(room) {
  clearTimeout(room.moveTimer);
  const p = room.state.turn;
  const ms = Math.min(MOVE_MS, room.bank[p]);
  const grace = moveGrace(room.players[p]?.rtt);
  room.moveTimer = setTimeout(() => guard('move-timeout', () => {
    const reason = room.bank[p] <= MOVE_MS ? 'timeout' : 'move_timeout';
    // A duel ends here. At a table of four the game does not stop because one
    // person stopped: that seat is emptied and the other three play on.
    if (isQuad(room)) return knockOut(room, p, reason);
    return finish(room, 1 - p, reason);
  }), ms + grace);
}

/* Empty a seat. The pawn comes off the board, the walls that player built stay
   where they are — the others have been playing around them — and the turn
   moves on to whoever is next. When only one player is left, that is the win.

   reason: 'move_timeout' | 'timeout' | 'resign' | 'left' */
function knockOut(room, idx, reason) {
  if (room.status !== 'playing' || !isAlive(room.state, idx)) return;
  room.out = room.out || {};
  room.out[idx] = reason;
  eliminate(room.state, idx);
  clearTimeout(room.moveTimer);
  for (const pl of room.players) {
    tell(room, pl, { t: 'player_out', room: room.id, seat: idx, reason, left: aliveCount(room.state) });
  }
  if (room.state.winner !== null) {
    for (const pl of room.players) tell(room, pl, stateMsg(room));
    guard('finish', () => finish(room, room.state.winner, 'last_standing'));
    return;
  }
  room.turnStarted = Date.now();
  if (!room.paused) armMoveTimer(room);
  for (const pl of room.players) tell(room, pl, stateMsg(room));
}

// Private rooms are practice. Two friends sharing a code could otherwise trade
// wins all evening and walk out as Legends.
function isRanked(room) { return !room.code; }

// The handshake's Origin must name this same site. Bots run in-process and
// have no request at all, so they are trusted by definition. Ports are ignored
// because the proxy in front of the app terminates TLS on a different one.
let untrustedSeen = 0;
function sameOrigin(req) {
  if (!req) return true;
  const origin = req.headers?.origin;
  const host = req.headers?.host;
  let ok = false;
  try {
    ok = Boolean(origin && host) && new URL(origin).hostname === host.split(':')[0];
  } catch {
    ok = false;
  }
  // Logged so a proxy that rewrites these headers shows up as a flood right
  // after a deploy, rather than as players quietly not scoring.
  if (!ok && ++untrustedSeen % 20 === 1) {
    console.warn(`ws: unscored connection #${untrustedSeen} (origin=${origin || 'none'} host=${host || 'none'})`);
  }
  return ok;
}

// Rematches against the same person pay less and then nothing, so a pair that
// finds each other in the public lobby cannot pump each other up either.
function rematchFactor(room) {
  const n = room.played || 1;
  if (n <= 3) return 1;
  if (n <= 6) return 0.5;
  return 0;
}

/* ---------- task of the day ----------
   Sent when a player arrives and again after every match that moves it. The
   client only draws what it is told: which task, how far along, and whether
   the reward has just landed. */

async function sendDaily(pl) {
  if (pl.isBot || !pl.ws) return;
  const day = localDay(pl.tzOffset || 0);
  const task = taskForDay(day);
  const st = await dailyState({ userId: pl.userId, deviceId: pl.deviceId }, day);
  send(pl, {
    t: 'daily', task: task.id, target: task.target, reward: task.reward,
    progress: st && st.taskId === task.id ? st.progress : 0,
    done: Boolean(st && st.taskId === task.id && st.done),
  });
}

async function bumpDaily(room, pl, won) {
  if (pl.isBot || !pl.ws) return;
  // A match decided in a handful of moves is a machine farming, not a game.
  // Points already refuse to count those, and so does the task.
  if ((room.moves || 0) < (isQuad(room) ? MIN_QUAD_MOVES : MIN_RANKED_MOVES)) return;
  const day = localDay(pl.tzOffset || 0);
  const task = taskForDay(day);
  const idx = room.players.indexOf(pl);
  // "beat someone above you" and "beat a person, not a bot" both need one
  // opponent to point at. In a duel that is the other player; at a table of
  // four it is the strongest of the three, and the table counts as human if
  // any real person was sitting at it.
  const rest = others(room, idx);
  const opp = rest.reduce((a, b) => ((b.points || 0) > (a?.points || 0) ? b : a), rest[0]);
  const inc = matchProgress(task, {
    won,
    walls: (room.state.walls || []).filter(w => w.by === idx).length,
    myPoints: pl.points || 0,
    oppPoints: opp?.points || 0,
    oppIsBot: rest.every(o => o.isBot),
    quad: isQuad(room),
  });
  if (!inc) return;
  const st = await dailyBump({ userId: pl.userId, deviceId: pl.deviceId }, day, task.id, inc, task.target);
  if (!st) return;
  if (st.awardedNow) {
    pl.points = (pl.points || 0) + task.reward;
    persistPoints(pl, task.reward);
  }
  send(pl, {
    t: 'daily', task: task.id, target: task.target, reward: task.reward,
    progress: st.progress, done: st.done, justDone: st.awardedNow,
    points: st.awardedNow ? pl.points : undefined,
  });
}

function persistPoints(pl, delta) {
  if (!delta) return;
  if (pl.isBot) addBotPoints(pl.nick, delta);
  else addPoints({ userId: pl.userId, deviceId: pl.deviceId }, delta);
}

// Updates the in-memory totals straight away so the game_over message is
// already correct, and writes to the database in the background.
const MIN_RANKED_MOVES = 6;

/* A four-handed game pays one winner and charges three losers. The winner's
   number is measured against the strongest player at the table — winning a
   table with a higher-ranked player in it is the harder thing to do — and each
   loser is charged against the winner. Walking out costs more than losing.

   Six moves is enough to know a duel was played; at a table of four it is not
   even two moves each, so that floor is raised in step with the seats. */
const MIN_QUAD_MOVES = 16;

function awardQuadPoints(room, winnerIdx) {
  const n = room.players.length;
  const deltas = new Array(n).fill(0);
  if (!isRanked(room)) return deltas;
  if ((room.moves || 0) < MIN_QUAD_MOVES) return deltas;
  const w = room.players[winnerIdx];
  if (w.fromPage === false) return deltas;   // won from outside the game itself
  const field = Math.max(...room.players.map((pl, i) => (i === winnerIdx ? 0 : pl.points || 0)));
  const dw = quadPointsDelta(w.points || 0, field, 'win');
  w.points = (w.points || 0) + dw;
  deltas[winnerIdx] = dw;
  persistPoints(w, dw);
  for (let i = 0; i < n; i++) {
    if (i === winnerIdx) continue;
    const pl = room.players[i];
    const why = room.out?.[i];
    const outcome = (why === 'left' || why === 'resign') ? 'quit' : 'loss';
    const before = pl.points || 0;
    const raw = quadPointsDelta(before, w.points || 0, outcome);
    pl.points = Math.max(0, before + raw);   // a beginner never digs a hole
    deltas[i] = pl.points - before;          // report what was really lost
    persistPoints(pl, deltas[i]);
  }
  return deltas;
}

function awardPoints(room, w, l) {
  const deltas = [0, 0];
  const factor = isRanked(room) ? rematchFactor(room) : 0;
  if (!factor) return deltas;
  // Automation farms points by starting a game and winning it in seconds.
  // No genuine match is decided in fewer than six moves, so below that the
  // result stands but nothing is scored.
  if ((room.moves || 0) < MIN_RANKED_MOVES) return deltas;
  const wp = w.points || 0, lp = l.points || 0;
  const dw = Math.round(pointsDelta(wp, lp, true) * factor);
  const dl = Math.round(pointsDelta(lp, wp, false) * factor);
  if (w.fromPage === false) return deltas;  // won from outside the game itself
  w.points = wp + dw;
  l.points = Math.max(0, lp + dl);          // a beginner never digs a hole
  deltas[room.players.indexOf(w)] = dw;
  deltas[room.players.indexOf(l)] = l.points - lp;  // report what was really lost
  persistPoints(w, deltas[room.players.indexOf(w)]);
  persistPoints(l, deltas[room.players.indexOf(l)]);
  return deltas;
}

async function finish(room, winnerIdx, reason) {
  if (room.status !== 'playing') return;
  room.status = 'over';
  clearTimeout(room.moveTimer);
  for (const pl of room.players) clearTimeout(pl.graceTimer);
  const quad = isQuad(room);
  const w = room.players[winnerIdx];
  const losers = others(room, winnerIdx);
  const deltas = quad ? awardQuadPoints(room, winnerIdx)
                      : awardPoints(room, w, room.players[1 - winnerIdx]);
  room.players.forEach((pl, i) => {
    const payload = {
      t: 'game_over', room: room.id, winner: winnerIdx, you: i, reason,
      points: { delta: deltas[i], total: pl.points || 0, ranked: isRanked(room) },
    };
    if (quad) {
      // At a table of four the headline reason is how the game ended; each
      // player also needs to know why THEY are no longer in it, which may be
      // something else entirely.
      payload.out = { ...(room.out || {}) };
      payload.yourReason = room.out?.[i] || (i === winnerIdx ? 'goal' : reason);
      payload.players = seatList(room);
    }
    if (!pl.isBot) keepResult(pl.token, payload);
    tell(room, pl, payload);
  });
  // The streak needs a database round trip, so it follows the result rather
  // than holding it up — the result overlay only appears after 600ms anyway.
  for (const pl of room.players) {
    if (pl.isBot) continue;
    touchStreak({ userId: pl.userId, deviceId: pl.deviceId }, localDay(pl.tzOffset || 0))
      .catch(e => { console.error('[streak]', e && e.stack ? e.stack : e); return null; })
      .then((st) => {
        if (!st) return;
        pl.streak = st.streak;
        pl.streakBest = st.best;
        pl.streakToday = true;   // the match just played is today's
        pl.streakState = 'today';
        pl.streakLost = 0;
        send(pl, { t: 'streak', streak: st.streak, best: st.best, advanced: st.advanced, froze: st.froze });
      });
  }
  // The task of the day follows the result rather than holding it up.
  guard('daily', () => bumpDaily(room, w, true));
  for (const pl of losers) guard('daily', () => bumpDaily(room, pl, false));
  if (quad) {
    if (w.userId || losers.some(pl => pl.userId)) {
      await recordQuadResult(w.userId || null, losers.map(pl => pl.userId || null));
    }
  } else if (w.userId || losers[0].userId) {
    await recordResult(w.userId || null, losers[0].userId || null);
  }
  if (w.isBot) recordBotResult(w.nick, true);
  for (const pl of losers) if (pl.isBot) recordBotResult(pl.nick, false);
  // real people on every seat → a genuine human-vs-human match
  if (!w.isBot && losers.every(pl => !pl.isBot)) recordHumanMatch(room.mode || 'duel');
}

function destroyRoom(room) {
  clearTimeout(room.moveTimer);
  for (const pl of room.players) {
    clearTimeout(pl.graceTimer);
    if (pl.roomId === room.id) pl.roomId = null;
  }
  rooms.delete(room.id);
  broadcastLobby();
}

/* The four-handed waiting room. Everyone sitting in it sees the same thing —
   who is already here and how many seats are left — so it is one message sent
   to all of them rather than a count each client works out for itself. */
function sendRoomWait(room) {
  if (!isQuad(room) || room.status !== 'open') return;
  const msg = {
    t: 'room_wait',
    room: room.id,
    seats: seatsOf(room),
    players: room.players.map(pl => ({ nick: pl.nick, points: pl.points || 0, bot: Boolean(pl.isBot) })),
    code: room.code || null,
  };
  for (const pl of room.players) tell(room, pl, msg);
}

function leaveRoom(client, notifyOpp = true) {
  const room = rooms.get(client.roomId);
  client.roomId = null;
  if (!room) return;
  const idx = room.players.indexOf(client);
  if (idx === -1) return;
  if (room.status === 'open') {
    // A four-handed room is still filling up. Someone who came and changed
    // their mind simply frees the seat; only the person who opened it can
    // take the room away with them.
    if (isQuad(room) && idx > 0) {
      room.players.splice(idx, 1);
      sendRoomWait(room);
      broadcastLobby();
      return;
    }
    for (const pl of room.players) {
      if (pl !== client && pl.roomId === room.id) {
        pl.roomId = null;
        send(pl, { t: 'room_closed' });
      }
    }
    destroyRoom(room);
    return;
  }
  if (room.status === 'playing') {
    // Leaving a live game of four empties that seat; the other three play on.
    if (isQuad(room)) knockOut(room, idx, 'left');
    else guard('finish', () => finish(room, 1 - idx, 'opponent_left'));
  } else if (room.status === 'over' && notifyOpp && !isQuad(room)) {
    const opp = room.players[1 - idx];
    if (opp.roomId === room.id) send(opp, { t: 'rematch_declined' });
  }
  // keep room until everyone leaves
  if (room.players.every(p => p.roomId !== room.id)) destroyRoom(room);
}

function joinRoom(client, room) {
  if (room.status !== 'open') { send(client, { t: 'error', code: 'room_full' }); return; }
  if (room.players.includes(client)) return;
  if (room.players.length >= seatsOf(room)) { send(client, { t: 'error', code: 'room_full' }); return; }
  if (client.roomId && client.roomId !== room.id) leaveRoom(client, false);
  room.players.push(client);
  client.roomId = room.id;
  client.inLobby = false;
  if (room.players.length >= seatsOf(room)) { startGame(room); return; }
  // still short of a full table: show everyone who is here so far
  sendRoomWait(room);
  broadcastLobby();
}

// opts: {mode:'duel'|'race'|'quad', walls, time:'0'|'3'|'5'}
// duel is always 10 walls; race offers 10 or 15; time '0' = no bank, 30s/move.
// The four-handed table has nothing to choose: 7 walls, five minutes, always.
function createRoom(client, isPrivate, opts = {}) {
  if (client.roomId) leaveRoom(client, false);
  const mode = ['race', 'quad'].includes(opts.mode) ? opts.mode : 'duel';
  const quad = mode === 'quad';
  const walls = quad ? 7 : mode === 'race' ? (Number(opts.walls) === 10 ? 10 : 15) : 10;
  const time = quad ? '5'
    : ['0', '3', '5'].includes(String(opts.time)) ? String(opts.time) : '5';
  const room = {
    id: rid(),
    code: isPrivate ? roomCode() : null,
    mode,
    walls,
    time,
    noTime: time === '0',
    bankMs: time === '3' ? 180_000 : 300_000,
    players: [client],
    status: 'open',
    state: null,
    bank: null,
    moveTimer: null,
    rematch: new Array(quad ? QUAD_SEATS : 2).fill(false),
    turnStarted: 0,
    openedAt: Date.now(),
  };
  rooms.set(room.id, room);
  client.roomId = room.id;
  send(client, { t: 'room_created', roomId: room.id, code: room.code, mode, seats: seatsOf(room) });
  if (quad) sendRoomWait(room);
  broadcastLobby();
}

async function handleHello(client, msg) {
  // resolve identity: registered user (JWT) or guest nick. A guest never signs
  // up, so this is the only place their name is checked — and the socket is
  // reachable without the page, so it cannot be left to the client.
  let nick = String(msg.nick || '').slice(0, 16);
  if (checkNick(nick)) nick = randomNick(() => crypto.randomInt(0, 1e6) / 1e6);
  let userId = null;
  // A pass that was sent and did not check out is worth saying out loud. It
  // used to be swallowed: the player stayed signed in as far as their screen
  // was concerned while every point they won went to the device instead of
  // their account, and the first they knew of it was "Rookie, 40 points".
  let authFailed = false;
  if (msg.jwt) {
    const user = await verifyUser(msg.jwt);
    if (user) {
      userId = user.id;
      const profile = await getProfile(user.id);
      if (profile?.nick) nick = profile.nick;
    } else {
      authFailed = true;
    }
  }
  client.nick = nick;
  client.userId = userId;
  // The device id is the only identity 94% of players ever have, so it is what
  // carries a guest's ladder points between sessions.
  const dev = String(msg.device || '');
  client.deviceId = /^[A-Za-z0-9-]{8,64}$/.test(dev) ? dev : null;
  // The browser's own offset decides when the player's day rolls over — a
  // streak that turns at Moscow midnight is meaningless in Tehran.
  const off = Number(msg.tz);
  client.tzOffset = Number.isFinite(off) && Math.abs(off) <= 840 ? off : 0;
  const pts = await getPoints({ userId, deviceId: client.deviceId });
  client.points = pts.points;
  client.veteran = pts.veteran;
  client.streakBest = pts.streakBest;
  // Alive is not the same as safe, and lost is not the same as gone. The
  // client draws all of it, so it gets the state rather than a boolean.
  const today = localDay(client.tzOffset);
  const state = streakState(pts.streakDay, today);
  client.streakState = state;
  client.streak = state === 'lost' ? 0 : pts.streak;
  client.streakToday = state === 'today';
  // A broken streak stays on offer for a week. The number can be sitting in
  // either column depending on whether a game has been played since it broke.
  const pending = pendingStreak(
    { streak: pts.streak, streak_prev: pts.streakPrev, streak_day: pts.streakDay }, today);
  client.streakLost = canRestore(pts.streakDay, today, pending) ? pending : 0;
  // Whether this month's free restore is still there. The player is never
  // shown this — it only decides whether an ad plays before the streak comes
  // back, and from their side the button reads the same either way.
  client.streakFree = freeRestore(pts.freezeMonth, today);

  // reconnect to a live game?
  if (msg.token && byToken.has(msg.token)) {
    const old = byToken.get(msg.token);
    if (old !== client) {
      client.token = old.token;
      client.roomId = old.roomId;
      client.nick = old.nick;
      client.userId = old.userId;
      client.deviceId = old.deviceId ?? client.deviceId;
      client.points = old.points ?? client.points;
      client.veteran = old.veteran ?? client.veteran;
      client.streak = old.streak ?? client.streak;
      client.streakBest = old.streakBest ?? client.streakBest;
      client.tzOffset = old.tzOffset ?? client.tzOffset;
      client.rtt = old.rtt || client.rtt;   // their connection did not change
      byToken.set(client.token, client);
      clients.delete(old.ws);
      const room = rooms.get(client.roomId);
      if (room) {
        const idx = room.players.indexOf(old);
        if (idx !== -1) {
          room.players[idx] = client;
          clearTimeout(old.graceTimer);
          if (room.status === 'playing') {
            resumeClock(room);   // everyone is here again, so time counts again
            send(client, startMsg(room, idx, { resumed: true }));
            // the ones who waited need the restarted clock too, or their screen
            // keeps counting down a turn the server has already given back
            for (const o of others(room, idx)) {
              tell(room, o, { t: 'opp_reconnected', room: room.id, seat: idx, nick: client.nick, clocks: clockPayload(room) });
            }
          } else if (room.status === 'open') {
            sendRoomWait(room);
          }
        }
      }
    }
  }
  if (!client.token) {
    client.token = rid();
    byToken.set(client.token, client);
  }
  // Their match ended while they were disconnected, so the result went to a
  // socket nobody was listening on. Hand it over now — but never on top of a
  // game that is still running, or a stale result would end a live one.
  const liveRoom = rooms.get(client.roomId);
  const missed = (!liveRoom || liveRoom.status !== 'playing') ? takeResult(msg.token) : null;

  send(client, {
    t: 'hello_ok', token: client.token, nick: client.nick, online: onlineCount(),
    authFailed,
    points: client.points || 0, veteran: Boolean(client.veteran),
    streak: client.streak || 0, streakBest: client.streakBest || 0,
    streakToday: Boolean(client.streakToday),
    streakState: client.streakState || 'none',
    streakLost: client.streakLost || 0,
    streakFree: Boolean(client.streakFree),
  });
  if (missed) send(client, missed);
  guard('daily', () => sendDaily(client));
}

function handleMove(client, msg) {
  const room = rooms.get(client.roomId);
  if (!room || room.status !== 'playing') return;
  const idx = room.players.indexOf(client);
  if (idx === -1 || room.state.turn !== idx) return;

  const elapsed = Date.now() - room.turnStarted;
  room.bank[idx] = Math.max(0, room.bank[idx] - elapsed);

  const move = msg.move || {};
  const ok = applyMove(room.state, {
    type: move.type, r: move.r | 0, c: move.c | 0, o: move.o,
  });
  if (!ok) {
    send(client, { t: 'error', code: 'bad_move' });
    send(client, stateMsg(room));
    return;
  }
  room.moves = (room.moves || 0) + 1;
  if (move.type === 'wall') {
    room.state.walls[room.state.walls.length - 1].by = idx; // for wall colors on clients
  }
  if (room.state.winner !== null) {
    for (const pl of room.players) tell(room, pl, stateMsg(room));
    guard('finish', () => finish(room, room.state.winner, 'goal'));
    return;
  }
  room.turnStarted = Date.now();
  // While the room is paused nobody is waiting on the other side, so the
  // 30s move limit must not start running against a player who is not there
  // to see the move. resumeClock() arms it when they are back.
  if (!room.paused) armMoveTimer(room);
  for (const pl of room.players) tell(room, pl, stateMsg(room));
}

function handleRematch(client, msg) {
  const room = rooms.get(client.roomId);
  if (!room || room.status !== 'over') return;
  // Four people all agreeing to go again is a wait nobody sits through. The
  // four-handed result screen offers a fresh table instead of a rematch.
  if (isQuad(room)) { leaveRoom(client, false); return; }
  const idx = room.players.indexOf(client);
  if (idx === -1) return;
  if (!msg.yes) {
    send(room.players[1 - idx], { t: 'rematch_declined' });
    leaveRoom(client, false);
    return;
  }
  room.rematch[idx] = true;
  const opp = room.players[1 - idx];
  if (opp.roomId !== room.id) { send(client, { t: 'rematch_declined' }); return; }
  if (room.rematch[0] && room.rematch[1]) {
    startGame(room);
  } else {
    send(opp, { t: 'rematch_offer' });
  }
}

const emojiLast = new WeakMap();
function handleEmoji(client, msg) {
  if (!EMOJIS.includes(msg.e)) return;
  const now = Date.now();
  if (now - (emojiLast.get(client) || 0) < 1000) return; // 1/sec throttle
  emojiLast.set(client, now);
  const room = rooms.get(client.roomId);
  if (!room || room.status === 'open') return;
  const idx = room.players.indexOf(client);
  if (idx === -1) return;
  for (const o of others(room, idx)) tell(room, o, { t: 'emoji', room: room.id, e: msg.e, seat: idx });
}

export function attachWs(wss) {
  initBots({
    rooms,
    joinRoom,
    createRoom,
    leaveRoom,
    handleMove,
    handleRematch,
    handleEmoji,
    broadcastLobby,
    resign(client) {
      const room = rooms.get(client.roomId);
      if (room && room.status === 'playing') {
        const idx = room.players.indexOf(client);
        if (idx === -1) return;
        if (isQuad(room)) knockOut(room, idx, 'resign');
        else guard('finish', () => finish(room, 1 - idx, 'resign'));
      }
    },
    sendRoomWait,
    seatsOf,
  });

  wss.on('connection', (ws, req) => {
    const client = { ws, token: null, nick: '', userId: null, roomId: null, inLobby: false,
                     graceTimer: null, alive: true, rtt: 0, pingAt: 0 };
    // A browser always sends Origin on a WebSocket handshake; a script talking
    // to the socket directly usually does not, and the worst point farmers had
    // never loaded the page at all. Rather than refuse the connection — which
    // would risk locking out a real player over a header — the game is played
    // normally and simply scores nothing.
    client.fromPage = sameOrigin(req);
    clients.set(ws, client);

    ws.on('pong', () => {
      client.alive = true;
      // the heartbeat doubles as a latency measure: smoothed, so one slow
      // packet does not hand somebody five free seconds
      if (client.pingAt) {
        const sample = Date.now() - client.pingAt;
        client.rtt = client.rtt ? Math.round(client.rtt * 0.6 + sample * 0.4) : sample;
        client.pingAt = 0;
      }
    });

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString().slice(0, 4096)); } catch { return; }
      try {
        switch (msg.t) {
          case 'hello': await handleHello(client, msg); break;
          case 'lobby_sub':
            client.inLobby = true;
            send(client, { t: 'lobby', rooms: lobbyRooms(), online: onlineCount() });
            break;
          case 'lobby_unsub': client.inLobby = false; break;
          case 'create_room': {
            createRoom(client, Boolean(msg.private), { mode: msg.mode, walls: msg.walls, time: msg.time });
            const fresh = rooms.get(client.roomId);
            if (client.isBot) break;
            if (isQuad(fresh)) fillQuadRoom(fresh);      // three seats to fill
            else if (!msg.private) notifyUserWaiting(fresh, 8000 + Math.random() * 22_000);
            break;
          }
          case 'join_room': {
            const room = rooms.get(String(msg.roomId || ''));
            if (!room || room.code) send(client, { t: 'error', code: 'room_not_found' });
            else joinRoom(client, room);
            break;
          }
          case 'join_code': {
            const code = String(msg.code || '').trim().toUpperCase();
            const room = [...rooms.values()].find(r => r.code === code && r.status === 'open');
            if (!room) send(client, { t: 'error', code: 'room_not_found' });
            else joinRoom(client, room);
            break;
          }
          case 'quick': {
            const mode = msg.mode === 'race' ? 'race' : 'duel';
            const opens = [...rooms.values()].filter(r =>
              r.status === 'open' && !r.code && (r.mode || 'duel') === mode && r.players[0] !== client);
            // prefer a real human's room over a bot's, so live players meet live players
            const open = opens.find(r => !r.players[0].isBot) || opens[0];
            if (open) joinRoom(client, open);
            else {
              createRoom(client, false, { mode });
              // quick match should feel quick — a bot arrives within seconds
              notifyUserWaiting(rooms.get(client.roomId), 2500 + Math.random() * 4500);
            }
            break;
          }
          case 'leave_room': leaveRoom(client); break;
          case 'move': handleMove(client, msg); break;

          /* ---------- friends ----------
             Only between accounts: a guest has no lasting name, so there is
             nobody on the other side of the friendship tomorrow. */
          case 'friend_add': {
            const id = String(msg.id || '');
            if (!client.userId || !id || id === client.userId) break;
            if (await friendCount(client.userId) >= FRIEND_MAX) {
              send(client, { t: 'error', code: 'friends_full' });
              break;
            }
            if (await friendAdd(client.userId, id)) {
              send(client, { t: 'friend_added', id });
              // tell them, if they are here to hear it
              for (const c of clients.values()) {
                if (c.userId === id) send(c, { t: 'friend_added_you', nick: client.nick });
              }
            }
            break;
          }
          /* Looking someone up by the name they play under. Exact match
             only: a search that lists half-matching strangers is a way to
             pester people rather than a way to find the one you just met. */
          case 'friend_search': {
            if (!client.userId) { send(client, { t: 'friend_found', found: null }); break; }
            const q = String(msg.nick || '').trim().slice(0, 32);
            if (q.length < 2) { send(client, { t: 'friend_found', found: null }); break; }
            const row = await friendFind(q, client.userId);
            send(client, {
              t: 'friend_found',
              found: row ? {
                id: row.id, nick: row.nick, points: row.points || 0, streak: row.streak || 0,
                already: Boolean(row.already), pending: Boolean(row.pending),
                online: [...clients.values()].some(c => c.userId === row.id),
              } : null,
            });
            break;
          }
          /* A stranger found by name gets asked, not added. Someone you have
             just played is added outright — you were both there. */
          case 'friend_request': {
            const id = String(msg.id || '');
            if (!client.userId || !id || id === client.userId) break;
            if (await friendCount(client.userId) >= FRIEND_MAX) {
              send(client, { t: 'error', code: 'friends_full' });
              break;
            }
            await friendRequestAdd(client.userId, id);
            send(client, { t: 'friend_requested', id });
            for (const c of clients.values()) {
              if (c.userId === id) send(c, { t: 'friend_request_in', nick: client.nick });
            }
            break;
          }
          case 'friend_requests': {
            if (!client.userId) { send(client, { t: 'friend_requests', list: [] }); break; }
            const list = await friendRequestsIn(client.userId);
            send(client, {
              t: 'friend_requests',
              list: list.map(r => ({ id: r.id, nick: r.nick, points: r.points || 0, streak: r.streak || 0 })),
            });
            break;
          }
          case 'friend_answer': {
            const id = String(msg.id || '');
            if (!client.userId || !id) break;
            if (msg.yes) {
              if (await friendCount(client.userId) >= FRIEND_MAX) {
                send(client, { t: 'error', code: 'friends_full' });
                break;
              }
              await friendRequestAccept(client.userId, id);
              for (const c of clients.values()) {
                if (c.userId === id) send(c, { t: 'friend_added_you', nick: client.nick });
              }
            } else {
              await friendRequestDecline(client.userId, id);
            }
            send(client, { t: 'friend_answered', id, yes: Boolean(msg.yes) });
            break;
          }
          case 'friend_remove': {
            const id = String(msg.id || '');
            if (!client.userId || !id) break;
            await friendRemove(client.userId, id);
            send(client, { t: 'friend_removed', id });
            break;
          }
          case 'friends': {
            if (!client.userId) { send(client, { t: 'friends', list: [] }); break; }
            const list = await friendList(client.userId);
            const busy = new Set();
            const here = new Set();
            for (const c of clients.values()) {
              if (!c.userId) continue;
              here.add(c.userId);
              if (c.roomId) busy.add(c.userId);
            }
            send(client, {
              t: 'friends',
              list: list.map(f => ({
                id: f.id, nick: f.nick, points: f.points || 0, streak: f.streak || 0,
                wins: f.wins || 0, losses: f.losses || 0,
                online: here.has(f.id), busy: busy.has(f.id),
              })),
            });
            break;
          }
          /* Calling a friend opens a private room with the settings you played
             last — they came to play, not to fill in a form — and hands them
             the code directly instead of making you send it. */
          case 'friend_call': {
            const id = String(msg.id || '');
            if (!client.userId || !id) break;
            const target = [...clients.values()].find(c => c.userId === id && !c.roomId);
            if (!target) { send(client, { t: 'error', code: 'friend_away' }); break; }
            createRoom(client, true, { mode: msg.mode, walls: msg.walls, time: msg.time });
            const room = rooms.get(client.roomId);
            if (!room) break;
            send(target, {
              t: 'friend_call',
              from: client.nick,
              code: room.code,
              mode: room.mode,
              walls: room.walls,
              time: room.time,
            });
            break;
          }
          // A client that thinks it has fallen behind asks for the position.
          // A single dropped state message used to leave the board frozen on
          // the opponent's turn: no legal moves on screen, while the server
          // had already handed the turn over and was counting down 30s.
          case 'sync': {
            // the watchdog asks at most every few seconds; anything faster is
            // a broken or hostile client, so make it cheap to ignore
            const nowMs = Date.now();
            if (nowMs - (client.lastSync || 0) < 1500) break;
            client.lastSync = nowMs;
            const room = rooms.get(client.roomId);
            if (!room || room.status !== 'playing') {
              // Nothing to sync to: the match ended while they were off the
              // air, or the room is long gone. Answering with silence left
              // the board frozen on their screen, so say it plainly instead.
              send(client, takeResult(client.token) || { t: 'no_game' });
              break;
            }
            const idx = room.players.indexOf(client);
            if (idx === -1) { send(client, { t: 'no_game' }); break; }
            send(client, startMsg(room, idx, { resumed: true, out: { ...(room.out || {}) } }));
            break;
          }
          case 'rematch': handleRematch(client, msg); break;
          case 'emoji': handleEmoji(client, msg); break;
          case 'resign': {
            const room = rooms.get(client.roomId);
            if (room && room.status === 'playing') {
              const idx = room.players.indexOf(client);
              if (idx === -1) break;
              if (isQuad(room)) knockOut(room, idx, 'resign');
              else guard('finish', () => finish(room, 1 - idx, 'resign'));
            }
            break;
          }
        }
      } catch (e) {
        console.error('ws message error:', e);
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      broadcastLobby();
      const room = rooms.get(client.roomId);
      if (!room) { if (client.token) byToken.delete(client.token); return; }
      const idx = room.players.indexOf(client);
      if (room.status === 'playing' && idx !== -1) {
        // give them GRACE_MS to reconnect (token survives in byToken).
        // A duel has nothing to do but wait. At a table of four the game only
        // stops if the missing player is the one on move — freezing three
        // people because a fourth, who was not even on turn, dropped their
        // connection is how a room empties.
        if (!isQuad(room) || room.state?.turn === idx) pauseClock(room);
        for (const o of others(room, idx)) {
          tell(room, o, { t: 'opp_disconnected', room: room.id, seat: idx, nick: client.nick, grace: GRACE_MS, clocks: clockPayload(room) });
        }
        client.graceTimer = setTimeout(() => guard('grace-expired', () => {
          byToken.delete(client.token);
          if (room.status === 'playing') {
            if (isQuad(room)) knockOut(room, idx, 'left');
            else finish(room, 1 - idx, 'opponent_left');
          }
          if (room.players.every(p => clients.get(p.ws) !== p)) destroyRoom(room);
        }), GRACE_MS);
      } else {
        if (client.token) byToken.delete(client.token);
        leaveRoom(client, true);
      }
    });
  });

  // Heartbeat: drop dead connections. This has to be well under MOVE_MS —
  // at 30s a socket could die and the player be timed out for a move they
  // never saw before the server even noticed they were gone.
  setInterval(() => guard('heartbeat', () => {
    for (const [ws, client] of clients) {
      if (!client.alive) { ws.terminate(); continue; }
      client.alive = false;
      client.pingAt = Date.now();
      try { ws.ping(); } catch { /* ignore */ }
    }
  }), 8_000);
}
