/* The arithmetic behind the video of a finished game.
 *
 * Nothing here draws anything — the picture was checked by looking at it. What
 * is checked here is what a picture will not tell you: that the board fits the
 * frame whatever shape it is, that a long game is shortened instead of running
 * for two minutes, and that the clip shows the right position at the right
 * moment. The first of these was a real bug: the board was drawn against a
 * fixed 640px square, so the race board — taller than it is wide — ran off the
 * bottom of the video.
 *
 *   node test/clip.mjs
 */
import {
  W, H, SLOT_Y, SLOT_W, SLOT_H, LEAD_MS, END_MS, MOVE_ANIM,
  SLOT_MAX, BUDGET_MS, LONG_AFTER, TAIL_MOVES, TAIL_SLOT, HEAD_MS,
  geometry, buildTimeline, frameState, spin, spinWall, dedupeHistory,
} from '../public/js/clipmath.js';

let failures = 0;
const ok = (cond, what) => {
  if (cond) console.log('  ok   ' + what);
  else { failures++; console.log('  FAIL ' + what); }
};

/* ---------- 1. the board fits, whatever its shape ---------- */
console.log('\nthe board fits the frame');
for (const [name, cols, rows] of [['duel 9x9', 9, 9], ['four-handed 11x11', 11, 11], ['race 9x13', 9, 13]]) {
  const g = geometry(cols, rows);
  ok(g.bw <= SLOT_W + 0.01 && g.bh <= SLOT_H + 0.01, `${name}: inside its slot`);
  ok(g.bx >= 0 && g.bx + g.bw <= W, `${name}: not off the side`);
  ok(g.by >= 0 && g.by + g.bh <= H, `${name}: not off the bottom`);
  ok(Math.abs(g.bx - (W - g.bw) / 2) < 0.01, `${name}: centred`);
  // one cell plus one groove, repeated, must come to the whole board
  const across = g.pad * 2 + cols * g.u + (cols - 1) * g.g;
  ok(Math.abs(across - g.bw) < 0.01, `${name}: the cells add up to the width`);
}

/* ---------- 2. how long it runs ---------- */
console.log('\nthe length of the clip');
{
  const short = buildTimeline(new Array(5).fill({}));      // 4 moves
  ok(short.slot === SLOT_MAX, `a short game is not stretched (${short.slot}ms a move)`);

  /* A long game: the opening fast-forwards and the end plays properly. The
     even pace this replaced turned 140 moves into 45 seconds of a pawn jumping
     three times a second. */
  for (const moves of [60, 140, 400]) {
    const long = buildTimeline(new Array(moves + 1).fill({}));
    ok(long.total <= 30_000, `${moves} moves still fit in half a minute (${(long.total / 1000).toFixed(1)}s)`);
    ok(long.slots.slice(-TAIL_MOVES).every(v => v === TAIL_SLOT),
       `${moves} moves: the last ${TAIL_MOVES} play at a watchable pace`);
    ok(long.fast === moves - TAIL_MOVES && long.speedup > 1,
       `${moves} moves: the opening fast-forwards (×${long.speedup})`);
  }
  const edge = buildTimeline(new Array(LONG_AFTER + 1).fill({}));
  ok(edge.fast === 0, `${LONG_AFTER} moves is still played at one even pace`);
  const head = buildTimeline(new Array(141).fill({}));
  ok(Math.abs(head.starts[head.fast] - LEAD_MS - HEAD_MS) < head.fast,
     'the whole fast part takes the time it was given');

  const middling = buildTimeline(new Array(41).fill({}));  // 40 moves
  ok(Math.abs(middling.steps * middling.slot - BUDGET_MS) < middling.slot,
     `forty moves land on the budget (${Math.round(middling.steps * middling.slot / 1000)}s of ${BUDGET_MS / 1000}s)`);
  ok(middling.total === LEAD_MS + middling.steps * middling.slot + END_MS,
     'the opening pause and the result are counted in');

  const nothing = buildTimeline([{}]);
  ok(nothing.steps === 0 && nothing.total > 0, 'a game with no moves still has a length');
}

