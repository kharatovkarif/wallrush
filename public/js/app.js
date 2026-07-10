// WallRush client app: screens, board UI, online play (WebSocket), AI mode, auth.
import { initialState, applyMove, pawnMoves, canPlaceWall, goalRow, cloneState, N } from './engine.js?v=8';
import { aiMove } from './ai.js?v=8';
import { makeT } from './i18n.js?v=8';

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

let guestNick = sessionStorage.getItem('wr_nick');
if (!guestNick) {
  guestNick = 'User' + (1000 + Math.floor(Math.random() * 9000));
  sessionStorage.setItem('wr_nick', guestNick);
}

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

/* ================= helpers ================= */
function vibrate(pattern) {
  if (vibroOn && navigator.vibrate) navigator.vibrate(pattern);
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
        game.state = msg.state;
        game.clocks = { ...msg.clocks, recvAt: Date.now() };
        cancelWallPreview();
        renderGame();
        vibrate(12);
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
    el.innerHTML = `<div class="r-avatar"></div><b></b><button class="btn-join"></button>`;
    el.querySelector('.r-avatar').textContent = letter;
    el.querySelector('b').textContent = room.nick;
    const btn = el.querySelector('.btn-join');
    btn.textContent = t('join');
    btn.addEventListener('click', () => wsSend({ t: 'join_room', roomId: room.id }));
    list.appendChild(el);
  }
}

$('btn-online').addEventListener('click', () => show('screen-rooms'));
$('btn-create-room').addEventListener('click', () => wsSend({ t: 'create_room', private: false }));
$('btn-quick').addEventListener('click', () => { wsSend({ t: 'quick' }); show('screen-waiting'); $('waiting-code').hidden = true; });
$('btn-friend').addEventListener('click', () => show('screen-friend'));
$('btn-friend-create').addEventListener('click', () => wsSend({ t: 'create_room', private: true }));
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

function computeGeo() {
  const size = board.clientWidth;
  const u = size / 12;       // 9u cells + 8*0.3u gaps + 2*0.3u padding = 12u
  const g = 0.3 * u;
  geo = { size, u, g, pad: g };
}

function cellXY(r, c) {
  return { x: geo.pad + c * (geo.u + geo.g), y: geo.pad + r * (geo.u + geo.g) };
}

// view mapping: player 1 sees the board rotated 180°
function toView(r, c) {
  if (game?.myIndex === 1) return { r: 8 - r, c: 8 - c };
  return { r, c };
}
function wallToView(w) {
  if (game?.myIndex === 1) return { r: 7 - w.r, c: 7 - w.c, o: w.o };
  return w;
}
// inverse mappings equal the forward ones (180° rotation is an involution)
const fromView = toView;
const wallFromView = wallToView;

function buildBoard() {
  computeGeo();
  board.innerHTML = '';
  cellEls = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
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
  const thick = geo.g * 1.7; // slightly overlaps cells — thick, competitor-style bars
  const len = 2 * geo.u + geo.g;
  const a = cellXY(vw.r, vw.c);
  if (vw.o === 'h') {
    return { x: a.x, y: a.y + geo.u + geo.g / 2 - thick / 2, w: len, h: thick };
  }
  return { x: a.x + geo.u + geo.g / 2 - thick / 2, y: a.y, w: thick, h: len };
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
    el.className = 'wall ' + (w.by === me ? myColor() : oppColor());
    if (idx < prevWallCount) el.classList.add('no-anim');
    const rect = wallRect(wallToView(w));
    el.style.cssText = `left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px`;
    board.appendChild(el);
  });
  game._wallsRendered = s.walls.length;

  // pawns: my pawn gets my color
  pawnEls[me].className = 'pawn ' + myColor();
  pawnEls[1 - me].className = 'pawn ' + oppColor();
  positionPawn(0);
  positionPawn(1);

  // goal zones + legal cells
  const myTurn = s.turn === me && s.winner === null && !game.over;
  const legal = myTurn ? pawnMoves(s, me) : [];
  for (const el of cellEls) {
    const vr = +el.dataset.vr, vc = +el.dataset.vc;
    const lg = fromView(vr, vc);
    el.className = 'cell';
    if (lg.r === goalRow(me)) el.classList.add('goal-mine');
    if (lg.r === goalRow(1 - me)) el.classList.add('goal-opp');
    if (legal.some(m => m.r === lg.r && m.c === lg.c)) el.classList.add('legal');
  }

  // HUD
  $('me-nick').textContent = myNick();
  $('opp-nick').textContent = game.oppNick;
  $('me-walls').textContent = s.left[me];
  $('opp-walls').textContent = s.left[1 - me];
  $('chip-me').querySelector('.chip-ball').style.background = '';
  $('chip-me').querySelector('.chip-ball').className = 'chip-ball pawn-mini ' + myColor();
  $('chip-opp').querySelector('.chip-ball').className = 'chip-ball pawn-mini ' + oppColor();
  applyChipBallColors();
  $('chip-me').classList.toggle('turn-active', myTurn);
  $('chip-opp').classList.toggle('turn-active', !myTurn && s.winner === null && !game.over);
  $('turn-banner').textContent = myTurn ? t('your_turn') : t('opp_turn');
  $('zone-top').textContent = t('zone_you');
  $('zone-top').classList.add('mine');
  $('zone-bottom').textContent = t('zone_opp');
}

