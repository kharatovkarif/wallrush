// WallRush client app: screens, board UI, online play (WebSocket), AI mode, auth.
import { initialState, applyMove, pawnMoves, canPlaceWall, goalRow, cloneState, N } from './engine.js?v=43';
import { aiMove } from './ai.js?v=43';
import { makeT } from './i18n.js?v=43';

/* ================= state ================= */
const $ = (id) => document.getElementById(id);

// first visit: CIS system language or CIS timezone → RU, otherwise EN (user can change it in the profile)
function detectLang() {
  const saved = localStorage.getItem('wr_lang');
  if (saved === 'ru' || saved === 'en') return saved;
  const cisLangs = ['ru', 'uk', 'be', 'kk', 'ky', 'uz', 'tg', 'az', 'hy', 'ka', 'tk'];
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language || ''];
  if (langs.some(l => cisLangs.includes(String(l).slice(0, 2).toLowerCase()))) return 'ru';
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  const cisTz = /Moscow|Kaliningrad|Samara|Volgograd|Saratov|Astrakhan|Kirov|Ulyanovsk|Yekaterinburg|Omsk|Novosibirsk|Barnaul|Tomsk|Novokuznetsk|Krasnoyarsk|Irkutsk|Chita|Yakutsk|Khandyga|Vladivostok|Ust-Nera|Magadan|Sakhalin|Srednekolymsk|Kamchatka|Anadyr|Minsk|Kiev|Kyiv|Uzhgorod|Zaporozhye|Simferopol|Chisinau|Tiraspol|Almaty|Astana|Qostanay|Aqtobe|Aqtau|Atyrau|Oral|Qyzylorda|Tashkent|Samarkand|Bishkek|Dushanbe|Ashgabat|Baku|Yerevan|Tbilisi/i;
  if (cisTz.test(tz)) return 'ru';
  return 'en';
}
let lang = detectLang();
let t = makeT(lang);
let vibroOn = localStorage.getItem('wr_vibro') !== '0';
let soundOn = localStorage.getItem('wr_sound') !== '0';

// move sounds, like a chess clock (WebAudio, no files needed):
// pawn = short high "tick", wall = lower wooden "knock"
let audioCtx = null;
function tick(mine, wall = false) {
  if (!soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    if (wall) {
      o.type = 'sine';
      o.frequency.setValueAtTime(mine ? 340 : 270, t0);
      o.frequency.exponentialRampToValueAtTime(mine ? 180 : 140, t0 + 0.1); // falling thud
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0);
      o.stop(t0 + 0.15);
    } else {
      o.type = 'triangle';
      o.frequency.value = mine ? 660 : 500; // my move rings higher than theirs
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0);
      o.stop(t0 + 0.1);
    }
  } catch { /* no audio — fine */ }
}

// theme: light by default, dark if the user switched it in the profile
function applyTheme() {
  document.documentElement.dataset.theme = localStorage.getItem('wr_theme') === 'dark' ? 'dark' : 'light';
}
applyTheme();

// per-device id for visitor tracking (guests included)
let deviceId = localStorage.getItem('wr_device');
if (!deviceId) {
  deviceId = (crypto.randomUUID ? crypto.randomUUID() : 'd' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));
  localStorage.setItem('wr_device', deviceId);
}
// running as an installed app? (home-screen icon opens in standalone mode)
function runsInstalled() {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  } catch { return false; }
}

function logVisit(game = false, installed = false) {
  try {
    fetch('/api/visit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
      },
      body: JSON.stringify({
        device: deviceId, nick: myNick(), game,
        // language + timezone → the owner sees who comes from where
        lang: navigator.language || '',
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
        // installed-the-app flag: fires on install and on standalone launches
        installed: installed || runsInstalled(),
      }),
    }).catch(() => {});
  } catch {}
}
// the moment the user accepts the install prompt, tell the server
window.addEventListener('appinstalled', () => logVisit(false, true));

// guest nick sticks to the device forever, so the same person keeps the same
// name across visits (was per-tab before — every visit looked like a new user)
let guestNick = localStorage.getItem('wr_nick') || sessionStorage.getItem('wr_nick');
if (!guestNick) {
  guestNick = 'User' + (1000 + Math.floor(Math.random() * 9000));
}
localStorage.setItem('wr_nick', guestNick);

let config = { auth: false };
let supabase = null;      // supabase-js client (if auth configured)
let session = null;       // supabase session
let profile = null;       // {nick, wins, losses}

let ws = null;
let wsReady = false;
let wsToken = sessionStorage.getItem('wr_ws_token') || null;

// game context
let game = null; // { mode:'ai'|'online', state, myIndex, oppNick, clocks, over }
let aiTimer = null;

/* ---- AI runs in a Web Worker so the UI never freezes while it thinks ---- */
let aiWorker = null;      // null = not created yet, false = unavailable
let aiReqId = 0;
const aiPending = new Map();

function getAiWorker() {
  if (aiWorker === false) return null;
  if (!aiWorker) {
    try {
      aiWorker = new Worker('js/ai-worker.js?v=43', { type: 'module' });
      aiWorker.onmessage = (e) => {
        const cb = aiPending.get(e.data.id);
        aiPending.delete(e.data.id);
        if (cb) cb(e.data.move);
      };
      aiWorker.onerror = () => { aiWorker = false; };
    } catch {
      aiWorker = false;
      return null;
    }
  }
  return aiWorker;
}

function aiMoveAsync(state, level, opts) {
  return new Promise((resolve) => {
    const w = getAiWorker();
    if (!w) { setTimeout(() => resolve(aiMove(state, level, opts)), 30); return; }
    const id = ++aiReqId;
    aiPending.set(id, resolve);
    w.postMessage({ id, state, level, opts });
    // safety net: if the worker died mid-request, compute on the main thread
    setTimeout(() => {
      if (aiPending.has(id)) {
        aiPending.delete(id);
        resolve(aiMove(state, level, opts));
      }
    }, 4000);
  });
}

/* ================= helpers ================= */
function vibrate(pattern) {
  if (vibroOn && navigator.vibrate) navigator.vibrate(pattern);
}

// Record every board position so the finished game can be replayed.
// Kept only in memory for the current game — discarded on menu/new game.
function recordSnapshot(state) {
  if (!game) return;
  (game.history = game.history || []).push(cloneState(state));
}