/* ---------- 3. what is on screen when ---------- */
console.log('\nthe right position at the right moment');
{
  const history = [{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }];
  const art = { history, time: buildTimeline(history) };
  const { slot } = art.time;

  const opening = frameState(art, 0);
  ok(opening.base.n === 0 && opening.p === 0, 'it opens on the first position, before anything moves');

  const firstMove = frameState(art, LEAD_MS + 1);
  ok(firstMove.base.n === 0 && firstMove.next.n === 1, 'the first move is between positions 0 and 1');

  // ...to within a rounding error: the fraction is arrived at by dividing and
  // multiplying by the same slot length, which does not always come back whole
  const walked = frameState(art, LEAD_MS + MOVE_ANIM);
  ok(walked.p > 0.999, 'a pawn has finished walking after its animation, not at the end of the slot');
  const midWalk = frameState(art, LEAD_MS + MOVE_ANIM / 2);
  ok(midWalk.p > 0.45 && midWalk.p < 0.55, 'and is halfway across halfway through it');

  const later = frameState(art, LEAD_MS + slot * 2 + 5);
  ok(later.base.n === 2 && later.next.n === 3, 'the third move is between positions 2 and 3');

  const ending = frameState(art, art.time.total);
  ok(ending.base.n === 3 && ending.next.n === 3 && ending.done, 'it ends on the last position and stays there');

  const past = frameState(art, art.time.total * 3);
  ok(past.base.n === 3, 'and cannot run off the end of the history');
}

console.log('\nfast-forward still shows every move');
{
  const history = Array.from({ length: 141 }, (_, n) => ({ n }));
  const art = { history, time: buildTimeline(history) };
  let seen = new Set();
  for (let ms = 0; ms <= art.time.total; ms += 5) seen.add(frameState(art, ms).next.n);
  ok(seen.size === 141, `every one of the 141 positions is on screen at some point (${seen.size})`);
  const inFast = frameState(art, art.time.starts[10] + 1);
  ok(inFast.i === 10 && inFast.base.n === 10, 'mid-fast-forward it is between the right two positions');
  const done = frameState(art, art.time.starts[art.time.fast] - 1);
  ok(done.p > 0.9, 'a fast move has finished walking before the next one starts');
}

console.log('\nthe same position twice is not a pause');
{
  const a = { pawns: [{ r: 8, c: 4 }, { r: 0, c: 4 }], walls: [], turn: 0 };
  const b = { pawns: [{ r: 7, c: 4 }, { r: 0, c: 4 }], walls: [], turn: 1 };
  const c = { pawns: [{ r: 7, c: 4 }, { r: 0, c: 4 }], walls: [{}], turn: 0 };
  const out = dedupeHistory([a, a, b, b, b, null, c, c]);
  ok(out.length === 3 && out[0] === a && out[1] === b && out[2] === c, 'repeats are dropped, order kept');
  ok(dedupeHistory([a, b, a]).length === 3, 'a position that comes back later is kept — that is a real move');
}

/* ---------- 4. the board is turned, not mirrored ---------- */
console.log('\nturning the board the way the player saw it');
{
  const n = 9;
  let same = true;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const back = spin(r, c, 4, n);
      if (back.r !== r || back.c !== c) same = false;
    }
  }
  ok(same, 'four quarter turns of a cell come back to where they started');

  const w = { r: 2, c: 5, o: 'h' };
  const round = spinWall(w, 4, n - 1);
  ok(round.r === w.r && round.c === w.c && round.o === w.o, 'and of a wall, orientation included');

  const quarter = spinWall(w, 1, n - 1);
  ok(quarter.o === 'v', 'one quarter turn lays a flat wall on its side');

  // a corner has to land in the next corner round, or the board is mirrored
  const corner = spin(0, 0, 1, n);
  ok(corner.r === 0 && corner.c === n - 1, 'the top-left corner turns into the top-right one');
}

console.log(failures ? `\n${failures} FAILURES` : '\nall good');
process.exit(failures ? 1 : 0);
