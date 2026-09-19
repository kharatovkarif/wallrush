/* The flame, asked about once a day instead of once a game.
 *
 * Twenty games in an evening used to mean twenty calls to the database, and
 * nineteen of them could only repeat what the first had said. Now the first
 * goes through and the rest are answered from memory — which is only safe if
 * the celebration still happens exactly once, the day still rolls over at the
 * player's own midnight, and getting a lost streak back is still noticed.
 *
 *   node test/streak.mjs
 */
let failures = 0;
const ok = (c, w) => { if (c) console.log('  ok   ' + w); else { failures++; console.log('  FAIL ' + w); } };

process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'sb_secret_stub_for_tests';

const db = await import('../server/db.js');

// count the calls that would have gone to the database
let calls = [];
let answer = { streak: 5, best: 9, advanced: true, froze: false };
db.supa.rpc = async (name, args) => { calls.push({ name, args }); return { data: [answer] }; };
const reset = () => { calls = []; };

const ann = { userId: 'u-ann' };
const guest = { deviceId: 'd-guest' };

console.log('\ntwenty games in one evening');
{
  reset();
  const first = await db.touchStreak(ann, '2026-09-19');
  ok(calls.length === 1, 'the first game of the day asks the database');
  ok(first.streak === 5 && first.advanced === true, 'and gets the real answer, celebration included');

  for (let i = 0; i < 19; i++) await db.touchStreak(ann, '2026-09-19');
  ok(calls.length === 1, `nineteen more games asked it ${calls.length - 1} more times`);

  const later = await db.touchStreak(ann, '2026-09-19');
  ok(later.streak === 5 && later.best === 9, 'the number stays right all evening');
  ok(later.advanced === false, 'but the flame only celebrates once');
  ok(later.froze === false, 'and a saved streak is only announced once');
}

console.log('\nmidnight, in the player’s own timezone');
{
  reset();
  answer = { streak: 6, best: 9, advanced: true, froze: false };
  const next = await db.touchStreak(ann, '2026-09-20');
  ok(calls.length === 1, 'a new day asks again');
  ok(next.streak === 6 && next.advanced === true, 'and the flame grows');
  reset();
  await db.touchStreak(ann, '2026-09-20');
  ok(calls.length === 0, 'and then goes quiet again for that day');
}

console.log('\none player does not answer for another');
{
  reset();
  answer = { streak: 1, best: 1, advanced: true, froze: false };
  const g = await db.touchStreak(guest, '2026-09-20');
  ok(calls.length === 1, 'a guest on the same day is asked about separately');
  ok(g.streak === 1, 'and gets their own number, not somebody else’s');
}

console.log('\ngetting a lost streak back is noticed');
{
  reset();
  answer = { streak: 6, best: 9, advanced: false, froze: false };
  await db.touchStreak(ann, '2026-09-20');
  ok(calls.length === 0, 'the day is still remembered');
  db.forgetStreak(ann);            // what restoreStreak does
  answer = { streak: 12, best: 12, advanced: false, froze: true };
  const back = await db.touchStreak(ann, '2026-09-20');
  ok(calls.length === 1, 'after a restore the database is asked again');
  ok(back.streak === 12, 'and the restored number is the one shown');
}

console.log('\nan account and a device are told apart');
{
  reset();
  // the same person, once signed in and once not, must not share an answer
  answer = { streak: 3, best: 3, advanced: true, froze: false };
  await db.touchStreak({ userId: 'u-x', deviceId: 'd-x' }, '2026-09-21');
  await db.touchStreak({ deviceId: 'd-x' }, '2026-09-21');
  ok(calls.length === 2, 'signed in and signed out are two different players here');
}

console.log(failures ? `\n${failures} FAILURES` : '\nall good');
process.exit(failures ? 1 : 0);
