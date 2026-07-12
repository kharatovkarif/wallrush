// WallRush AI.
// Difficulty is a skill dial: the chance of playing the strong move vs a weak
// one. easy/normal/hard use a fast look-ahead; hardcore runs a real search
// engine (alpha-beta negamax + transposition table + iterative deepening) that
// looks many moves ahead — it examines the opponent's replies to every line and
// only plays into positions it can hold, so a human practically cannot win.
import { pawnMoves, canPlaceWall, distToGoal, goalRow, cloneState, applyMove, N } from './engine.js';

export const AI_LEVELS = {
  easy:     { skill: 0.34 },                 // ~20% AI win
  normal:   { skill: 0.50 },                 // ~50%
  hard:     { skill: 0.67 },                 // ~80%
  hardcore: { skill: 1.00, engine: true },   // deep search — near-unbeatable
};

function pawnDist(state, p) {
  return distToGoal(state.walls, goalRow(p))[state.pawns[p].r * N + state.pawns[p].c];
}

function myBestStep(state, p) {
  const dist = distToGoal(state.walls, goalRow(p));
  const moves = pawnMoves(state, p);
  let bestD = Infinity;
  for (const m of moves) { const d = dist[m.r * N + m.c]; if (d !== -1 && d < bestD) bestD = d; }
  const best = moves.filter(m => dist[m.r * N + m.c] === bestD);
  const pool = best.length ? best : moves;
  return { move: pool[Math.floor(Math.random() * pool.length)], dist: bestD };
}

function shortestPathCells(state, p) {
  const dist = distToGoal(state.walls, goalRow(p));
  const cells = [];
  let cur = { ...state.pawns[p] };
  let guard = 0;
  while (dist[cur.r * N + cur.c] > 0 && guard++ < 100) {
    cells.push(cur);
    const opts = [[-1, 0], [1, 0], [0, -1], [0, 1]]
      .map(([dr, dc]) => ({ r: cur.r + dr, c: cur.c + dc }))
      .filter(m => m.r >= 0 && m.r < N && m.c >= 0 && m.c < N)
      .filter(m => dist[m.r * N + m.c] === dist[cur.r * N + cur.c] - 1);
    if (!opts.length) break;
    cur = opts[0];
  }
  return cells;
}

// Legal wall candidates that matter, each with its path-length gain, sorted best
// first (good move ordering makes alpha-beta prune hard so the search goes deep).
function candidateWalls(state, p, cap) {
  if (state.left[p] <= 0) return [];
  const set = new Map();
  const add = (cells, span) => {
    for (const cell of cells.slice(0, span))
      for (let dr = -1; dr <= 0; dr++)
        for (let dc = -1; dc <= 0; dc++)
          for (const o of ['h', 'v']) {
            const w = { r: cell.r + dr, c: cell.c + dc, o };
            if (w.r < 0 || w.r > N - 2 || w.c < 0 || w.c > N - 2) continue;
            set.set(`${w.r},${w.c},${w.o}`, w);
          }
  };
  add(shortestPathCells(state, 1 - p), 8);
  add(shortestPathCells(state, p), 4);
  // extend existing walls (choke points)
  for (const e of state.walls)
    for (const o of ['h', 'v'])
      for (const d of [-2, -1, 1, 2]) {
        const w = o === 'h' ? { r: e.r, c: e.c + d, o } : { r: e.r + d, c: e.c, o };
        if (w.r < 0 || w.r > N - 2 || w.c < 0 || w.c > N - 2) continue;
        set.set(`${w.r},${w.c},${w.o}`, w);
      }

  const opp = 1 - p, oppPos = state.pawns[opp], myPos = state.pawns[p];
  const dOpp0 = distToGoal(state.walls, goalRow(opp))[oppPos.r * N + oppPos.c];
  const dMy0 = distToGoal(state.walls, goalRow(p))[myPos.r * N + myPos.c];
  const scored = [];
  for (const w of set.values()) {
    if (!canPlaceWall(state, p, w)) continue;
    const walls = [...state.walls, w];
    const gain = (distToGoal(walls, goalRow(opp))[oppPos.r * N + oppPos.c] - dOpp0)
               - (distToGoal(walls, goalRow(p))[myPos.r * N + myPos.c] - dMy0);
    scored.push({ w, gain });
  }
  scored.sort((a, b) => b.gain - a.gain);
  return scored.slice(0, cap);
}

/* ---------- shallow strong move: easy / normal / hard ---------- */
function greedyMove(state, p) {
  const my = myBestStep(state, p);
  const oppDist = pawnDist(state, 1 - p);
  const walls = candidateWalls(state, p, 8);
  if (walls.length) {
    const { w, gain } = walls[0];
    const behindOrTied = my.dist >= oppDist;
    if (gain >= 2 || (behindOrTied && gain >= 1)) return { type: 'wall', ...w };
  }
  return { type: 'pawn', r: my.move.r, c: my.move.c };
}

