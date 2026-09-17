/* The write queue.
 *
 * Counters that used to go out one request at a time now wait a few seconds
 * and travel together. This is what took the database down on 17 September —
 * eleven requests a second, around the clock — so what holds here matters:
 * nothing sent twice, nothing lost while a flush is in flight, one player's
 * games added up into one row, and a database that has been away unable to
 * turn into a burst when it returns.
 *
 *   node test/queue.mjs
 */
import { _setDbForTest, logVisitLater, noteMatchLater, bumpDayLater,
         flushWrites, queueStatus } from '../server/queue.js';

let failures = 0;
const ok = (c, w) => { if (c) console.log('  ok   ' + w); else { failures++; console.log('  FAIL ' + w); } };

let sent = [];
let hold = null;            // set to a promise to keep a flush in flight
let fail = false;
const fakeDb = {
  dbEnabled: true,
  mskDay: () => '2026-09-17',
  dayKeyOf: (p) => (p.isBot ? 'b:' + p.nick : p.userId ? 'u:' + p.userId : p.deviceId ? 'd:' + p.deviceId : null),
  supa: {
    from: (table) => ({
      insert: async (rows) => { if (hold) await hold; if (fail) throw new Error('db away'); sent.push({ table, rows }); return {}; },
    }),
    rpc: async (name, args) => { if (hold) await hold; if (fail) throw new Error('db away'); sent.push({ rpc: name, args }); return {}; },
  },
};
_setDbForTest(fakeDb);
const reset = () => { sent = []; hold = null; fail = false; };

console.log('\none request instead of many');
{
  reset();
  for (let i = 0; i < 250; i++) logVisitLater('dev-' + i, i % 5 === 0 ? 'game' : 'visit');
  for (let i = 0; i < 90; i++) noteMatchLater(i % 3 === 0 ? 'quad' : 'duel');
  ok(queueStatus().visitsHeld === 250, '250 visits are held, not sent');
  await flushWrites();
  const visitCalls = sent.filter(s => s.table === 'visit_log');
  const matchCalls = sent.filter(s => s.table === 'human_matches');
  ok(visitCalls.length === 1, `250 visits went out as ${visitCalls.length} request`);
  ok(visitCalls[0].rows.length === 250, 'with all 250 rows in it');
  ok(matchCalls.length === 1 && matchCalls[0].rows.length === 90, '90 matches went as one request');
  ok(queueStatus().visitsHeld === 0, 'and the buffer is empty afterwards');
}

console.log('\na player playing fast is one row, not five');
{
  reset();
  const ann = { nick: 'Ann', userId: 'u1' };
  bumpDayLater(ann, 40, 'win');
  bumpDayLater(ann, 40, 'win');
  bumpDayLater(ann, -15, 'loss');
  bumpDayLater({ nick: 'Bob', deviceId: 'd9' }, 25, 'win');
  ok(queueStatus().dayRowsHeld === 2, 'four games by two people are two rows');
  await flushWrites();
  const rows = sent.filter(s => s.rpc === 'day_points').map(s => s.args);
  ok(rows.length === 2, `sent as ${rows.length} calls, not 4`);
  const a = rows.find(r => r.w === 'u:u1');
  ok(a.dp === 65 && a.win === 2 && a.loss === 1, `Ann's evening added up: ${a.dp} points, ${a.win} wins, ${a.loss} loss`);
  ok(rows.find(r => r.w === 'd:d9').k === 'guest', 'a guest is recorded as a guest');
}

console.log('\na name changed mid-day follows the player');
{
  reset();
  bumpDayLater({ nick: 'OldName', userId: 'u2' }, 10, 'win');
  bumpDayLater({ nick: 'NewName', userId: 'u2' }, 10, 'win');
  await flushWrites();
  const r = sent.find(s => s.rpc === 'day_points').args;
  ok(r.n === 'NewName' && r.dp === 20, 'one row, the newer name, both wins');
}

console.log('\nnothing is lost while a flush is in flight');
{
  reset();
  logVisitLater('dev-a');
  let release;
  hold = new Promise(r => { release = r; });
  const inFlight = flushWrites();
  logVisitLater('dev-b');          // arrives mid-flush
  logVisitLater('dev-c');
  release();
  await inFlight;
  ok(sent.filter(s => s.table === 'visit_log')[0].rows.length === 1, 'the first flush sent only what it took');
  ok(queueStatus().visitsHeld === 2, 'and the two that arrived meanwhile are still held');
  hold = null;
  await flushWrites();
  const all = sent.filter(s => s.table === 'visit_log').flatMap(s => s.rows.map(r => r.device_id));
  ok(JSON.stringify(all) === JSON.stringify(['dev-a', 'dev-b', 'dev-c']), 'all three arrive, each exactly once');
}

console.log('\ntwo flushes at once do not send the same row twice');
{
  reset();
  for (let i = 0; i < 10; i++) logVisitLater('d' + i);
  let release;
  hold = new Promise(r => { release = r; });
  const a = flushWrites();
  const b = flushWrites();        // the timer firing on top of a slow flush
  release();
  await Promise.all([a, b]);
  const rows = sent.filter(s => s.table === 'visit_log').flatMap(s => s.rows);
  ok(rows.length === 10, `10 rows went out, not ${rows.length}`);
}

console.log('\na database that has been away cannot become a burst');
{
  reset();
  fail = true;
  for (let i = 0; i < 40; i++) logVisitLater('x' + i);
  await flushWrites();
  ok(queueStatus().lastError === 'db away', 'the failure is remembered');
  ok(queueStatus().visitsHeld === 0, 'the failed batch is dropped, not queued up to retry');
  fail = false;
  logVisitLater('after');
  await flushWrites();
  const rows = sent.filter(s => s.table === 'visit_log').flatMap(s => s.rows);
  ok(rows.length === 1 && rows[0].device_id === 'after', 'and the next flush is just the new one');

  // the hard cap, for an outage that lasts
  for (let i = 0; i < 5000; i++) logVisitLater('flood-' + i);
  ok(queueStatus().visitsHeld <= 4000, `held at ${queueStatus().visitsHeld}, capped at 4000`);
  ok(queueStatus().dropped > 0, 'and the overflow is counted rather than hidden');
  await flushWrites();
}

console.log('\nnothing without an identity is written');
{
  reset();
  logVisitLater('', 'visit');
  logVisitLater(null);
  bumpDayLater({ nick: 'Ghost' }, 40, 'win');     // no account, no device
  bumpDayLater({ nick: 'Ann', userId: 'u1' }, 0, null);
  const s = queueStatus();
  ok(s.visitsHeld === 0 && s.dayRowsHeld === 0, 'a visit with no device and a player with no id are skipped');
}

console.log(failures ? `\n${failures} FAILURES` : '\nall good');
process.exit(failures ? 1 : 0);
