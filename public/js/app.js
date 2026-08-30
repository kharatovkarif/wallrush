// WallRush client app: screens, board UI, online play (WebSocket), AI mode, auth.
import { initialState, applyMove, pawnMoves, canPlaceWall, goalRow, cloneState, N } from './engine.js?v=119';
import { aiMove } from './ai.js?v=119';
import { makeT, LANGS, LANG_CODES, RTL, loadLang } from './i18n.js?v=142';
import { rankOf, nextRank } from './ranks.js?v=119';
import { flameClass, isMilestone, FLAMES, MILESTONES } from './streak.js?v=119';
import { checkNick, nickOk, randomNick } from './nick.js?v=119';
import {
  embedded, initPortal, inPortal, portalAd, portalPlaying, portalHappy,
  portalLoaded, portalInviteCode, portalShowInvite, portalHideInvite, portalInstant,
  portalRoom, portalOnJoin, portalInviteLink, portalMuted, portalOnMute, portalUserName,
} from './portal.js?v=119';

/* ================= state ================= */
const $ = (id) => document.getElementById(id);

const SUPPORTED = new Set(LANG_CODES);
// CIS languages we do not translate: Russian is the common second language there.
const CIS_LANGS = ['uk', 'be', 'kk', 'ky', 'uz', 'tg', 'az', 'hy', 'ka', 'tk'];
const CIS_TZ = /Moscow|Kaliningrad|Samara|Volgograd|Saratov|Astrakhan|Kirov|Ulyanovsk|Yekaterinburg|Omsk|Novosibirsk|Barnaul|Tomsk|Novokuznetsk|Krasnoyarsk|Irkutsk|Chita|Yakutsk|Khandyga|Vladivostok|Ust-Nera|Magadan|Sakhalin|Srednekolymsk|Kamchatka|Anadyr|Minsk|Kiev|Kyiv|Uzhgorod|Zaporozhye|Simferopol|Chisinau|Tiraspol|Almaty|Astana|Qostanay|Aqtobe|Aqtau|Atyrau|Oral|Qyzylorda|Tashkent|Samarkand|Bishkek|Dushanbe|Ashgabat|Baku|Yerevan|Tbilisi/i;
// Second hint only, for phones kept in English while the owner is elsewhere.
// Neither the phone language nor the timezone is changed by a VPN, so this
// never guesses from the IP address and never fights with a VPN.
const TZ_LANG = [
  [/Tehran/i, 'fa'],
  [/Istanbul/i, 'tr'],
  [/Paris|Brussels|Monaco|Casablanca|Algiers|Tunis|Dakar|Abidjan|Kinshasa|Lubumbashi|Douala|Libreville|Bamako|Ouagadougou|Niamey|Conakry|Antananarivo|Port-au-Prince/i, 'fr'],
  [/Madrid|Canary|Ceuta|Mexico_City|Tijuana|Monterrey|Bogota|Lima|Santiago|Buenos_Aires|Cordoba|Caracas|Guayaquil|Asuncion|Montevideo|La_Paz|Havana|Santo_Domingo|Guatemala|Tegucigalpa|Managua|El_Salvador|Panama|Costa_Rica|Puerto_Rico/i, 'es'],
  [CIS_TZ, 'ru'],
];

// First visit: the phone's own language wins, then its timezone, then English.
// Whatever the player picks by hand is remembered and always beats detection.
function detectLang() {
  const saved = localStorage.getItem('wr_lang');
  if (saved && SUPPORTED.has(saved)) return saved;
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language || ''];
  for (const l of langs) {
    const base = String(l).slice(0, 2).toLowerCase();
    if (SUPPORTED.has(base)) return base;
    if (CIS_LANGS.includes(base)) return 'ru';
  }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  for (const [re, code] of TZ_LANG) if (re.test(tz)) return code;
  return 'en';
}
let lang = detectLang();
let t = makeT(lang);
let vibroOn = localStorage.getItem('wr_vibro') !== '0';
let soundOn = localStorage.getItem('wr_sound') !== '0';
// A portal's own mute control sits outside the frame and outranks our
// setting: silencing their page must silence us, whatever the profile says.
let portalMute = false;

// move sounds, like a chess clock (WebAudio, no files needed):
// pawn = short high "tick", wall = lower wooden "knock"
let audioCtx = null;
function tick(mine, wall = false) {
  if (!soundOn || portalMute) return;
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
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
// running as an installed app? (home-screen icon opens in standalone mode)
function runsInstalled() {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  } catch { return false; }
}

/* Where a player came from, worked out once and then kept forever.

   Three ways of knowing, in order of how much they can be trusted.

   A tag in the link — /?f=tt — is put there on purpose and cannot be confused
   with anything. It is the only way to tell one video from another.

   Failing that, the app they came out of. Instagram, TikTok and Facebook open
   links inside a browser of their own and hide who sent the visitor, which is
   why the referrer is useless for exactly the places that matter most — but
   that browser announces itself by name, so the visit can be attributed with
   no tag at all. This covers the ordinary case: a finger on the link in a bio.

   Failing that, who sent them. Catches search engines, Reddit, forums — every
   place that plays by the normal rules.

   Nothing catches a person who reads the address off the screen and types it.
   Those are honestly counted as direct.

   First touch only. Somebody who arrives from Instagram and comes back the
   next day by typing the address is still an Instagram player; overwriting
   would quietly turn every returning visitor into "direct" and make the whole
   table say that nothing works. */
const SRC_APPS = [
  [/Instagram/i, 'instagram'],
  [/BytedanceWebview|musical_ly|TikTok|Bytedance|trill/i, 'tiktok'],
  [/FBAN|FBAV|FB_IAB|FBIOS|FBSV/i, 'facebook'],
  [/Telegram/i, 'telegram'],
  [/Snapchat/i, 'snapchat'],
  [/Twitter/i, 'twitter'],
  [/Pinterest/i, 'pinterest'],
  [/LinkedInApp/i, 'linkedin'],
];
const SRC_HOSTS = [
  [/instagram|ig\.me/, 'instagram'], [/tiktok|musical\.ly/, 'tiktok'],
  [/youtube|youtu\.be/, 'youtube'], [/facebook|fb\.com|fb\.me/, 'facebook'],
  [/t\.me|telegram/, 'telegram'], [/google\./, 'google'],
  [/yandex\./, 'yandex'], [/bing\./, 'bing'], [/duckduckgo/, 'duckduckgo'],
  [/reddit/, 'reddit'], [/discord/, 'discord'], [/twitter|x\.com/, 'twitter'],
  [/pinterest/, 'pinterest'], [/whatsapp/, 'whatsapp'],
];

function trafficSource() {
  const saved = localStorage.getItem('wr_src');
  if (saved) return saved;
  let src = '';
  try {
    const q = new URLSearchParams(location.search);
    // ?f= is ours and short enough to type; utm_source is what every other
    // tool writes, so both are read
    const tag = (q.get('f') || q.get('utm_source') || '').toLowerCase();
    if (/^[a-z0-9_-]{1,24}$/.test(tag)) src = tag;
    if (!src) src = (SRC_APPS.find(([re]) => re.test(navigator.userAgent || '')) || [])[1] || '';
    if (!src && document.referrer) {
      const host = new URL(document.referrer).hostname;
      if (host && host !== location.hostname) {
        src = (SRC_HOSTS.find(([re]) => re.test(host)) || [])[1] || 'ref:' + host.replace(/^www\./, '').slice(0, 32);
      }
    }
    if (!src) src = 'direct';
  } catch { src = 'direct'; }
  localStorage.setItem('wr_src', src);
  return src;
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
        src: trafficSource(),
      }),
    }).catch(() => {});
  } catch {}
}
// the moment the user accepts the install prompt, tell the server
window.addEventListener('appinstalled', () => logVisit(false, true));