function myNick() {
  return profile?.nick || guestNick;
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ================= i18n ================= */
function applyI18n() {
  t = makeT(lang);
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  $('lang-ru').classList.toggle('active', lang === 'ru');
  $('lang-en').classList.toggle('active', lang === 'en');
  updateProfileUI();
}

/* ================= navigation ================= */
const NAV_SCREENS = ['screen-home', 'screen-leaderboard', 'screen-profile'];
let currentScreen = 'screen-home';

function show(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(screenId).classList.add('active');
  currentScreen = screenId;
  const nav = $('bottom-nav');
  nav.classList.toggle('hidden', screenId === 'screen-game' || screenId === 'screen-waiting');
  document.querySelectorAll('.nav-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.screen === screenId));
  if (screenId === 'screen-leaderboard') loadLeaderboard();
  if (screenId === 'screen-rooms') wsSend({ t: 'lobby_sub' });
  else wsSend({ t: 'lobby_unsub' });
}

document.querySelectorAll('.nav-btn').forEach(b =>
  b.addEventListener('click', () => show(b.dataset.screen)));
document.querySelectorAll('[data-back]').forEach(b =>
  b.addEventListener('click', () => show('screen-home')));

/* ================= WebSocket ================= */
let reconnectDelay = 500;

function wsSend(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    reconnectDelay = 500;
    wsReady = true;
    wsSend({ t: 'hello', nick: myNick(), token: wsToken, jwt: session?.access_token });
    if (currentScreen === 'screen-rooms') wsSend({ t: 'lobby_sub' });
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleWsMessage(msg);
  };
  ws.onclose = () => {
    wsReady = false;
    if (game?.mode === 'online' && !game.over) toast(t('conn_lost'));
    setTimeout(connectWs, reconnectDelay);
    reconnectDelay = Math.min(8000, reconnectDelay * 2);
  };
}

function handleWsMessage(msg) {
  switch (msg.t) {
    case 'hello_ok':
      wsToken = msg.token;
      sessionStorage.setItem('wr_ws_token', wsToken);
      $('online-count').textContent = msg.online;
      break;
    case 'lobby':
      $('online-count').textContent = msg.online;
      renderRooms(msg.rooms || []);
      break;
    case 'room_created':
      $('waiting-code').hidden = !msg.code;
      if (msg.code) $('room-code-value').textContent = msg.code;
      show('screen-waiting');
      break;
    case 'game_start':
      startOnlineGame(msg);
      break;
    case 'state':
      if (game?.mode === 'online') {
        // turn passed to me ⇒ this state carries the opponent's move
        const oppMoved = msg.state.turn === game.myIndex && game.state?.turn !== game.myIndex;
        const oppWalled = msg.state.walls.length > (game.state?.walls.length ?? 0);
        game.state = msg.state;
        game.clocks = { ...msg.clocks, recvAt: Date.now() };
        recordSnapshot(msg.state); // server states cover both players' moves
        cancelWallPreview();
        renderGame();
        if (oppMoved) { vibrate(12); tick(false, oppWalled); }
      }
      break;
    case 'game_over':
      if (game?.mode === 'online') onGameOver(msg.winner === msg.you, msg.reason);
      break;
    case 'emoji':
      showEmoji(msg.e);
      vibrate(20);
      break;
    case 'rematch_offer':
      toast(t('rematch') + '?');
      break;
    case 'rematch_declined':
      $('rematch-status').hidden = false;
      $('rematch-status').textContent = t('rematch_declined');
      $('btn-rematch').style.display = 'none';
      break;
    case 'opp_disconnected':
      toast(t('opp_disconnected'));
      break;
    case 'opp_reconnected':
      toast(t('opp_reconnected'));
      break;
    case 'error':
      if (msg.code === 'room_not_found') toast(t('err_room_not_found'));
      else if (msg.code === 'room_full') toast(t('err_room_full'));
      else if (msg.code !== 'bad_move') toast(t('err_generic'));
      break;
  }
}

/* ================= lobby ================= */
function renderRooms(rooms) {
  const list = $('rooms-list');
  list.innerHTML = '';
  if (!rooms.length) {
    list.innerHTML = `<div class="rooms-empty">${t('rooms_empty')}</div>`;
    return;
  }
  for (const room of rooms) {
    const el = document.createElement('div');
    el.className = 'room-item';
    const letter = (room.nick || '?')[0].toUpperCase();
    el.innerHTML = `<div class="r-avatar"></div><div class="r-info"><b></b><small></small></div><button class="btn-join"></button>`;
    el.querySelector('.r-avatar').textContent = letter;
    el.querySelector('b').textContent = room.nick;
    // show what kind of room it is: mode · walls · time
    const modeLabel = room.mode === 'race' ? '🏁 ' + t('race_title') : '⚔️ ' + t('duel_title');
    const timeLabel = room.time === '0' ? '∞' : room.time + t('min_short');
    el.querySelector('small').textContent = `${modeLabel} · ${room.walls}🧱 · ${timeLabel}`;
    const btn = el.querySelector('.btn-join');
    btn.textContent = t('join');
    btn.addEventListener('click', () => wsSend({ t: 'join_room', roomId: room.id }));
    list.appendChild(el);
  }
}

$('btn-online').addEventListener('click', () => show('screen-rooms'));
$('btn-quick').addEventListener('click', () => { wsSend({ t: 'quick' }); show('screen-waiting'); $('waiting-code').hidden = true; });
$('btn-friend').addEventListener('click', () => show('screen-friend'));

/* ---- create-room settings dialog: mode / walls / time ---- */
let createCfg = { mode: 'duel', walls: '10', time: '5', private: false };
function pickOpt(groupId, val) {
  document.querySelectorAll(`#${groupId} button`).forEach(b =>
    b.classList.toggle('on', b.dataset.val === val));
}
function syncCreateDialog() {
  const race = createCfg.mode === 'race';
  // duel is always 10 walls; race lets you pick 10 or 15
  $('cr-walls').querySelector('[data-val="15"]').hidden = !race;
  if (!race && createCfg.walls === '15') { createCfg.walls = '10'; pickOpt('cr-walls', '10'); }
  $('cr-mode-hint').textContent = race ? t('race_rules') : t('duel_rules');
}
function openCreateDialog(isPrivate) {
  createCfg = { mode: 'duel', walls: '10', time: '5', private: isPrivate };
  pickOpt('cr-mode', 'duel'); pickOpt('cr-walls', '10'); pickOpt('cr-time', '5');
  syncCreateDialog();
  $('overlay-create').hidden = false;
}
$('btn-create-room').addEventListener('click', () => openCreateDialog(false));
$('btn-friend-create').addEventListener('click', () => openCreateDialog(true));
$('cr-cancel').addEventListener('click', () => { $('overlay-create').hidden = true; });
$('cr-mode').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  createCfg.mode = b.dataset.val; pickOpt('cr-mode', b.dataset.val); syncCreateDialog();
});
$('cr-walls').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || b.hidden) return;
  createCfg.walls = b.dataset.val; pickOpt('cr-walls', b.dataset.val);
});
$('cr-time').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  createCfg.time = b.dataset.val; pickOpt('cr-time', b.dataset.val);
});
$('cr-create').addEventListener('click', () => {
  $('overlay-create').hidden = true;
  wsSend({
    t: 'create_room', private: createCfg.private,
    mode: createCfg.mode, walls: Number(createCfg.walls), time: createCfg.time,
  });
});
$('btn-friend-join').addEventListener('click', () => {
  const code = $('friend-code-input').value.trim().toUpperCase();
  if (code.length >= 4) wsSend({ t: 'join_code', code });
});
$('btn-cancel-wait').addEventListener('click', () => { wsSend({ t: 'leave_room' }); show('screen-home'); });
$('btn-how').addEventListener('click', () => { $('overlay-how').hidden = false; });
$('btn-how-close').addEventListener('click', () => { $('overlay-how').hidden = true; });

