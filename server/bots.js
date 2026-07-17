// Bot players: virtual clients that live on the server and play through the
// exact same room/move pipeline as real people. They keep the lobby busy,
// answer quick-match, join user rooms after a wait, think like humans
// (variable delays), chat with emojis, sometimes resign lost games and
// respond to rematch offers.
import { aiMove } from '../public/js/ai.js';
import { distToGoal } from '../public/js/engine.js';
import { seedBots, growBots } from './db.js';

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
  setTimeout(refreshFake, 45_000 + Math.random() * 75_000);
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
  return `${s.pawns[0].r},${s.pawns[0].c}|${s.pawns[1].r},${s.pawns[1].c}|${s.left[0]},${s.left[1]}`;
}

function clearBotTimers(bot) {
  clearTimeout(bot.thinkTimer);
  clearTimeout(bot.leaveTimer);
  bot.thinkTimer = null;
  bot.leaveTimer = null;
}

function sendEmoji(bot, e, delay) {
  setTimeout(() => {
    const room = api.rooms.get(bot.roomId);
    if (room) api.handleEmoji(bot, { e });
  }, delay);
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
    // room_created / opp_disconnected / emoji / errors need no reaction
  }
}

/* ---------- thinking ---------- */
// How tense is the position for the bot? Obvious races get a snappy reply;
// only real decisions (a live blocking chance, a tight finish) get a real pause.
function moveTension(room, idx) {
  const s = room.state;
  const myD = distToGoal(s.walls, idx === 0 ? 0 : 8)[s.pawns[idx].r * 9 + s.pawns[idx].c];
  const oppD = distToGoal(s.walls, idx === 0 ? 8 : 0)[s.pawns[1 - idx].r * 9 + s.pawns[1 - idx].c];
  if (myD === -1 || oppD === -1) return 1;
  const haveWalls = s.left[idx] > 0;
  if (myD + 1 < oppD) return 0;                 // clearly ahead → just run, no thinking
  if (!haveWalls) return 0;                      // nothing to decide but where to step
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
  // the very first move comes quickly — nobody ponders move one
  if (room.state.walls.length === 0 && room.state.left[0] + room.state.left[1] === 20) {
    d = Math.min(d, 700 + Math.random() * 1000);
  }
  // never flag: stay well inside the bank and the 30s move cap
  if (room.bank) d = Math.max(400, Math.min(d, room.bank[idx] - 5000, 12_000));

  bot.thinkTimer = setTimeout(() => doMove(bot), d);
}

function doMove(bot) {
  const room = api.rooms.get(bot.roomId);
  if (!room || room.status !== 'playing') return;
  const idx = room.players.indexOf(bot);
  if (idx === -1 || room.state.turn !== idx) return;
  const state = JSON.parse(JSON.stringify(room.state));

  // hopeless and out of walls? some personalities just resign
  if (bot.p.resigner && state.left[idx] === 0) {
    const myD = distToGoal(state.walls, idx === 0 ? 0 : 8)[state.pawns[idx].r * 9 + state.pawns[idx].c];
    const oppD = distToGoal(state.walls, idx === 0 ? 8 : 0)[state.pawns[1 - idx].r * 9 + state.pawns[1 - idx].c];
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
    if (now > b.openDeadline) api.leaveRoom(b, false);
  }
  // top up to the current target
  if (botOpenRooms().length < rotTarget && Math.random() < 0.75) {
    const b = pickIdle();
    if (b) {
      api.createRoom(b, false);
      b.openDeadline = now + 12_000 + Math.random() * 35_000;
    }
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

/* ---------- users waiting for an opponent ---------- */
// Called by rooms.js when a real player creates a public room (long wait)
// or falls through quick-match into a fresh room (short wait).
export function notifyUserWaiting(room, delayMs) {
  if (!room || room.code) return;
  setTimeout(() => {
    const live = api.rooms.get(room.id);
    if (!live || live.status !== 'open' || live.players.length !== 1) return;
    if (live.players[0].isBot) return;
    const b = pickIdle();
    if (b) api.joinRoom(b, live);
  }, delayMs);
}

/* ---------- boot ---------- */
export function initBots(hooks) {
  api = hooks;
  for (const p of ROSTER) bots.push(makeBot(p));
  seedBots(ROSTER.map(p => p.nick));

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
  setTimeout(growthTick, 10 * 60 * 1000); // first pass shortly after boot
  setInterval(growthTick, 60 * 60 * 1000);

  refreshFake();
  retarget();
  setInterval(rotationTick, 4500);
  console.log(`bots: ${bots.length} personas online`);
}