// guest nick sticks to the device forever, so the same person keeps the same
// name across visits (was per-tab before — every visit looked like a new user)
let guestNick = localStorage.getItem('wr_nick') || sessionStorage.getItem('wr_nick');
// A name saved before the rules existed is replaced here rather than left to
// fail at the server, so a guest with a banned name simply gets a clean one.
if (!guestNick || checkNick(guestNick)) {
  guestNick = randomNick();
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

/* ================= ladder ================= */
// Points and streak live on the server; these are the last values it told us.
let myPoints = 0;
let myVeteran = false;
let myStreak = 0;
let myStreakBest = 0;
// Whether today already counts towards the streak. A streak that is alive but
// not yet extended today is exactly the moment it can be lost, so the flame
// goes out and the game asks for a game today instead of tomorrow.
let myStreakToday = false;
// 'none' | 'today' | 'risk' | 'freeze' | 'lost' — the card reads differently in
// each, because "4 days" after a missed day looks like a broken counter.
let myStreakState = 'none';
let myStreakLost = 0;     // days on offer to take back, 0 when there is nothing
let myStreakFree = false; // this month's free restore is still unspent
// Below this there is nothing worth buying back: "get 1 day back" reads as a
// joke, and the day is quicker to replay than to think about.
const MIN_RESTORE_DAYS = 3;
let streakEvent = null;   // set when a match just advanced the streak
let celebratedDay = 0;    // guards against showing the same milestone twice

const rankName = (points) => t(rankOf(points).key);
const rankIcon = (points) => rankOf(points).icon;

// Compact badge for lists and the match header: icon plus name, no number —
// the raw score is noise next to a nickname.
function rankChip(points) {
  return `${rankIcon(points)} ${rankName(points)}`;
}
let aiTimer = null;

/* ---- AI runs in a Web Worker so the UI never freezes while it thinks ---- */
let aiWorker = null;      // null = not created yet, false = unavailable
let aiReqId = 0;
const aiPending = new Map();

function getAiWorker() {
  if (aiWorker === false) return null;
  if (!aiWorker) {
    try {
      aiWorker = new Worker('js/ai-worker.js?v=119', { type: 'module' });
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
  document.documentElement.lang = lang;
  document.documentElement.dir = RTL.has(lang) ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  const cur = LANGS.find(l => l.code === lang) || LANGS[0];
  $('btn-lang').textContent = cur.flag + ' ' + cur.code.toUpperCase();
  $('lang-current').textContent = cur.flag + ' ' + cur.native;
  document.querySelectorAll('#lang-list button').forEach(b =>
    b.classList.toggle('active', b.dataset.lang === lang));
  updateProfileUI();
}

// The list is built once from LANGS, each entry written in its own language.
function buildLangList() {
  $('lang-list').innerHTML = LANGS
    .map(l => `<button data-lang="${l.code}"><span class="lf">${l.flag}</span>${l.native}</button>`)
    .join('');
  $('lang-list').querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => setLang(b.dataset.lang)));
}

async function setLang(code) {
  if (!SUPPORTED.has(code)) return;
  await loadLang(code);            // no-op for ru/en, which ship with the app
  lang = code;
  localStorage.setItem('wr_lang', code);
  applyI18n();
  if (game) renderGame();
  $('overlay-lang').hidden = true;
}

/* ================= navigation ================= */
const NAV_SCREENS = ['screen-home', 'screen-leaderboard', 'screen-profile'];
let currentScreen = 'screen-home';

function show(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(screenId).classList.add('active');
  currentScreen = screenId;
  // Every screen starts at its own beginning. The page scrolls as one, so
  // opening the advertising page from halfway down the home screen used to
  // land the reader halfway down that one too — straight into the prices,
  // with the numbers they are supposed to read first left above them.
  window.scrollTo(0, 0);
  const nav = $('bottom-nav');
  const playing = screenId === 'screen-game' || screenId === 'screen-waiting';
  nav.classList.toggle('hidden', playing);
  // Ads live in the menus only, never over a live board
  document.documentElement.classList.toggle('in-game', playing);
  document.querySelectorAll('.nav-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.screen === screenId));
  if (screenId === 'screen-leaderboard') loadLeaderboard();
  if (screenId === 'screen-reviews') loadReviews();
  if (screenId === 'screen-ads') loadAdsStats();
  if (screenId === 'screen-profile') { updateProfileUI(); renderPushRow(); loadFriends(); } // points move every match
  if (screenId === 'screen-friends') { renderFriends(); loadFriends(); }
  if (screenId === 'screen-rooms') wsSend({ t: 'lobby_sub' });
  else wsSend({ t: 'lobby_unsub' });
}

document.querySelectorAll('.nav-btn').forEach(b =>
  b.addEventListener('click', () => show(b.dataset.screen)));
document.querySelectorAll('[data-back]').forEach(b =>
  b.addEventListener('click', () => show('screen-home')));

// Safari on iOS applies :active only on pages that listen for touches at all.
// Without this one empty listener every button on an iPhone stayed flat under
// the finger and the whole app felt a beat behind.
document.addEventListener('touchstart', () => {}, { passive: true });

/* ---------- with no connection ----------
   The app already worked offline — the shell is cached and the AI plays
   locally — but it gave no sign of it. Quick match, the lobby and playing a
   friend all looked exactly as usual and led to a wait with no end, so the
   whole game read as broken when in fact only half of it was unavailable. */
const ONLINE_ONLY = ['btn-quick', 'btn-online', 'btn-friend'];

function renderOnlineState() {
  const off = !navigator.onLine;
  $('offline-bar').hidden = !off;
  for (const id of ONLINE_ONLY) $(id).disabled = off;
  // an online count of 0 next to a green dot reads as "nobody is playing"
  $('online-count').parentElement.hidden = off;
}
window.addEventListener('online', () => {
  renderOnlineState();
  connectWs();                       // reconnect at once instead of on a timer
  if (currentScreen === 'screen-leaderboard') loadLeaderboard();
});
window.addEventListener('offline', renderOnlineState);


/* ================= friends =================
   Only between accounts: a guest is a different person after clearing the
   browser, so there is nobody on the other side of the friendship tomorrow.
   Calling one opens a private room with the settings you played last —
   they came to play, not to fill in a form. */
let friends = [];
let addedThisMatch = new Set();

function renderAddFriend() {
  const btn = $('btn-add-friend');
  const id = game?.oppId;
  const canAdd = Boolean(session && id && !friends.some(f => f.id === id));
  btn.hidden = !canAdd;
  if (!canAdd) return;
  btn.disabled = addedThisMatch.has(id);
  btn.textContent = addedThisMatch.has(id)
    ? '✓ ' + t('friend_added')
    : '＋ ' + t('friend_add') + ' ' + (game?.oppNick || '');
}

$('btn-add-friend').addEventListener('click', () => {
  const id = game?.oppId;
  if (!id) return;
  addedThisMatch.add(id);
  renderAddFriend();
  wsSend({ t: 'friend_add', id });
});

/* Nicknames are chosen by the people who wear them, and they go into the page
   as HTML. Without this a nick with a < in it would be markup rather than a
   name — and, worse, this helper was called from the friends list without ever
   being written, so drawing a single friend threw and the list came out empty.
   Anyone who had added even one friend saw a friends feature that did nothing:
   564 friendships across the game, invisible to the people who made them. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/* The friends screen. Everything about friends is here: who they are, who
   asked to be added, and the search for someone by the name they play under.

   It used to be a block at the bottom of the profile, below every setting.
   A player with ninety matches and five friends already added wrote that the
   game had no friends list and no way to remove anyone — both were there, four
   screens of scrolling down. */
let friendRequests = [];
let foundFriend = null;
let callTarget = null;      // set while the settings dialog is being used to call someone

function frRow(f) {
  const state = f.busy ? 'busy' : f.online ? 'on' : '';
  const where = f.busy ? t('friend_busy') : f.online ? t('friend_online') : t('friend_offline');
  const flame = f.streak > 0 ? ' · 🔥 ' + f.streak : '';
  return `<div class="fr-row">
    <span class="fr-dot ${state}"></span>
    <span class="fr-info"><b>${esc(f.nick)}</b><small>${where} · ${f.points} ${t('save_ask_points')}${flame}</small></span>
    <button class="fr-call" data-call="${esc(f.id)}"${f.online && !f.busy ? '' : ' disabled'}>${t('friend_call')}</button>
    <button class="fr-del" data-del="${esc(f.id)}" aria-label="remove">✕</button>
  </div>`;
}

function renderFriends() {
  const guest = !session;
  $('fr-guest').hidden = !guest;
  $('fr-find').hidden = guest;
  $('fr-list').innerHTML = guest ? '' : friends.map(frRow).join('');
  $('fr-count').textContent = guest || !friends.length ? '' : String(friends.length);
  $('fr-empty').hidden = guest || friends.length > 0;

  $('fr-requests-box').hidden = guest || friendRequests.length === 0;
  $('fr-req-count').textContent = friendRequests.length ? String(friendRequests.length) : '';
  $('fr-requests').innerHTML = friendRequests.map(r => `<div class="fr-row">
    <span class="fr-dot"></span>
    <span class="fr-info"><b>${esc(r.nick)}</b><small>${r.points} ${t('save_ask_points')}</small></span>
    <button class="fr-call" data-yes="${esc(r.id)}">✓</button>
    <button class="fr-del" data-no="${esc(r.id)}" aria-label="decline">✕</button>
  </div>`).join('');

  // the badge on the profile row, so an unanswered request is visible from
  // outside this screen
  const row = $('btn-open-friends');
  if (row) row.textContent = friendRequests.length ? '🤝 ' + friendRequests.length : '🤝';
}

function renderFound() {
  const box = $('fr-found');
  if (foundFriend === null) { box.innerHTML = ''; return; }
  if (!foundFriend) { box.innerHTML = `<p class="hint">${t('friends_not_found')}</p>`; return; }
  const f = foundFriend;
  const label = f.already ? t('friends_already') : f.pending ? t('friends_pending') : '＋ ' + t('friend_add');
  box.innerHTML = `<div class="fr-row">
    <span class="fr-dot ${f.online ? 'on' : ''}"></span>
    <span class="fr-info"><b>${esc(f.nick)}</b><small>${f.points} ${t('save_ask_points')}</small></span>
    <button class="fr-call" data-ask="${esc(f.id)}"${f.already || f.pending ? ' disabled' : ''}>${label}</button>
  </div>`;
}

$('fr-list').addEventListener('click', (e) => {
  const call = e.target.closest('[data-call]');
  if (call) { openCallDialog(call.dataset.call); return; }
  const del = e.target.closest('[data-del]');
  if (del && confirm(t('friend_remove_ask'))) wsSend({ t: 'friend_remove', id: del.dataset.del });
});

$('fr-requests').addEventListener('click', (e) => {
  const yes = e.target.closest('[data-yes]');
  const no = e.target.closest('[data-no]');
  const id = yes?.dataset.yes || no?.dataset.no;
  if (!id) return;
  wsSend({ t: 'friend_answer', id, yes: Boolean(yes) });
  friendRequests = friendRequests.filter(r => r.id !== id);
  renderFriends();
});

$('fr-found').addEventListener('click', (e) => {
  const ask = e.target.closest('[data-ask]');
  if (!ask || ask.disabled) return;
  wsSend({ t: 'friend_request', id: ask.dataset.ask });
  ask.disabled = true;
  ask.textContent = t('friends_pending');
});

function searchFriend() {
  const nick = $('fr-search').value.trim();
  if (nick.length < 2) return;
  foundFriend = null;
  renderFound();
  wsSend({ t: 'friend_search', nick });
}
$('fr-search-go').addEventListener('click', searchFriend);
$('fr-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchFriend(); });
$('fr-back').addEventListener('click', () => show('screen-profile'));
$('btn-open-friends').addEventListener('click', () => show('screen-friends'));

/* Calling someone opens the same settings dialog as creating a room: they
   asked for the mode to be their choice rather than whatever was played last. */
function openCallDialog(id) {
  callTarget = id;
  openCreateDialog(true);
  $('cr-create').textContent = t('friend_call');
}

function loadFriends() {
  if (!session) { renderFriends(); return; }
  wsSend({ t: 'friends' });
  wsSend({ t: 'friend_requests' });
}

let callCode = '';
$('btn-call-no').addEventListener('click', () => { $('overlay-call').hidden = true; callCode = ''; });
$('btn-call-yes').addEventListener('click', () => {
  $('overlay-call').hidden = true;
  if (callCode) wsSend({ t: 'join_code', code: callCode });
  callCode = '';
});

/* ================= WebSocket ================= */
let reconnectDelay = 500;

function wsSend(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

/* A socket can look open while nothing is getting through — a phone changing
   network, a tunnel that died quietly. A single lost state message left the
   board frozen showing the opponent to move: no legal moves on screen, so no
   way to play, while the server had already handed the turn over and was
   counting down the thirty seconds. The player then lost a game they were
   never able to take a turn in.

   So during a game: if nothing has arrived for a few seconds, ask the server
   what the position is. Same on coming back to the tab. */
let lastMsgAt = 0;
let syncTimer = null;

function inLiveGame() { return game?.mode === 'online' && !game.over; }

function requestSync() {
  if (!inLiveGame()) return;
  // Only ask on a live socket. A closed one is already being rebuilt by
  // ws.onclose — reconnecting from here as well produced two sockets at once.
  if (ws && ws.readyState === 1) wsSend({ t: 'sync' });
}

function watchdogTick() {
  if (!inLiveGame()) return;
  const quiet = Date.now() - lastMsgAt;
  if (quiet > 10000) requestSync();
  // A socket can stay "open" for good with nothing going through it: a phone
  // that changed network, a tunnel that died without saying so. The browser
  // reports readyState 1, no onclose ever fires, and asking for a sync over
  // it is shouting down a dead line — the board froze on its last frame for
  // as long as the player was willing to wait. So after the sync goes
  // unanswered, hang up by hand: onclose then rebuilds the connection, and
  // hello with the same token brings the game back.
  if (quiet > 20000 && ws && ws.readyState === 1) {
    lastMsgAt = Date.now();       // the new socket gets its own grace period
    try { ws.close(); } catch { /* already going */ }
  }
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    reconnectDelay = 500;
    wsReady = true;
    lastMsgAt = Date.now();
    wsSend({ t: 'hello', nick: myNick(), token: wsToken, device: deviceId, tz: new Date().getTimezoneOffset(), jwt: session?.access_token });
    if (currentScreen === 'screen-rooms') wsSend({ t: 'lobby_sub' });
  };
  ws.onmessage = (ev) => {
    lastMsgAt = Date.now();
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleWsMessage(msg);
  };
  ws.onclose = () => {
    wsReady = false;
    if (inLiveGame()) toast(t('conn_lost'));
    setTimeout(connectWs, reconnectDelay);
    reconnectDelay = Math.min(8000, reconnectDelay * 2);
  };
  if (!syncTimer) {
    syncTimer = setInterval(watchdogTick, 3000);
    // back from the lock screen or another app: check the board immediately
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') requestSync();
    });
  }
}

function handleWsMessage(msg) {
  switch (msg.t) {
    case 'hello_ok':
      wsToken = msg.token;
      sessionStorage.setItem('wr_ws_token', wsToken);
      $('online-count').textContent = msg.online;
      myPoints = msg.points || 0;
      myVeteran = Boolean(msg.veteran);
      myStreak = msg.streak || 0;
      myStreakBest = msg.streakBest || 0;
      myStreakToday = Boolean(msg.streakToday);
      myStreakState = msg.streakState || 'none';
      myStreakLost = msg.streakLost || 0;
      myStreakFree = Boolean(msg.streakFree);
      renderStreakOffer();
      renderStreak();
      updateProfileUI();
      flushPendingJoin();   // arrived through an invite link
      flushPendingQuick();  // arrived from a notification
      flushPortalRoom();    // leading a group in from the portal
      // A reconnect in the middle of a game: make the server say where we
      // stand. It answers with the position, the result we missed, or nothing.
      if (inLiveGame()) requestSync();
      break;
    case 'lobby':
      $('online-count').textContent = msg.online;
      renderRooms(msg.rooms || []);
      break;
    case 'room_created':
      $('waiting-code').hidden = !msg.code;
      if (msg.code) showInvite(msg.code);
      // Inside the portal the same code also goes to their invite button in
      // the frame's footer, so a group can be gathered without leaving it.
      if (msg.code) portalShowInvite(msg.code);
      // Their friends list shows a Join button beside this player only while
      // this is true, so it is set the moment the room opens and cleared the
      // moment it fills — a stale "joinable" sends friends into a full room.
      portalRoom(msg.code, true);
      show('screen-waiting');
      break;
    case 'friends':
      friends = msg.list || [];
      renderFriends();
      renderAddFriend();
      break;
    case 'friend_added':
      toast(t('friend_added_ok'));
      loadFriends();
      break;
    case 'friend_added_you':
      toast(`${msg.nick} ${t('friend_added_you')}`);
      loadFriends();
      break;
    case 'friend_removed':
      friends = friends.filter(f => f.id !== msg.id);
      renderFriends();
      break;
    case 'friend_found':
      foundFriend = msg.found || false;   // false = looked and found nobody
      renderFound();
      break;
    case 'friend_requested':
      toast(t('friends_sent'));
      break;
    case 'friend_request_in':
      // someone asked while we were here to see it
      toast(`${msg.nick} ${t('friends_wants')}`);
      loadFriends();
      break;
    case 'friend_requests':
      friendRequests = msg.list || [];
      renderFriends();
      break;
    case 'friend_answered':
      if (msg.yes) loadFriends();
      break;
    case 'friend_call': {
      // Someone is holding a room open for us; the code is the way in.
      callCode = msg.code || '';
      $('call-from').textContent = `${msg.from} ${t('call_title')}`;
      const modeName = msg.mode === 'race' ? t('race_title') : t('duel_title');
      const timeName = msg.time === '0' ? '∞' : msg.time + ' ' + t('min_short');
      $('call-settings').textContent = `${modeName} · ${msg.walls} 🧱 · ${timeName}`;
      $('overlay-call').hidden = false;
      vibrate([30, 60, 30]);
      break;
    }
    case 'game_start':
      portalHideInvite();       // the room is full; there is nobody left to invite
      portalRoom(inviteCode, false);   // same room, no longer open
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
      if (game?.mode === 'online') {
        if (msg.points) {
          myPoints = msg.points.total ?? myPoints;
          game.award = msg.points;
          updateProfileUI();
        }
        onGameOver(msg.winner === msg.you, msg.reason);
      }
      break;
    case 'streak':
      myStreak = msg.streak || 0;
      myStreakBest = msg.best || myStreakBest;
      myStreakToday = true;   // this message only arrives after a match today
      myStreakState = 'today';
      myStreakLost = 0;
      if (msg.advanced) streakEvent = { days: myStreak, froze: Boolean(msg.froze) };
      renderStreak();
      updateProfileUI();
      // the result overlay may already be up — fill the line in place
      if (!$('overlay-gameover').hidden) showStreakLine();
      // and celebrate regardless of where the player is by now: this message
      // arrives on its own schedule, and the moment must not depend on that
      if (msg.advanced && isMilestone(myStreak)) celebrateStreak(myStreak);
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
      // the clock stops while they are away, and the screen has to show that
      if (msg.clocks && game) game.clocks = { ...msg.clocks, recvAt: Date.now() };
      toast(t('opp_disconnected'));
      break;
    case 'opp_reconnected':
      if (msg.clocks && game) game.clocks = { ...msg.clocks, recvAt: Date.now() };
      toast(t('opp_reconnected'));
      break;
    case 'daily':
      renderDaily(msg);
      break;
    case 'no_game':
      // The room is gone and the server has no result for us either. Nothing
      // is coming, so let go of the board rather than freeze on it.
      if (inLiveGame()) {
        game.over = true;
        toast(t('game_gone'));
        show('screen-home');
      }
      break;
    case 'error':
      if (msg.code === 'friends_full') toast(t('friends_full'));
      else if (msg.code === 'room_not_found') toast(t('err_room_not_found'));
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
    // the rank sits with the nickname, so you know who you are about to face
    el.querySelector('b').textContent = `${rankIcon(room.points || 0)} ${room.nick}`;
    // show what kind of room it is: mode · walls · time
    const modeLabel = room.mode === 'race' ? '🏁 ' + t('race_title') : '⚔️ ' + t('duel_title');
    const timeLabel = room.time === '0' ? '∞' : room.time + t('min_short');
    el.querySelector('small').textContent = `${rankName(room.points || 0)} · ${modeLabel} · ${room.walls}🧱 · ${timeLabel}`;
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
  $('cr-create').textContent = t('create_room');
  pickOpt('cr-mode', 'duel'); pickOpt('cr-walls', '10'); pickOpt('cr-time', '5');
  syncCreateDialog();
  $('overlay-create').hidden = false;
}
$('btn-create-room').addEventListener('click', () => { callTarget = null; openCreateDialog(false); });
$('btn-friend-create').addEventListener('click', () => { callTarget = null; openCreateDialog(true); });
$('cr-cancel').addEventListener('click', () => { $('overlay-create').hidden = true; callTarget = null; });
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
  if (callTarget) {
    wsSend({ t: 'friend_call', id: callTarget,
             mode: createCfg.mode, walls: Number(createCfg.walls), time: createCfg.time });
    toast(t('friend_calling'));
    callTarget = null;
    return;
  }
  wsSend({
    t: 'create_room', private: createCfg.private,
    mode: createCfg.mode, walls: Number(createCfg.walls), time: createCfg.time,
  });
});
$('btn-friend-join').addEventListener('click', () => {
  const code = $('friend-code-input').value.trim().toUpperCase();
  if (code.length >= 4) wsSend({ t: 'join_code', code });
});