/* ================= board rendering ================= */
const board = $('board');
let geo = null; // {u, g, pad, size}
let cellEls = [];
let pawnEls = [null, null];

// board dimensions of the current game (race is bigger than the classic 9x9)
function dims() {
  const s = game?.state;
  return { cols: s?.cols || 9, rows: s?.rows || 9 };
}
function isRace() { return game?.state?.mode === 'race'; }

function computeGeo() {
  const { cols, rows } = dims();
  // cells are 1u, grooves and padding 0.3u → total width in units:
  const uw = cols * 1.3 + 0.3;
  const uh = rows * 1.3 + 0.3;
  const size = board.clientWidth;
  const u = size / uw;
  const g = 0.3 * u;
  geo = { size, height: u * uh, u, g, pad: g };
}

// view mapping: player 1 sees the board rotated 180° — but NOT in race mode,
// where both players stand on the same (bottom) side
function toView(r, c) {
  if (game?.myIndex === 1 && !isRace()) {
    const { cols, rows } = dims();
    return { r: rows - 1 - r, c: cols - 1 - c };
  }
  return { r, c };
}
function wallToView(w) {
  if (game?.myIndex === 1 && !isRace()) {
    const { cols, rows } = dims();
    return { r: rows - 2 - w.r, c: cols - 2 - w.c, o: w.o };
  }
  return w;
}
// inverse mappings equal the forward ones (180° rotation is an involution)
const fromView = toView;
const wallFromView = wallToView;

function cellXY(r, c) {
  return { x: geo.pad + c * (geo.u + geo.g), y: geo.pad + r * (geo.u + geo.g) };
}

function buildBoard() {
  const { cols, rows } = dims();
  // race board is taller than wide — cap width so the whole board fits on screen
  board.style.aspectRatio = `${cols * 1.3 + 0.3} / ${rows * 1.3 + 0.3}`;
  board.style.maxWidth = isRace() ? 'min(80vw, 46dvh)' : 'min(87vw, 55dvh)';
  computeGeo();
  board.innerHTML = '';
  cellEls = [];

  // competitor look: tinted end-zone bands under a thin pencil grid,
  // cells stay as invisible tap targets
  const bandH = geo.pad + geo.u + geo.g / 2;
  for (const pos of ['top', 'bottom']) {
    if (isRace() && pos === 'bottom') continue; // race: only the finish band on top
    const b = document.createElement('div');
    b.className = 'zone-band ' + pos;
    b.style.cssText = (pos === 'top' ? 'top:0;' : 'bottom:0;') + `left:0;width:100%;height:${bandH}px`;
    board.appendChild(b);
  }
  for (let i = 1; i < Math.max(cols, rows); i++) {
    const at = geo.pad + i * (geo.u + geo.g) - geo.g / 2;
    if (i < cols) {
      const v = document.createElement('div');
      v.className = 'grid-line';
      v.style.cssText = `left:${at}px;top:${geo.pad / 2}px;width:1px;height:${geo.height - geo.pad}px`;
      board.append(v);
    }
    if (i < rows) {
      const h = document.createElement('div');
      h.className = 'grid-line';
      h.style.cssText = `left:${geo.pad / 2}px;top:${at}px;width:${geo.size - geo.pad}px;height:1px`;
      board.append(h);
    }
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const el = document.createElement('div');
      el.className = 'cell';
      const { x, y } = cellXY(r, c);
      el.style.cssText = `left:${x}px;top:${y}px;width:${geo.u}px;height:${geo.u}px`;
      el.dataset.vr = r;
      el.dataset.vc = c;
      board.appendChild(el);
      cellEls.push(el);
    }
  }
  pawnEls = [0, 1].map(i => {
    const el = document.createElement('div');
    el.className = 'pawn';
    const d = geo.u * 0.82;
    el.style.width = el.style.height = d + 'px';
    board.appendChild(el);
    return el;
  });
}

function positionPawn(i) {
  const p = game.state.pawns[i];
  const v = toView(p.r, p.c);
  const { x, y } = cellXY(v.r, v.c);
  const off = geo.u * 0.09;
  pawnEls[i].style.left = (x + off) + 'px';
  pawnEls[i].style.top = (y + off) + 'px';
}

function wallRect(vw) {
  const thick = geo.g * 0.78;             // slim capsule, well inside the groove
  const inset = -geo.g / 2;               // stretch to the grid lines: collinear walls join seamlessly
  const len = 2 * geo.u + geo.g - 2 * inset;
  const a = cellXY(vw.r, vw.c);
  if (vw.o === 'h') {
    return { x: a.x + inset, y: a.y + geo.u + geo.g / 2 - thick / 2, w: len, h: thick };
  }
  return { x: a.x + geo.u + geo.g / 2 - thick / 2, y: a.y + inset, w: thick, h: len };
}

