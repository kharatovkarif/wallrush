// WallRush online rooms: lobby, matches, clocks, reconnect, rematch, emoji.
// Server is authoritative: it validates every move with the shared engine.
import { initialState, applyMove } from '../public/js/engine.js';
import { pointsDelta } from '../public/js/ranks.js';
import { streakState, canRestore, pendingStreak, freeRestore, localDay } from '../public/js/streak.js';
import { checkNick, randomNick } from '../public/js/nick.js';
import {
  verifyUser, getProfile, recordResult, recordBotResult, recordHumanMatch,
  getPoints, addPoints, addBotPoints, touchStreak,
  friendAdd, friendRemove, friendList,
} from './db.js';
import { initBots, fakeOnline, notifyUserWaiting } from './bots.js';
import crypto from 'crypto';

const BANK_MS = 300_000;      // 5:00 per player per game
const MOVE_MS = 30_000;       // max per move
const GRACE_MS = 30_000;      // reconnect window
const EMOJIS = ['😂', '🫡', '🤝', '😡'];

const clients = new Map();   // ws -> client {ws, token, nick, userId, roomId, inLobby}
const byToken = new Map();   // token -> client
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

function lobbyRooms() {
  const list = [];
  for (const room of rooms.values()) {
    if (room.status === 'open' && !room.code) {
      list.push({
        id: room.id, nick: room.players[0].nick, points: room.players[0].points || 0,
        mode: room.mode || 'duel', walls: room.walls || 10, time: room.time || '5',
      });
    }
  }
  return list;
}

// bots inflate the visible counter so the lobby always feels populated
function onlineCount() { return clients.size + fakeOnline(); }
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
  return { t: 'state', state: room.state, clocks: clockPayload(room) };
}

function startGame(room) {
  room.state = initialState(room.mode || 'duel', { walls: room.walls });
  room.state.turn = crypto.randomInt(2); // random first move
  // no-time rooms get a huge bank that never runs out — only the 30s move cap
  const bankMs = room.noTime ? 8_640_000_000 : (room.bankMs || BANK_MS);
  room.bank = [bankMs, bankMs];
  room.status = 'playing';
  room.played = (room.played || 0) + 1;
  room.moves = 0;
  room.rematch = [false, false];
  room.turnStarted = Date.now();
  armMoveTimer(room);
  room.players.forEach((pl, i) => {
    send(pl, {
      t: 'game_start',
      you: i,
      state: room.state,
      clocks: clockPayload(room),
      opp: { nick: room.players[1 - i].nick, points: room.players[1 - i].points || 0,
             // so the winner can offer to add them as a friend
             id: room.players[1 - i].userId || null },
      me: { points: pl.points || 0, veteran: Boolean(pl.veteran) },
      ranked: isRanked(room),
    });
  });
  broadcastLobby();
}

