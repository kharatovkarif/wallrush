// Premium: what each lava.top event does, without a database.
import assert from 'node:assert/strict';
import { addPeriod, planFromAmount, decide, secretMatches, isPremium } from '../server/premium.js';

const t0 = new Date('2026-11-13T10:00:00Z');

// periods
assert.equal(addPeriod(t0, 'month').toISOString(), '2026-12-13T10:00:00.000Z');
assert.equal(addPeriod(t0, 'year').toISOString(), '2027-11-13T10:00:00.000Z');

// a payment from lava.top's own page: the amount tells the plan
assert.equal(planFromAmount(5, 'USD'), 'month');
assert.equal(planFromAmount(29.99, 'USD'), 'year');
assert.equal(planFromAmount(414, 'RUB'), 'month');
assert.equal(planFromAmount(2490, 'RUB'), 'year');
assert.equal(planFromAmount(990, 'RUB'), 'year');
assert.equal(planFromAmount(149, 'RUB'), 'month');

// first payment starts from now
let d = decide('payment.success', { plan: 'month', now: t0 });
assert.equal(d.action, 'extend');
assert.equal(d.paidUntil.toISOString(), '2026-12-13T10:00:00.000Z');

// a renewal that arrives early extends from the end of what was paid, not from now
d = decide('subscription.recurring.payment.success', { plan: 'month', paidUntil: '2026-12-13T10:00:00Z', now: new Date('2026-12-12T10:00:00Z') });
assert.equal(d.paidUntil.toISOString(), '2027-01-13T10:00:00.000Z');

// a renewal after a lapse starts again from now
d = decide('subscription.recurring.payment.success', { plan: 'month', paidUntil: '2026-12-13T10:00:00Z', now: new Date('2027-02-01T00:00:00Z') });
assert.equal(d.paidUntil.toISOString(), '2027-03-01T00:00:00.000Z');

// cancel and failed charges change nothing by themselves; money back revokes
assert.equal(decide('subscription.cancelled').action, 'note');
assert.equal(decide('payment.failed').action, 'note');
assert.equal(decide('subscription.recurring.payment.failed').action, 'note');
assert.equal(decide('payment.refund.success').action, 'revoke');
assert.equal(decide('payment.chargeback').action, 'revoke');

// the webhook secret
assert.equal(secretMatches('abc', 'abc'), true);
assert.equal(secretMatches(' abc ', 'abc'), true);
assert.equal(secretMatches('abd', 'abc'), false);
assert.equal(secretMatches('ab', 'abc'), false);
assert.equal(secretMatches('', ''), false);       // no secret set: nobody gets in
assert.equal(secretMatches(undefined, 'abc'), false);

assert.equal(isPremium(null), false);
assert.equal(isPremium('2099-01-01T00:00:00Z'), true);
assert.equal(isPremium('2000-01-01T00:00:00Z'), false);

console.log('premium: all checks passed');
import { pricesIn } from '../server/premium.js';
const offers = [
  { id: 'A', prices: [{ currency: 'USD', periodicity: 'MONTHLY', amount: 5 }, { currency: 'USD', periodicity: 'PERIOD_YEAR', amount: 39.99 }] },
  { id: 'B', prices: [{ currency: 'RUB', periodicity: 'MONTHLY', amount: 149 }, { currency: 'RUB', periodicity: 'PERIOD_YEAR', amount: 990 }] },
];
assert.deepEqual(pricesIn(offers, 'RUB'), { month: 149, monthOffer: 'B', year: 990, yearOffer: 'B' });
assert.deepEqual(pricesIn(offers, 'USD'), { month: 5, monthOffer: 'A', year: 39.99, yearOffer: 'A' });
assert.deepEqual(pricesIn(offers, 'EUR'), {});
console.log('premium prices: ok');
import { hookKeyFrom, hookBody } from '../server/premium.js';
assert.equal(hookKeyFrom({ 'x-api-key': 'k1' }), 'k1');
assert.equal(hookKeyFrom({ authorization: 'Bearer k2' }), 'k2');
assert.equal(hookKeyFrom({ authorization: 'k3' }), 'k3');
assert.equal(hookKeyFrom({ 'api-key': 'k4' }), 'k4');
assert.equal(hookKeyFrom({}), '');
assert.deepEqual(hookBody('{"eventType":"payment.success"}'), { eventType: 'payment.success' });
assert.deepEqual(hookBody({ a: 1 }), { a: 1 });
assert.equal(hookBody('not json')._raw, 'not json');
console.log('premium webhook parsing: ok');
import { needsReminder, chargeText } from '../server/premium.js';
{
  const now = Date.parse('2027-11-06T12:00:00Z');
  const base = { plan: 'year', status: 'active', paid_until: '2027-11-13T11:00:00Z', reminded_for: null };
  assert.equal(needsReminder(base, now), true, 'a year ending in 7 days gets a reminder');
  assert.equal(needsReminder({ ...base, paid_until: '2027-11-20T00:00:00Z' }, now), false, 'not two weeks ahead');
  assert.equal(needsReminder({ ...base, plan: 'month' }, now), false, 'months are not reminded');
  assert.equal(needsReminder({ ...base, status: 'renew_off' }, now), false, 'nothing will be charged');
  assert.equal(needsReminder({ ...base, status: 'cancelled' }, now), false, 'nothing will be charged');
  assert.equal(needsReminder({ ...base, reminded_for: base.paid_until }, now), false, 'only once per period');
  assert.equal(needsReminder({ ...base, reminded_for: '2026-11-13T13:26:00Z' }, now), true, 'last year\'s reminder does not count');
  assert.equal(needsReminder({ ...base, paid_until: '2027-11-01T00:00:00Z' }, now), false, 'already past');
  assert.equal(chargeText({ amount: 39.99, currency: 'USD' }), '$39.99');
  assert.equal(chargeText({ amount: 990, currency: 'RUB' }), '990 ₽');
  console.log('premium reminders: ok');
}