function renderGame() {
  if (!game) return;
  const s = game.state;
  const me = game.myIndex;

  // walls (replay the pop-in animation only for newly added ones)
  const prevWallCount = game._wallsRendered || 0;
  board.querySelectorAll('.wall:not(.preview)').forEach(el => el.remove());
  s.walls.forEach((w, idx) => {
    const el = document.createElement('div');
    // wall wears the color of whoever placed it (player 0 blue, player 1 red)
    el.className = 'wall ' + (w.by === 0 ? 'blue' : w.by === 1 ? 'red' : '');
    if (idx < prevWallCount) el.classList.add('no-anim');
    const rect = wallRect(wallToView(w));
    el.style.cssText = `left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px`;
    board.appendChild(el);
  });
  game._wallsRendered = s.walls.length;

  const myTurn = s.turn === me && s.winner === null && !game.over;

  // pawns: my pawn gets my color; glowing ring when it's my turn
  pawnEls[me].className = 'pawn ' + myColor() + (myTurn ? ' glow' : '');
  pawnEls[1 - me].className = 'pawn ' + oppColor();
  positionPawn(0);
  positionPawn(1);

  // move hints are colored like my ball
  board.classList.toggle('my-blue', myColor() === 'blue');
  board.classList.toggle('my-red', myColor() === 'red');

  const legal = myTurn ? pawnMoves(s, me) : [];
  for (const el of cellEls) {
    const vr = +el.dataset.vr, vc = +el.dataset.vc;
    const lg = fromView(vr, vc);
    const isLegal = legal.some(m => m.r === lg.r && m.c === lg.c);
    el.classList.toggle('legal', isLegal);
  }

  // HUD
  $('me-nick').textContent = myNick();
  $('opp-nick').textContent = game.oppNick;
  $('me-walls').textContent = s.left[me];
  $('opp-walls').textContent = s.left[1 - me];
  $('dock-walls').textContent = s.left[me];
  const canDrag = myTurn && s.left[me] > 0;
  $('drag-h').classList.toggle('disabled', !canDrag);
  $('drag-v').classList.toggle('disabled', !canDrag);
  $('chip-me').className = 'p-pill ' + myColor() + (myTurn ? ' turn-active' : '');
  $('chip-opp').className = 'p-pill ' + oppColor() +
    (!myTurn && s.winner === null && !game.over ? ' turn-active' : '');
  $('chip-me').querySelector('.chip-ball').className = 'chip-ball ' + myColor();
  $('chip-opp').querySelector('.chip-ball').className = 'chip-ball ' + oppColor();
  applyChipBallColors();
  $('turn-banner').textContent = myTurn ? t('your_turn') : t('opp_turn');
  const bandTop = board.querySelector('.zone-band.top');
  const bandBottom = board.querySelector('.zone-band.bottom');
  if (isRace()) {
    // race: everyone runs to the same finish line on top
    $('zone-top').textContent = '🏁 ' + t('finish_label');
    $('zone-top').className = 'zone-label zone-top finish';
    $('zone-bottom').textContent = '▲ ' + myNick().toUpperCase() + ' · ' + String(game.oppNick).toUpperCase();
    $('zone-bottom').className = 'zone-label zone-bottom';
    if (bandTop) bandTop.className = 'zone-band top finish';
  } else {
    // like the competitor: each end is tinted with its OWNER's color —
    // opponent's home on top, mine at the bottom (that's also my start)
    $('zone-top').textContent = '▲ ' + String(game.oppNick).toUpperCase();
    $('zone-top').className = 'zone-label zone-top ' + oppColor();
    $('zone-bottom').textContent = '▼ ' + myNick().toUpperCase();
    $('zone-bottom').className = 'zone-label zone-bottom ' + myColor();
    if (bandTop) bandTop.className = 'zone-band top ' + oppColor();
    if (bandBottom) bandBottom.className = 'zone-band bottom ' + myColor();
  }
}

function myColor() { return game.myIndex === 0 ? 'blue' : 'red'; }
function oppColor() { return game.myIndex === 0 ? 'red' : 'blue'; }

function applyChipBallColors() {
  document.querySelectorAll('.chip-ball').forEach(el => {
    const isRed = el.classList.contains('red');
    el.style.background = isRed
      ? 'radial-gradient(circle at 32% 26%, #ffb9c0, #e33d52 62%, #a91f33)'
      : 'radial-gradient(circle at 32% 26%, #b6d2ff, #2f6df6 62%, #1a48b8)';
  });
}

/* ================= clocks ================= */
function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

setInterval(() => {
  if (!game || game.over) return;
  if (game.mode === 'ai') {
    $('me-clock').textContent = '—';
    $('opp-clock').textContent = '—';
    $('me-clock').classList.remove('danger');
    $('opp-clock').classList.remove('danger');
    return;
  }
  const ck = game.clocks;
  if (!ck) return;
  const elapsed = Date.now() - ck.recvAt;
  const me = game.myIndex;
  const bank = [...ck.bank];
  const active = ck.turn;
  bank[active] = Math.max(0, bank[active] - elapsed);
  const moveLeft = Math.max(0, Math.min(ck.moveLimit - elapsed, bank[active]));

  // no-time rooms show ∞ — only the 30s per-move rule applies
  $('me-clock').textContent = ck.noTime ? '∞' : fmtClock(bank[me]);
  $('opp-clock').textContent = ck.noTime ? '∞' : fmtClock(bank[1 - me]);
  const meDanger = active === me && (moveLeft <= 10_000 || (!ck.noTime && bank[me] <= 10_000));
  const oppDanger = active !== me && (moveLeft <= 10_000 || (!ck.noTime && bank[1 - me] <= 10_000));
  $('me-clock').classList.toggle('danger', meDanger);
  $('opp-clock').classList.toggle('danger', oppDanger);

  const myTurn = active === me;
  $('turn-banner').textContent =
    (myTurn ? t('your_turn') : t('opp_turn')) + ` · ${Math.ceil(moveLeft / 1000)}s`;
}, 250);

/* ============ moves: tap a cell to move · drag a wall from the dock ============ */
let previewEl = null;
let dragWall = null; // 'h' | 'v' while a wall is being dragged from the dock
let dragValid = false;
let dragSlot = null; // logical wall coords under the finger

function isMyTurn() {
  return game && !game.over && game.state.winner === null && game.state.turn === game.myIndex;
}

function cancelWallPreview() {
  dragWall = null;
  dragSlot = null;
  dragValid = false;
  if (previewEl) { previewEl.remove(); previewEl = null; }
}

// nearest wall slot to a board point, orientation is fixed by the dragged handle
function nearestSlot(px, py, o) {
  const step = geo.u + geo.g;
  const { cols, rows } = dims();
  const clampR = (v) => Math.max(0, Math.min(rows - 2, v));
  const clampC = (v) => Math.max(0, Math.min(cols - 2, v));
  const r = clampR(Math.round((py - geo.pad - geo.u - geo.g / 2) / step));
  const c = clampC(Math.round((px - geo.pad - geo.u - geo.g / 2) / step));
  return wallFromView({ o, r, c });
}