function armMoveTimer(room) {
  clearTimeout(room.moveTimer);
  const p = room.state.turn;
  const ms = Math.min(MOVE_MS, room.bank[p]);
  room.moveTimer = setTimeout(() => {
    const reason = room.bank[p] <= MOVE_MS ? 'timeout' : 'move_timeout';
    finish(room, 1 - p, reason);
  }, ms + 250); // small grace for network latency
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

function persistPoints(pl, delta) {
  if (!delta) return;
  if (pl.isBot) addBotPoints(pl.nick, delta);
  else addPoints({ userId: pl.userId, deviceId: pl.deviceId }, delta);
}

// Updates the in-memory totals straight away so the game_over message is
// already correct, and writes to the database in the background.
const MIN_RANKED_MOVES = 6;

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
  const w = room.players[winnerIdx], l = room.players[1 - winnerIdx];
  const deltas = awardPoints(room, w, l);
  room.players.forEach((pl, i) => {
    send(pl, {
      t: 'game_over', winner: winnerIdx, you: i, reason,
      points: { delta: deltas[i], total: pl.points || 0, ranked: isRanked(room) },
    });
  });
  // The streak needs a database round trip, so it follows the result rather
  // than holding it up — the result overlay only appears after 600ms anyway.
  for (const pl of room.players) {
    if (pl.isBot) continue;
    touchStreak({ userId: pl.userId, deviceId: pl.deviceId }, localDay(pl.tzOffset || 0))
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
  if (w.userId || l.userId) {
    await recordResult(w.userId || null, l.userId || null);
  }
  if (w.isBot) recordBotResult(w.nick, true);
  if (l.isBot) recordBotResult(l.nick, false);
  // both sides are real people → a genuine human-vs-human match
  if (!w.isBot && !l.isBot) recordHumanMatch(room.mode || 'duel');
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

function leaveRoom(client, notifyOpp = true) {
  const room = rooms.get(client.roomId);
  client.roomId = null;
  if (!room) return;
  const idx = room.players.indexOf(client);
  if (idx === -1) return;
  if (room.status === 'open') {
    destroyRoom(room);
    return;
  }
  if (room.status === 'playing') {
    finish(room, 1 - idx, 'opponent_left');
  } else if (room.status === 'over' && notifyOpp) {
    const opp = room.players[1 - idx];
    if (opp.roomId === room.id) send(opp, { t: 'rematch_declined' });
  }
  // keep room until both leave
  if (room.players.every(p => p.roomId !== room.id)) destroyRoom(room);
}

function joinRoom(client, room) {
  if (room.status !== 'open') { send(client, { t: 'error', code: 'room_full' }); return; }
  if (room.players[0] === client) return;
  room.players.push(client);
  client.roomId = room.id;
  client.inLobby = false;
  startGame(room);
}

// opts: {mode:'duel'|'race', walls, time:'0'|'3'|'5'}
// duel is always 10 walls; race offers 10 or 15; time '0' = no bank, 30s/move
function createRoom(client, isPrivate, opts = {}) {
  if (client.roomId) leaveRoom(client, false);
  const mode = opts.mode === 'race' ? 'race' : 'duel';
  const walls = mode === 'race' ? (Number(opts.walls) === 10 ? 10 : 15) : 10;
  const time = ['0', '3', '5'].includes(String(opts.time)) ? String(opts.time) : '5';
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
    rematch: [false, false],
    turnStarted: 0,
  };
  rooms.set(room.id, room);
  client.roomId = room.id;
  send(client, { t: 'room_created', roomId: room.id, code: room.code });
  broadcastLobby();
}

async function handleHello(client, msg) {
  // resolve identity: registered user (JWT) or guest nick. A guest never signs
  // up, so this is the only place their name is checked — and the socket is
  // reachable without the page, so it cannot be left to the client.
  let nick = String(msg.nick || '').slice(0, 16);
  if (checkNick(nick)) nick = randomNick(() => crypto.randomInt(0, 1e6) / 1e6);
  let userId = null;
  if (msg.jwt) {
    const user = await verifyUser(msg.jwt);
    if (user) {
      userId = user.id;
      const profile = await getProfile(user.id);
      if (profile?.nick) nick = profile.nick;
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
      byToken.set(client.token, client);
      clients.delete(old.ws);
      const room = rooms.get(client.roomId);
      if (room) {
        const idx = room.players.indexOf(old);
        if (idx !== -1) {
          room.players[idx] = client;
          clearTimeout(old.graceTimer);
          if (room.status === 'playing') {
            resumeClock(room);   // both are here again, so time counts again
            send(client, {
              t: 'game_start',
              you: idx,
              state: room.state,
              clocks: clockPayload(room),
              opp: { nick: room.players[1 - idx].nick, points: room.players[1 - idx].points || 0,
                    id: room.players[1 - idx].userId || null },
              me: { points: client.points || 0, veteran: Boolean(client.veteran) },
              ranked: isRanked(room),
              resumed: true,
            });
            // the one who waited needs the restarted clock too, or their screen
            // keeps counting down a turn the server has already given back
            send(room.players[1 - idx], { t: 'opp_reconnected', clocks: clockPayload(room) });
          }
        }
      }
    }
  }
  if (!client.token) {
    client.token = rid();
    byToken.set(client.token, client);
  }
  send(client, {
    t: 'hello_ok', token: client.token, nick: client.nick, online: onlineCount(),
    points: client.points || 0, veteran: Boolean(client.veteran),
    streak: client.streak || 0, streakBest: client.streakBest || 0,
    streakToday: Boolean(client.streakToday),
    streakState: client.streakState || 'none',
    streakLost: client.streakLost || 0,
    streakFree: Boolean(client.streakFree),
  });
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
    for (const pl of room.players) send(pl, stateMsg(room));
    finish(room, room.state.winner, 'goal');
    return;
  }
  room.turnStarted = Date.now();
  // While the room is paused nobody is waiting on the other side, so the
  // 30s move limit must not start running against a player who is not there
  // to see the move. resumeClock() arms it when they are back.
  if (!room.paused) armMoveTimer(room);
  for (const pl of room.players) send(pl, stateMsg(room));
}

