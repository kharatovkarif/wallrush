// WallRush medium-strength AI. Plays greedy shortest-path with occasional
// wall placements; deliberately imperfect so an average player can win.
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

function bestWall(state, p) {
  const opp = 1 - p;
  const before = distToGoal(state.walls, goalRow(opp));
  const beforeMy = distToGoal(state.walls, goalRow(p));
  const oppPos = state.pawns[opp];
  const myPos = state.pawns[p];
  const dOpp0 = before[oppPos.r * N + oppPos.c];
  const dMy0 = beforeMy[myPos.r * N + myPos.c];

  const path = shortestPathCells(state, opp);
  const cand = new Map();
  for (const cell of path.slice(0, 8)) {
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
  // medium strength: pick among the top 3, not always the best
  const top = scored.slice(0, 3);
  return top[Math.floor(Math.random() * top.length)];
}

// Decide AI's move for the player whose turn it is.
export function aiMove(state) {
  const p = state.turn;
  const opp = 1 - p;
  const my = myBestStep(state, p);
  const oppDist = distToGoal(state.walls, goalRow(opp))[state.pawns[opp].r * N + state.pawns[opp].c];

  // 25% of the time just walk — deliberate imperfection
  const lazy = Math.random() < 0.25;
  const shouldConsiderWall = !lazy && state.left[p] > 0 &&
    (oppDist <= my.dist + 1 || oppDist <= 3);

  if (shouldConsiderWall) {
    const wall = bestWall(state, p);
    // require a meaningful gain; be stricter when opponent is still far
    const need = oppDist <= 3 ? 1 : 2;
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