function updateDragPreview(clientX, clientY, isTouch) {
  const bw = board.getBoundingClientRect();
  const px = clientX - bw.left;
  let py = clientY - bw.top;
  if (isTouch) py -= geo.u * 0.8; // keep the wall visible above the finger
  // outside the board → hide the preview but keep dragging
  if (px < -geo.u || py < -geo.u || px > bw.width + geo.u || py > bw.height + geo.u) {
    if (previewEl) { previewEl.remove(); previewEl = null; }
    dragSlot = null;
    return;
  }
  dragSlot = nearestSlot(Math.max(0, Math.min(bw.width, px)), Math.max(0, Math.min(bw.height, py)), dragWall);
  dragValid = canPlaceWall(game.state, game.myIndex, dragSlot) && game.state.left[game.myIndex] > 0;
  if (!previewEl) {
    previewEl = document.createElement('div');
    board.appendChild(previewEl);
  }
  previewEl.className = `wall preview ${myColor()} ${dragValid ? 'preview-ok' : 'preview-bad'}`;
  const rect = wallRect(wallToView(dragSlot));
  previewEl.style.cssText = `left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px`;
}

function finishDrag() {
  if (dragWall && dragSlot && dragValid) {
    const w = dragSlot;
    cancelWallPreview();
    submitMove({ type: 'wall', ...w });
  } else {
    cancelWallPreview();
  }
}

function startDrag(o) {
  if (!isMyTurn() || game.state.left[game.myIndex] <= 0) return false;
  dragWall = o;
  dragSlot = null;
  dragValid = false;
  vibrate(12);
  return true;
}

for (const [id, o] of [['drag-h', 'h'], ['drag-v', 'v']]) {
  const el = $(id);
  el.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (startDrag(o)) {
      const tt = e.changedTouches[0];
      updateDragPreview(tt.clientX, tt.clientY, true);
    }
  }, { passive: false });
  el.addEventListener('mousedown', (e) => {
    if ('ontouchstart' in window) return;
    e.preventDefault();
    startDrag(o);
  });
}

document.addEventListener('touchmove', (e) => {
  if (!dragWall) return;
  e.preventDefault();
  const tt = e.changedTouches[0];
  updateDragPreview(tt.clientX, tt.clientY, true);
}, { passive: false });
document.addEventListener('touchend', () => { if (dragWall) finishDrag(); });
document.addEventListener('touchcancel', () => { if (dragWall) cancelWallPreview(); });

window.addEventListener('mousemove', (e) => { if (dragWall) updateDragPreview(e.clientX, e.clientY, false); });
window.addEventListener('mouseup', () => { if (dragWall) finishDrag(); });

// tap a highlighted cell → move the ball
function tapCell(target) {
  if (!isMyTurn() || dragWall) return false;
  const cell = target?.closest?.('.cell');
  if (cell && cell.classList.contains('legal')) {
    const lg = fromView(+cell.dataset.vr, +cell.dataset.vc);
    submitMove({ type: 'pawn', r: lg.r, c: lg.c });
    return true;
  }
  return false;
}

// react on touchend directly: mobile browsers fire `click` with a delay,
// and the move must land the instant the finger lifts
let cellTouch = null;
board.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1 && !dragWall) {
    const tt = e.touches[0];
    cellTouch = { x: tt.clientX, y: tt.clientY };
  } else cellTouch = null;
}, { passive: true });
board.addEventListener('touchend', (e) => {
  const start = cellTouch;
  cellTouch = null;
  if (!start || dragWall) return;
  const tt = e.changedTouches[0];
  if (Math.abs(tt.clientX - start.x) > 14 || Math.abs(tt.clientY - start.y) > 14) return; // was a scroll
  if (tapCell(document.elementFromPoint(tt.clientX, tt.clientY))) {
    e.preventDefault(); // swallow the delayed synthetic click so the move isn't sent twice
  }
}, { passive: false });

board.addEventListener('click', (e) => { tapCell(e.target); }, false);

function submitMove(move) {
  if (!isMyTurn()) return;
  vibrate(move.type === 'wall' ? 25 : 15);
  tick(true, move.type === 'wall');
  if (game.mode === 'online') {
    wsSend({ t: 'move', move });
    // optimistic apply for snappy UI; server state will overwrite
    const copy = cloneState(game.state);
    if (applyMove(copy, move)) {
      if (move.type === 'wall') copy.walls[copy.walls.length - 1].by = game.myIndex;
      game.state = copy;
      renderGame();
    }
  } else {
    const s = game.state;
    if (!applyMove(s, move)) return;
    notePos(s);
    if (move.type === 'wall') s.walls[s.walls.length - 1].by = game.myIndex;
    recordSnapshot(s);
    renderGame();
    if (s.winner !== null) { onGameOver(s.winner === game.myIndex, 'goal'); return; }
    scheduleAiMove();
  }
}

/* ================= AI mode ================= */
function posKey(s) {
  return `${s.pawns[0].r},${s.pawns[0].c}|${s.pawns[1].r},${s.pawns[1].c}|${s.left[0]},${s.left[1]}`;
}

function notePos(s) {
  if (!game || game.mode !== 'ai') return;
  (game.seen = game.seen || []).push(posKey(s));
  if (game.seen.length > 16) game.seen.shift();
}

function scheduleAiMove() {
  clearTimeout(aiTimer);
  const hardcore = game.aiLevel === 'hardcore';
  aiTimer = setTimeout(async () => {
    if (!game || game.mode !== 'ai' || game.over) return;
    const g = game;
    const s = game.state;
    if (s.turn !== 1 - game.myIndex) return;
    const t0 = Date.now();
    const move = await aiMoveAsync(s, game.aiLevel, { recent: game.seen || [] });
    if (game !== g || !move) return; // the game was left/restarted meanwhile
    const finish = () => {
      if (!game || game.mode !== 'ai' || game.over) return;
      if (applyMove(s, move)) {
        notePos(s);
        if (move.type === 'wall') s.walls[s.walls.length - 1].by = 1 - game.myIndex;
        recordSnapshot(s);
        renderGame();
        vibrate(10);
        tick(false, move.type === 'wall');
        if (s.winner !== null) onGameOver(s.winner === game.myIndex, 'goal');
      }
    };
    // hardcore always answers after exactly ~1.3s: thinking time + padding
    const pad = hardcore ? Math.max(0, 1300 - (Date.now() - t0)) : 0;
    aiTimer = setTimeout(finish, pad);
  }, hardcore ? 120 : 500 + Math.random() * 700);
}

function startAiGame(level = 'normal', boardMode = 'duel') {
  game = {
    mode: 'ai',
    aiLevel: level,
    state: initialState(boardMode),
    myIndex: 0,
    oppNick: '🤖 ' + t('ai_' + level),
    clocks: null,
    over: false,
  };
  game.state.turn = Math.random() < 0.5 ? 0 : 1;
  game.seen = []; // recent positions, so hardcore never shuffles back and forth
  game.history = [cloneState(game.state)]; // for the post-game replay
  stopReplay();
  $('overlay-gameover').hidden = true;
  cancelWallPreview();
  logVisit(true);
  show('screen-game');
  buildBoard();
  renderGame();
  if (game.state.turn === 1) scheduleAiMove();
}

