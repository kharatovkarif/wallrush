/* The arithmetic behind the video: where the board sits, how long the clip
   runs, and which position is on screen at a given moment.

   Kept apart from clip.js because none of it needs a browser — no canvas, no
   codecs, no audio — so `npm test` can check the rules that actually have
   opinions in them: that the board always fits the frame whatever its shape,
   that a long game is shortened instead of running for two minutes, and that a
   short one is not padded out. */

export const W = 720, H = 1280;
export const FPS = 30;
export const RATE = 48000;                      // audio

// The slot the board is given. It is fitted inside rather than stretched to
// fill: the duel and the table of four are square, the race board is taller
// than it is wide, and a clip where the race board runs off the bottom is
// worse than one where it is a little smaller.
export const SLOT_Y = 175, SLOT_W = 690, SLOT_H = 810;

export const LEAD_MS = 500;                     // a moment on the opening position
export const END_MS = 2000;                     // the result, held long enough to read
export const MOVE_ANIM = 210;                   // same as the CSS transition on a pawn
export const WALL_ANIM = 160;
/* Long games are shortened rather than left to run: a clip nobody watches to
   the end is a clip nobody sends on. Short ones are not stretched — a six-move
   game is allowed to be short. */
export const SLOT_MAX = 620, SLOT_MIN = 300, BUDGET_MS = 17000;

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// The same quarter turns the live board uses, so the clip matches the game the
// player actually watched rather than some other camera angle.
export function spin(r, c, k, n) {
  let p = { r, c };
  for (let i = 0; i < k; i++) p = { r: p.c, c: n - 1 - p.r };
  return p;
}
export function spinWall(w, k, m) {
  let p = { r: w.r, c: w.c, o: w.o };
  for (let i = 0; i < k; i++) p = { r: p.c, c: m - 1 - p.r, o: p.o === 'h' ? 'v' : 'h' };
  return p;
}

export function geometry(cols, rows) {
  const uw = cols * 1.3 + 0.3, uh = rows * 1.3 + 0.3;
  const u = Math.min(SLOT_W / uw, SLOT_H / uh);
  const bw = u * uw, bh = u * uh;
  return {
    u,
    g: 0.3 * u,
    pad: 0.3 * u,
    bw,
    bh,
    bx: (W - bw) / 2,
    by: SLOT_Y + (SLOT_H - bh) / 2,
  };
}

export function buildTimeline(history) {
  const steps = Math.max(0, history.length - 1);
  const slot = steps
    ? Math.round(Math.max(SLOT_MIN, Math.min(SLOT_MAX, BUDGET_MS / steps)))
    : SLOT_MAX;
  return { steps, slot, total: LEAD_MS + steps * slot + END_MS };
}

/* Which two positions the frame at `ms` sits between, and how far along it is.
   `p` moves a pawn, `pWall` pops a wall in — two speeds because a wall appears
   quicker than a pawn walks. */
export function frameState(art, ms) {
  const { history } = art;
  const { steps, slot } = art.time;
  if (steps === 0) return { base: history[0], next: history[0], p: 1, pWall: 1, done: true };
  const x = (ms - LEAD_MS) / slot;
  if (x <= 0) return { base: history[0], next: history[0], p: 0, pWall: 0, done: false };
  if (x >= steps) return { base: history[steps], next: history[steps], p: 1, pWall: 1, done: true };
  const i = Math.floor(x);
  const frac = x - i;
  return {
    base: history[i],
    next: history[i + 1],
    p: clamp01((frac * slot) / MOVE_ANIM),
    pWall: clamp01((frac * slot) / WALL_ANIM),
    done: false,
  };
}
