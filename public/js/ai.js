// WallRush AI with difficulty levels.
// Race-aware: it compares "just run" vs "place a wall" by the resulting
// distance margin (opponent's shortest path minus mine). A wall is a real
// tempo win only when it lengthens the opponent's path by 2+ (it costs the
// AI one move). Lower levels blunder, get lazy, and pick weaker walls.
import { pawnMoves, canPlaceWall, distToGoal, goalRow, isBlocked, N } from './engine.js';

function myBestStep(state, p) {
  const dist = distToGoal(state.walls, goalRow(p));
  const moves = pawnMoves(state, p);
  let bestD = Infinity;
  for (const m of moves) {
    const d = dist[m.r * N + m.c];
    if (d !== -1 && d < bestD) bestD = d;
  }
  // several steps are often equally good — pick one at random so games differ
  const best = moves.filter(m => dist[m.r * N + m.c] === bestD);
  const move = best.length ? best[Math.floor(Math.random() * best.length)] : moves[0];
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
      .filter(m => dist[m.r * N + m.c] === dist[cur.r * N + cur.c] - 1)
      .filter(m => !isBlocked(state.walls, cur.r, cur.c, m.r, m.c));
    if (!opts.length) break;
    cur = opts[Math.floor(Math.random() * opts.length)];
  }
  cells.push(cur);
  return cells;
}

// per-level knobs
export const AI_LEVELS = {
  easy:     { blunder: 0.45, lazy: 0.70, topK: 6, needFar: 3, pathLen: 4 },
  normal:   { blunder: 0.10, lazy: 0.35, topK: 3, needFar: 2, pathLen: 8 },
  hard:     { blunder: 0.00, lazy: 0.10, topK: 2, needFar: 2, pathLen: 12, race: true },
  hardcore: { blunder: 0.00, lazy: 0.00, topK: 1, needFar: 2, pathLen: 99, race: true, aggressive: true, full: true },
};

// Best wall for player p (returns {w, gain} or null). gain = how many extra
// moves it forces on the opponent minus any extra moves it costs the AI.
function bestWall(state, p, cfg) {
  const opp = 1 - p;
  const oppPos = state.pawns[opp], myPos = state.pawns[p];
  const dOpp0 = distToGoal(state.walls, goalRow(opp))[oppPos.r * N + oppPos.c];
  const dMy0 = distToGoal(state.walls, goalRow(p))[myPos.r * N + myPos.c];

  const cand = new Map();
  if (cfg.full) {
    for (let r = 0; r < N - 1; r++)
      for (let c = 0; c < N - 1; c++)
        for (const o of ['h', 'v']) cand.set(`${r},${c},${o}`, { r, c, o });
  } else {
    for (const cell of shortestPathCells(state, opp).slice(0, cfg.pathLen)) {
      for (let dr = -1; dr <= 0; dr++)
        for (let dc = -1; dc <= 0; dc++)
          for (const o of ['h', 'v']) {
            const w = { r: cell.r + dr, c: cell.c + dc, o };
            if (w.r < 0 || w.r > N - 2 || w.c < 0 || w.c > N - 2) continue;
            cand.set(`${w.r},${w.c},${w.o}`, w);
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
  if (!scored.length) return null;
  scored.sort((a, b) => b.gain - a.gain);
  const top = scored.filter(s => s.gain === scored[0].gain);          // all ties with the best gain
  const pool = cfg.topK <= 1 ? top : scored.slice(0, cfg.topK);
  return pool[Math.floor(Math.random() * pool.length)];
}

// Decide the AI's move for the player whose turn it is.
export function aiMove(state, level = 'normal') {
  const cfg = AI_LEVELS[level] || AI_LEVELS.normal;
  const p = state.turn, opp = 1 - p;
  const my = myBestStep(state, p);
  const oppDist = distToGoal(state.walls, goalRow(opp))[state.pawns[opp].r * N + state.pawns[opp].c];

  // low levels wander off the shortest path sometimes
  if (cfg.blunder && Math.random() < cfg.blunder) {
    const moves = pawnMoves(state, p);
    const m = moves[Math.floor(Math.random() * moves.length)];
    return { type: 'pawn', r: m.r, c: m.c };
  }

  const consider = state.left[p] > 0 && Math.random() >= cfg.lazy;
  if (consider) {
    const wall = bestWall(state, p, cfg);
    if (wall) {
      if (cfg.race) {
        // A gain>=2 wall is a real tempo win — always take it. Otherwise, when
        // I'm not strictly ahead in the race, disrupt aggressively with any
        // wall (gain>=1); when clearly ahead, just run to the goal.
        const behindOrTied = my.dist >= oppDist;
        if (wall.gain >= 2) return { type: 'wall', ...wall.w };
        if (behindOrTied && wall.gain >= 1) return { type: 'wall', ...wall.w };
      } else {
        const threat = oppDist <= my.dist + 1 || oppDist <= 3;
        const need = oppDist <= 3 ? Math.max(1, cfg.needFar - 1) : cfg.needFar;
        if (threat && wall.gain >= need) return { type: 'wall', ...wall.w };
      }
    }
  }
  if (my.move) return { type: 'pawn', r: my.move.r, c: my.move.c };
  const moves = pawnMoves(state, p);
  const m = moves[Math.floor(Math.random() * moves.length)];
  return { type: 'pawn', r: m.r, c: m.c };
}