$('btn-ai').addEventListener('click', () => show('screen-ai'));
for (const lvl of ['easy', 'normal', 'hard', 'hardcore']) {
  $('ai-' + lvl).addEventListener('click', () => startAiGame(lvl));
}

/* ================= online game ================= */
function startOnlineGame(msg) {
  game = {
    mode: 'online',
    state: msg.state,
    myIndex: msg.you,
    oppNick: msg.opp?.nick || '???',
    clocks: { ...msg.clocks, recvAt: Date.now() },
    over: false,
    history: [cloneState(msg.state)], // for the post-game replay
  };
  stopReplay();
  $('overlay-gameover').hidden = true;
  $('btn-rematch').style.display = '';
  $('rematch-status').hidden = true;
  cancelWallPreview();
  logVisit(true);
  show('screen-game');
  buildBoard();
  renderGame();
  vibrate([20, 40, 20]);
}

/* ================= game over / rematch ================= */
function onGameOver(iWon, reason) {
  if (!game || game.over) return;
  game.over = true;
  clearTimeout(aiTimer);
  renderGame();
  const reasonKey = {
    goal: 'reason_goal', timeout: 'reason_timeout', move_timeout: 'reason_move_timeout',
    opponent_left: 'reason_opponent_left', resign: 'reason_resign',
  }[reason] || 'reason_goal';
  setTimeout(() => {
    $('result-emoji').textContent = iWon ? '🏆' : '😔';
    $('result-title').textContent = iWon ? t('game_win') : t('game_lose');
    $('result-reason').textContent = t(reasonKey);
    document.querySelector('.win-modal').classList.toggle('lose', !iWon);
    // players strip
    $('rs-ball-me').className = 'rs-ball ' + myColor();
    $('rs-ball-opp').className = 'rs-ball ' + oppColor();
    $('rs-nick-me').textContent = myNick();
    $('rs-nick-opp').textContent = game?.oppNick || '';
    $('rs-tag-me').textContent = iWon ? 'WIN' : 'LOSS';
    $('rs-tag-me').className = iWon ? 'win' : 'loss';
    $('rs-tag-opp').textContent = iWon ? 'LOSS' : 'WIN';
    $('rs-tag-opp').className = iWon ? 'loss' : 'win';
    spawnConfetti(iWon);
    $('btn-rematch').style.display = '';
    $('rematch-status').hidden = true;
    $('overlay-gameover').hidden = false;
  }, 600);
  vibrate(iWon ? [40, 60, 40, 60, 80] : 60);
}

function spawnConfetti(on) {
  const box = $('confetti');
  box.innerHTML = '';
  if (!on) return;
  const colors = ['#2f6df6', '#ffb340', '#ff5c7a', '#21c07a', '#9b7bff', '#ff8a5c'];
  for (let i = 0; i < 42; i++) {
    const p = document.createElement('span');
    p.style.left = Math.random() * 100 + '%';
    p.style.background = colors[i % colors.length];
    p.style.animationDuration = (2.4 + Math.random() * 2.4) + 's';
    p.style.animationDelay = (Math.random() * 1.8) + 's';
    p.style.transform = `rotate(${Math.random() * 360}deg)`;
    box.appendChild(p);
  }
}

$('btn-rematch').addEventListener('click', () => {
  if (!game) return;
  if (game.mode === 'ai') { startAiGame(game.aiLevel); return; }
  wsSend({ t: 'rematch', yes: true });
  $('rematch-status').hidden = false;
  $('rematch-status').textContent = t('rematch_wait');
});

$('btn-to-menu').addEventListener('click', () => {
  if (game?.mode === 'online') wsSend({ t: 'rematch', yes: false });
  wsSend({ t: 'leave_room' });
  stopReplay();
  game = null; // history goes with it — nothing is kept
  $('overlay-gameover').hidden = true;
  show('screen-home');
});

/* ================= replay of the finished game ================= */
let replay = null; // { idx, timer, playing, savedState }

function renderReplayFrame() {
  if (!replay || !game) return;
  const last = game.history.length - 1;
  replay.idx = Math.max(0, Math.min(last, replay.idx));
  game.state = cloneState(game.history[replay.idx]);
  game._wallsRendered = game.state.walls.length; // no pop-in flicker while scrubbing
  renderGame();
  $('turn-banner').textContent = t('replay_move') + ' ' + replay.idx + '/' + last;
  $('rp-count').textContent = replay.idx + '/' + last;
  $('rp-fill').style.width = (last ? (replay.idx / last * 100) : 0) + '%';
  $('rp-play').textContent = replay.playing ? '⏸' : '▶';
}

function replayTick() {
  if (!replay) return;
  const last = game.history.length - 1;
  if (replay.idx >= last) { replay.playing = false; renderReplayFrame(); return; }
  replay.idx++;
  renderReplayFrame();
  tick(replay.idx % 2 === 0); // soft click on each step
}

function playReplay(on) {
  if (!replay) return;
  clearInterval(replay.timer);
  replay.playing = on;
  if (on) {
    if (replay.idx >= game.history.length - 1) replay.idx = 0; // restart from the top
    renderReplayFrame();
    replay.timer = setInterval(replayTick, 750);
  }
  renderReplayFrame();
}

function startReplay() {
  if (!game || !game.history || game.history.length < 2) return;
  replay = { idx: 0, timer: null, playing: false, savedState: game.state };
  $('overlay-gameover').hidden = true;
  $('replay-bar').hidden = false;
  playReplay(true);
}

function stopReplay() {
  if (!replay) return;
  clearInterval(replay.timer);
  if (game) game.state = replay.savedState; // put the final position back
  replay = null;
  $('replay-bar').hidden = true;
}

$('btn-replay').addEventListener('click', startReplay);
$('rp-close').addEventListener('click', () => {
  stopReplay();
  $('overlay-gameover').hidden = false; // back to the win/lose screen
});
$('rp-play').addEventListener('click', () => playReplay(!replay?.playing));
$('rp-start').addEventListener('click', () => { if (replay) { playReplay(false); replay.idx = 0; renderReplayFrame(); } });
$('rp-prev').addEventListener('click', () => { if (replay) { playReplay(false); replay.idx--; renderReplayFrame(); } });
$('rp-next').addEventListener('click', () => { if (replay) { playReplay(false); replay.idx++; renderReplayFrame(); } });