function myColor() { return game.myIndex === 0 ? 'blue' : 'red'; }
function oppColor() { return game.myIndex === 0 ? 'red' : 'blue'; }

function applyChipBallColors() {
  document.querySelectorAll('.chip-ball').forEach(el => {
    const isRed = el.classList.contains('red');
    el.style.background = isRed
      ? 'radial-gradient(circle at 32% 28%, #ff8a94, #ff4d5e 60%, #c62f40)'
      : 'radial-gradient(circle at 32% 28%, #7aa5ff, #3d7bff 60%, #2453b8)';
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

  $('me-clock').textContent = fmtClock(bank[me]);
  $('opp-clock').textContent = fmtClock(bank[1 - me]);
  const meDanger = active === me && (moveLeft <= 10_000 || bank[me] <= 10_000);
  const oppDanger = active !== me && (moveLeft <= 10_000 || bank[1 - me] <= 10_000);
  $('me-clock').classList.toggle('danger', meDanger);
  $('opp-clock').classList.toggle('danger', oppDanger);

  const myTurn = active === me;
  $('turn-banner').textContent =
    (myTurn ? t('your_turn') : t('opp_turn')) + ` · ${Math.ceil(moveLeft / 1000)}s`;
}, 250);

/* ============ moves: tap to move / tap empty → wall + ↻/✓ buttons ============ */
// Tap-only interaction: the most reliable thing across every mobile browser.
// No drag, no pointer capture, no touch-action dependency.
let activeWall = null;  // { r, c, o } logical coords of the wall being placed
let previewEl = null;

function isMyTurn() {
  return game && !game.over && game.state.winner === null && game.state.turn === game.myIndex;
}

function cancelWallPreview() {
  activeWall = null;
  if (previewEl) { previewEl.remove(); previewEl = null; }
  $('wall-tools').hidden = true;
}

// nearest wall slot to a board point; orientation = whichever groove is closer
function nearestSlot(px, py) {
  const step = geo.u + geo.g;
  const clamp7 = (v) => Math.max(0, Math.min(7, v));
  const r = clamp7(Math.round((py - geo.pad - geo.u - geo.g / 2) / step));
  const c = clamp7(Math.round((px - geo.pad - geo.u - geo.g / 2) / step));
  const gx = geo.pad + c * step + geo.u + geo.g / 2;
  const gy = geo.pad + r * step + geo.u + geo.g / 2;
  const o = Math.abs(px - gx) < Math.abs(py - gy) ? 'v' : 'h';
  return wallFromView({ o, r, c });
}

function renderWallPreview() {
  if (!activeWall) return;
  const valid = canPlaceWall(game.state, game.myIndex, activeWall) && game.state.left[game.myIndex] > 0;
  if (!previewEl) {
    previewEl = document.createElement('div');
    board.appendChild(previewEl);
  }
  previewEl.className = `wall preview ${myColor()} ${valid ? 'preview-ok' : 'preview-bad'}`;
  const rect = wallRect(wallToView(activeWall));
  previewEl.style.cssText = `left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px`;
  $('wall-tools').hidden = false;
  $('wall-place').disabled = !valid;
  $('dbg').textContent = `стенка ${activeWall.o === 'h' ? '━' : '┃'} ${valid ? 'можно ✓' : 'нельзя'}`;
}

// single reliable handler: fires on every tap/click, on desktop and mobile
board.addEventListener('click', (e) => {
  if (!isMyTurn()) { $('dbg').textContent = 'не твой ход'; return; }
  const bw = board.getBoundingClientRect();
  const px = e.clientX - bw.left, py = e.clientY - bw.top;

  // tapped a highlighted move-cell → move the ball
  const cell = e.target.closest?.('.cell');
  if (cell && cell.classList.contains('legal')) {
    cancelWallPreview();
    const lg = fromView(+cell.dataset.vr, +cell.dataset.vc);
    $('dbg').textContent = `ход ${lg.r},${lg.c}`;
    submitMove({ type: 'pawn', r: lg.r, c: lg.c });
    return;
  }

  // tapped elsewhere → put (or move) a wall preview at the nearest slot
  if (game.state.left[game.myIndex] <= 0) { $('dbg').textContent = 'стенки кончились'; return; }
  activeWall = nearestSlot(px, py);
  renderWallPreview();
}, false);

$('wall-rotate').addEventListener('click', () => {
  if (!activeWall) return;
  activeWall = { ...activeWall, o: activeWall.o === 'h' ? 'v' : 'h' };
  renderWallPreview();
});
$('wall-place').addEventListener('click', () => {
  if (!activeWall) return;
  if (!canPlaceWall(game.state, game.myIndex, activeWall) || game.state.left[game.myIndex] <= 0) return;
  const w = activeWall;
  cancelWallPreview();
  submitMove({ type: 'wall', ...w });
});
$('wall-cancel').addEventListener('click', cancelWallPreview);

function submitMove(move) {
  if (!isMyTurn()) return;
  vibrate(move.type === 'wall' ? 25 : 15);
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
    if (move.type === 'wall') s.walls[s.walls.length - 1].by = game.myIndex;
    renderGame();
    if (s.winner !== null) { onGameOver(s.winner === game.myIndex, 'goal'); return; }
    scheduleAiMove();
  }
}