/* ================= deep search engine (hardcore) ================= */
const MATE = 1e6;

// Static evaluation from the side-to-move's perspective. The race is decided by
// distance; the side on move reaches ~one step sooner, so it gets a tempo bonus.
function evalPos(state) {
  const p = state.turn, opp = 1 - p;
  const myD = pawnDist(state, p);
  const oppD = pawnDist(state, opp);
  return (oppD - myD) * 10 + 5 + (state.left[p] - state.left[opp]) * 2;
}

function keyOf(state) {
  const w = state.walls.map(x => `${x.r}${x.c}${x.o}`).sort().join('');
  const pw = state.pawns;
  return `${pw[0].r}${pw[0].c}${pw[1].r}${pw[1].c}${state.turn}${state.left[0]}${state.left[1]}|${w}`;
}

function orderedMoves(state, p, wallCap) {
  const my = myBestStep(state, p);
  const moves = [{ type: 'pawn', r: my.move.r, c: my.move.c, _p: 3 }];
  for (const m of pawnMoves(state, p)) {
    if (m.r === my.move.r && m.c === my.move.c) continue;
    moves.push({ type: 'pawn', r: m.r, c: m.c, _p: 1 });
  }
  if (state.left[p] > 0) for (const { w, gain } of candidateWalls(state, p, wallCap)) {
    moves.push({ type: 'wall', ...w, _p: 2 + Math.min(gain, 3) });
  }
  moves.sort((a, b) => b._p - a._p);
  return moves;
}

let TT, nodes, deadline;

function negamax(state, depth, alpha, beta, rootDepth) {
  if (Date.now() > deadline) throw 'timeout';
  const alpha0 = alpha;
  const key = keyOf(state) + ':' + depth;
  const hit = TT.get(key);
  if (hit !== undefined) {
    if (hit.flag === 0) return hit.score;
    if (hit.flag < 0 && hit.score <= alpha) return hit.score;
    if (hit.flag > 0 && hit.score >= beta) return hit.score;
  }
  if (depth === 0) return evalPos(state);

  const p = state.turn;
  const wallCap = depth >= 4 ? 12 : depth >= 2 ? 8 : 4;
  let best = -Infinity;
  for (const move of orderedMoves(state, p, wallCap)) {
    nodes++;
    const c = cloneState(state);
    applyMove(c, move);
    let score;
    if (c.winner === p) score = MATE - (rootDepth - depth);   // sooner win is better
    else score = -negamax(c, depth - 1, -beta, -alpha, rootDepth);
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  const flag = best <= alpha0 ? -1 : best >= beta ? 1 : 0;
  TT.set(key, { score: best, flag });
  return best;
}

function searchRoot(state, depth) {
  const p = state.turn;
  let alpha = -Infinity;
  const scored = [];
  for (const move of orderedMoves(state, p, 14)) {
    const c = cloneState(state);
    applyMove(c, move);
    let score;
    if (c.winner === p) score = MATE;
    else score = -negamax(c, depth - 1, -Infinity, -alpha, depth);
    scored.push({ move, score });
    if (score > alpha) alpha = score;
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter(s => s.score >= scored[0].score - 0.001);
  return { move: top[Math.floor(Math.random() * top.length)].move, score: scored[0].score };
}

function engineMove(state, p, budgetMs, maxDepth) {
  TT = new Map(); nodes = 0;
  deadline = Date.now() + (budgetMs || 550);
  let best = greedyMove(state, p);
  for (let depth = 2; depth <= (maxDepth || 20); depth += 2) {
    try {
      const res = searchRoot(state, depth);
      best = res.move;
      if (res.score >= MATE - 1000) break; // proven forced win — no need to go deeper
    } catch (e) {
      break; // ran out of time; keep best from the last completed depth
    }
  }
  return best;
}

/* ---------- weak move for the skill dial ---------- */
function weakMove(state, p) {
  const moves = pawnMoves(state, p);
  if (Math.random() < 0.35) {
    const dist = distToGoal(state.walls, goalRow(p));
    let best = moves[0], bd = Infinity;
    for (const m of moves) { const d = dist[m.r * N + m.c]; if (d !== -1 && d < bd) { bd = d; best = m; } }
    return { type: 'pawn', r: best.r, c: best.c };
  }
  const m = moves[Math.floor(Math.random() * moves.length)];
  return { type: 'pawn', r: m.r, c: m.c };
}

export function aiMove(state, level = 'normal', opts = {}) {
  const cfg = AI_LEVELS[level] || AI_LEVELS.normal;
  const p = state.turn;
  if (Math.random() < cfg.skill) {
    if (cfg.engine) return engineMove(state, p, opts.budgetMs, opts.maxDepth);
    return greedyMove(state, p);
  }
  return weakMove(state, p);
}