/* resign */
$('btn-resign').addEventListener('click', () => { if (game && !game.over) $('overlay-resign').hidden = false; });
$('btn-resign-no').addEventListener('click', () => { $('overlay-resign').hidden = true; });
$('btn-resign-yes').addEventListener('click', () => {
  $('overlay-resign').hidden = true;
  if (!game || game.over) return;
  if (game.mode === 'online') wsSend({ t: 'resign' });
  else onGameOver(false, 'resign');
});

/* ================= emoji ================= */
let emojiTimer = null;
document.querySelectorAll('#emoji-bar button').forEach(b =>
  b.addEventListener('click', () => {
    if (game?.mode === 'online') wsSend({ t: 'emoji', e: b.dataset.emoji });
    showEmoji(b.dataset.emoji, true);
  }));

function showEmoji(e, mine = false) {
  const pop = $('emoji-pop');
  pop.textContent = e;
  pop.style.right = mine ? '' : '8px';
  pop.style.left = mine ? '8px' : '';
  pop.style.top = mine ? '' : '8px';
  pop.style.bottom = mine ? '8px' : '';
  pop.hidden = false;
  clearTimeout(emojiTimer);
  emojiTimer = setTimeout(() => { pop.hidden = true; }, 1800);
}

/* ================= leaderboard ================= */
async function loadLeaderboard() {
  const list = $('lb-list');
  try {
    const res = await fetch('/api/leaderboard');
    const { rows } = await res.json();
    list.innerHTML = '';
    if (!rows?.length) {
      list.innerHTML = `<div class="lb-empty">${t('leaderboard_empty')}</div>`;
      return;
    }
    rows.forEach((row, i) => {
      const el = document.createElement('div');
      el.className = 'lb-item';
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
      el.innerHTML = `<div class="lb-rank"></div><div class="r-avatar"></div>
        <div class="lb-nick"></div>
        <div class="lb-score"><b></b><small></small></div>`;
      el.querySelector('.lb-rank').textContent = medal;
      el.querySelector('.r-avatar').textContent = (row.nick || '?')[0].toUpperCase();
      el.querySelector('.lb-nick').textContent = row.nick;
      el.querySelector('.lb-score b').textContent = row.wins;
      el.querySelector('.lb-score small').textContent = `${t('lb_wins')} · ${row.losses} ${t('lb_losses')}`;
      list.appendChild(el);
    });
  } catch {
    list.innerHTML = `<div class="lb-empty">${t('err_generic')}</div>`;
  }
}

/* ================= profile & auth ================= */
function updateProfileUI() {
  const nick = myNick();
  $('profile-nick').textContent = nick;
  $('profile-avatar').textContent = nick[0].toUpperCase();
  const wins = profile?.wins || 0, losses = profile?.losses || 0;
  $('stat-games').textContent = wins + losses;
  $('stat-wins').textContent = wins;
  $('stat-losses').textContent = losses;
  $('stat-rate').textContent = (wins + losses) > 0 ? Math.round(100 * wins / (wins + losses)) + '%' : '—';
  $('theme-toggle').checked = localStorage.getItem('wr_theme') === 'dark';
  const logged = Boolean(session && profile);
  $('guest-hint').hidden = logged;
  $('auth-buttons').hidden = logged; // always visible for guests, even if auth is broken —
                                     // tapping then explains WHY it is unavailable
  $('logged-box').hidden = !logged;
  $('vibro-toggle').checked = vibroOn;
  $('sound-toggle').checked = soundOn;
}

let authMode = 'login'; // 'login' | 'register' | 'nick' | 'reset'

function openAuthForm(mode) {
  authMode = mode;
  // login accepts nick OR email; registration pre-fills a suggested nick
  $('auth-email').placeholder = mode === 'login' ? t('email_or_nick') : t('email');
  if (mode === 'register' && !$('auth-nick').value) {
    $('auth-nick').value = 'Player' + (100 + Math.floor(Math.random() * 900));
  }
  $('auth-buttons').hidden = true;
  $('auth-form').hidden = false;
  $('auth-msg').hidden = true;
  $('auth-email').hidden = mode === 'nick' || mode === 'reset';
  $('auth-password').hidden = mode === 'nick';
  $('auth-nick').hidden = mode !== 'register' && mode !== 'nick';
  $('btn-forgot').hidden = mode !== 'login';
  $('btn-auth-toggle').hidden = mode === 'nick' || mode === 'reset';
  $('btn-auth-submit').textContent =
    mode === 'login' ? t('do_login') : mode === 'register' ? t('do_register') : t('save');
  $('btn-auth-toggle').textContent = mode === 'login' ? t('no_account') : t('have_account');
  if (mode === 'reset') $('auth-password').placeholder = t('new_password');
}

function closeAuthForm() {
  $('auth-form').hidden = true;
  updateProfileUI();
}

function authMsg(text, ok = false) {
  const el = $('auth-msg');
  el.textContent = text;
  el.className = 'auth-msg' + (ok ? ' ok' : '');
  el.hidden = false;
}

function ensureAuthAvailable() {
  if (config.auth && supabase) return true;
  toast(`${t('auth_unavailable')} [${config.dbStatus || 'offline'}]${config.dbDetail ? ' — ' + config.dbDetail : ''}`);
  return false;
}
$('btn-show-login').addEventListener('click', () => { if (ensureAuthAvailable()) openAuthForm('login'); });
$('btn-show-register').addEventListener('click', () => { if (ensureAuthAvailable()) openAuthForm('register'); });
$('btn-auth-toggle').addEventListener('click', () => openAuthForm(authMode === 'login' ? 'register' : 'login'));
$('btn-auth-cancel').addEventListener('click', closeAuthForm);

$('btn-forgot').addEventListener('click', async () => {
  const email = $('auth-email').value.trim();
  if (!email || !supabase) return;
  await supabase.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
  authMsg(t('reset_sent'), true);
});

