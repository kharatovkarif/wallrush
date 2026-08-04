/* Everything CrazyGames, kept in one file.

   The same build serves two places. On wallrush.online the game is its own
   page and nothing in here runs: `embedded` comes out false, the SDK is never
   fetched, and every function below returns immediately. Inside the portal the
   game sits in a frame on their page, and then the rules are theirs — our own
   banners must not appear, and the money comes from ads we ask them for.

   Two different questions, deliberately answered separately:

     embedded   — are we inside anybody's frame? Decides whether our banners
                  are allowed. Every portal forbids them, not only this one,
                  so the answer must not depend on recognising CrazyGames.
     inPortal() — is this really CrazyGames, with a working SDK? Decides
                  whether their calls do anything.

   Nothing here is allowed to throw. A portal is somebody else's page that can
   change without warning, and a game that dies because an ad call went
   missing is worse than a game with no ads. */

const SDK_SRC = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';

// A cross-origin parent makes even reading window.top throw, and that throw is
// itself the answer: something is framing us.
export const embedded = (() => {
  try { return window.self !== window.top; } catch { return true; }
})();

let sdk = null;      // set only once init has succeeded on their site
let ready = null;    // the in-flight init, so a second call waits rather than repeats

function loadScript() {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SDK_SRC;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('sdk script failed'));
    document.head.appendChild(s);
    // their servers going slow must not hold the game on a loading screen
    setTimeout(() => reject(new Error('sdk script timeout')), 8000);
  });
}

/* Fetched on demand rather than sitting in the page as a tag, so a visitor to
   wallrush.online never downloads it and never gets touched by it. */
export function initPortal() {
  if (ready) return ready;
  ready = (async () => {
    if (!embedded) return null;
    try {
      await loadScript();
      const s = window.CrazyGames && window.CrazyGames.SDK;
      if (!s) return null;
      await s.init();
      // 'crazygames' on their site; 'local' or 'disabled' anywhere else, and
      // in those cases their calls are not ours to make
      if (s.environment !== 'crazygames') return null;
      sdk = s;
      return s;
    } catch (e) {
      console.warn('portal: SDK unavailable —', e.message);
      return null;
    }
  })();
  return ready;
}

export const inPortal = () => Boolean(sdk);

/* ---------- their ads ----------
   Resolves true only when an ad actually played through. Everything else —
   no fill, a blocker, their SDK having a bad day — resolves false, and the
   caller carries on as if nothing had been asked for. */
export function portalAd(kind = 'midgame') {
  return new Promise((resolve) => {
    if (!sdk) { resolve(false); return; }
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      sdk.ad.requestAd(kind, {
        adStarted: () => {},
        adFinished: () => done(true),
        adError: () => done(false),
      });
    } catch { done(false); }
    // a callback that never comes must not strand the player mid-menu
    setTimeout(() => done(false), 45000);
  });
}

/* ---------- signals they use to place their own ads well ----------
   Telling them when a match is actually being played is what keeps their ads
   out of the middle of one. */
export function portalPlaying(on) {
  try {
    if (!sdk) return;
    if (on) sdk.game.gameplayStart(); else sdk.game.gameplayStop();
  } catch { /* their call, their problem */ }
}

// a good moment — a win. They use it to pick when not to interrupt.
export function portalHappy() {
  try { sdk && sdk.game.happytime(); } catch {}
}

export function portalLoaded() {
  try { sdk && sdk.game.sdkGameLoadingStop(); } catch {}
}

/* ---------- playing with friends, their way ----------
   They have their own invite flow: a player presses a button in the frame's
   footer, their friends open a link, and everyone must land in the same room
   without passing through a menu. Our private rooms already work like that —
   these three only translate between their code and ours. */
export function portalInviteCode() {
  try { return (sdk && sdk.game.getInviteParam('code')) || ''; } catch { return ''; }
}

export function portalShowInvite(code) {
  try { sdk && sdk.game.showInviteButton({ code }); } catch {}
}

export function portalHideInvite() {
  try { sdk && sdk.game.hideInviteButton(); } catch {}
}

// Set when a group arrives together: open straight into a room, no menu.
export function portalInstant() {
  try { return Boolean(sdk && sdk.game.isInstantMultiplayer); } catch { return false; }
}
