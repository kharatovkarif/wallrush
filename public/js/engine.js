// WallRush game engine (Quoridor rules). Shared between browser and Node.
// Two modes:
//   duel (classic): 9x9, players start on opposite sides, each runs to the
//     other side; 10 walls each.
//   race: 11x13, BOTH players start on the bottom row and race to the top
//     row; 15 walls each.
// Walls: {r, c, o} with r in 0..rows-2, c in 0..cols-2.
//   o='h' — horizontal wall between rows r and r+1, spanning columns c and c+1
//   o='v' — vertical wall between columns c and c+1, spanning rows r and r+1

export const N = 9; // classic board size (legacy callers)
export const WALLS_PER_PLAYER = 10;

export const MODES = {
  duel: { cols: 9, rows: 9, walls: 10 },
  race: { cols: 11, rows: 13, walls: 15 },
};

export function initialState(mode = 'duel') {
  const m = MODES[mode] || MODES.duel;
  if (mode === 'race') {
    return {
      mode: 'race', cols: m.cols, rows: m.rows,
      pawns: [{ r: m.rows - 1, c: 3 }, { r: m.rows - 1, c: m.cols - 4 }],
      walls: [],
      left: [m.walls, m.walls],
      turn: 0,
      winner: null,
    };
  }
  return {
    mode: 'duel', cols: 9, rows: 9,
    pawns: [{ r: 8, c: 4 }, { r: 0, c: 4 }],
    walls: [],
    left: [m.walls, m.walls],
    turn: 0,
    winner: null,
  };
}

export const colsOf = (s) => s.cols || 9;
export const rowsOf = (s) => s.rows || 9;

// Where player p is heading. In race mode everyone runs to the top row.
// Legacy calls without a state assume the classic 9x9 duel.
export function goalRow(p, state) {
  if (state && state.mode === 'race') return 0;
  return p === 0 ? 0 : (state ? rowsOf(state) - 1 : 8);
}

export function cloneState(s) {
  return {
    mode: s.mode || 'duel', cols: colsOf(s), rows: rowsOf(s),
    pawns: s.pawns.map(p => ({ ...p })),
    walls: s.walls.map(w => ({ ...w })),
    left: [...s.left],
    turn: s.turn,
    winner: s.winner,
  };
}

// Is the edge between two ADJACENT cells blocked by a wall?
export function isBlocked(walls, r1, c1, r2, c2) {
  if (r1 === r2) {
    // horizontal step: crossing vertical boundary between min(c) and min(c)+1
    const c = Math.min(c1, c2);
    for (const w of walls) {
      if (w.o === 'v' && w.c === c && (w.r === r1 || w.r === r1 - 1)) return true;
    }
  } else {
    // vertical step: crossing horizontal boundary between min(r) and min(r)+1
    const r = Math.min(r1, r2);
    for (const w of walls) {
      if (w.o === 'h' && w.r === r && (w.c === c1 || w.c === c1 - 1)) return true;
    }
  }
  return false;
}

const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

// Legal pawn destinations for player p (includes jumps over the opponent pawn,
// straight and diagonal per classic rules; never through walls).
export function pawnMoves(state, p) {
  const cols = colsOf(state), rows = rowsOf(state);
  const inB = (r, c) => r >= 0 && r < rows && c >= 0 && c < cols;
  const me = state.pawns[p];
  const opp = state.pawns[1 - p];
  const out = [];
  for (const [dr, dc] of DIRS) {
    const r1 = me.r + dr, c1 = me.c + dc;
    if (!inB(r1, c1) || isBlocked(state.walls, me.r, me.c, r1, c1)) continue;
    if (r1 !== opp.r || c1 !== opp.c) {
      out.push({ r: r1, c: c1 });
      continue;
    }
    // opponent adjacent: try straight jump over them
    const r2 = r1 + dr, c2 = c1 + dc;
    if (inB(r2, c2) && !isBlocked(state.walls, r1, c1, r2, c2)) {
      out.push({ r: r2, c: c2 });
    } else {
      // straight jump blocked by wall/edge: diagonal side-steps
      const perps = dr === 0 ? [[-1, 0], [1, 0]] : [[0, -1], [0, 1]];
      for (const [pr, pc] of perps) {
        const r3 = r1 + pr, c3 = c1 + pc;
        if (!inB(r3, c3)) continue;
        if (isBlocked(state.walls, r1, c1, r3, c3)) continue;
        if (r3 === me.r && c3 === me.c) continue;
        out.push({ r: r3, c: c3 });
      }
    }
  }
  return out;
}