/* ================= AI mode ================= */
function scheduleAiMove() {
  clearTimeout(aiTimer);
  aiTimer = setTimeout(() => {
    if (!game || game.mode !== 'ai' || game.over) return;
    const s = game.state;
    if (s.turn !== 1 - game.myIndex) return;
    const move = aiMove(s);
    if (applyMove(s, move)) {
      if (move.type === 'wall') s.walls[s.walls.length - 1].by = 1 - game.myIndex;
      renderGame();
      vibrate(10);
      if (s.winner !== null) onGameOver(s.winner === game.myIndex, 'goal');
    }
  }, 500 + Math.random() * 700);
}

function startAiGame() {
  game = {
    mode: 'ai',
    state: initialState(),
    myIndex: 0,
    oppNick: '🤖 AI',
    clocks: null,
    over: false,
  };
  game.state.turn = Math.random() < 0.5 ? 0 : 1;
  $('overlay-gameover').hidden = true;
  cancelWallPreview();
  show('screen-game');
  buildBoard();
  renderGame();
  if (game.state.turn === 1) scheduleAiMove();
}

$('btn-ai').addEventListener('click', startAiGame);

/* ================= online game ================= */
function startOnlineGame(msg) {
  game = {
    mode: 'online',
    state: msg.state,
    myIndex: msg.you,
    oppNick: msg.opp?.nick || '???',
    clocks: { ...msg.clocks, recvAt: Date.now() },
    over: false,
  };
  $('overlay-gameover').hidden = true;
  $('btn-rematch').style.display = '';
  $('rematch-status').hidden = true;
  cancelWallPreview();
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
    $('btn-rematch').style.display = '';
    $('rematch-status').hidden = true;
    $('overlay-gameover').hidden = false;
  }, 600);
  vibrate(iWon ? [40, 60, 40, 60, 80] : 60);
}

$('btn-rematch').addEventListener('click', () => {
  if (!game) return;
  if (game.mode === 'ai') { startAiGame(); return; }
  wsSend({ t: 'rematch', yes: true });
  $('rematch-status').hidden = false;
  $('rematch-status').textContent = t('rematch_wait');
});

$('btn-to-menu').addEventListener('click', () => {
  if (game?.mode === 'online') wsSend({ t: 'rematch', yes: false });
  wsSend({ t: 'leave_room' });
  game = null;
  $('overlay-gameover').hidden = true;
  show('screen-home');
});

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
  const logged = Boolean(session && profile);
  $('guest-hint').hidden = logged;
  $('auth-buttons').hidden = logged; // always visible for guests, even if auth is broken —
                                     // tapping then explains WHY it is unavailable
  $('logged-box').hidden = !logged;
  $('vibro-toggle').checked = vibroOn;
}

let authMode = 'login'; // 'login' | 'register' | 'nick' | 'reset'

function openAuthForm(mode) {
  authMode = mode;
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
      const { error } = await supabase.auth.signInWithPassword({ email, password });
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

/* ================= boot ================= */
window.addEventListener('resize', () => {
  if (game && currentScreen === 'screen-game') { buildBoard(); cancelWallPreview(); renderGame(); }
});

async function boot() {
  applyI18n();
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