/* ================= invite a friend by link ================= */
// Without these two counters there is no way to tell whether invitations are
// being sent at all, let alone whether anyone arrives through them.
function logEvent(kind) {
  try {
    fetch('/api/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: deviceId, kind }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* analytics must never break the game */ }
}

// wallrush.online/#K7X2P9 — the friend taps it and lands straight in the room,
// with nothing to read out or type in.
const CODE_RE = /^[A-Z0-9]{4,8}$/;
const roomLink = (code) => location.origin + '/#' + code;

let inviteCode = '';
function showInvite(code) {
  inviteCode = code;
  $('room-code-value').textContent = code;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // clipboard API needs a secure context and permission; the old selection
    // trick still works where it does not
    try {
      const el = document.createElement('textarea');
      el.value = text;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand('copy');
      el.remove();
      return ok;
    } catch {
      return false;
    }
  }
}


// Straight from the result screen into a private room, keeping whatever
// settings were last used — the friend just wants to play, not configure.
// This one button brings around 388 new players a day, over a tenth of all
// growth, which is why it holds the result screen.
$('btn-invite-friend').addEventListener('click', () => {
  $('overlay-gameover').hidden = true;
  wsSend({
    t: 'create_room', private: true,
    mode: createCfg.mode, walls: Number(createCfg.walls), time: createCfg.time,
  });
});

$('invite-share').addEventListener('click', async () => {
  // Inside a portal our own address is the wrong one to hand out: it takes
  // the friend out of the page they are on. Theirs opens the room in place.
  const url = (await portalInviteLink(inviteCode)) || roomLink(inviteCode);
  logEvent('invite_share');
  // the native sheet puts the link straight into WhatsApp or Telegram
  if (navigator.share) {
    try {
      await navigator.share({ title: 'WallRush', text: t('invite_text'), url });
      return;
    } catch {
      return;   // the player dismissed the sheet — not an error
    }
  }
  // desktop browsers often have no share sheet — copy instead, same one tap
  toast(await copyText(url) ? t('invite_copied') : url);
});

// A code in the address bar means the player arrived through an invitation.
// It is consumed once: the hash is cleared so a refresh does not rejoin.
let pendingJoin = '';
function takeInviteFromUrl() {
  const code = decodeURIComponent(location.hash.replace(/^#/, '')).trim().toUpperCase();
  if (!CODE_RE.test(code)) return;
  pendingJoin = code;
  history.replaceState(null, '', location.pathname + location.search);
}

// arriving from a notification: straight into matchmaking
let pendingQuick = false;
// leading a group in from a portal: open a private room the moment we connect
let pendingPortalRoom = false;
function takeQuickFromUrl() {
  const q = new URLSearchParams(location.search);
  if (q.get('go') !== 'quick') return;
  pendingQuick = true;
  history.replaceState(null, '', location.pathname);
}

function flushPendingJoin() {
  if (!pendingJoin) return;
  wsSend({ t: 'join_code', code: pendingJoin });
  logEvent('invite_join');
  pendingJoin = '';
}

function flushPendingQuick() {
  if (!pendingQuick) return;
  pendingQuick = false;
  wsSend({ t: 'quick' });
  show('screen-waiting');
  $('waiting-code').hidden = true;
}
$('btn-cancel-wait').addEventListener('click', () => { portalHideInvite(); portalRoom('', false); wsSend({ t: 'leave_room' }); show('screen-home'); });
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

  // HUD — rank icons only during play; the number belongs on the result screen
  $('me-nick').textContent = myNick();
  $('opp-nick').textContent = game.oppNick;
  const online = game.mode === 'online';
  $('me-rank').textContent = online ? rankIcon(myPoints) : '';
  $('opp-rank').textContent = online ? rankIcon(game.oppPoints || 0) : '';
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
  // Frozen while an opponent is away: the server has stopped charging the turn,
  // so a screen that kept counting down would be showing a defeat that is not
  // going to happen.
  // Measured from when the SERVER started this turn, not from when this packet
  // happened to arrive. Anchoring it to arrival meant any clock update sent
  // mid-turn — which is exactly what a re-sync does — snapped the countdown
  // back to a full 30 seconds in front of the player.
  const sentAfter = Math.max(0, (ck.serverNow || 0) - (ck.turnStarted || 0));
  const elapsed = ck.paused ? 0 : sentAfter + (Date.now() - ck.recvAt);
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
  portalPlaying(true);   // a portal keeps its own ads out of a live match
  if (game.state.turn === 1) scheduleAiMove();
}

$('btn-ai').addEventListener('click', () => show('screen-ai'));
for (const lvl of ['easy', 'normal', 'hard', 'hardcore']) {
  $('ai-' + lvl).addEventListener('click', () => startAiGame(lvl));
}

/* ================= online game ================= */
function startOnlineGame(msg) {
  if (msg.me) { myPoints = msg.me.points || 0; myVeteran = Boolean(msg.me.veteran); }
  // A resumed start that carries the position we already have tells us nothing
  // new. The client asks for the position whenever the line goes quiet, and
  // rebuilding the whole screen each time looked like the page reloading
  // itself mid-game. Take the clocks and leave the board alone.
  if (msg.resumed && game && game.mode === 'online' && !game.over && game.state &&
      JSON.stringify(game.state) === JSON.stringify(msg.state)) {
    game.clocks = { ...msg.clocks, recvAt: Date.now() };
    return;
  }
  // a second match on the same day must not replay the same celebration —
  // but a reconnect into the SAME match is not a second match
  if (!msg.resumed) { streakEvent = null; celebratedDay = 0; }
  // A resumed game_start is the SAME match continuing — a reconnect, or the
  // client asking for the position after a dropped message. Rebuilding the
  // snapshot list here threw away everything played before that moment, so
  // the post-game replay started from wherever the resync happened instead
  // of from move one. Keep what we already have.
  const kept = msg.resumed && game && game.mode === 'online' && !game.over && game.history?.length
    ? game.history : null;
  if (kept) {
    const last = kept[kept.length - 1];
    // moves made while we were away never reached us; record where we came back
    if (JSON.stringify(last) !== JSON.stringify(msg.state)) kept.push(cloneState(msg.state));
  }
  game = {
    mode: 'online',
    state: msg.state,
    myIndex: msg.you,
    oppNick: msg.opp?.nick || '???',
    oppId: msg.opp?.id || null,
    oppPoints: msg.opp?.points || 0,
    ranked: msg.ranked !== false,
    clocks: { ...msg.clocks, recvAt: Date.now() },
    over: false,
    award: null,
    history: kept || [cloneState(msg.state)], // for the post-game replay
  };
  stopReplay();
  $('overlay-gameover').hidden = true;
  $('btn-rematch').style.display = '';
  $('rematch-status').hidden = true;
  cancelWallPreview();
  // Only a real start counts as a game played. This runs on every resumed
  // game_start too — a reconnect, or the client asking for the position after
  // a tab switch — and each one was recording another game against the player
  // and another row in the event log, inflating both the player's count and
  // the site's "games played". Nor should coming back to the tab buzz the
  // phone as if a new match had just begun.
  if (!msg.resumed) logVisit(true);
  show('screen-game');
  buildBoard();
  renderGame();
  portalPlaying(true);   // a portal keeps its own ads out of a live match
  if (!msg.resumed) vibrate([20, 40, 20]);
}

/* ================= game over / rematch ================= */
/* Their ad goes between matches and nowhere else, and not after every one.
   A portal pays per ad shown, which makes it tempting to ask on every result
   screen — and that is exactly how a game gets closed and never opened again.
   One every four minutes at most, on a screen the player is leaving anyway. */
const PORTAL_AD_GAP_MS = 4 * 60 * 1000;
let lastPortalAd = 0;

function maybePortalAd() {
  if (!inPortal() || Date.now() - lastPortalAd < PORTAL_AD_GAP_MS) return;
  lastPortalAd = Date.now();
  portalAd('midgame');
}

function onGameOver(iWon, reason) {
  if (!game || game.over) return;
  game.over = true;
  clearTimeout(aiTimer);
  portalPlaying(false);
  if (iWon) portalHappy();
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
    showAward();
    showStreakLine();
    spawnConfetti(iWon);
    $('btn-rematch').style.display = '';
    $('rematch-status').hidden = true;
    renderAddFriend();
    $('overlay-gameover').hidden = false;
    askAfterWin(iWon);
    maybePortalAd();
  }, 600);
  vibrate(iWon ? [40, 60, 40, 60, 80] : 60);
}

