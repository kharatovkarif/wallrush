// Bot players: virtual clients that live on the server and play through the
// exact same room/move pipeline as real people. They keep the lobby busy,
// answer quick-match, join user rooms after a wait, think like humans
// (variable delays), chat with emojis, sometimes resign lost games and
// respond to rematch offers.
import { aiMove } from '../public/js/ai.js';
import { ai4Move, quadTension } from '../public/js/ai4.js';
import { distToGoal, goalRow } from '../public/js/engine.js';
import { seedBots, growBots, botPoints } from './db.js';
import { guard } from './rooms.js';

// skill: 'easy' | 'normal' | 'hard' | 'ace' (ace = the real engine, capped budget)
// speed: multiplier on think time (0.6 = snappy player, 1.4 = slow thinker)
// chatty: 0..1 — how often they send emojis
// resigner: whether they may resign a hopeless game
const ROSTER = [
  { nick: 'gisno', skill: 'hard', speed: 0.8, chatty: 0.5, resigner: true },
  { nick: 'user729', skill: 'normal', speed: 1.0, chatty: 0.2, resigner: false },
  { nick: 'Danya05', skill: 'normal', speed: 0.7, chatty: 0.8, resigner: true },
  { nick: 'wall_e_', skill: 'ace', speed: 1.1, chatty: 0.3, resigner: false },
  { nick: 'KiraM', skill: 'easy', speed: 0.9, chatty: 0.6, resigner: true },
  { nick: 'foxy_wr', skill: 'hard', speed: 1.0, chatty: 0.7, resigner: false },
  { nick: 'Marat_07', skill: 'normal', speed: 1.2, chatty: 0.4, resigner: true },
  { nick: 'stenka72', skill: 'hard', speed: 1.3, chatty: 0.1, resigner: false },
  { nick: 'Lexa', skill: 'easy', speed: 0.6, chatty: 0.9, resigner: true },
  { nick: 'ZloyPingvin', skill: 'normal', speed: 1.0, chatty: 0.7, resigner: false },
  { nick: 'miron4ik', skill: 'easy', speed: 0.8, chatty: 0.5, resigner: true },
  { nick: 'TommyGun', skill: 'hard', speed: 0.9, chatty: 0.3, resigner: false },
  { nick: 'sova_night', skill: 'normal', speed: 1.4, chatty: 0.2, resigner: true },
  { nick: 'Arsen21', skill: 'ace', speed: 1.0, chatty: 0.4, resigner: false },
  { nick: 'bublik', skill: 'easy', speed: 0.7, chatty: 0.8, resigner: true },
  { nick: 'NeoFit', skill: 'normal', speed: 1.1, chatty: 0.3, resigner: false },
  { nick: 'kvadrat', skill: 'hard', speed: 1.2, chatty: 0.2, resigner: true },
  { nick: 'Rina_x', skill: 'normal', speed: 0.8, chatty: 0.6, resigner: false },
  { nick: 'Shustrik', skill: 'easy', speed: 0.5, chatty: 0.7, resigner: true },
  { nick: 'DedMaxim', skill: 'hard', speed: 1.4, chatty: 0.4, resigner: false },
  { nick: 'tokyo_dr1ft', skill: 'normal', speed: 0.9, chatty: 0.5, resigner: true },
  { nick: 'vint1k', skill: 'easy', speed: 0.8, chatty: 0.4, resigner: false },
  { nick: 'MegaMozg', skill: 'ace', speed: 1.2, chatty: 0.3, resigner: false },
  { nick: 'Olezha', skill: 'normal', speed: 1.0, chatty: 0.6, resigner: true },
  { nick: 'sanya_krut', skill: 'hard', speed: 0.9, chatty: 0.7, resigner: false },
  { nick: 'PolinaV', skill: 'normal', speed: 1.1, chatty: 0.5, resigner: true },
  { nick: 'wallmaster', skill: 'ace', speed: 1.0, chatty: 0.2, resigner: false },
  { nick: 'krot_v_dele', skill: 'easy', speed: 0.9, chatty: 0.6, resigner: true },
  { nick: 'Timur_ka', skill: 'normal', speed: 0.7, chatty: 0.8, resigner: false },
  { nick: 'ZaGadka', skill: 'hard', speed: 1.3, chatty: 0.1, resigner: true },
  { nick: 'nixon77', skill: 'normal', speed: 1.0, chatty: 0.3, resigner: false },
  { nick: 'belka_strelka', skill: 'easy', speed: 0.8, chatty: 0.7, resigner: true },
  { nick: 'Grafit', skill: 'hard', speed: 1.1, chatty: 0.2, resigner: false },
  { nick: 'MrPencil', skill: 'normal', speed: 0.9, chatty: 0.5, resigner: true },
  { nick: 'ulitka_speed', skill: 'easy', speed: 1.4, chatty: 0.6, resigner: false },
  { nick: 'Katya2006', skill: 'normal', speed: 0.8, chatty: 0.7, resigner: true },
  { nick: 'prosto_igrok', skill: 'easy', speed: 1.0, chatty: 0.3, resigner: false },
  { nick: 'FenixQQ', skill: 'ace', speed: 0.9, chatty: 0.5, resigner: false },
  { nick: 'sm0ke', skill: 'hard', speed: 1.0, chatty: 0.4, resigner: true },
  { nick: 'Vitalya', skill: 'normal', speed: 1.2, chatty: 0.6, resigner: false },
  { nick: 'dobryak', skill: 'easy', speed: 1.1, chatty: 0.9, resigner: true },
  { nick: 'Igrek', skill: 'normal', speed: 1.0, chatty: 0.2, resigner: false },
  { nick: 'hodok', skill: 'hard', speed: 1.2, chatty: 0.3, resigner: true },
  { nick: 'labirint_pro', skill: 'ace', speed: 1.1, chatty: 0.4, resigner: false },
  { nick: 'Sergo_86', skill: 'normal', speed: 0.9, chatty: 0.5, resigner: true },
];

