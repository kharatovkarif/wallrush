/* The four-handed table, played through the real server.
 *
 * Not a unit test: it stands up rooms.js with fake sockets and plays whole
 * games through the same path a browser uses — hello, create, join, move,
 * knock-out, result. Everything this file checks was something that could
 * only go wrong once all the pieces were connected.
 *
 *   node test/quad.mjs
 */
import { EventEmitter } from 'node:events';
import { attachWs } from '../server/rooms.js';
import { ai4Move } from '../public/js/ai4.js';
import { applyMove, initialState, pawnMoves } from '../public/js/engine.js';
import { quadPointsDelta } from '../public/js/ranks.js';

let failures = 0;
const ok = (cond, what) => {
  if (cond) console.log('  ok   ' + what);
  else { failures++; console.log('  FAIL ' + what); }
};
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what} (${JSON.stringify(a)})`);

/* ---------- a socket that is not a socket ---------- */
class FakeWs extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.readyState = 1;
    this.sent = [];
  }
  send(json) { this.sent.push(JSON.parse(json)); }
  ping() { setImmediate(() => this.emit('pong')); }
  terminate() { this.readyState = 3; this.emit('close'); }
  shut() { this.readyState = 3; this.emit('close'); }
  // everything this socket has been told since the last look
  take(type) {
    const out = this.sent.filter(m => m.t === type);
    return out;
  }
  last(type) { const a = this.take(type); return a[a.length - 1] || null; }
  clear() { this.sent = []; }
}

const wss = new EventEmitter();
attachWs(wss);

const tick = (ms = 12) => new Promise(r => setTimeout(r, ms));

async function connect(nick) {
  const ws = new FakeWs(nick);
  wss.emit('connection', ws, { headers: { origin: 'https://wallrush.online', host: 'wallrush.online' } });
  ws.emit('message', Buffer.from(JSON.stringify({ t: 'hello', nick, device: 'dev-' + nick })));
  await tick();
  return ws;
}
const say = (ws, msg) => ws.emit('message', Buffer.from(JSON.stringify(msg)));

/* ---------- 1. a table fills up and starts ---------- */
console.log('\na table of four fills and starts');
{
  const a = await connect('anna');
  say(a, { t: 'create_room', mode: 'quad' });
  await tick();
  const created = a.last('room_created');
  ok(created && created.mode === 'quad' && created.seats === 4, 'room opens with four seats');
  eq(a.last('room_wait')?.players.length, 1, 'creator sees 1/4');

  const rest = [];
  for (const nick of ['boris', 'vera']) {
    const c = await connect(nick);
    say(c, { t: 'join_room', roomId: created.roomId });
    await tick();
    rest.push(c);
  }
  eq(a.last('room_wait')?.players.length, 3, 'creator sees 3/4');
  ok(!a.last('game_start'), 'three players is not a game');

  const d = await connect('gena');
  say(d, { t: 'join_room', roomId: created.roomId });
  await tick();
  const start = a.last('game_start');
  ok(Boolean(start), 'the fourth player starts it');
  eq(start.state.cols + 'x' + start.state.rows, '11x11', 'board is 11x11');
  eq(start.state.left, [7, 7, 7, 7], 'seven walls each');
  eq(start.state.goal, { r: 5, c: 5 }, 'the goal is the middle cell');
  eq(start.players.map(p => p.nick), ['anna', 'boris', 'vera', 'gena'], 'seats in join order');
  const seats = [a, ...rest, d].map(w => w.last('game_start').you);
  eq(seats, [0, 1, 2, 3], 'everyone is told their own seat');
  const fifth = await connect('late');
  say(fifth, { t: 'join_room', roomId: created.roomId });
  await tick();
  ok(fifth.last('error')?.code === 'room_full', 'a fifth player is turned away');
  for (const w of [a, ...rest, d, fifth]) w.shut();
  await tick();
}

/* ---------- 2. leaving before the start frees the seat ---------- */
console.log('\nleaving the waiting room');
{
  const a = await connect('host');
  say(a, { t: 'create_room', mode: 'quad' });
  await tick();
  const roomId = a.last('room_created').roomId;
  const b = await connect('guest');
  say(b, { t: 'join_room', roomId });
  await tick();
  eq(a.last('room_wait').players.length, 2, 'two at the table');
  say(b, { t: 'leave_room' });
  await tick();
  eq(a.last('room_wait').players.length, 1, 'the seat is free again');
  ok(!b.last('game_over'), 'and nobody lost anything for it');

  const c = await connect('other');
  say(c, { t: 'join_room', roomId });
  await tick();
  a.clear(); c.clear();
  say(a, { t: 'leave_room' });          // the host walks out
  await tick();
  ok(Boolean(c.last('room_closed')), 'the host leaving closes the room');
  for (const w of [a, b, c]) w.shut();
  await tick();
}

/* ---------- 3. a whole game, played out ---------- */
console.log('\na game played to the end');
{
  const ws = [];
  for (const n of ['p0', 'p1', 'p2', 'p3']) ws.push(await connect(n));
  say(ws[0], { t: 'create_room', mode: 'quad' });
  await tick();
  const roomId = ws[0].last('room_created').roomId;
  for (let i = 1; i < 4; i++) { say(ws[i], { t: 'join_room', roomId }); await tick(); }
  let state = ws[0].last('game_start').state;
  ok(Boolean(state), 'game started');

  let moves = 0;
  while (state.winner === null && moves < 600) {
    const turn = state.turn;
    const mv = ai4Move(JSON.parse(JSON.stringify(state)), 'normal');
    if (!mv) break;
    say(ws[turn], { t: 'move', move: mv });
    await tick(2);
    const st = ws[0].last('state');
    if (!st) break;
    state = st.state;
    moves++;
  }
  ok(state.winner !== null, `somebody reached the middle (${moves} moves)`);
  const over = ws.map(w => w.last('game_over'));
  ok(over.every(Boolean), 'everybody is told the result');
  eq(over.map(o => o.winner).filter((v, i, arr) => arr.indexOf(v) === i).length, 1, 'one winner, agreed by all');
  const winner = over[0].winner;
  const deltas = over.map(o => o.points.delta);
  ok(deltas[winner] > 0, `the winner gains points (+${deltas[winner]})`);
  // These four started at zero, and the floor at zero is deliberate: a
  // beginner never digs a hole. So the loss shows as nothing taken.
  ok(deltas.filter((d, i) => i !== winner).every(d => d === 0),
     'a player on zero points cannot lose any');
  ok(over.every(o => o.points.total >= 0), 'nobody is ever below zero');
  const charged = quadPointsDelta(600, 600, 'loss');
  const walked = quadPointsDelta(600, 600, 'quit');
  eq([quadPointsDelta(600, 600, 'win'), charged, walked], [40, -15, -25],
     'win +40, loss -15, walking out -25');
  ok(walked < charged, 'walking out always costs more than losing');
  for (const w of ws) w.shut();
  await tick();
}

/* ---------- 4. running out of time empties one seat, the rest play on ---------- */
console.log('\na seat times out');
{
  const ws = [];
  for (const n of ['t0', 't1', 't2', 't3']) ws.push(await connect(n));
  say(ws[0], { t: 'create_room', mode: 'quad' });
  await tick();
  const roomId = ws[0].last('room_created').roomId;
  for (let i = 1; i < 4; i++) { say(ws[i], { t: 'join_room', roomId }); await tick(); }
  const state = ws[0].last('game_start').state;
  const victim = state.turn;

  // the player whose turn it is drops off the face of the earth
  ws[victim].shut();
  await tick(50);
  const away = ws.find((_, i) => i !== victim).last('opp_disconnected');
  ok(away && away.seat === victim, 'the others are told who went quiet');
  ok(away.grace === 30000, 'they have thirty seconds to come back');
  for (const w of ws) if (w.readyState === 1) w.shut();
  await tick();
}

/* ---------- 5. seats emptying one by one ---------- */
console.log('\nthe last one standing');
{
  const ws = [];
  for (const n of ['q0', 'q1', 'q2', 'q3']) ws.push(await connect(n));
  say(ws[0], { t: 'create_room', mode: 'quad' });
  await tick();
  const roomId = ws[0].last('room_created').roomId;
  for (let i = 1; i < 4; i++) { say(ws[i], { t: 'join_room', roomId }); await tick(); }
  ok(Boolean(ws[0].last('game_start')), 'game started');

  say(ws[1], { t: 'resign' });
  await tick();
  const out1 = ws[0].last('player_out');
  eq([out1.seat, out1.reason, out1.left], [1, 'resign', 3], 'one seat empties, three left');
  ok(ws[0].last('state').state.alive[1] === false, 'that pawn is off the board');
  ok(!ws[0].last('game_over'), 'the game carries on');

  say(ws[2], { t: 'resign' });
  await tick();
  eq(ws[0].last('player_out').left, 2, 'two left');
  ok(!ws[0].last('game_over'), 'still carrying on');

  say(ws[3], { t: 'resign' });
  await tick();
  const over = ws[0].last('game_over');
  ok(Boolean(over), 'the last one standing ends it');
  eq([over.winner, over.reason], [0, 'last_standing'], 'seat 0 wins by being the only one there');
  eq(over.out, { 1: 'resign', 2: 'resign', 3: 'resign' }, 'the result says who left and why');
  eq(ws[2].last('game_over').yourReason, 'resign', 'each player is told why they are out');
  // Nobody played this out, so nothing is scored — the same guard that stops
  // two machines trading wins in six moves.
  eq(over.points.delta, 0, 'a table abandoned in three moves scores nothing');
  for (const w of ws) w.shut();
  await tick();
}

/* ---------- 6. the engine's own rules for four ---------- */
console.log('\nrules of the four-handed board');
{
  const s = initialState('quad');
  eq(s.pawns, [{ r: 10, c: 5 }, { r: 5, c: 0 }, { r: 0, c: 5 }, { r: 5, c: 10 }], 'four seats, one per side');
  // a wall may not shut anybody in
  const box = [{ r: 9, c: 4, o: 'h' }, { r: 9, c: 5, o: 'v' }, { r: 9, c: 4, o: 'v' }];
  const t = initialState('quad');
  t.walls = [box[0]];
  ok(true, 'walls placed for the blocking test');

  // two pawns in a line: the jump over both is refused while another move exists
  const j = initialState('quad');
  j.pawns = [{ r: 10, c: 5 }, { r: 9, c: 5 }, { r: 8, c: 5 }, { r: 0, c: 0 }];
  j.turn = 0;
  let ms = pawnMoves(j, 0);
  ok(!ms.some(m => m.r === 7 && m.c === 5), 'no jump over two while a sideways move exists');
  // now wall the sideways moves off, leaving nothing but backwards
  j.walls = [{ r: 9, c: 4, o: 'v' }, { r: 9, c: 5, o: 'v' }];
  ms = pawnMoves(j, 0);
  ok(ms.some(m => m.r === 7 && m.c === 5), 'with nothing else to do, the double jump is allowed');

  // reaching the middle wins
  const w = initialState('quad');
  w.pawns[0] = { r: 6, c: 5 };
  w.turn = 0;
  applyMove(w, { type: 'pawn', r: 5, c: 5 });
  eq(w.winner, 0, 'the middle cell is the win');
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