$('btn-auth-submit').addEventListener('click', async () => {
  if (!supabase) return;
  const email = $('auth-email').value.trim();
  const password = $('auth-password').value;
  const nick = $('auth-nick').value.trim();
  try {
    if (authMode === 'register') {
      if (!/^[A-Za-z0-9_а-яА-ЯёЁ]{3,16}$/.test(nick)) { authMsg(t('err_nick_bad')); return; }
      // server-side signup: account is created already confirmed
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, nick }),
      });
      const data = await res.json();
      if (data.error) {
        const map = {
          email_bad: t('err_email_bad'), email_taken: t('err_email_taken'),
          password_short: t('err_password_short'),
          nick_bad: t('err_nick_bad'), nick_taken: t('err_nick_taken'),
        };
        authMsg(map[data.error] || (data.detail ? `${t('err_generic')}: ${data.detail}` : t('err_generic')));
        return;
      }
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) { authMsg(t('auth_error')); return; }
      await afterLogin();
    } else if (authMode === 'login') {
      let loginEmail = email;
      if (email && !email.includes('@')) { // a nick was typed — resolve it to the email
        const r = await fetch('/api/resolve-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nick: email }),
        });
        const d = await r.json();
        if (d.error) { authMsg(t('err_login_not_found')); return; }
        loginEmail = d.email;
      }
      const { error } = await supabase.auth.signInWithPassword({ email: loginEmail, password });
      if (error) { authMsg(t('auth_error')); return; }
      await afterLogin();
    } else if (authMode === 'nick') {
      if (!/^[A-Za-z0-9_а-яА-ЯёЁ]{3,16}$/.test(nick)) { authMsg(t('err_nick_bad')); return; }
      const created = await createProfileReq(nick);
      if (!created) return;
      closeAuthForm();
    } else if (authMode === 'reset') {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) { authMsg(error.message); return; }
      await afterLogin();
    }
  } catch {
    authMsg(t('err_generic'));
  }
});

async function createProfileReq(nick) {
  const res = await fetch('/api/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ nick }),
  });
  const data = await res.json();
  if (data.error === 'nick_taken') { authMsg(t('err_nick_taken')); return false; }
  if (data.error === 'nick_bad') { authMsg(t('err_nick_bad')); return false; }
  if (data.error) { authMsg(t('err_generic')); return false; }
  profile = data.profile;
  updateProfileUI();
  return true;
}

async function afterLogin() {
  const { data } = await supabase.auth.getSession();
  session = data.session;
  if (!session) return;
  const res = await fetch('/api/profile', { headers: { Authorization: `Bearer ${session.access_token}` } });
  const body = await res.json();
  profile = body.profile;
  if (!profile) {
    const pending = localStorage.getItem('wr_pending_nick');
    if (pending && await createProfileReq(pending)) {
      localStorage.removeItem('wr_pending_nick');
      closeAuthForm();
    } else {
      openAuthForm('nick'); // ask for a nick
      updateProfileUI();
      return;
    }
  } else {
    closeAuthForm();
  }
  updateProfileUI();
  // re-identify on the game server with the account nick
  wsSend({ t: 'hello', nick: myNick(), token: wsToken, jwt: session.access_token });
}

$('btn-logout').addEventListener('click', async () => {
  if (supabase) await supabase.auth.signOut();
  session = null;
  profile = null;
  updateProfileUI();
  wsSend({ t: 'hello', nick: myNick(), token: wsToken });
});

/* ================= settings ================= */
document.querySelectorAll('.lang-switch button').forEach(b =>
  b.addEventListener('click', () => {
    lang = b.dataset.lang;
    localStorage.setItem('wr_lang', lang);
    applyI18n();
    if (game) renderGame();
  }));

$('vibro-toggle').addEventListener('change', (e) => {
  vibroOn = e.target.checked;
  localStorage.setItem('wr_vibro', vibroOn ? '1' : '0');
  if (vibroOn) vibrate(20);
});

$('sound-toggle').addEventListener('change', (e) => {
  soundOn = e.target.checked;
  localStorage.setItem('wr_sound', soundOn ? '1' : '0');
  if (soundOn) tick(true); // preview
});

/* ================= PWA: installable app ================= */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// browsers fire this when the app is installable — show the profile button
// and (like the competitor) a slim banner right on the home screen
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvt = e;
  $('install-row').hidden = false;
  // show the banner on every visit/reload (closing only hides it for now)
  if (!runsInstalled()) $('install-banner').hidden = false;
});
async function doInstall() {
  if (!installEvt) return;
  installEvt.prompt();
  await installEvt.userChoice.catch(() => {});
  installEvt = null;
  $('install-row').hidden = true;
  $('install-banner').hidden = true;
}
$('btn-install').addEventListener('click', doInstall);
$('install-banner-go').addEventListener('click', doInstall);
$('install-banner-close').addEventListener('click', () => {
  $('install-banner').hidden = true; // just for this view — returns on next reload
  iosDismissed = true;
});

// iPhone/iPad: Safari never fires beforeinstallprompt, so show a manual hint
// (Share → Add to Home Screen). Only in Safari (other iOS browsers can't do it).
let iosDismissed = false;
function maybeShowIosInstall() {
  const ua = navigator.userAgent;
  const isIOS = /iphone|ipad|ipod/i.test(ua);
  const iosSafari = isIOS && /safari/i.test(ua) && !/crios|fxios|edgios|yabrowser|opios/i.test(ua);
  if (iosSafari && !runsInstalled() && !iosDismissed) {
    $('install-banner-go').hidden = true;          // no auto-install button on iOS
    const el = $('install-banner-text');
    el.removeAttribute('data-i18n');               // stop applyI18n from overwriting it
    el.textContent = t('install_ios');
    $('install-banner').hidden = false;
  }
}
maybeShowIosInstall();

/* ================= legal / info pages ================= */
document.querySelectorAll('.legal-links a[data-legal]').forEach(a =>
  a.addEventListener('click', () => {
    const p = a.dataset.legal; // rules | help | terms | privacy
    $('legal-title').textContent = t(p + '_title');
    $('legal-text').textContent = t(p + '_body');
    $('overlay-legal').hidden = false;
  }));
$('legal-close').addEventListener('click', () => { $('overlay-legal').hidden = true; });

$('theme-toggle').addEventListener('change', (e) => {
  localStorage.setItem('wr_theme', e.target.checked ? 'dark' : 'light');
  applyTheme();
});

/* ================= boot ================= */
window.addEventListener('resize', () => {
  if (game && currentScreen === 'screen-game') { buildBoard(); cancelWallPreview(); renderGame(); }
});

async function boot() {
  applyI18n();
  logVisit(false);
  updateProfileUI();
  connectWs();
  try {
    config = await (await fetch('/api/config')).json();
  } catch { config = { auth: false }; }
  if (config.auth) {
    try {
      // bundled locally (public/vendor) — no CDN needed; esm.sh is only a fallback
      const mod = window.supabase || await import('https://esm.sh/@supabase/supabase-js@2');
      supabase = mod.createClient(config.supabaseUrl, config.supabaseAnonKey);
      supabase.auth.onAuthStateChange((event) => {
        if (event === 'PASSWORD_RECOVERY') {
          show('screen-profile');
          openAuthForm('reset');
        }
      });
      const { data } = await supabase.auth.getSession();
      if (data.session) { session = data.session; await afterLogin(); }
    } catch (e) {
      console.error('auth init failed', e);
      config.auth = false;
    }
  }
  updateProfileUI();
}

boot();