// Bots are supposed to feel like real people: competent racers, never wandering.
// Even the "easy" personas play at least the normal level, so nobody looks dumb.
const SKILL_LEVEL = { easy: 'normal', normal: 'normal', hard: 'hard', ace: 'hardcore' };
// The four-handed brain is a different animal — judgement rather than search —
// so the personas map onto its own three levels.
const QUAD_SKILL = { easy: 'easy', normal: 'normal', hard: 'hard', ace: 'hard' };
const SKILL_WINP = { easy: 0.48, normal: 0.52, hard: 0.62, ace: 0.72 };

let api = null;          // hooks into rooms.js, set by initBots
const bots = [];

/* ---------- fake online counter ---------- */
// Baseline follows the time of day (peak in the MSK evening) and drifts a bit
// so the number never looks frozen.
let fakeCount = 22;
export function fakeOnline() { return fakeCount; }

function refreshFake() {
  const h = (new Date().getUTCHours() + 3) % 24; // MSK
  const wave = Math.sin(((h - 14) / 24) * 2 * Math.PI); // peaks around 20:00
  const base = 26 + wave * 10;
  fakeCount = Math.max(14, Math.min(42, Math.round(base + (Math.random() * 8 - 4))));
  if (api) api.broadcastLobby();
  setTimeout(() => guard('online-counter', refreshFake), 45_000 + Math.random() * 75_000);
}

/* ---------- virtual clients ---------- */
function makeBot(p) {
  const bot = {
    // fake socket: server "sends" straight into the bot brain
    ws: null,
    token: 'bot_' + p.nick,
    nick: p.nick,
    userId: null,
    roomId: null,
    inLobby: false,
    graceTimer: null,
    alive: true,
    isBot: true,
    points: 0,     // filled from bot_players once initBots has loaded them
    p,
    // per-game state
    me: -1,
    recent: [],
    thinkTimer: null,
    leaveTimer: null,
    openDeadline: 0,
  };
  bot.ws = {
    readyState: 1,
    send: (json) => {
      let msg;
      try { msg = JSON.parse(json); } catch { return; }
      setImmediate(() => { try { onMsg(bot, msg); } catch (e) { console.error('bot msg error:', e); } });
    },
  };
  return bot;
}

