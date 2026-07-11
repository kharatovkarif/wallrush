// WallRush AI. One strong "brain" that looks one move ahead (it compares
// running to the goal vs. placing a wall by the resulting distance margin —
// opponent's shortest path minus its own). Difficulty is a skill dial: the
// chance the AI plays that strong move instead of a weak one, tuned so the
// AI wins roughly 20% (easy) / 50% (normal) / 80% (hard) / 100% (hardcore).
import { pawnMoves, canPlaceWall, distToGoal, goalRow, isBlocked, N } from './engine.js';

// chance of playing the strong, look-ahead move (else a weak move)
export const AI_LEVELS = {
  easy:     { skill: 0.34 }, // ~20% AI win
  normal:   { skill: 0.50 }, // ~50%
  hard:     { skill: 0.67 }, // ~80%
  hardcore: { skill: 1.00 }, // ~100%
};

function myBestStep(state, p) {
  const dist = distToGoal(state.walls, goalRow(p));
  const moves = pawnMoves(state, p);
  let bestD = Infinity;
  for (const m of moves) {
    const d = dist[m.r * N + m.c];
    if (d !== -1 && d < bestD) bestD = d;
  }
  const best = moves.filter(m => dist[m.r * N + m.c] === bestD);
  const move = best.length ? best[Math.floor(Math.random() * best.length)] : moves[0];
  return { move, dist: bestD };
}

// Best wall for p, searching every legal slot. Returns {w, gain} or null.
// gain = extra moves forced on the opponent minus extra moves it costs the AI.
function bestWall(state, p) {
  const opp = 1 - p;
  const oppPos = state.pawns[opp], myPos = state.pawns[p];
  const dOpp0 = distToGoal(state.walls, goalRow(opp))[oppPos.r * N + oppPos.c];
  const dMy0 = distToGoal(state.walls, goalRow(p))[myPos.r * N + myPos.c];

  const scored = [];
  for (let r = 0; r < N - 1; r++) {
    for (let c = 0; c < N - 1; c++) {
      for (const o of ['h', 'v']) {
        const w = { r, c, o };
        if (!canPlaceWall(state, p, w)) continue;
        const walls = [...state.walls, w];
        const dOpp = distToGoal(walls, goalRow(opp))[oppPos.r * N + oppPos.c];
        const dMy = distToGoal(walls, goalRow(p))[myPos.r * N + myPos.c];
        const gain = (dOpp - dOpp0) - (dMy - dMy0);
        if (gain > 0) scored.push({ w, gain });
      }
    }
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.gain - a.gain);
  const top = scored.filter(s => s.gain === scored[0].gain); // ties → random for variety
  return top[Math.floor(Math.random() * top.length)];
}

// The strong move: one-ply race evaluation.
function strongMove(state, p) {
  const opp = 1 - p;
  const my = myBestStep(state, p);
  const oppDist = distToGoal(state.walls, goalRow(opp))[state.pawns[opp].r * N + state.pawns[opp].c];

  if (state.left[p] > 0) {
    const wall = bestWall(state, p);
    if (wall) {
      const behindOrTied = my.dist >= oppDist;
      // a gain>=2 wall is a real tempo win; when not ahead, any wall disrupts
      if (wall.gain >= 2 || (behindOrTied && wall.gain >= 1)) {
        return { type: 'wall', ...wall.w };
      }
    }
  }
  return { type: 'pawn', r: my.move.r, c: my.move.c };
}

// The weak move: mostly a random legal step (may even go backwards), so lower
// skill levels genuinely give the win away.
function weakMove(state, p) {
  const moves = pawnMoves(state, p);
  // 35% of the time still step toward goal, so it's not utterly clueless
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
  if (Math.random() < cfg.skill) return strongMove(state, p);
  return weakMove(state, p);
}