// The points line under the result. This is the number people come back for,
// so it gets its own row rather than being tucked into the stats strip.
function showAward() {
  const row = $('pts-row'), up = $('rank-up'), note = $('pts-note');
  row.hidden = true; up.hidden = true; note.hidden = true;
  if (game?.mode !== 'online') return;
  const a = game.award;
  if (game.ranked === false || a?.ranked === false) {
    // friendly game via a private code — say so instead of showing nothing
    note.textContent = t('unranked_hint');
    note.hidden = false;
    return;
  }
  // nothing moved: either the floor at zero held, or a rematch hit the cap
  if (!a || !a.delta) return;
  const before = (a.total || 0) - a.delta;
  row.hidden = false;
  $('pts-delta').textContent = (a.delta > 0 ? '+' : '') + a.delta;
  $('pts-delta').className = 'pts-delta ' + (a.delta > 0 ? 'up' : 'down');
  $('pts-total').textContent = `${a.total} ${t('points_label')}`;
  if (rankOf(a.total).key !== rankOf(before).key) {
    const climbed = a.delta > 0;
    up.textContent = (climbed ? t('rank_up') : t('rank_down')) + ' ' + rankChip(a.total);
    up.className = 'rank-up ' + (climbed ? 'up' : 'down');
    up.hidden = false;
    if (climbed) vibrate([30, 50, 30, 50, 60]);
  }
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

/* Voluntary support: a short video that plays here rather than a tab that
   throws the player onto somebody else's site.

   It lives in the support dialog on the home screen, not on the result screen.
   The result screen is the most valuable place in the game, and measured over
   a day the invite there brought 388 new players while this ad earned cents.

   Before this it was OnClicka, which stopped delivering anything — and before
   that a direct link opened with window.open, and before that a RichAds
   popunder that relabelled the button while no ad ever appeared.

   Which network serves the video is the only part that keeps changing, so it
   is the only part written down here. Everything below stays network-agnostic:
   the overlay watches for a video of any size anywhere on the page rather than
   trusting a network to fill our slot, because none of them reliably do. That
   watch is what actually closes the window, with or without a callback.

   Now AppLixir. Their SDK does not serve from a tag on its own — it waits to be
   asked, so `show` says how to ask. Set AD_PROVIDER to null and Support and the
   streak restore both keep working: the window says there is no ad and the
   streak comes back anyway, which is the path everyone the ad never reached has
   always taken.

   The status names below are from their published events and could not be
   checked from here — their CDN is unreachable from this machine, so nothing
   about this integration has been seen running. Every status the SDK reports is
   therefore logged verbatim, so the first real play tells us what it truly
   sends and this list can stop guessing. Nothing depends on getting them right:
   a reward that never fires still leaves the streak granted. */
const AD_PROVIDER = {
  src: 'https://cdn.applixir.com/applixir.app.v6.1.0.js',
  show(onReward) {
    if (typeof initializeAndOpenPlayer !== 'function') return false;
    initializeAndOpenPlayer({
      apiKey: 'f12d997b-c4fa-4682-be49-e656c6121b56',
      injectionElementId: 'ad-video-slot',
      adStatusCallbackFn: (status) => {
        console.info('[ad] status:', status);
        const s = String(status || '').toLowerCase();
        if (s.includes('reward') || s.includes('watched') || s === 'ad-complete') onReward(true);
      },
      adErrorCallbackFn: (err) => { console.warn('[ad] error:', err); onReward(false); },
    });
    return true;
  },
};
const AD_WAIT_MS = 7000;      // nothing on screen by then means no ad is coming
const AD_SDK_WAIT_MS = 45000; // but once a network is working, it gets room to ask its questions

let adTimer = 0;

// Fetched once the support dialog is open rather than on the tap itself: the
// download used to happen while the player stared at an empty box. Called
// again later it returns the same promise — the script is already here.
let adReady = null;
function preloadAd() {
  if (!AD_PROVIDER || embedded) return null;   // never our own network inside a portal
  if (adReady) return adReady;
  adReady = new Promise((resolve) => {
    const s = document.createElement('script');
    s.async = true;
    s.src = AD_PROVIDER.src;
    s.onload = () => resolve(true);
    // A blocker, a dead CDN, a country the network does not reach: all arrive
    // here. Forget the promise so a later attempt gets a fresh try rather than
    // a cached no.
    s.onerror = () => { adReady = null; resolve(false); };
    document.head.appendChild(s);
  });
  return adReady;
}

let adEscape = 0;

function closeAdOverlay() {
  clearTimeout(adTimer);
  clearTimeout(adEscape);
  clearInterval(adWatch);
  $('overlay-ad').hidden = true;
  $('ad-close').hidden = true;
}

// True once an ad is actually on screen. It deliberately does not assume the
// network put its player inside our slot — it does not — so a video of any
// size anywhere on the page counts. Without this an empty box would sit there
// for everyone the ad never reaches: a blocker, no fill, or a country the
// network does not serve.
function adRendered() {
  const slot = $('ad-video-slot');
  if (slot.children.length > 0 && slot.getBoundingClientRect().height > 40) return true;
  return [...document.querySelectorAll('video')].some((v) => {
    const r = v.getBoundingClientRect();
    return r.width > 60 && r.height > 60;
  });
}

// Where the network's "they earned it" lands. Support says thank you; the
// streak restore hands the streak back the moment it arrives instead of sitting
// out its timeout. Whoever is waiting claims the callback, so a stale handler
// from an earlier window cannot fire into a later one.
let adRewardHandler = null;
function adRewarded(ok) {
  const waiting = adRewardHandler;
  adRewardHandler = null;
  if (waiting) waiting(ok);
  else if (ok) toast(t('support_thanks'));
}

// The ad brings its own close button, so this window must not add a second
// one. Ours stays out of sight and only appears if the ad is somehow still
// here long after any ad should be — a way out that nobody normally sees.
const AD_ESCAPE_MS = 25000;

function openSupportVideo() {
  // Inside the portal, Support and the streak restore keep working — the
  // rewarded video simply comes from the portal instead of our own network,
  // in their own player rather than our window.
  // A button that does nothing at all is worse than one that says no: an ad
  // that never arrives gets the same answer here as it does on our own site.
  if (embedded) { portalAd('rewarded').then((ok) => toast(t(ok ? 'support_thanks' : 'ad_none'))); return; }
  // With no network configured there is nothing to wait for, so say so at once
  // instead of making the player watch an empty box time out.
  if (!AD_PROVIDER) { toast(t('ad_none')); return; }
  const note = $('ad-note');
  const own = $('ad-close');
  note.textContent = t('ad_loading');
  note.hidden = false;
  own.hidden = true;
  $('overlay-ad').hidden = false;
  // The SDK has to be asked before it plays anything, and asking before it has
  // finished downloading does nothing at all — so the ask waits for the script.
  Promise.resolve(preloadAd()).then((loaded) => {
    if ($('overlay-ad').hidden) return;   // they closed the window while it loaded
    if (loaded && AD_PROVIDER.show(adRewarded)) deadline = Date.now() + AD_SDK_WAIT_MS;
  });

  clearTimeout(adEscape);
  adEscape = setTimeout(() => { own.hidden = false; }, AD_ESCAPE_MS);

  // Poll rather than trust a single timeout: the moment an ad appears the note
  // gets out of its way, and if none ever does we say so and close.
  //
  // The deadline moves once the SDK is in charge. Seven seconds is right for
  // "nothing is coming", and wrong the moment a network puts its own screen up
  // first — AppLixir asks for consent before it will play anything, and the
  // first real test declared no ad while that question was still on screen,
  // waiting to be read. Reading takes longer than seven seconds.
  let deadline = Date.now() + AD_WAIT_MS;
  clearTimeout(adTimer);
  (function check() {
    if (adRendered()) {
      note.hidden = true;
      watchAdClosed();
      return;
    }
    if (Date.now() > deadline) {
      note.textContent = t('ad_none');
      adTimer = setTimeout(closeAdOverlay, 2500);
      return;
    }
    adTimer = setTimeout(check, 300);
  })();
}

// Closing the ad with the ad's own button leaves this window standing, so the
// same thing had to be closed twice. Watching for the ad to go means their one
// tap finishes the job.
let adWatch = 0;
function watchAdClosed() {
  clearInterval(adWatch);
  adWatch = setInterval(() => {
    if ($('overlay-ad').hidden) { clearInterval(adWatch); return; }
    if (!adRendered()) { clearInterval(adWatch); closeAdOverlay(); }
  }, 400);
}

$('ad-close').addEventListener('click', closeAdOverlay);
// Deliberately no backdrop-to-close here, unlike every other overlay. The ad
// fills most of the screen, so a thumb resting anywhere beside it killed the
// window mid-load — and the player got neither the ad nor any idea why. This
// window now only ever leaves on its own: the ad's close button, ours after
// the escape delay, or by itself when no ad turns up.

/* Support / advertise dialogs on the home screen. Both are opt-in: nothing
   loads or fires until the player opens them. */
$('btn-open-support').addEventListener('click', () => {
  $('overlay-support').hidden = false;
  // Fetch the ad script while the dialog is being read, so tapping Watch does
  // not start with a download. Nothing is fetched for anyone who never opens
  // this dialog, which is almost everybody.
  preloadAd();
});
$('support-close').addEventListener('click', () => { $('overlay-support').hidden = true; });
$('support-watch').addEventListener('click', () => {
  $('overlay-support').hidden = true;   // the video replaces the dialog
  openSupportVideo();
});
// Kept whole, guarded, because the wallet is only away for as long as the ad
// networks are looking. Put the markup back and this wakes up with it; without
// the guard, its absence would throw on boot and take the whole app down.
if ($('wallet-copy')) {
  $('wallet-copy').addEventListener('click', async () => {
    const addr = $('wallet-addr').textContent.trim();
    try {
      await navigator.clipboard.writeText(addr);
    } catch {
      // older browsers / no clipboard permission — select it so it can be copied by hand
      const r = document.createRange();
      r.selectNodeContents($('wallet-addr'));
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
    const b = $('wallet-copy');
    b.textContent = t('copied');
    setTimeout(() => { b.textContent = t('copy'); }, 2000);
  });
}

$('btn-open-ads').addEventListener('click', () => show('screen-ads'));

// An address on the game's own domain rather than a personal mailbox: this is
// the one line a possible advertiser judges the place by. Cloudflare Email
// Routing forwards it straight into the same inbox as before.
const ADS_EMAIL = 'ads@wallrush.online';
$('ads-email-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(ADS_EMAIL); } catch { return; }
  const b = $('ads-email-copy');
  b.textContent = t('copied');
  setTimeout(() => { b.textContent = t('ads_copy_mail'); }, 2000);
});

$('btn-to-menu').addEventListener('click', () => {
  if (game?.mode === 'online') wsSend({ t: 'rematch', yes: false });
  portalHideInvite();
  portalRoom('', false);
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
/* The table as it was the last time it could be fetched.

   Offline this used to say "error, try again", which is true and useless: the
   player is on a train and cannot try anything. Yesterday's standings are
   worth far more than an apology, so long as they are labelled as yesterday's
   rather than passed off as live. */
const LB_CACHE = 'wr_lb';

async function loadLeaderboard() {
  const list = $('lb-list');
  try {
    const res = await fetch('/api/leaderboard');
    const { rows } = await res.json();
    if (rows?.length) {
      try { localStorage.setItem(LB_CACHE, JSON.stringify({ at: Date.now(), rows })); } catch {}
    }
    renderLeaderboard(rows, 0);
  } catch {
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(LB_CACHE) || 'null'); } catch {}
    if (cached?.rows?.length) renderLeaderboard(cached.rows, cached.at);
    else list.innerHTML = `<div class="lb-empty">${t(navigator.onLine ? 'err_generic' : 'offline_bar')}</div>`;
  }
}

// `savedAt` marks the list as a copy: 0 means it came from the server just now.
function renderLeaderboard(rows, savedAt) {
  const list = $('lb-list');
  list.innerHTML = '';
  if (!rows?.length) {
    list.innerHTML = `<div class="lb-empty">${t('leaderboard_empty')}</div>`;
    return;
  }
  if (savedAt) {
    const p = document.createElement('p');
    p.className = 'lb-stale';
    p.textContent = t('lb_stale').replace('%t', new Date(savedAt).toLocaleString());
    list.appendChild(p);
  }
  {
    rows.forEach((row, i) => {
      const el = document.createElement('div');
      el.className = 'lb-item';
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
      el.innerHTML = `<div class="lb-rank"></div><div class="r-avatar"></div>
        <div class="lb-nick"></div>
        <div class="lb-score"><b></b><small></small></div>`;
      const pts = row.points || 0;
      el.querySelector('.lb-rank').textContent = medal;
      el.querySelector('.r-avatar').textContent = (row.nick || '?')[0].toUpperCase();
      el.querySelector('.lb-nick').innerHTML =
        `<span class="lb-name"></span><small class="lb-badge"></small>`;
      el.querySelector('.lb-name').textContent = row.nick;
      el.querySelector('.lb-badge').textContent = rankChip(pts);
      el.querySelector('.lb-score b').textContent = pts.toLocaleString();
      el.querySelector('.lb-score small').textContent =
        `${t('points_label')} · ${row.wins} ${t('lb_wins')}`;
      list.appendChild(el);
    });
  }
}

/* ================= profile & auth ================= */
function updateProfileUI() {
  const nick = myNick();
  $('profile-nick').textContent = nick;
  $('profile-avatar').textContent = nick[0].toUpperCase();
  renderRankCard();
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

/* ================= streak ================= */
// Russian needs three plural forms and Turkish none, so the unit and the
// sentence shape both come from the language pack.
function daysWord(n) {
  if (lang === 'ru') {
    const a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return t('day_one');
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return t('day_few');
    return t('day_many');
  }
  return n === 1 ? t('day_one') : t('day_many');
}

// %n is the number and %u the unit, both filled per language: word order
// differs (Turkish leads with "üst üste") and Russian inflects the unit.
const daysPhrase = (n, key = 'streak_days') =>
  t(key).replace('%n', n).replace('%u', daysWord(n));

// The flame in the home header: the one place a returning player sees it
// before they have done anything.
function renderStreak() {
  const pill = $('streak-pill');
  // The flame always carries the number, alive or broken. It is the streak
  // itself — vanishing would read as the count being lost. Only the offer
  // behind it has a minimum, so a one-day streak still shows 1 and simply has
  // nothing to tap.
  const days = myStreak > 0 ? myStreak : myStreakLost;
  pill.hidden = days < 1;
  pill.classList.toggle('broken', myStreak < 1 && restorable() > 0);
  if (days < 1) return;
  $('streak-count').textContent = days;
  const lit = myStreak > 0 && myStreakState === 'today';
  $('streak-flame').className = 'flame ' + flameClass(days) + (lit ? '' : ' unlit');
}

// What the flame offers back, or 0 when there is nothing worth offering.
function restorable() {
  return myStreakLost >= MIN_RESTORE_DAYS ? myStreakLost : 0;
}

/* ---------- the flame, explained ---------- */
// Everything the streak does lives behind the flame itself, on both screens.
// Before this the rules only surfaced once a streak had already broken, so the
// players actually keeping one — the ones the flame is for — never saw them.
function streakShownDays() {
  return Math.max(1, myStreak > 0 ? myStreak : myStreakLost);
}

// The ladder of tiers, with the one currently in force marked. Built on every
// open because the language, the streak and the tier can all have moved since.
function renderFlameLadder() {
  const box = $('info-flames');
  const mine = flameClass(streakShownDays());
  box.innerHTML = '';
  FLAMES.forEach((f, i) => {
    const next = FLAMES[i + 1];
    const li = document.createElement('li');
    if (f.cls === mine) li.className = 'now';
    const icon = document.createElement('span');
    icon.className = 'flame ' + f.cls;
    icon.textContent = '🔥';
    const label = document.createElement('span');
    // plain numbers, so the range needs no translating in six languages
    label.textContent = next ? `${f.min}–${next.min - 1}` : `${f.min}+`;
    li.append(icon, label);
    box.appendChild(li);
  });
}

function openStreakInfo() {
  const days = streakShownDays();
  const broken = myStreak < 1 && myStreakLost > 0;
  const lit = myStreak > 0 && myStreakState === 'today';
  $('info-flame').className = 'flame ' + flameClass(days) + (lit ? '' : ' unlit') + ' cel-flame';
  $('info-title').textContent = broken ? daysPhrase(myStreakLost, 'streak_lost')
    : myStreak > 0 ? daysPhrase(myStreak) : t('streak_none');
  $('info-sub').textContent = broken ? t('streak_lost_sub')
    : myStreak > 0 ? (lit ? t('streak_keep') : t('streak_today')) : '';

  const btn = $('btn-restore-home');
  btn.hidden = !restorable();
  btn.disabled = false;
  if (restorable()) btn.textContent = daysPhrase(myStreakLost, 'streak_restore');

  // One free restore per calendar month, counted the way a player expects to
  // read it: what is left over what they get.
  $('info-free').textContent = (myStreakFree ? 1 : 0) + '/1';
  renderFlameLadder();
  $('info-milestones').textContent = MILESTONES.join('  ·  ');
  $('overlay-streak-info').hidden = false;
}

for (const id of ['streak-pill', 'streak-flame-btn']) {
  $(id).addEventListener('click', openStreakInfo);
}
$('btn-info-close').addEventListener('click', () => { $('overlay-streak-info').hidden = true; });
$('overlay-streak-info').addEventListener('click', (e) => {
  if (e.target === $('overlay-streak-info')) $('overlay-streak-info').hidden = true;
});

// One line on the result screen — and on a milestone day, a celebration over
// the top of it. A week of coming back should not pass as one more grey line.
function showStreakLine() {
  const el = $('streak-line');
  if (!streakEvent) { el.hidden = true; return; }
  const { days, froze } = streakEvent;
  el.className = 'streak-line ' + flameClass(days);
  el.textContent = (froze ? t('streak_saved') + ' ' : '') + '🔥 ' + daysPhrase(days);
  el.hidden = false;
  if (isMilestone(days)) celebrateStreak(days);
}

/* The streak card, in whichever of its states applies. Four days showing after
   a missed day is what made this necessary: the number had not changed, the
   game said nothing, and the only sane conclusion was that it was broken. Now
   each state says out loud what happened and what it costs. */
function renderStreakCard() {
  const flame = $('streak-flame-big');
  const sub = $('streak-sub');
  const restore = $('btn-restore-streak');

  // The offer stands on its own: a player who already started a new run sees
  // that run on the card and the old one waiting on the button beneath it.
  restore.hidden = !restorable();
  if (restorable()) restore.textContent = daysPhrase(myStreakLost, 'streak_restore');

  if (restorable() && myStreak < 1) {
    flame.className = 'flame ' + flameClass(myStreakLost) + ' unlit';
    $('streak-days').textContent = daysPhrase(myStreakLost, 'streak_lost');
    sub.textContent = t('streak_lost_sub');
    $('streak-card').classList.add('cold');
    return;
  }

  const lit = myStreak > 0 && myStreakState === 'today';
  flame.className = 'flame ' + flameClass(Math.max(1, myStreak)) + (lit ? '' : ' unlit');
  $('streak-days').textContent = myStreak > 0 ? daysPhrase(myStreak) : t('streak_none');
  // What the player has to do today outranks the personal best — the record
  // can wait until the day is safe.
  sub.textContent = myStreak > 0
    ? (myStreakState === 'risk' ? t('streak_today')
      : myStreakBest > myStreak ? t('streak_best').replace('%n', myStreakBest)
      : t('streak_keep'))
    : '';
  $('streak-card').classList.toggle('cold', myStreak < 1);
}

/* Buying a streak back. The ad plays first and the streak is restored only
   after it actually rendered — otherwise everyone whose ad never arrives, and
   that is a good part of this audience, would pay nothing and get it anyway,
   which makes the whole offer meaningless. */
// Both buttons do the same thing, so they share one handler.
for (const id of ['btn-restore-streak', 'btn-restore-home']) {
  $(id).addEventListener('click', () => startRestore());
}

/* One button, one outcome: the streak comes back. What happens underneath
   differs — this month's first restore is free, the rest play an ad first —
   but the player is never told which, because from their side nothing about
   the button changed. If the ad never arrives, which is the normal case for a
   good part of this audience, the streak is given anyway rather than held to
   ransom over something they cannot control. */
function startRestore() {
  $('btn-restore-streak').disabled = true;
  $('btn-restore-home').disabled = true;
  if (myStreakFree) { claimStreak(); return; }
  // In the portal the ad is theirs and tells us when it is over, so there is
  // nothing to watch for and no reason to make the player wait out a timeout.
  if (embedded) { portalAd('rewarded').then(claimStreak); return; }
  // No network, nothing to watch: give the streak back now rather than hold it
  // behind an eight-second wait for an ad that cannot arrive.
  if (!AD_PROVIDER) { claimStreak(); return; }
  // Two ways home, because the streak must come back either way. The network
  // saying "they earned it" is the quick one; the watch below is the one that
  // works when no such word ever comes, which is most of this audience.
  let claimed = false;
  const once = () => { if (!claimed) { claimed = true; claimStreak(); } };
  adRewardHandler = once;
  openSupportVideo();
  const started = Date.now();
  (function waitForAd() {
    if (claimed) return;
    if (adRendered() || Date.now() - started > AD_WAIT_MS + 1500) { once(); return; }
    setTimeout(waitForAd, 300);
  })();
}

async function claimStreak() {
  try {
    const res = await fetch('/api/streak/restore', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
      },
      body: JSON.stringify({ device: deviceId, tz: new Date().getTimezoneOffset() }),
    });
    const data = await res.json();
    if (!data.ok) {
      $('btn-restore-streak').disabled = false;
      $('btn-restore-home').disabled = false;
      return;
    }
    myStreak = data.streak || myStreakLost;
    myStreakState = 'today';     // the day is closed; playing is optional now
    myStreakToday = true;
    myStreakLost = 0;
    myStreakFree = false;
    closeAdOverlay();
    renderStreak();
    renderStreakCard();
    renderStreakOffer();
    toast(t('streak_restored'));
  } catch {
    $('btn-restore-streak').disabled = false;
    $('btn-restore-home').disabled = false;
  }
}