function stateKey(s) {
  return s.pawns.map(p => `${p.r},${p.c}`).join('|') + '|' + s.left.join(',');
}

const isQuadState = (s) => (s?.mode || 'duel') === 'quad';

function clearBotTimers(bot) {
  clearTimeout(bot.thinkTimer);
  clearTimeout(bot.leaveTimer);
  bot.thinkTimer = null;
  bot.leaveTimer = null;
}

function sendEmoji(bot, e, delay) {
  setTimeout(() => guard('bot-emoji', () => {
    const room = api.rooms.get(bot.roomId);
    if (room) api.handleEmoji(bot, { e });
  }), delay);
}

function onMsg(bot, msg) {
  switch (msg.t) {
    case 'game_start': {
      clearBotTimers(bot);
      bot.me = msg.you;
      bot.recent = [stateKey(msg.state)];
      // greet sometimes
      if (Math.random() < bot.p.chatty * 0.35) sendEmoji(bot, '🫡', 900 + Math.random() * 2200);
      if (msg.state.turn === bot.me) scheduleThink(bot);
      break;
    }
    case 'state': {
      const s = msg.state;
      bot.recent.push(stateKey(s));
      if (bot.recent.length > 16) bot.recent.shift();
      if (s.turn === bot.me) {
        // opponent just moved — react to a nasty wall once in a while
        const w = s.walls[s.walls.length - 1];
        if (w && w.by !== bot.me && Math.random() < bot.p.chatty * 0.15) {
          sendEmoji(bot, Math.random() < 0.6 ? '😡' : '😂', 700 + Math.random() * 1800);
        }
        scheduleThink(bot);
      } else {
        clearTimeout(bot.thinkTimer);
      }
      break;
    }
    case 'game_over': {
      clearBotTimers(bot);
      const room = api.rooms.get(bot.roomId);
      if (room && (room.mode || 'duel') === 'quad') {
        // nobody is offered a rematch at a table of four, so just drift off
        bot.leaveTimer = setTimeout(() => {
          if (bot.roomId) api.leaveRoom(bot, false);
        }, 4000 + Math.random() * 9000);
        break;
      }
      const opp = room ? room.players.find(pl => pl !== bot) : null;
      const vsBot = Boolean(opp?.isBot);
      if (vsBot) {
        // bot-vs-bot: wrap up quickly and quietly, no rematch loops
        bot.leaveTimer = setTimeout(() => {
          if (bot.roomId) api.leaveRoom(bot, false);
        }, 2500 + Math.random() * 4000);
        break;
      }
      if (msg.winner === bot.me && Math.random() < bot.p.chatty * 0.5) {
        sendEmoji(bot, '🤝', 800 + Math.random() * 1500);
      }
      // sometimes the bot itself asks for a rematch, like a hooked player
      if (Math.random() < 0.3) {
        setTimeout(() => {
          const r = api.rooms.get(bot.roomId);
          if (r && r.status === 'over' && opp && opp.roomId === r.id) {
            api.handleRematch(bot, { yes: true });
          }
        }, 3000 + Math.random() * 4000);
      }
      // hang around a little in case the human wants a rematch, then leave
      bot.leaveTimer = setTimeout(() => {
        if (bot.roomId) api.leaveRoom(bot, true);
      }, 15_000 + Math.random() * 15_000);
      break;
    }
    case 'emoji': {
      // people answer emojis — so do bots
      if (Math.random() < bot.p.chatty * 0.55) {
        const reply = Math.random() < 0.45 ? msg.e : (Math.random() < 0.5 ? '😂' : '🫡');
        sendEmoji(bot, reply, 1200 + Math.random() * 2500);
      }
      break;
    }
    case 'rematch_offer': {
      clearTimeout(bot.leaveTimer);
      setTimeout(() => {
        if (!api.rooms.get(bot.roomId)) return;
        api.handleRematch(bot, { yes: Math.random() < 0.7 });
      }, 2000 + Math.random() * 4000);
      break;
    }
    case 'rematch_declined': {
      clearBotTimers(bot);
      bot.leaveTimer = setTimeout(() => {
        if (bot.roomId) api.leaveRoom(bot, false);
      }, 1000 + Math.random() * 1500);
      break;
    }
    case 'player_out': break;   // somebody left the table; the next state says the rest
    // room_created / room_wait / opp_disconnected / errors need no reaction
  }
}

