/* The clock under abuse.
 *
 * A player reported that an opponent about to lose could leave and come back
 * over and over, and that each return handed them a fresh thirty seconds — so
 * the game never moved. This file reproduces that through the real server with
 * fake sockets, and then holds the fix to it.
 *
 * The windows are shortened for the suite (_setClocksForTest); the rules being
 * checked are the same ones the running server applies.
 *
 *   node test/clock.mjs
 */
import { EventEmitter } from 'node:events';
import { attachWs, _setClocksForTest, moveGrace } from '../server/rooms.js';
import { pawnMoves } from '../public/js/engine.js';

let failures = 0;
const ok = (cond, what) => {
  if (cond) console.log('  ok   ' + what);
  else { failures++; console.log('  FAIL ' + what); }
};

// 1.2s a move, 400ms to come back, 1s of being away per game in total.
const MOVE = 1200, GRACE = 400, BUDGET = 1000;
_setClocksForTest({ moveMs: MOVE, graceMs: GRACE, budgetMs: BUDGET });

class FakeWs extends EventEmitter {
  constructor(name) { super(); this.name = name; this.readyState = 1; this.sent = []; }
  send(json) { this.sent.push(JSON.parse(json)); }
  ping() { setImmediate(() => this.emit('pong')); }
  shut() { this.readyState = 3; this.emit('close'); }
  take(t) { return this.sent.filter(m => m.t === t); }
  last(t) { const a = this.take(t); return a[a.length - 1] || null; }
  clear() { this.sent = []; }
}

const wss = new EventEmitter();
attachWs(wss);
const tick = (ms = 25) => new Promise(r => setTimeout(r, ms));
const say = (ws, msg) => ws.emit('message', Buffer.from(JSON.stringify(msg)));

async function connect(nick, token) {
  const ws = new FakeWs(nick);
  wss.emit('connection', ws, { headers: { origin: 'https://wallrush.online', host: 'wallrush.online' } });
  say(ws, { t: 'hello', nick, device: 'dev-' + nick, ...(token ? { token } : {}) });
  await tick();
  return ws;
}

// Two players at a private table (private so nothing touches the ladder), with
// no bank — the thirty-second move rule is then the only clock, which is the
// one being abused.
async function table() {
  const a = await connect('ann');
  say(a, { t: 'create_room', code: 'TEST' + Math.random().toString(36).slice(2, 6).toUpperCase(), noTime: true });
  await tick();
  const made = a.last('room_created');
  const b = await connect('bob');
  say(b, { t: 'join_room', roomId: made.roomId });
  await tick(40);
  const sa = a.last('game_start'), sb = b.last('game_start');
  if (!sa || !sb) throw new Error('the game did not start: ' + JSON.stringify(a.sent.map(m => m.t)));
  // whoever is on move is the one who can stall
  const mover = sa.state.turn === sa.you ? a : b;
  const waiter = mover === a ? b : a;
  return { a, b, mover, waiter, tokens: { [a.name]: a.last('hello_ok').token, [b.name]: b.last('hello_ok').token } };
}

const clocksOf = (ws) => {
  for (let i = ws.sent.length - 1; i >= 0; i--) if (ws.sent[i].clocks) return ws.sent[i].clocks;
  return null;
};

/* ---------- 1. leaving and coming back does not buy a new move ---------- */
console.log('\nthe stall: drop out, come back, repeat');
{
  const { mover, waiter, tokens } = await table();
  let token = tokens[mover.name];
  let spent = 0;
  let back = mover;
  for (let round = 1; round <= 3; round++) {
    await tick(250);              // think for a quarter second
    back.shut();                  // ...then pull the plug
    await tick(200);              // ...and hang about, but come back in time
    back = await connect(back.name, token);
    await tick(30);
    const ck = clocksOf(back) || clocksOf(waiter);
    ok(ck && ck.moveSpent > spent,
      `round ${round}: the move is ${Math.round(ck.moveSpent)}ms old, not back to zero`);
    spent = ck ? ck.moveSpent : spent;
    token = back.last('hello_ok').token;
  }
  ok(spent >= 700, `three rounds of it spent ${Math.round(spent)}ms of one 1200ms move`);
  ok(!waiter.last('game_over'), 'and the player who stayed has not lost on time');
  back.shut(); waiter.shut();
  await tick(GRACE + 120);
}