function renderStreakOffer() { $('overlay-streak-info').hidden = true; }

function celebrateStreak(days) {
  if (celebratedDay === days) return;   // already shown for this milestone
  celebratedDay = days;
  $('cel-flame').className = 'flame ' + flameClass(days) + ' cel-flame';
  $('cel-num').textContent = days;
  $('cel-title').textContent = daysPhrase(days, 'streak_milestone');
  // sparks are built fresh so they restart their drift every time
  const box = $('streak-sparks');
  box.innerHTML = '';
  for (let i = 0; i < 18; i++) {
    const sp = document.createElement('i');
    sp.style.left = Math.random() * 100 + '%';
    sp.style.animationDuration = (2.6 + Math.random() * 2.4) + 's';
    sp.style.animationDelay = (Math.random() * 1.3) + 's';
    sp.style.opacity = '0';
    box.appendChild(sp);
  }
  $('overlay-streak').hidden = false;
  vibrate([40, 60, 40, 60, 90]);
}

$('cel-close').addEventListener('click', () => { $('overlay-streak').hidden = true; });
// tapping the backdrop closes it too — nobody should have to hunt for the button
$('overlay-streak').addEventListener('click', (e) => {
  if (e.target === $('overlay-streak')) $('overlay-streak').hidden = true;
});

