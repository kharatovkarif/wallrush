// WallRush AI with difficulty levels. Greedy shortest-path plus wall
// placements; lower levels are deliberately imperfect.
import { pawnMoves, canPlaceWall, distToGoal, goalRow, isBlocked, N } from './engine.js';

function myBestStep(state, p) {
  const dist = distToGoal(state.walls, goalRow(p));
  const moves = pawnMoves(state, p);
  let best = null, bestD = Infinity;
  for (const m of moves) {
    const d = dist[m.r * N + m.c];
    if (d !== -1 && d < bestD) { bestD = d; best = m; }
  }
  return { move: best || moves[0], dist: bestD };
}

// Trace one shortest path for player p (cells), to focus wall candidates.
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
      .filter(m => dist[m.r * N + m.c] === dist[cur.r * N + cur.c] - 1)
      .filter(m => !isBlockedStep(state.walls, cur, m));
    if (!opts.length) break;
    cur = opts[0];
  }
  cells.push(cur);
  return cells;
}

function isBlockedStep(walls, a, b) { return isBlocked(walls, a.r, a.c, b.r, b.c); }

// per-level knobs:
//  lazy   — chance to just walk instead of thinking about walls
//  topK   — pick a wall among the K best (1 = always the strongest)
//  needNear/needFar — minimum path-gain required to spend a wall
//  blunder — chance to make a random pawn step (easy only)
//  pathLen — how far along the opponent's path to look for wall spots
export const AI_LEVELS = {
  easy:     { lazy: 0.55, topK: 5, needNear: 2, needFar: 3, blunder: 0.30, pathLen: 5 },
  normal:   { lazy: 0.25, topK: 3, needNear: 1, needFar: 2, blunder: 0,    pathLen: 8 },
  hard:     { lazy: 0.15, topK: 2, needNear: 1, needFar: 2, blunder: 0,    pathLen: 10, race: true },
  hardcore: { lazy: 0,    topK: 1, needNear: 1, needFar: 2, blunder: 0,    pathLen: 12, race: true },
};

function bestWall(state, p, cfg) {
  const opp = 1 - p;
  const before = distToGoal(state.walls, goalRow(opp));
  const beforeMy = distToGoal(state.walls, goalRow(p));
  const oppPos = state.pawns[opp];
  const myPos = state.pawns[p];
  const dOpp0 = before[oppPos.r * N + oppPos.c];
  const dMy0 = beforeMy[myPos.r * N + myPos.c];

  const path = shortestPathCells(state, opp);
  const cand = new Map();
  for (const cell of path.slice(0, cfg.pathLen)) {
    for (let dr = -1; dr <= 0; dr++) {
      for (let dc = -1; dc <= 0; dc++) {
        for (const o of ['h', 'v']) {
          const w = { r: cell.r + dr, c: cell.c + dc, o };
          if (w.r < 0 || w.r > N - 2 || w.c < 0 || w.c > N - 2) continue;
          cand.set(`${w.r},${w.c},${w.o}`, w);
        }
      }
    }
  }

  const scored = [];
  for (const w of cand.values()) {
    if (!canPlaceWall(state, p, w)) continue;
    const walls = [...state.walls, w];
    const dOpp = distToGoal(walls, goalRow(opp))[oppPos.r * N + oppPos.c];
    const dMy = distToGoal(walls, goalRow(p))[myPos.r * N + myPos.c];
    const gain = (dOpp - dOpp0) - (dMy - dMy0);
    if (gain > 0) scored.push({ w, gain });
  }
  scored.sort((a, b) => b.gain - a.gain);
  if (!scored.length) return null;
  const top = scored.slice(0, cfg.topK);
  return top[Math.floor(Math.random() * top.length)];
}

// Decide AI's move for the player whose turn it is.
export function aiMove(state, level = 'normal') {
  const cfg = AI_LEVELS[level] || AI_LEVELS.normal;
  const p = state.turn;
  const opp = 1 - p;
  const my = myBestStep(state, p);
  const oppDist = distToGoal(state.walls, goalRow(opp))[state.pawns[opp].r * N + state.pawns[opp].c];

  // easy levels sometimes wander off the shortest path
  if (cfg.blunder && Math.random() < cfg.blunder) {
    const moves = pawnMoves(state, p);
    const m = moves[Math.floor(Math.random() * moves.length)];
    return { type: 'pawn', r: m.r, c: m.c };
  }

  if (cfg.race) {
    // race-aware: walls are considered only when the opponent is a real
    // threat, and stepping already gains a tempo — so a wall must set the
    // opponent back by 2+ net moves (1+ when he is about to finish)
    const threat = oppDist <= my.dist + 1 || oppDist <= 4;
    if (threat && state.left[p] > 0 && Math.random() >= cfg.lazy) {
      const wall = bestWall(state, p, cfg);
      const need = oppDist <= 2 ? cfg.needNear : cfg.needFar;
      if (wall && wall.gain >= need) return { type: 'wall', ...wall.w };
    }
    if (my.move) return { type: 'pawn', r: my.move.r, c: my.move.c };
  }

  const lazy = Math.random() < cfg.lazy;
  const shouldConsiderWall = !lazy && state.left[p] > 0 &&
    (oppDist <= my.dist + 1 || oppDist <= 3);

  if (shouldConsiderWall) {
    const wall = bestWall(state, p, cfg);
    const need = oppDist <= 3 ? cfg.needNear : cfg.needFar;
    if (wall && wall.gain >= need) {
      return { type: 'wall', ...wall.w };
    }
  }
  if (my.move) return { type: 'pawn', r: my.move.r, c: my.move.c };
  // should never happen (path always exists), but fail safe
  const moves = pawnMoves(state, p);
  const m = moves[Math.floor(Math.random() * moves.length)];
  return { type: 'pawn', r: m.r, c: m.c };
}