/* ---------- 2. the move still runs out, stall or no stall ---------- */
console.log('\nthe move still ends');
{
  const { mover, waiter, tokens } = await table();
  const token = tokens[mover.name];
  await tick(700);
  mover.shut();
  await tick(150);
  const again = await connect(mover.name, token);
  await tick(30);
  waiter.clear();
  // ~850ms of a 1200ms move is gone; sitting still must cost them the rest,
  // plus the round trip the server allows every move on top of the limit
  await tick(MOVE - 700 + moveGrace(0) + 250);
  ok(Boolean(waiter.last('game_over')), 'the stalled move times out on schedule');
  const over = waiter.last('game_over');
  ok(over && over.reason !== 'goal', `and it is a timeout (${over && over.reason})`);
  again.shut(); waiter.shut();
  await tick(GRACE + 120);
}

const waitForOver = async (ws) => {
  for (let i = 0; i < 60; i++) { await tick(15); const o = ws.last('game_over'); if (o) return o; }
  return null;
};

/* ---------- 3. being away has a budget, and it runs out ---------- */
console.log('\nthe allowance for being away');
{
  // First, what a whole window is worth to somebody who has spent nothing:
  // drop once, never come back, and time how long the others are made to wait.
  let fullWindow = 0;
  {
    const t0 = await table();
    const at = Date.now();
    t0.mover.shut();
    ok(Boolean(await waitForOver(t0.waiter)), 'a first drop, never returned from, ends the game');
    fullWindow = Date.now() - at;
    ok(fullWindow >= GRACE, `and it made them wait the whole ${GRACE}ms window (${fullWindow}ms)`);
    t0.waiter.shut();
    await tick(GRACE + 120);
  }

  const { mover, waiter, tokens } = await table();
  let token = tokens[mover.name];
  let back = mover;
  const waiterSeat = waiter.last('game_start').you;
  const away = GRACE - 150;                       // most of a window, then back
  const rounds = Math.floor(BUDGET / away) - 1;   // comfortably inside the budget

  for (let i = 1; i <= rounds; i++) {
    back.shut();
    await tick(away);
    back = await connect(back.name, token);
    await tick(30);
    ok(!waiter.last('game_over'), `drop ${i} of ${rounds} is forgiven`);
    token = back.last('hello_ok').token;
  }

  /* Most of the allowance is gone, so the next drop must not buy another
     whole window — that is the trick being stopped. Measured rather than
     asserted against a fixed wait, and compared with `fullWindow` below: the
     baseline is the same drop made by somebody who has spent nothing. */
  waiter.clear();
  const droppedAt = Date.now();
  back.shut();
  const over = await waitForOver(waiter);
  const waited = Date.now() - droppedAt;
  ok(Boolean(over), 'and then a drop ends the game');
  ok(waited < fullWindow - 80,
    `that drop was allowed ${waited}ms, against ${fullWindow}ms for a first one`);
  ok(over && over.winner === waiterSeat, 'and it is the player who stayed who wins it');
  waiter.shut();
  await tick(GRACE + 120);
}


/* ---------- 4. the honest case is untouched ---------- */
console.log('\nsomebody else losing their connection');
{
  const { mover, waiter, tokens } = await table();
  const token = tokens[waiter.name];
  await tick(600);                   // the mover has used half their move
  waiter.shut();                     // ...and the OTHER player drops
  await tick(150);
  const back = await connect(waiter.name, token);
  await tick(30);
  const ck = clocksOf(mover);
  ok(ck && ck.moveSpent === 0,
    'the player on move gets a whole move back — the drop was not theirs');
  ok(!mover.last('game_over'), 'and nobody lost while waiting');
  mover.shut(); back.shut();
  await tick(GRACE + 120);
}

/* ---------- 5. an ordinary game is not disturbed ---------- */
console.log('\nnothing dropped at all');
{
  const { a, b, mover, waiter } = await table();
  const ck = clocksOf(mover);
  ok(ck && ck.moveSpent === 0, 'a fresh move starts at zero');
  const me = mover.last('game_start');
  const [to] = pawnMoves(me.state, me.state.turn);
  say(mover, { t: 'move', move: { type: 'pawn', r: to.r, c: to.c } });
  await tick(40);
  const after = clocksOf(waiter);
  ok(!mover.last('error'), 'the move is accepted');
  ok(after && after.turn !== me.state.turn, 'and the turn passes');
  ok(after && after.moveSpent === 0, 'and the next move starts at zero too');
  a.shut(); b.shut();
  await tick(GRACE + 120);
}

console.log(failures ? `\n${failures} FAILURES` : '\nall good');
process.exit(failures ? 1 : 0);
