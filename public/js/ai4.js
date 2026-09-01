// The four-handed bot.
//
// The two-handed engine cannot be reused here. It is alpha-beta search, which
// rests on there being exactly one opponent whose loss is my gain; with three
// of them the arithmetic means nothing. So this is a judgement bot rather than
// a search bot: it looks one wall deep, asks who is winning, and decides
// whether to run or to spend a wall on them.
//
// It is deliberately not perfect. Three flawless robots and one human is not a
// game anybody enjoys, so skill is a dial: how often the bot plays the move it
// found rather than a plainer one.
import {
  pawnMoves, canPlaceWall, cloneState, distToTarget, goalOf, isAlive, colsOf, rowsOf,
} from './engine.js';

export const AI4_LEVELS = {
  easy:   { skill: 0.45, wallSense: 0.5 },
  normal: { skill: 0.68, wallSense: 0.8 },
  hard:   { skill: 0.88, wallSense: 1.0 },
};

const distOf = (state, walls) =>
  distToTarget(walls || state.walls, goalOf(0, state), colsOf(state), rowsOf(state));

const at = (dist, cols, pawn) => dist[pawn.r * cols + pawn.c];

// Everyone's remaining distance, -1 where the way is shut (which the wall rule
// forbids, so it only ever shows up on a state built by hand).
function distances(state, walls) {
  const cols = colsOf(state);
  const dist = distOf(state, walls);
  return state.pawns.map((pw, i) => (isAlive(state, i) ? at(dist, cols, pw) : Infinity));
}

// The cells I would walk through on my way in. Walls are worth considering
// near these, and nowhere else — the board is 121 squares and almost all of
// them are irrelevant to the race.
function pathCells(state, p, walls, rnd = Math.random) {
  const cols = colsOf(state), rows = rowsOf(state);
  const dist = distOf(state, walls);
  const cells = [];
  let cur = { ...state.pawns[p] };
  let guard = 0;
  while (dist[cur.r * cols + cur.c] > 0 && guard++ < 80) {
    cells.push(cur);
    const here = dist[cur.r * cols + cur.c];
    const next = [[-1, 0], [1, 0], [0, -1], [0, 1]]
      .map(([dr, dc]) => ({ r: cur.r + dr, c: cur.c + dc }))
      .filter(m => m.r >= 0 && m.r < rows && m.c >= 0 && m.c < cols)
      .filter(m => dist[m.r * cols + m.c] === here - 1);
    if (!next.length) break;
    // Among equally good steps, pick one at random. Always taking the first
    // meant the guessed route bent the same way for every player, and the two
    // seats it bent away from were quietly never blocked.
    cur = next[Math.floor(rnd() * next.length)];
  }
  return cells;
}

function stepMoves(state, p) {
  const cols = colsOf(state);
  const dist = distOf(state);
  const moves = pawnMoves(state, p);
  if (!moves.length) return { best: [], all: [] };
  let bestD = Infinity;
  for (const m of moves) {
    const d = dist[m.r * cols + m.c];
    if (d !== -1 && d < bestD) bestD = d;
  }
  return { best: moves.filter(m => dist[m.r * cols + m.c] === bestD), all: moves };
}

/* Who is the one to stop. Not simply whoever is closest: a player two steps
   from the centre with walls left in hand is a different problem from one who
   is close but spent. */
function threatOrder(state, ds, me, rnd = Math.random) {
  const list = [];
  for (let i = 0; i < state.pawns.length; i++) {
    if (i === me || !isAlive(state, i)) continue;
    // ties are broken by a coin, not by seat number: sorting by index quietly
    // made the last seat the one nobody ever blocked, and it won far too often
    list.push({ i, d: ds[i], k: rnd() });
  }
  return list.sort((a, b) => (a.d - b.d) || (a.k - b.k));
}

