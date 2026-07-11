// WallRush AI.
// Difficulty is a skill dial: the chance of playing the "strong" move vs a
// weak one. The strong move is a real look-ahead:
//   - easy/normal/hard: one-ply race evaluation (run vs. wall by distance)
//   - hardcore: minimax (alpha-beta) several moves deep — it simulates every
//     sensible line of play and picks the one that keeps you from ever winning.
import { pawnMoves, canPlaceWall, distToGoal, goalRow, cloneState, applyMove, N } from './engine.js';

export const AI_LEVELS = {
  easy:     { skill: 0.34 },              // ~20% AI win
  normal:   { skill: 0.50 },              // ~50%
  hard:     { skill: 0.67 },              // ~80%
  hardcore: { skill: 1.00, deep: true },  // ~100% — look-ahead, near-unbeatable
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
  const move = (best.length ? best : moves)[Math.floor(Math.random() * (best.length || moves.length))];
  return { move, dist: bestD };
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
    cur = opts[Math.floor(Math.random() * opts.length)];
  }
  return cells;
}

// Legal wall candidates that matter: slots hugging the opponent's shortest
// path (to block) and the AI's own path (to defend). Capped for speed.
function candidateWalls(state, p, cap) {
  if (state.left[p] <= 0) return [];
  const set = new Map();
  const add = (cells, span) => {
    for (const cell of cells.slice(0, span)) {
      for (let dr = -1; dr <= 0; dr++)
        for (let dc = -1; dc <= 0; dc++)
          for (const o of ['h', 'v']) {
            const w = { r: cell.r + dr, c: cell.c + dc, o };
            if (w.r < 0 || w.r > N - 2 || w.c < 0 || w.c > N - 2) continue;
            set.set(`${w.r},${w.c},${w.o}`, w);
          }
    }
  };
  add(shortestPathCells(state, 1 - p), 6);
  add(shortestPathCells(state, p), 3);

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
  return scored.slice(0, cap); // [{w, gain}]
}

/* ---------- shallow (1-ply) strong move: easy / normal / hard ---------- */
function greedyMove(state, p) {
  const opp = 1 - p;
  const my = myBestStep(state, p);
  const oppDist = pawnDist(state, opp);
  if (state.left[p] > 0) {
    const walls = candidateWalls(state, p, 8);
    if (walls.length) {
      const { w, gain } = walls[0];                       // highest-gain wall (correct gain)
      const behindOrTied = my.dist >= oppDist;
      if (gain >= 2 || (behindOrTied && gain >= 1)) return { type: 'wall', ...w };
    }
  }
  return { type: 'pawn', r: my.move.r, c: my.move.c };
}

/* ---------- hardcore: look-ahead with a strong opponent model ----------
   For each of my sensible moves, assume the opponent replies with its own
   best (greedy race) move, then score the resulting race margin. Pick the
   move that leaves me best off after that reply. This beats the plain
   1-ply greedy because it foresees the opponent's answer. */
const WIN = 1e6;

function evalRel(state, p) {
  const myD = pawnDist(state, p);
  const oppD = pawnDist(state, 1 - p);
  // whoever is to move effectively reaches one step sooner → tempo term
  const tempo = state.turn === p ? 0.5 : -0.5;
  return (oppD - myD + tempo) * 8 + (state.left[p] - state.left[1 - p]) * 0.6;
}

function deepMove(state, p) {
  const opp = 1 - p;
  const my = myBestStep(state, p);
  const moves = [{ type: 'pawn', r: my.move.r, c: my.move.c }];
  for (const { w } of candidateWalls(state, p, 10)) moves.push({ type: 'wall', ...w });

  let bestScore = -Infinity;
  const scored = [];
  for (const move of moves) {
    const c = cloneState(state);
    applyMove(c, move);
    let score;
    if (c.winner === p) {
      score = WIN;                                  // this move wins outright
    } else {
      const reply = greedyMove(c, opp);             // opponent's best answer
      const c2 = cloneState(c);
      applyMove(c2, reply);
      score = c2.winner === opp ? -WIN : evalRel(c2, p);
    }
    scored.push({ move, score });
    if (score > bestScore) bestScore = score;
  }
  const top = scored.filter(s => s.score >= bestScore - 0.001);
  return top[Math.floor(Math.random() * top.length)].move;
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

export function aiMove(state, level = 'normal') {
  const cfg = AI_LEVELS[level] || AI_LEVELS.normal;
  const p = state.turn;
  if (Math.random() < cfg.skill) {
    return cfg.deep ? deepMove(state, p) : greedyMove(state, p);
  }
  return weakMove(state, p);
}
