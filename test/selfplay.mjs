// Engine + AI sanity check: AI plays itself N games; verifies rules hold.
import { initialState, applyMove, pawnMoves, canPlaceWall, hasPath, goalRow } from '../public/js/engine.js';
import { aiMove } from '../public/js/ai.js';

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error('FAIL:', msg); }
}

// --- unit checks ---
{
  const s = initialState();
  check(s.pawns[0].r === 8 && s.pawns[1].r === 0, 'initial pawn rows');
  check(pawnMoves(s, 0).length === 3, 'pawn at edge has 3 moves');
  // wall between pawn and goal is fine while another path exists
  check(canPlaceWall(s, 0, { r: 4, c: 4, o: 'h' }), 'simple wall is legal');
  // overlapping walls rejected
  applyMove(s, { type: 'wall', r: 4, c: 4, o: 'h' });
  check(!canPlaceWall(s, 1, { r: 4, c: 4, o: 'h' }), 'duplicate wall rejected');
  check(!canPlaceWall(s, 1, { r: 4, c: 5, o: 'h' }), 'overlapping wall rejected');
  check(!canPlaceWall(s, 1, { r: 4, c: 4, o: 'v' }), 'crossing wall rejected');
  check(canPlaceWall(s, 1, { r: 4, c: 6, o: 'h' }), 'adjacent non-overlapping wall ok');
}

// --- jump checks ---
{
  const s = initialState();
  s.pawns[0] = { r: 4, c: 4 };
  s.pawns[1] = { r: 3, c: 4 };
  const moves = pawnMoves(s, 0);
  check(moves.some(m => m.r === 2 && m.c === 4), 'straight jump over adjacent opponent');
  check(!moves.some(m => m.r === 3 && m.c === 4), 'cannot land on opponent');
  // wall behind opponent forces diagonal jumps
  s.walls.push({ r: 2, c: 4, o: 'h' });
  const moves2 = pawnMoves(s, 0);
  check(!moves2.some(m => m.r === 2 && m.c === 4), 'straight jump blocked by wall');
  check(moves2.some(m => m.r === 3 && m.c === 3), 'diagonal jump left available');
  check(moves2.some(m => m.r === 3 && m.c === 5), 'diagonal jump right available');
}

// --- full-block prevention ---
{
  const s = initialState();
  s.pawns[0] = { r: 8, c: 0 };
  s.walls.push({ r: 7, c: 0, o: 'h' }, { r: 7, c: 2, o: 'h' }, { r: 7, c: 4, o: 'h' }, { r: 7, c: 6, o: 'h' });
  // wall v at (7,7) would seal the whole bottom row corridor for player 0
  const sealed = { r: 7, c: 7, o: 'v' };
  const before = hasPath([...s.walls, sealed], s.pawns[0], goalRow(0));
  check(canPlaceWall(s, 1, sealed) === before, 'wall legality matches path existence');
}

// --- AI self-play ---
const GAMES = 30;
let done = 0;
for (let g = 0; g < GAMES; g++) {
  const s = initialState();
  let moves = 0;
  while (s.winner === null && moves < 400) {
    const mv = aiMove(s);
    const ok = applyMove(s, mv);
    check(ok, `AI produced illegal move at move ${moves}: ${JSON.stringify(mv)}`);
    if (!ok) break;
    check(hasPath(s.walls, s.pawns[0], goalRow(0)), 'player 0 path preserved');
    check(hasPath(s.walls, s.pawns[1], goalRow(1)), 'player 1 path preserved');
    moves++;
  }
  check(s.winner !== null, `game ${g} finished (moves=${moves})`);
  if (s.winner !== null) done++;
}
console.log(`Self-play: ${done}/${GAMES} games finished, failures: ${failures}`);
process.exit(failures ? 1 : 0);