// Rank, points, and how far the next rank is. The bar is the whole point:
// "97 to go" pulls far harder than a bare number.
function renderRankCard() {
  const pts = myPoints;
  const cur = rankOf(pts);
  const next = nextRank(pts);
  $('rank-badge').textContent = cur.icon;
  $('rank-name').textContent = t(cur.key);
  $('rank-points').textContent = `${pts.toLocaleString()} ${t('points_label')}`;
  $('veteran-badge').hidden = !myVeteran;
  // streak card sits under the rank: one is skill, the other is showing up
  renderStreakCard();
  if (next) {
    const span = next.min - cur.min;
    const done = Math.max(0, Math.min(1, (pts - cur.min) / span));
    $('rank-fill').style.width = (done * 100).toFixed(1) + '%';
    $('rank-next').textContent = t('rank_next')
      .replace('%n', (next.min - pts).toLocaleString())
      .replace('%r', t(next.key));
    $('rank-bar').hidden = false;
  } else {
    $('rank-bar').hidden = true;
    $('rank-next').textContent = t('rank_top');
  }
}

// 'forgot' asks for the address to send the letter to; 'reset' is the form the
// letter leads back to, where the new password is typed.
let authMode = 'login'; // 'login' | 'register' | 'nick' | 'forgot' | 'reset'

// Supabase hands the recovery session back in the URL and its client wipes the
// URL as soon as it reads it, so the flag has to be taken here, at import time,
// before createClient runs.
const CAME_FOR_RECOVERY = /[#?&]type=recovery/.test(location.hash + location.search);

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
  $('auth-password').hidden = mode === 'nick' || mode === 'forgot';
  $('auth-nick').hidden = mode !== 'register' && mode !== 'nick';
  $('btn-forgot').hidden = mode !== 'login';
  $('btn-auth-toggle').hidden = mode === 'nick' || mode === 'reset' || mode === 'forgot';
  $('btn-auth-submit').textContent =
    mode === 'login' ? t('do_login')
    : mode === 'register' ? t('do_register')
    : mode === 'forgot' ? t('send_reset')
    : t('save');
  $('btn-auth-toggle').textContent = mode === 'login' ? t('no_account') : t('have_account');
  if (mode === 'forgot') $('auth-email').placeholder = t('email');
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

// Only switches the form over — the address is asked for on the next screen.
// It used to read the email box straight away and return in silence when it was
// empty, which looked like a dead button.
$('btn-forgot').addEventListener('click', () => openAuthForm('forgot'));

$('btn-auth-submit').addEventListener('click', async () => {
  if (!supabase) return;
  const email = $('auth-email').value.trim();
  const password = $('auth-password').value;
  const nick = $('auth-nick').value.trim();
  try {
    if (authMode === 'forgot') {
      if (!email) { authMsg(t('err_email_bad')); return; }
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: location.origin + '/' });
      // Supabase answers the same way for an address it has never seen, so the
      // form cannot be used to find out who has an account here. An error means
      // the letter genuinely did not go out, and saying "sent" to that leaves
      // someone waiting on mail that will never arrive.
      if (error) {
        // the built-in mail server allows very few letters an hour, and the
        // refusal that follows is the one people actually meet — telling them
        // to "try again" is the worst possible answer to being told to wait
        const busy = error.status === 429 || /rate limit/i.test(error.message || '');
        authMsg(t(busy ? 'err_reset_too_often' : 'err_generic'));
        return;
      }
      authMsg(t('reset_sent'), true);
      return;
    }
    if (authMode === 'register') {
      const nickErr = checkNick(nick);
      if (nickErr) { authMsg(t(nickErr === 'format' ? 'err_nick_bad' : 'err_nick_' + nickErr)); return; }
      // server-side signup: account is created already confirmed
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // the device carries the guest progress this account inherits
        body: JSON.stringify({ email, password, nick, device: deviceId }),
      });
      const data = await res.json();
      if (data.error) {
        const map = {
          email_bad: t('err_email_bad'), email_taken: t('err_email_taken'),
          // the server names the domain it thinks was meant — say it out loud,
          // an unexplained rejection of a working-looking address reads as a bug
          email_typo: t('err_email_typo').replace('{domain}', data.suggest || ''),
          password_short: t('err_password_short'),
          nick_bad: t('err_nick_bad'), nick_taken: t('err_nick_taken'),
          nick_rude: t('err_nick_rude'), nick_reserved: t('err_nick_reserved'),
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
      const nickErr = checkNick(nick);
      if (nickErr) { authMsg(t(nickErr === 'format' ? 'err_nick_bad' : 'err_nick_' + nickErr)); return; }
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
    body: JSON.stringify({ nick, device: deviceId }),
  });
  const data = await res.json();
  if (data.error === 'nick_taken') { authMsg(t('err_nick_taken')); return false; }
  if (data.error === 'nick_bad') { authMsg(t('err_nick_bad')); return false; }
  if (data.error === 'nick_rude') { authMsg(t('err_nick_rude')); return false; }
  if (data.error === 'nick_reserved') { authMsg(t('err_nick_reserved')); return false; }
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
  showNickNotice();
  // re-identify on the game server with the account nick
  wsSend({ t: 'hello', nick: myNick(), token: wsToken, device: deviceId, tz: new Date().getTimezoneOffset(), jwt: session.access_token });
  loadFriends();
}

