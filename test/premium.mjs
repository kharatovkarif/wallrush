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
