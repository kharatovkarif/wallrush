// WallRush online rooms: lobby, matches, clocks, reconnect, rematch, emoji.
// Server is authoritative: it validates every move with the shared engine.
import { initialState, applyMove } from '../public/js/engine.js';
import { verifyUser, getProfile, recordResult, recordBotResult } from './db.js';
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
      list.push({ id: room.id, nick: room.players[0].nick });
    }
  }
  return list;
}

// bots inflate the visible counter so the lobby always feels populated
function onlineCount() { return clients.size + fakeOnline(); }

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
  };
}

function stateMsg(room) {
  return { t: 'state', state: room.state, clocks: clockPayload(room) };
}

function startGame(room) {
  room.state = initialState();
  room.state.turn = crypto.randomInt(2); // random first move
  room.bank = [BANK_MS, BANK_MS];
  room.status = 'playing';
  room.rematch = [false, false];
  room.turnStarted = Date.now();
  armMoveTimer(room);
  room.players.forEach((pl, i) => {
    send(pl, {
      t: 'game_start',
      you: i,
      state: room.state,
      clocks: clockPayload(room),
      opp: { nick: room.players[1 - i].nick },
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

async function finish(room, winnerIdx, reason) {
  if (room.status !== 'playing') return;
  room.status = 'over';
  clearTimeout(room.moveTimer);
  for (const pl of room.players) clearTimeout(pl.graceTimer);
  room.players.forEach((pl, i) => {
    send(pl, { t: 'game_over', winner: winnerIdx, you: i, reason });
  });
  const w = room.players[winnerIdx], l = room.players[1 - winnerIdx];
  if (w.userId || l.userId) {
    await recordResult(w.userId || null, l.userId || null);
  }
  if (w.isBot) recordBotResult(w.nick, true);
  if (l.isBot) recordBotResult(l.nick, false);
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

function createRoom(client, isPrivate) {
  if (client.roomId) leaveRoom(client, false);
  const room = {
    id: rid(),
    code: isPrivate ? roomCode() : null,
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
  // resolve identity: registered user (JWT) or guest nick
  let nick = String(msg.nick || '').slice(0, 16) || 'User' + crypto.randomInt(1000, 9999);
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

  // reconnect to a live game?
  if (msg.token && byToken.has(msg.token)) {
    const old = byToken.get(msg.token);
    if (old !== client) {
      client.token = old.token;
      client.roomId = old.roomId;
      client.nick = old.nick;
      client.userId = old.userId;
      byToken.set(client.token, client);
      clients.delete(old.ws);
      const room = rooms.get(client.roomId);
      if (room) {
        const idx = room.players.indexOf(old);
        if (idx !== -1) {
          room.players[idx] = client;
          clearTimeout(old.graceTimer);
          if (room.status === 'playing') {
            send(client, {
              t: 'game_start',
              you: idx,
              state: room.state,
              clocks: clockPayload(room),
              opp: { nick: room.players[1 - idx].nick },
              resumed: true,
            });
            send(room.players[1 - idx], { t: 'opp_reconnected' });
          }
        }
      }
    }
  }
  if (!client.token) {
    client.token = rid();
    byToken.set(client.token, client);
  }
  send(client, { t: 'hello_ok', token: client.token, nick: client.nick, online: onlineCount() });
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
  if (move.type === 'wall') {
    room.state.walls[room.state.walls.length - 1].by = idx; // for wall colors on clients
  }
  if (room.state.winner !== null) {
    for (const pl of room.players) send(pl, stateMsg(room));
    finish(room, room.state.winner, 'goal');
    return;
  }
  room.turnStarted = Date.now();
  armMoveTimer(room);
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

  wss.on('connection', (ws) => {
    const client = { ws, token: null, nick: '', userId: null, roomId: null, inLobby: false, graceTimer: null, alive: true };
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
            createRoom(client, Boolean(msg.private));
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
            const open = [...rooms.values()].find(r =>
              r.status === 'open' && !r.code && r.players[0] !== client);
            if (open) joinRoom(client, open);
            else {
              createRoom(client, false);
              // quick match should feel quick — a bot arrives within seconds
              notifyUserWaiting(rooms.get(client.roomId), 2500 + Math.random() * 4500);
            }
            break;
          }
          case 'leave_room': leaveRoom(client); break;
          case 'move': handleMove(client, msg); break;
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
        send(room.players[1 - idx], { t: 'opp_disconnected', grace: GRACE_MS });
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

  // heartbeat: drop dead connections
  setInterval(() => {
    for (const [ws, client] of clients) {
      if (!client.alive) { ws.terminate(); continue; }
      client.alive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30_000);
}
