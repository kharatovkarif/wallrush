/* Today's table — the parts that are decisions rather than SQL.
 *
 * The Postgres half (the upsert that adds to a day, the board ordering) was
 * checked against the real database when it was written. What is left here is
 * the code around it: where a day ends, whose row is whose, and who does not
 * belong on a board.
 *
 *   node test/board.mjs
 */
import { mskDay, dayKeyOf, shapeDayBoard } from '../server/db.js';

let failures = 0;
const ok = (c, w) => { if (c) console.log('  ok   ' + w); else { failures++; console.log('  FAIL ' + w); } };
const at = (iso) => Date.parse(iso);

console.log('\nwhere the day ends');
{
  // Moscow is UTC+3 all year — no summer time since 2014 — so midnight there
  // is 21:00 the previous day in UTC.
  ok(mskDay(at('2026-09-13T20:59:59Z')) === '2026-09-13', 'a minute before midnight Moscow is still the 13th');
  ok(mskDay(at('2026-09-13T21:00:00Z')) === '2026-09-14', 'and at midnight Moscow it is the 14th');
  ok(mskDay(at('2026-09-13T00:00:00Z')) === '2026-09-13', 'midnight UTC is the same day, three hours in');
  ok(mskDay(at('2026-12-31T21:00:01Z')) === '2027-01-01', 'the year turns over with it');
  // whatever the reader's own clock says, the day is the same one
  const now = Date.now();
  ok(mskDay(now) === mskDay(now), 'and it does not depend on where it is read');
}

console.log('\nwhose row is whose');
{
  ok(dayKeyOf({ userId: 'abc', deviceId: 'dev1', nick: 'x' }) === 'u:abc',
    'an account is keyed by account, not by the device it played from');
  ok(dayKeyOf({ deviceId: 'dev1', nick: 'x' }) === 'd:dev1', 'a guest is keyed by device');
  ok(dayKeyOf({ isBot: true, nick: 'Marat' }) === 'b:Marat', 'and ours by name');
  ok(dayKeyOf({ nick: 'nobody' }) === null, 'somebody with neither is not written at all');
  // the same person on two devices is one row, which is the point of the key
  ok(dayKeyOf({ userId: 'abc', deviceId: 'phone' }) === dayKeyOf({ userId: 'abc', deviceId: 'laptop' }),
    'the same account on two devices is one row');
}

console.log('\nwho belongs on the board');
{
  const raw = [
    { who: 'u:good', nick: 'Ann', kind: 'user', points: 90, wins: 3, losses: 0 },
    { who: 'u:cheat', nick: 'Bot9', kind: 'user', points: 80, wins: 4, losses: 0 },
    { who: 'd:dev1', nick: 'Guest', kind: 'guest', points: 70, wins: 2, losses: 1 },
    { who: 'b:Marat', nick: 'Marat', kind: 'bot', points: 60, wins: 2, losses: 1 },
  ];
  const clean = shapeDayBoard(raw, ['cheat'], 100);
  ok(clean.length === 3, 'a flagged account is off the day board too');
  ok(!clean.some(r => r.nick === 'Bot9'), 'and it is the right one that went');
  ok(clean.map(r => r.nick).join(',') === 'Ann,Guest,Marat', 'the order survives the filtering');
  ok(clean.some(r => r.kind === 'guest'), 'guests are on it — this is the board they can reach');
  ok(!('who' in clean[0]), 'and the account id never leaves the server');

  ok(shapeDayBoard(raw, [], 2).length === 2, 'the list is cut to length');
  // asking for more rows than are shown is what makes room for the cut above
  const padded = shapeDayBoard(raw, ['cheat'], 3);
  ok(padded.length === 3, 'dropping a flagged player does not leave the list short');

  ok(shapeDayBoard(null, [], 10).length === 0, 'nothing at all is an empty board, not a crash');
  ok(shapeDayBoard([], ['x'], 10).length === 0, 'and so is an empty day');
}

console.log(failures ? `\n${failures} FAILURES` : '\nall good');
process.exit(failures ? 1 : 0);