// A nickname that broke the rules was replaced by hand. The player is told
// once, in their own language, and the note is cleared as soon as they read it.
function showNickNotice() {
  const old = profile?.nick_notice;
  if (!old) return;
  $('nick-notice-text').textContent = t('nick_changed_body')
    .replace('%old', old).replace('%new', profile.nick);
  $('overlay-nick-notice').hidden = false;
  profile.nick_notice = null;
  fetch('/api/nick-notice/ack', {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}` },
  }).catch(() => {});
}
$('btn-nick-notice-close').addEventListener('click', () => {
  $('overlay-nick-notice').hidden = true;
});

$('btn-logout').addEventListener('click', async () => {
  if (supabase) await supabase.auth.signOut();
  session = null;
  profile = null;
  updateProfileUI();
  wsSend({ t: 'hello', nick: myNick(), token: wsToken, device: deviceId, tz: new Date().getTimezoneOffset() });
});

/* ================= settings ================= */
$('btn-lang').addEventListener('click', () => { $('overlay-lang').hidden = false; });
$('lang-current').addEventListener('click', () => { $('overlay-lang').hidden = false; });
$('lang-close').addEventListener('click', () => { $('overlay-lang').hidden = true; });

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

/* ================= the advertising page =================
   Yesterday's real figures, fetched once when the page is opened. An
   advertiser decides on reach, and a rounded promise decides nothing. */

async function loadAdsStats() {
  try {
    const r = await (await fetch('/api/ads/stats')).json();
    if (!r || !r.people) return;
    const n = (x) => Number(x).toLocaleString(lang === 'ru' ? 'ru' : 'en-US');
    $('ads-date').textContent = new Date(r.day + 'T12:00:00Z').toLocaleDateString(lang === 'en' ? 'en-GB' : lang);
    $('ads-people').textContent = n(r.people);
    $('ads-games').textContent = n(r.games);
    // the quietest hour of the day says more than a peak: it is the number
    // that holds at four in the morning
    $('ads-quiet').textContent = n(r.quietestHour);
    $('ads-geo').textContent = String(r.countriesTotal || 0);
    $('ads-flags').innerHTML = (r.countries || [])
      .map(c => `<span class="ads-flag">${c.flag} <b>${c.pct}%</b></span>`).join('');
    $('ads-live').hidden = false;
  } catch { /* the page still works without them */ }
}

/* The enquiry form. Everything that can be a list is a list: the first three
   that arrived read "Wathsapp", a phone number with no country code, and one
   usable email — a box you can type anything into gets anything typed into it.

   Nothing is preselected for the contact. A default there would be answered by
   accident, and an accidental answer is exactly how "Wathsapp" ended up in the
   place where a phone number was supposed to go. */
const ADREQ_PLATFORMS = {
  telegram: { ph: '@nickname', hint: 'ads_req_h_tg', ok: (v) => /^@?[\w\d_]{4,}$/.test(v) || /t\.me\//i.test(v) },
  whatsapp: { ph: '+998 90 123 45 67', hint: 'ads_req_h_wa', ok: (v) => /^\+\d[\d\s()-]{6,}$/.test(v) },
  instagram: { ph: '@nickname', hint: 'ads_req_h_ig', ok: (v) => /^@?[\w\d._]{3,}$/.test(v) || /instagram\.com\//i.test(v) },
  email: { ph: 'name@company.com', hint: 'ads_req_h_mail', ok: (v) => /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(v) },
};

function packOptions(selected) {
  const sel = $('adreq-pack');
  sel.innerHTML = [...document.querySelectorAll('#ads-packs .pack')].map(b => {
    const name = b.querySelector('.pk-name').textContent;
    const days = b.querySelector('.pk-days').textContent;
    const price = b.querySelector('.pk-price').textContent.trim().split(' ')[0];
    return `<option value="${b.dataset.pack}">${price} · ${name} · ${days}</option>`;
  }).join('');
  if (selected) sel.value = selected;
}

function syncAdreqContact() {
  const p = ADREQ_PLATFORMS[$('adreq-platform').value];
  const box = $('adreq-contact');
  box.disabled = !p;
  box.placeholder = p ? p.ph : '';
  box.type = $('adreq-platform').value === 'whatsapp' ? 'tel' : 'text';
  $('adreq-hint').textContent = p ? t(p.hint) : '';
}

function openAdReq(pack) {
  packOptions(pack);
  $('adreq-platform').value = '';
  $('adreq-contact').value = '';
  $('adreq-site').value = '';
  $('adreq-about').value = '';
  $('adreq-audience').value = 'world';
  $('adreq-geo').hidden = true;
  $('adreq-geo').value = '';
  syncAdreqContact();
  $('overlay-adreq').hidden = false;
}

$('ads-packs').addEventListener('click', (e) => {
  const b = e.target.closest('.pack');
  if (b) openAdReq(b.dataset.pack);
});
$('ads-leave').addEventListener('click', () => openAdReq(null));
$('adreq-platform').addEventListener('change', () => { syncAdreqContact(); $('adreq-contact').focus(); });
$('adreq-audience').addEventListener('change', () => {
  const own = $('adreq-audience').value === 'own';
  $('adreq-geo').hidden = !own;
  if (own) $('adreq-geo').focus();
});
$('adreq-cancel').addEventListener('click', () => { $('overlay-adreq').hidden = true; });
$('adreq-send').addEventListener('click', async () => {
  const platform = $('adreq-platform').value;
  if (!platform) { $('adreq-hint').textContent = t('ads_req_pick_first'); $('adreq-platform').focus(); return; }
  const contact = $('adreq-contact').value.trim();
  // A wrong contact is worse than none: we cannot reach them, and they are
  // left thinking they are waiting for an answer.
  if (!ADREQ_PLATFORMS[platform].ok(contact)) {
    $('adreq-hint').textContent = t('ads_req_bad');
    $('adreq-contact').focus();
    return;
  }
  const geo = $('adreq-audience').value;
  const audience = geo === 'own' ? ($('adreq-geo').value.trim() || 'world') : geo;
  $('overlay-adreq').hidden = true;
  toast(t('ads_req_sent'));
  try {
    await fetch('/api/ads/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pack: $('adreq-pack').value, platform, contact,
        site: $('adreq-site').value.trim(), about: $('adreq-about').value.trim(),
        audience, device: deviceId, lang,
      }),
    });
  } catch { /* they still have the telegram link */ }
});

/* ================= task of the day =================
   A strip on the home screen, nothing more. It appears when the server says
   what today's task is and disappears when there is no answer — a card that
   guesses would show the wrong task at midnight, and a wrong task is worse
   than none.

   The words come from i18n rather than the server: the server knows which
   task it is, the player's own language decides how it reads. */
let dailyNow = null;
// Set when the match just finished the task: the celebration takes that
// match's slot, so a player is congratulated or asked something, never both.
let dailyJustDone = false;

function dailyLine(task, target) {
  return (t('task_' + task) || '').replace('%n', target);
}

function renderDaily(msg) {
  dailyNow = msg;
  const card = $('daily-card');
  if (!msg || !msg.task) { card.hidden = true; return; }
  const done = Boolean(msg.done);
  const pct = Math.max(0, Math.min(100, Math.round(100 * msg.progress / msg.target)));
  $('daily-ic').textContent = done ? '✅' : '🎯';
  $('daily-text').textContent = dailyLine(msg.task, msg.target);
  $('daily-fill').style.width = pct + '%';
  $('daily-num').textContent = done ? t('daily_done') : `${msg.progress}/${msg.target}`;
  $('daily-reward').textContent = done ? '' : '+' + msg.reward;
  card.classList.toggle('is-done', done);
  card.hidden = false;
  if (msg.points !== undefined) { myPoints = msg.points; updateProfileUI(); }

  // The one moment it interrupts anything: the match that finished it.
  if (msg.justDone) {
    dailyJustDone = true;
    $('daily-done-what').textContent = dailyLine(msg.task, msg.target);
    $('daily-done-reward').textContent = '+' + msg.reward + ' ' + t('daily_points');
    setTimeout(() => { $('overlay-daily').hidden = false; vibrate([30, 60, 30, 60, 90]); }, 1400);
  }
}

$('btn-daily-ok').addEventListener('click', () => { $('overlay-daily').hidden = true; });
// tapping the strip starts a match, which is the only thing it ever asks for
$('daily-card').addEventListener('click', () => {
  if (dailyNow && dailyNow.done) return;
  wsSend({ t: 'quick' });
  show('screen-waiting');
  $('waiting-code').hidden = true;
});

/* ================= rating and reviews =================
   One tap is a complete answer. The words underneath are optional and most
   people will never write any, which is fine — a star still counts.

   Where the answer goes depends on what it says. One to three stars are a
   complaint and go to us privately: a rating like that is a bug report, and
   putting it on a public page helps nobody and fixes nothing. Four and five
   are offered a place on /reviews, the page a search engine can read.

   Asked late on purpose. Three matches is enough to be asked about
   notifications, which is a promise about the future; an opinion about the
   game needs more of the game than that. */
/* An account, or ten matches. Same rule the server enforces: a browser is
   free, so one game was no barrier — play once here, write, open another
   browser and write again. */
const RATE_AFTER_GAMES = 10;
let ratePicked = 0;
let rateStandalone = false;   // opened from the reviews screen, not after a match

function rateAnswered() { return Boolean(localStorage.getItem('wr_rate_answered')); }

// Returns true when it decided to ask, like the other two.
function maybeAskRate(iWon) {
  if (!iWon || rateAnswered()) return false;
  if (!session && Number(localStorage.getItem('wr_games') || 0) < RATE_AFTER_GAMES) return false;
  const shows = Number(localStorage.getItem('wr_rate_shows') || 0) + 1;
  if (shows > 2) return false;                       // two chances, then never again
  localStorage.setItem('wr_rate_shows', String(shows));
  setTimeout(() => {
    if (rateAnswered() || $('overlay-gameover').hidden) return;
    openRate(false);
  }, 2600);
  return true;
}

function openRate(standalone) {
  rateStandalone = standalone;
  ratePicked = 0;
  $('rate-emoji').textContent = '⭐';
  $('rate-title').textContent = t('rate_title');
  $('rate-sub').textContent = t('rate_sub');
  $('rate-text').hidden = true;
  $('rate-text').value = '';
  $('btn-rate-send').hidden = true;
  $('btn-rate-close').textContent = t('rate_later');
  paintStars(0);
  $('overlay-rate').hidden = false;
}

function paintStars(n) {
  $('rate-stars').querySelectorAll('button').forEach(b =>
    b.classList.toggle('on', Number(b.dataset.star) <= n));
}

$('rate-stars').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-star]');
  if (!b) return;
  ratePicked = Number(b.dataset.star);
  paintStars(ratePicked);
  vibrate(15);
  const good = ratePicked >= 4;
  // The wording changes with the answer: thanks for a good one, and a straight
  // question for a bad one. Both can be sent with the box left empty.
  $('rate-emoji').textContent = good ? '🎉' : '🛠️';
  $('rate-title').textContent = good ? t('rate_thanks') : t('rate_sorry');
  $('rate-sub').textContent = good ? t('rate_public_note') : t('rate_bad_note');
  const box = $('rate-text');
  box.hidden = false;
  box.placeholder = good ? t('rate_ph_good') : t('rate_ph_bad');
  $('btn-rate-send').hidden = false;
  $('btn-rate-send').textContent = t('rate_send');
  $('btn-rate-close').textContent = t('cancel');
});

async function sendReview() {
  if (!ratePicked) return;
  const stars = ratePicked, text = $('rate-text').value.trim();
  localStorage.setItem('wr_rate_answered', '1');
  localStorage.setItem('wr_rate_stars', String(stars));
  $('overlay-rate').hidden = true;
  // every review goes on the page now, good or bad
  toast(t('rate_sent_public'));
  try {
    await fetch('/api/review', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
      },
      body: JSON.stringify({ device: deviceId, stars, text, nick: myNick(), lang }),
    });
  } catch { /* the answer is not worth an error message to the player */ }
  if (rateStandalone || stars >= 4) loadReviews();
}

$('btn-rate-send').addEventListener('click', sendReview);
$('btn-rate-close').addEventListener('click', () => {
  $('overlay-rate').hidden = true;
  // Waving away a window that was never answered is not an answer: it can come
  // back once. Picking a star and then backing out is, so it does not.
  if (ratePicked) localStorage.setItem('wr_rate_answered', '1');
});

$('btn-open-reviews').addEventListener('click', () => show('screen-reviews'));
$('rv-back').addEventListener('click', () => show('screen-profile'));
$('btn-leave-review').addEventListener('click', () => openRate(true));

const starText = (n) => '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);

let rvFilter = 'new';

function rvDate(iso) {
  try { return new Date(iso).toLocaleDateString(lang === 'en' ? 'en-GB' : lang); }
  catch { return String(iso).slice(0, 10); }
}

async function loadReviews() {
  try {
    const r = await (await fetch(`/api/reviews?f=${rvFilter}&device=${encodeURIComponent(deviceId)}`)).json();
    $('rv-score').hidden = !r.count;
    $('rv-tabs').hidden = !r.count;
    $('rv-avg').textContent = r.count ? r.avg.toFixed(1) : '—';
    $('rv-avg-stars').textContent = starText(Math.round(r.avg || 0));
    $('rv-count').textContent = `${r.count} ${t('reviews_count')}`;
    // the spread, so the average is a number with a shape behind it
    $('rv-bars').innerHTML = (r.spread || []).map(sp => `
      <div class="rv-bar">
        <span class="rv-bl">${'★'.repeat(sp.stars)}</span>
        <span class="rv-bt"><i style="width:${sp.pct}%"></i></span>
        <span class="rv-bn">${sp.count}<small> (${sp.pct}%)</small></span>
      </div>`).join('');
    $('rv-list').innerHTML = (r.rows || []).map(row => `
      <div class="rv-item" data-id="${row.id}">
        <div class="rv-top"><b>${esc(row.nick)}</b><span class="rv-stars">${starText(row.stars)}</span></div>
        ${row.text ? `<p>${esc(row.text)}</p>` : ''}
        ${row.reply ? `<div class="rv-answer"><b>WallRush</b><p>${esc(row.reply)}</p></div>` : ''}
        <div class="rv-foot">
          <span>${rvDate(row.at)}</span>
          <button class="rv-like${row.liked ? ' on' : ''}" data-like="${row.id}">♥ <b>${row.likes || 0}</b></button>
        </div>
      </div>`).join('');
    $('rv-empty').hidden = Boolean(r.rows && r.rows.length);
    const played = Number(localStorage.getItem('wr_games') || 0);
    const mayWrite = Boolean(session) || played >= RATE_AFTER_GAMES;
    $('btn-leave-review').textContent = rateAnswered() ? t('rate_change') : t('rate_leave');
    $('btn-leave-review').disabled = !mayWrite;
    // Say why the button is off rather than leaving a dead button on screen.
    $('rv-gate').hidden = mayWrite;
    $('rv-gate').textContent = t('rate_gate').replace('%n', Math.max(0, RATE_AFTER_GAMES - played));
  } catch {
    $('rv-empty').hidden = false;
  }
}

$('rv-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  rvFilter = b.dataset.f;
  $('rv-tabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  loadReviews();
});

// A like is a tap and tapping again takes it back. The number moves at once
// and is corrected by the answer, so a slow connection never feels stuck.
$('rv-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-like]');
  if (!btn) return;
  const num = btn.querySelector('b');
  const was = btn.classList.contains('on');
  btn.classList.toggle('on', !was);
  num.textContent = Math.max(0, Number(num.textContent || 0) + (was ? -1 : 1));
  vibrate(12);
  try {
    const r = await (await fetch('/api/review/like', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: Number(btn.dataset.like), device: deviceId }),
    })).json();
    if (typeof r.likes === 'number') { num.textContent = r.likes; btn.classList.toggle('on', Boolean(r.liked)); }
  } catch { /* the heart can wait */ }
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
  const iosSafari = isIOS() && /safari/i.test(ua) && !/crios|fxios|edgios|yabrowser|opios/i.test(ua);
  if (iosSafari && !runsInstalled() && !iosDismissed) {
    $('install-banner-go').hidden = true;          // no auto-install button on iOS
    const el = $('install-banner-text');
    el.removeAttribute('data-i18n');               // stop applyI18n from overwriting it
    el.textContent = t('install_ios');
    $('install-banner').hidden = false;
  }
}
maybeShowIosInstall();

/* ================= notifications ================= */
// Permission can be asked exactly once: a refusal is permanent and we cannot
// undo it. So the ask waits until someone has finished three matches — by then
// they have a streak worth protecting, and the prompt reads as useful rather
// than as a website grabbing at them on arrival.
const PUSH_AFTER_GAMES = 3;

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlBase64ToUint8Array(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function subscribePush() {
  if (!pushSupported() || !config?.vapid) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.vapid),
    });
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device: deviceId, sub: sub.toJSON(),
        tz: new Date().getTimezoneOffset(), lang,
      }),
    });
    localStorage.setItem('wr_push', '1');
    return true;
  } catch (e) {
    console.warn('push subscribe failed', e);
    return false;
  }
}

/* Two things are worth asking a player for, and both belong at the same
   moment — just after a win. Asking for both at once is how you get neither,
   so only one goes out per match: the account first when there is progress
   that would actually be lost, reminders otherwise. */
let askedThisMatch = false;
function askAfterWin(iWon) {
  if (askedThisMatch) return;
  // One counter for every finished match, kept here rather than inside one of
  // the questions: it used to be bumped inside the notifications prompt, which
  // stopped counting the moment that prompt was answered — so anything asked
  // later saw a number frozen at three.
  localStorage.setItem('wr_games', String(Number(localStorage.getItem('wr_games') || 0) + 1));
  // The task of the day was just finished and is being celebrated. One thing
  // on screen after a match, not two.
  if (dailyJustDone) { dailyJustDone = false; return; }
  if (maybeAskSaveProgress(iWon)) { askedThisMatch = true; return; }
  if (maybeAskPush(iWon)) { askedThisMatch = true; return; }
  maybeAskRate(iWon);
}

/* A guest's points and streak live in this browser and nowhere else. Clearing
   the browser or changing phone loses the lot, and we never once said so —
   registration existed only as a button in the profile that nobody opens.
   Hence 5.7% of players with an account.

   Returns true when it decided to ask, so the caller knows to hold the other
   question back. */
function maybeAskSaveProgress(iWon) {
  if (!iWon || session) return false;                    // only guests, only on a win
  if (!config?.auth || !supabase) return false;          // accounts are off
  if (localStorage.getItem('wr_save_answered')) return false;
  // Something has to be genuinely at stake, or the warning is just noise.
  if (myPoints < 100 && myStreak < 2) return false;
  const shows = Number(localStorage.getItem('wr_save_shows') || 0) + 1;
  if (shows > 2) return false;
  localStorage.setItem('wr_save_shows', String(shows));

  const parts = [];
  if (myPoints > 0) parts.push(myPoints + ' ' + t('save_ask_points'));
  if (myStreak > 0) parts.push('🔥 ' + daysPhrase(myStreak));
  setTimeout(() => {
    if (session || $('overlay-gameover').hidden) return;
    $('save-ask-what').textContent = parts.join(' · ');
    $('overlay-save').hidden = false;
  }, 2300);
  return true;
}

$('btn-save-no').addEventListener('click', () => {
  localStorage.setItem('wr_save_answered', '1');
  $('overlay-save').hidden = true;
});
$('btn-save-yes').addEventListener('click', () => {
  localStorage.setItem('wr_save_answered', '1');
  $('overlay-save').hidden = true;
  $('overlay-gameover').hidden = true;
  if (ensureAuthAvailable()) { show('screen-profile'); openAuthForm('register'); }
});

/* Called after every finished match. Shows a question of our own, once, ever.

   It used to fire the browser's permission prompt straight at people. That
   prompt can be shown once in the lifetime of the site — a refusal is final
   and nothing we do afterwards can undo it — so throwing it at everyone spent
   the single chance on the many who were not going to say yes. Our own window
   costs nothing when refused and asks in words a player understands.

   The flag is written the moment the window opens, not when it is answered,
   so reloading the page cannot bring it back. One time and no more. */
function maybeAskPush(iWon) {
  if (!pushSupported() || !config?.vapid) return maybeHintInstallForPush();
  if (localStorage.getItem('wr_push')) return false;          // already subscribed
  if (localStorage.getItem('wr_push_answered')) return false; // they answered, respect it
  if (Notification.permission === 'denied') return false;     // nothing we can do
  if (Number(localStorage.getItem('wr_games') || 0) < PUSH_AFTER_GAMES) return false;

  // Ask on a win, not on a loss. "Shall we remind you about your streak?" put
  // to someone who has just lost reads as the site being pleased about it.
  if (!iWon) return false;
  // And only when there is a flame to protect, so the promise is about them.
  if (myStreak < 1) return false;

  // Two chances, not one. The flag used to be written the moment the window
  // opened, so a prompt that landed on top of the result screen and got waved
  // away took the only attempt with it.
  const shows = Number(localStorage.getItem('wr_push_shows') || 0) + 1;
  if (shows > 2) return false;
  localStorage.setItem('wr_push_shows', String(shows));

  // Permission already given on another visit: nothing to ask, just finish up.
  // Nothing appears on screen, so the slot stays free for another question.
  if (Notification.permission === 'granted') { subscribePush().then(renderPushRow); return false; }

  // Let them have the win first — the trophy, the points, the confetti. The
  // question used to open in the same instant as the result and covered it.
  setTimeout(() => {
    if (localStorage.getItem('wr_push') || $('overlay-gameover').hidden) return;
    $('push-ask-days').textContent = '🔥 ' + daysPhrase(myStreak);
    $('overlay-push').hidden = false;
  }, 2300);
  return true;
}

/* iPhone in a browser tab cannot receive push at all — the site has to be on
   the home screen first. Those people were silently skipped and never told
   why, so they had no way to ask for reminders even if they wanted them. */
function maybeHintInstallForPush() {
  if (!isIOS() || runsInstalled()) return false;
  if (localStorage.getItem('wr_push_ios_hint')) return false;
  if (Number(localStorage.getItem('wr_games') || 0) < PUSH_AFTER_GAMES || myStreak < 1) return false;
  localStorage.setItem('wr_push_ios_hint', '1');
  setTimeout(() => toast(t('push_ios_hint')), 2300);
  return true;
}

$('btn-push-no').addEventListener('click', () => {
  localStorage.setItem('wr_push_answered', '1');
  $('overlay-push').hidden = true;
});
$('btn-push-yes').addEventListener('click', async () => {
  localStorage.setItem('wr_push_answered', '1');
  $('overlay-push').hidden = true;
  // Asked inside the tap, which is what makes the browser show its prompt.
  let ok = false;
  try { ok = await Notification.requestPermission() === 'granted'; } catch { ok = false; }
  if (ok) ok = await subscribePush();
  if (ok) toast(t('push_on'));
  renderPushRow();
});

/* ---------- the switch in the profile ---------- */
// The one-time prompt after a third match reaches nobody who tapped past it,
// and a browser will not show it twice. A switch of their own is the only way
// back — and the way in for everyone the prompt caught at a bad moment.
function renderPushRow() {
  const row = $('push-row');
  if (!pushSupported() || !config?.vapid || Notification.permission === 'denied') {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  $('push-toggle').checked = Boolean(localStorage.getItem('wr_push'));
}

$('push-toggle').addEventListener('change', async (e) => {
  const box = e.target;
  if (box.checked) {
    // Asking inside the tap is what makes the browser show the prompt at all.
    box.disabled = true;
    let ok = Notification.permission === 'granted';
    if (!ok) {
      localStorage.setItem('wr_push_asked', '1');
      try { ok = await Notification.requestPermission() === 'granted'; } catch { ok = false; }
    }
    if (ok) ok = await subscribePush();
    box.disabled = false;
    box.checked = ok;
    toast(t(ok ? 'push_on' : 'push_blocked'));
    if (!ok) renderPushRow();          // a refusal hides the row for good
    return;
  }
  localStorage.removeItem('wr_push');
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      await sub.unsubscribe();
    }
  } catch { /* the row is off either way; the server drops dead endpoints */ }
  toast(t('push_off'));
});

/* ================= legal / info pages ================= */

// The documents are stored as plain text so they stay easy to translate, with
// three markers the renderer understands: "## " starts a section heading,
// "• " a list item, and a blank line separates paragraphs. Built with DOM
// nodes rather than innerHTML so the text is never treated as markup.
function renderDoc(target, text) {
  target.textContent = '';
  let list = null;
  const flushList = () => { list = null; };
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) { flushList(); continue; }
    if (line.startsWith('## ')) {
      flushList();
      const h = document.createElement('h3');
      h.textContent = line.slice(3);
      target.appendChild(h);
    } else if (line.startsWith('• ')) {
      if (!list) { list = document.createElement('ul'); target.appendChild(list); }
      const li = document.createElement('li');
      li.textContent = line.slice(2);
      list.appendChild(li);
    } else {
      flushList();
      const p = document.createElement('p');
      p.textContent = line;
      target.appendChild(p);
    }
  }
}

document.querySelectorAll('.legal-links a[data-legal]').forEach(a =>
  a.addEventListener('click', () => {
    const p = a.dataset.legal; // rules | help | terms | privacy
    $('legal-title').textContent = t(p + '_title');
    renderDoc($('legal-text'), t(p + '_body'));
    // only the two legal documents carry a revision date
    const dated = p === 'terms' || p === 'privacy';
    $('legal-updated').hidden = !dated;
    if (dated) $('legal-updated').textContent = t('doc_updated');
    $('overlay-legal').hidden = false;
    $('legal-text').scrollTop = 0;   // only sticks once the dialog is laid out
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

/* Arriving inside the portal, with their group.

   Their model has a leader and invitees. The leader's game is told to open
   straight into a room — no menu, no settings — and hands the room code back
   to them for the invite button. The invitees launch already carrying that
   code and must land in the same room without touching anything.

   Both cases map onto private rooms, which this game already has: the only
   new part is reading their code instead of ours out of the address bar. */
async function takePortalInvite() {
  if (!inPortal()) return;
  portalLoaded();

  // Their mute switch, now and whenever it is touched.
  portalMute = portalMuted();
  portalOnMute((m) => { portalMute = m; });

  /* A friend pressing Join in their friends drawer while this game is already
     running. Nothing reloads, so the room has to be changed from underneath:
     leave whatever we are in and go to theirs. */
  portalOnJoin((code) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      portalHideInvite();
      wsSend({ t: 'leave_room' });
      wsSend({ t: 'join_code', code });
    } else {
      pendingJoin = code;   // not connected yet: it goes out with the hello
    }
  });

  /* Signed in on CrazyGames, they play under that name. Their requirement,
     and a fair one — friends have to recognise each other across the board.
     Only for a guest: an account of ours already has a name its owner chose. */
  if (!profile) {
    const name = await portalUserName();
    if (name) {
      const clean = name.slice(0, 16);
      if (nickOk(clean)) { guestNick = clean; localStorage.setItem('wr_nick', clean); }
    }
  }

  const code = portalInviteCode();
  if (code) { pendingJoin = String(code).toUpperCase(); return; }
  // no code and told to go straight in: this player is the leader
  if (portalInstant()) pendingPortalRoom = true;
}

function flushPortalRoom() {
  if (!pendingPortalRoom) return;
  pendingPortalRoom = false;
  wsSend({
    t: 'create_room', private: true,
    mode: createCfg.mode, walls: Number(createCfg.walls), time: createCfg.time,
  });
}

async function boot() {
  takeInviteFromUrl();   // read the code before anything can rewrite the URL
  takeQuickFromUrl();
  // Before the socket opens, so an invited player has their room code ready
  // and lands in the room on the first connection rather than the second.
  await initPortal();
  await takePortalInvite();   // the nick it may set has to be in place before hello
  buildLangList();
  await loadLang(lang);            // detected pack, if it is not ru/en
  applyI18n();
  logVisit(false);
  updateProfileUI();
  renderOnlineState();
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
      if (data.session) {
        session = data.session;
        // kept apart so a stumble here cannot swallow the recovery form below
        try { await afterLogin(); } catch (e) { console.error('afterLogin failed', e); }
      }
      // A recovery link carries a valid session, so getSession() succeeds and
      // afterLogin() paints the ordinary profile — which is why the letter
      // landed on the site with no password form in sight. Put the form back
      // here, after everything else, so nothing paints over it.
      if (CAME_FOR_RECOVERY) { show('screen-profile'); openAuthForm('reset'); }
    } catch (e) {
      console.error('auth init failed', e);
      config.auth = false;
    }
  }
  updateProfileUI();
}

boot();