/* ---------- thinking ---------- */
// How tense is the position for the bot? Obvious races get a snappy reply;
// only real decisions (a live blocking chance, a tight finish) get a real pause.
function moveTension(room, idx) {
  const s = room.state;
  if (isQuadState(s)) return quadTension(s, idx);
  const cols = s.cols || 9, rows = s.rows || 9;
  const myD = distToGoal(s.walls, goalRow(idx, s), cols, rows)[s.pawns[idx].r * cols + s.pawns[idx].c];
  const oppD = distToGoal(s.walls, goalRow(1 - idx, s), cols, rows)[s.pawns[1 - idx].r * cols + s.pawns[1 - idx].c];
  if (myD === -1 || oppD === -1) return 1;
  const haveWalls = s.left[idx] > 0;
  if (myD + 1 < oppD) return 0;                 // clearly ahead → just run, no thinking
  if (!haveWalls) return 0;                      // nothing to decide but where to step
  if (s.mode === 'race') {
    // race is a sprint: distances stay equal most of the way, so almost every
    // move is "just run" — a real pause only when the finish line is close
    if (oppD <= 4 && oppD <= myD) return 2;
    if (oppD <= 7) return 1;
    return 0;
  }
  if (oppD <= 3 || Math.abs(myD - oppD) <= 1) return 2; // tight: worth a think about a wall
  return 1;
}

function scheduleThink(bot) {
  clearTimeout(bot.thinkTimer);
  const room = api.rooms.get(bot.roomId);
  if (!room || room.status !== 'playing') return;
  const idx = room.players.indexOf(bot);
  if (idx === -1) return;

  // human reaction: obvious move → almost instantly, normal move → about a
  // second, a real pause only when there's genuinely something to weigh
  const tension = moveTension(room, idx);
  let d;
  if (tension === 0) {
    d = 400 + Math.random() * 800;                          // 0.4–1.2s, just moving
  } else if (tension === 1) {
    d = Math.random() < 0.85 ? 900 + Math.random() * 1600   // 0.9–2.5s
                             : 3000 + Math.random() * 2000;  // 3–5s once in a while
  } else {
    d = Math.random() < 0.8 ? 2000 + Math.random() * 3000   // 2–5s, weighing a wall
                            : 5000 + Math.random() * 3000;   // 5–8s deep think
  }
  d *= bot.p.speed;
  // race games are longer, so people play them snappier overall
  if (room.state.mode === 'race') d *= 0.7;
  // Three people are waiting on every move here, not one. Bots that ponder
  // turn a four-handed game into a queue, so they answer briskly.
  if (isQuadState(room.state)) d *= 0.55;
  // the very first move comes quickly — nobody ponders move one
  if (room.state.walls.length === 0 && room.state.pawns.every(p2 => p2.r === 0 || p2.r >= (room.state.rows || 9) - 1)) {
    d = Math.min(d, 700 + Math.random() * 1000);
  }
  // never flag: stay well inside the bank and the 30s move cap
  const cap = isQuadState(room.state) ? 6000 : room.state.mode === 'race' ? 8000 : 12_000;
  if (room.bank) d = Math.max(400, Math.min(d, room.bank[idx] - 5000, cap));

  bot.thinkTimer = setTimeout(() => guard('bot-move', () => doMove(bot)), d);
}