function candidateWalls(state, me, ds, cap = 48, rnd = Math.random) {
  if (state.left[me] <= 0) return [];
  const rows = rowsOf(state), cols = colsOf(state);
  const seen = new Set();
  const out = [];
  const threats = threatOrder(state, ds, me, rnd);
  // walls that matter sit beside the leaders' routes, close to their pawns
  for (const th of threats.slice(0, 2)) {
    for (const cell of pathCells(state, th.i, null, rnd).slice(0, 5)) {
      for (let dr = -1; dr <= 0; dr++) {
        for (let dc = -1; dc <= 0; dc++) {
          for (const o of ['h', 'v']) {
            const w = { r: cell.r + dr, c: cell.c + dc, o };
            if (w.r < 0 || w.r > rows - 2 || w.c < 0 || w.c > cols - 2) continue;
            const key = `${w.r},${w.c},${w.o}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (!canPlaceWall(state, me, w)) continue;
            out.push(w);
            if (out.length >= cap) return out;
          }
        }
      }
    }
  }
  return out;
}

/* What a wall is worth to me.

   It has to hurt the player in front more than it hurts me, and hurting the
   other two is a small bonus rather than the point — a wall that slows
   everyone equally has changed nothing about who wins. */
function wallScore(state, me, w, ds) {
  const walls = [...state.walls, w];
  const after = distances(state, walls);
  if (after[me] === -1) return -Infinity;
  const cost = after[me] - ds[me];
  let gain = 0, best = 0;
  for (let i = 0; i < state.pawns.length; i++) {
    if (i === me || !isAlive(state, i)) continue;
    if (after[i] === -1) return -Infinity;
    const g = after[i] - ds[i];
    gain += g;
    if (ds[i] <= ds[me] && g > best) best = g;   // hurting a leader is the point
  }
  return best * 1.6 + (gain - best) * 0.25 - cost * 1.4;
}

const pick = (arr, rnd) => arr[Math.floor(rnd() * arr.length)];

/* Choose a move for player `me`. Returns {type:'pawn',r,c} or
   {type:'wall',r,c,o}, or null if there is genuinely nothing to play. */
export function ai4Move(state, level = 'normal', opts = {}) {
  const cfg = AI4_LEVELS[level] || AI4_LEVELS.normal;
  const rnd = opts.rnd || Math.random;
  const me = state.turn;
  const ds = distances(state, state.walls);
  const { best, all } = stepMoves(state, me);
  if (!all.length) return null;

  const run = () => ({ type: 'pawn', ...pick(best.length ? best : all, rnd) });
  // An off day: skip the wall thinking and just move. It still goes forwards —
  // a bot that wanders backwards does not read as a weaker player, it reads as
  // a broken one, and the game never ends.
  if (rnd() > cfg.skill) return run();

  const threats = threatOrder(state, ds, me, rnd);
  const leader = threats[0];
  const iLead = !leader || ds[me] <= leader.d;

  // Clearly in front and the finish is close: no wall is worth the tempo.
  if (iLead && (!leader || ds[me] < leader.d) && ds[me] <= 3) return run();
  // In front by a clear margin: run, mostly.
  if (iLead && leader && leader.d - ds[me] >= 2 && rnd() < 0.85) return run();
  if (state.left[me] <= 0) return run();

  const cands = candidateWalls(state, me, ds, 48, rnd);
  // Ties are settled by a coin. Taking the first-found best wall gave the bot
  // a standing preference for one orientation, and over many games that showed
  // up as two of the four seats winning noticeably more often.
  let bestW = null, bestS = -Infinity, ties = 0;
  for (const w of cands) {
    const s = wallScore(state, me, w, ds);
    if (s > bestS + 1e-9) { bestS = s; bestW = w; ties = 1; }
    else if (s > bestS - 1e-9) { ties++; if (rnd() < 1 / ties) bestW = w; }
  }
  // The bar is higher when I am already ahead — a wall costs a move, and the
  // move is what wins the race.
  const bar = (iLead ? 2.2 : 1.1) / Math.max(0.4, cfg.wallSense);
  // Hoard a wall or two for the finish rather than spending the lot early.
  const late = ds[me] <= 6 || (leader && leader.d <= 4);
  if (bestW && bestS >= bar && (late || state.left[me] > 2)) {
    return { type: 'wall', ...bestW };
  }
  return run();
}

// A rough read of how tense the position is, so the bot's thinking time can
// look like a person's: 0 = obvious, 2 = a real decision.
export function quadTension(state, me) {
  const ds = distances(state, state.walls);
  const threats = threatOrder(state, ds, me);
  if (!threats.length) return 0;
  const lead = threats[0].d;
  if (ds[me] + 2 < lead) return 0;
  if (state.left[me] <= 0) return 0;
  if (lead <= 3 || Math.abs(ds[me] - lead) <= 1) return 2;
  return 1;
}

export { distances as quadDistances, cloneState };