function handleRematch(client, msg) {
  const room = rooms.get(client.roomId);
  if (!room || room.status !== 'over') return;
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
  send(room.players[1 - idx], { t: 'emoji', e: msg.e });
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
        if (idx !== -1) finish(room, 1 - idx, 'resign');
      }
    },
  });

  wss.on('connection', (ws, req) => {
    const client = { ws, token: null, nick: '', userId: null, roomId: null, inLobby: false, graceTimer: null, alive: true };
    // A browser always sends Origin on a WebSocket handshake; a script talking
    // to the socket directly usually does not, and the worst point farmers had
    // never loaded the page at all. Rather than refuse the connection — which
    // would risk locking out a real player over a header — the game is played
    // normally and simply scores nothing.
    client.fromPage = sameOrigin(req);
    clients.set(ws, client);

    ws.on('pong', () => { client.alive = true; });

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
          case 'create_room':
            createRoom(client, Boolean(msg.private), { mode: msg.mode, walls: msg.walls, time: msg.time });
            // a bot will come knocking if nobody joins the public room
            if (!msg.private && !client.isBot) {
              notifyUserWaiting(rooms.get(client.roomId), 8000 + Math.random() * 22_000);
            }
            break;
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
            if (await friendAdd(client.userId, id)) {
              send(client, { t: 'friend_added', id });
              // tell them, if they are here to hear it
              for (const c of clients.values()) {
                if (c.userId === id) send(c, { t: 'friend_added_you', nick: client.nick });
              }
            }
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
            if (!room || room.status !== 'playing') break;
            const idx = room.players.indexOf(client);
            if (idx === -1) break;
            send(client, {
              t: 'game_start',
              you: idx,
              state: room.state,
              clocks: clockPayload(room),
              opp: { nick: room.players[1 - idx].nick, points: room.players[1 - idx].points || 0,
                    id: room.players[1 - idx].userId || null },
              me: { points: client.points || 0, veteran: Boolean(client.veteran) },
              ranked: isRanked(room),
              resumed: true,
            });
            break;
          }
          case 'rematch': handleRematch(client, msg); break;
          case 'emoji': handleEmoji(client, msg); break;
          case 'resign': {
            const room = rooms.get(client.roomId);
            if (room && room.status === 'playing') {
              const idx = room.players.indexOf(client);
              if (idx !== -1) finish(room, 1 - idx, 'resign');
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
        // give them GRACE_MS to reconnect (token survives in byToken)
        pauseClock(room);
        send(room.players[1 - idx], { t: 'opp_disconnected', grace: GRACE_MS, clocks: clockPayload(room) });
        client.graceTimer = setTimeout(() => {
          byToken.delete(client.token);
          if (room.status === 'playing') finish(room, 1 - idx, 'opponent_left');
          if (room.players.every(p => clients.get(p.ws) !== p)) destroyRoom(room);
        }, GRACE_MS);
      } else {
        if (client.token) byToken.delete(client.token);
        leaveRoom(client, true);
      }
    });
  });

  // Heartbeat: drop dead connections. This has to be well under MOVE_MS —
  // at 30s a socket could die and the player be timed out for a move they
  // never saw before the server even noticed they were gone.
  setInterval(() => {
    for (const [ws, client] of clients) {
      if (!client.alive) { ws.terminate(); continue; }
      client.alive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 8_000);
}