function doMove(bot) {
  const room = api.rooms.get(bot.roomId);
  if (!room || room.status !== 'playing') return;
  const idx = room.players.indexOf(bot);
  if (idx === -1 || room.state.turn !== idx) return;
  // The human is disconnected and the room is on hold. Moving now would send
  // a state they cannot receive, and they would come back to a board that had
  // changed without them. Wait and re-check.
  if (room.paused) { bot.thinkTimer = setTimeout(() => doMove(bot), 1000); return; }
  const state = JSON.parse(JSON.stringify(room.state));

  if (isQuadState(state)) {
    // Nobody resigns a four-handed game: there are still two other people to
    // finish ahead of, and an empty seat spoils the table for them.
    let mv = null;
    try {
      mv = ai4Move(state, QUAD_SKILL[bot.p.skill] || 'normal');
    } catch (e) {
      console.error('quad bot move failed:', e.message);
    }
    if (mv) api.handleMove(bot, { move: mv });
    return;
  }

  // hopeless and out of walls? some personalities just resign
  if (bot.p.resigner && state.left[idx] === 0) {
    const cols = state.cols || 9, rows = state.rows || 9;
    const myD = distToGoal(state.walls, goalRow(idx, state), cols, rows)[state.pawns[idx].r * cols + state.pawns[idx].c];
    const oppD = distToGoal(state.walls, goalRow(1 - idx, state), cols, rows)[state.pawns[1 - idx].r * cols + state.pawns[1 - idx].c];
    if (myD !== -1 && oppD !== -1 && myD - oppD >= 5 && Math.random() < 0.3) {
      if (Math.random() < bot.p.chatty * 0.6) api.handleEmoji(bot, { e: '🫡' });
      api.resign(bot);
      return;
    }
  }

  let move = null;
  try {
    move = aiMove(state, SKILL_LEVEL[bot.p.skill], {
      budgetMs: 300, maxDepth: 10, recent: new Set(bot.recent),
    });
  } catch (e) {
    console.error('bot move failed:', e.message);
  }
  if (!move) { api.resign(bot); return; }
  api.handleMove(bot, { move });
}

/* ---------- lobby life: rotating open rooms ---------- */
let rotTarget = 2;
function idleBots() { return bots.filter(b => !b.roomId); }
function pickIdle() {
  const free = idleBots();
  return free.length ? free[Math.floor(Math.random() * free.length)] : null;
}
function botOpenRooms() {
  return [...api.rooms.values()].filter(r => r.status === 'open' && !r.code && r.players[0].isBot);
}

function botGamesActive() {
  return [...api.rooms.values()].filter(r =>
    r.status === 'playing' && r.players.length === 2 && r.players.every(pl => pl.isBot)).length;
}

function rotationTick() {
  const now = Date.now();
  // rooms that waited long enough disappear (the "player" went elsewhere)
  for (const room of botOpenRooms()) {
    const b = room.players[0];
    if (now <= b.openDeadline) continue;
    // A four-handed table somebody has already sat down at is not ours to
    // clear away. Closing it under them would throw real players back to the
    // lobby seconds after they chose a seat.
    if (room.players.some(pl => !pl.isBot)) { b.openDeadline = now + 60_000; continue; }
    api.leaveRoom(b, false);
  }
  // top up to the current target; bots create both kinds with varied settings,
  // like real players picking their favourite rules
  if (botOpenRooms().length < rotTarget && Math.random() < 0.75) {
    const b = pickIdle();
    if (b) {
      const roll = Math.random();
      const mode = roll < 0.2 ? 'quad' : roll < 0.5 ? 'race' : 'duel';
      api.createRoom(b, false, {
        mode,
        walls: mode === 'race' ? (Math.random() < 0.6 ? 15 : 10) : 10,
        time: ['5', '5', '3', '0'][Math.floor(Math.random() * 4)],
      });
      // A table of four has to fill or it just sits there looking dead, so a
      // bot's own table waits longer than a duel room before it gives up.
      b.openDeadline = now + (mode === 'quad' ? 60_000 + Math.random() * 60_000
                                              : 12_000 + Math.random() * 35_000);
    }
  }
  // Seats at a waiting four-handed table fill in gradually, whoever opened it.
  // This is what puts a live "2/4 · 3/4" in the lobby instead of a row that
  // never changes, and it is how a real player's table gets its last seat.
  for (const room of api.rooms.values()) {
    if (room.status !== 'open' || room.code) continue;
    if ((room.mode || 'duel') !== 'quad') continue;
    if (room.players.length >= 4) continue;
    const waited = now - (room.openedAt || 0);
    if (waited < 12_000 || Math.random() > 0.2) continue;
    const b = pickIdle();
    if (b) api.joinRoom(b, room);
  }
  // once in a while a bot joins another bot's room and they REALLY play:
  // watchers see the room fill up and start, and the leaderboard grows
  // from genuine finished games (max one such match at a time)
  if (botGamesActive() < 1 && Math.random() < 0.06) {
    const open = botOpenRooms()[0];
    const b = pickIdle();
    if (open && b) api.joinRoom(b, open);
  }
}