function wallsConflict(a, b) {
  if (a.o === b.o) {
    if (a.o === 'h') return a.r === b.r && Math.abs(a.c - b.c) <= 1;
    return a.c === b.c && Math.abs(a.r - b.r) <= 1;
  }
  // h vs v cross at the same center point
  return a.r === b.r && a.c === b.c;
}

// BFS: does the pawn have any path to the goal row? (pawns don't block paths)
export function hasPath(walls, pawn, goal, cols = 9, rows = 9) {
  const seen = new Uint8Array(rows * cols);
  const q = [pawn.r * cols + pawn.c];
  seen[q[0]] = 1;
  while (q.length) {
    const cur = q.pop();
    const r = (cur / cols) | 0, c = cur % cols;
    if (r === goal) return true;
    for (const [dr, dc] of DIRS) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const k = nr * cols + nc;
      if (seen[k]) continue;
      if (isBlocked(walls, r, c, nr, nc)) continue;
      seen[k] = 1;
      q.push(k);
    }
  }
  return false;
}

// BFS distance map from every cell to the goal row (walls only).
// Index cells as r * cols + c.
export function distToGoal(walls, goal, cols = 9, rows = 9) {
  const dist = new Int16Array(rows * cols).fill(-1);
  const q = [];
  for (let c = 0; c < cols; c++) {
    dist[goal * cols + c] = 0;
    q.push(goal * cols + c);
  }
  let head = 0;
  while (head < q.length) {
    const cur = q[head++];
    const r = (cur / cols) | 0, c = cur % cols;
    for (const [dr, dc] of DIRS) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const k = nr * cols + nc;
      if (dist[k] !== -1) continue;
      if (isBlocked(walls, r, c, nr, nc)) continue;
      dist[k] = dist[cur] + 1;
      q.push(k);
    }
  }
  return dist;
}

// Can player p legally place wall w?
export function canPlaceWall(state, p, w) {
  const cols = colsOf(state), rows = rowsOf(state);
  if (state.left[p] <= 0) return false;
  if (w.r < 0 || w.r > rows - 2 || w.c < 0 || w.c > cols - 2) return false;
  if (w.o !== 'h' && w.o !== 'v') return false;
  for (const e of state.walls) if (wallsConflict(e, w)) return false;
  // both players must keep a path to their goal
  const walls = [...state.walls, w];
  return hasPath(walls, state.pawns[0], goalRow(0, state), cols, rows)
      && hasPath(walls, state.pawns[1], goalRow(1, state), cols, rows);
}

// Apply a move for the player whose turn it is.
// move: {type:'pawn', r, c} | {type:'wall', r, c, o}
// Returns true if the move was legal and applied.
export function applyMove(state, move) {
  if (state.winner !== null) return false;
  const p = state.turn;
  if (move.type === 'pawn') {
    const ok = pawnMoves(state, p).some(m => m.r === move.r && m.c === move.c);
    if (!ok) return false;
    state.pawns[p] = { r: move.r, c: move.c };
    if (move.r === goalRow(p, state)) {
      state.winner = p;
      return true;
    }
  } else if (move.type === 'wall') {
    const w = { r: move.r, c: move.c, o: move.o };
    if (!canPlaceWall(state, p, w)) return false;
    state.walls.push(w);
    state.left[p]--;
  } else {
    return false;
  }
  state.turn = 1 - p;
  return true;
}