function retarget() {
  rotTarget = 1 + Math.floor(Math.random() * 3); // 1..3 rooms
  setTimeout(retarget, 30_000 + Math.random() * 60_000);
}

/* ---------- filling a four-handed table ---------- */
/* Three empty seats and one person looking at them. Bots arrive the way people
   would — one at a time, spread out, never all at once on the same beat — and
   only as many as the room still needs. A private room is left alone far
   longer: it was opened for particular friends, and a bot taking their seat
   before they have read the invitation is worse than an empty chair. */
export function fillQuadRoom(room) {
  if (!room || (room.mode || 'duel') !== 'quad') return;
  const first = room.code ? 90_000 : 15_000;
  const gap = room.code ? 30_000 : 10_000;
  for (let k = 0; k < 3; k++) {
    const delay = first + k * gap + (Math.random() * 8000 - 3000);
    setTimeout(() => guard('quad-fill', () => {
      const live = api.rooms.get(room.id);
      if (!live || live.status !== 'open') return;
      if (live.players.length >= 4) return;
      const b = pickIdle();
      if (b) api.joinRoom(b, live);
    }), Math.max(4000, delay));
  }
}

/* ---------- users waiting for an opponent ---------- */
// Called by rooms.js when a real player creates a public room (long wait)
// or falls through quick-match into a fresh room (short wait).
export function notifyUserWaiting(room, delayMs) {
  if (!room || room.code) return;
  setTimeout(() => guard('bot-joins-waiting-room', () => {
    const live = api.rooms.get(room.id);
    if (!live || live.status !== 'open' || live.players.length !== 1) return;
    if (live.players[0].isBot) return;
    const b = pickIdle();
    if (b) api.joinRoom(b, live);
  }), delayMs);
}

/* ---------- boot ---------- */
export function initBots(hooks) {
  api = hooks;
  for (const p of ROSTER) bots.push(makeBot(p));
  seedBots(ROSTER.map(p => p.nick));
  // Bots wear the same rank badge as everyone else, so their standings have to
  // be loaded — a lobby full of Rookies who play like masters gives them away.
  // Refreshed periodically because growBots keeps moving them.
  const loadPoints = async () => {
    const map = await botPoints();
    for (const b of bots) if (map.has(b.nick)) b.points = map.get(b.nick);
  };
  guard('bot-points', loadPoints);
  setInterval(() => guard('bot-points', loadPoints), 30 * 60 * 1000);

  // leaderboard lives its own life: every hour a slice of bots "plays a
  // session" — active by day, busiest in the MSK evening, asleep at night.
  // Over a day ~60-70% of the roster visibly moves up, like real regulars.
  const winp = new Map(ROSTER.map(p => [p.nick, SKILL_WINP[p.skill]]));
  const growthTick = () => {
    const h = (new Date().getUTCHours() + 3) % 24; // MSK
    let w;
    if (h >= 3 && h < 10) w = 0.12;      // deep night: almost nobody plays
    else if (h >= 18 || h < 1) w = 1.5;  // evening prime time
    else w = 1;
    growBots(winp, 0.07 * w);
  };
  setTimeout(() => guard('bot-growth', growthTick), 10 * 60 * 1000); // first pass shortly after boot
  setInterval(() => guard('bot-growth', growthTick), 60 * 60 * 1000);

  refreshFake();
  retarget();
  setInterval(() => guard('lobby-rotation', rotationTick), 4500);
  console.log(`bots: ${bots.length} personas online`);
}
