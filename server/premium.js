/* Premium, paid through lava.top.

   The money never touches this server. A player taps a plan, we ask lava.top
   for an invoice in their account's email and send them to the payment page
   it returns. lava.top then tells us what happened by calling
   /api/premium/lava, and that call — not the browser coming back — is what
   switches premium on. A browser can claim anything; the webhook carries the
   secret only lava.top and Railway know.

   One row per contract in premium_contracts: the invoice we created (or a
   renewal lava.top reports), whose it is and what it has paid for. A player's
   profile carries only the answer, premium_until, because that is what every
   screen asks: is this person premium right now.

   Every event is written to premium_events before it is acted on, keyed by
   (event, contract). lava.top retries a webhook it did not get a 200 for, and
   a "paid" seen twice must not buy a second month. */

import { timingSafeEqual } from 'node:crypto';
import { supa, dbEnabled } from './db.js';

const GATE = 'https://gate.lava.top';
const PERIOD = { month: 'MONTHLY', year: 'PERIOD_YEAR' };
// A renewal is charged on the day the period ends and can take a while to
// clear; two days of slack keeps a paying player from flickering out of
// premium overnight.
const GRACE_MS = 2 * 86400_000;

const apiKey = () => (process.env.LAVA_API_KEY || '').trim();
const hookSecret = () => (process.env.LAVA_WEBHOOK_SECRET || '').trim();
export const premiumConfigured = () => Boolean(apiKey());

/* ---------- pure parts (tested in test/premium.mjs) ---------- */

export function addPeriod(from, plan) {
  const d = new Date(from);
  if (plan === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

// The plan an event paid for when no contract of ours says so: a payment
// lava.top took on its own page rather than through our invoice. A year costs
// several months, so anything well above one month's price is a year.
export function planFromAmount(amount, currency) {
  const n = Number(amount) || 0;
  const month = currency === 'RUB' ? 400 : 7;
  return n > month * 2 ? 'year' : 'month';
}

/* What an event does, decided without the database:
     extend — paid: the contract runs to `paidUntil`
     revoke — money went back: premium ends now
     note   — worth recording, changes nothing (a failed charge, a cancel:
              a cancelled subscription still runs to the end of what was paid) */
export function decide(eventType, { paidUntil = null, plan = 'month', now = new Date() } = {}) {
  const t = String(eventType || '');
  if (t === 'payment.success' || t === 'subscription.recurring.payment.success') {
    const base = paidUntil && new Date(paidUntil) > now ? new Date(paidUntil) : now;
    return { action: 'extend', paidUntil: addPeriod(base, plan) };
  }
  if (/refund|chargeback/i.test(t)) return { action: 'revoke' };
  return { action: 'note' };
}

export function secretMatches(given, expected) {
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given.trim());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ---------- lava.top API ---------- */

async function gate(path, { method = 'GET', body } = {}) {
  const r = await fetch(GATE + path, {
    method,
    headers: { 'X-Api-Key': apiKey(), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: r.ok, status: r.status, json, text: text.slice(0, 300) };
}

/* The subscription's offers, found by name rather than pasted into the code:
   the owner made them in the lava.top cabinet, and if one is ever recreated
   the game keeps working without anyone touching Railway. Prices can sit in
   one offer in several currencies or in separate offers (one in dollars, one
   in roubles); either way the game asks for the offer that has the price. */
let offerCache = { at: 0, offers: null };
async function premiumOffers() {
  if (offerCache.offers && Date.now() - offerCache.at < 3600_000) return offerCache.offers;
  const r = await gate('/api/v2/products?showAllSubscriptionPeriods=true');
  if (!r.ok) throw new Error(`products ${r.status} ${r.text}`);
  const items = (r.json?.items || []).map(i => i.data || i);
  const subs = items.filter(p => p && Array.isArray(p.offers) && p.offers.length);
  let mine = subs.filter(p => /wallrush/i.test(p.title || '') || p.offers.some(o => /wallrush/i.test(o.name || '')));
  if (!mine.length) mine = subs.filter(p => p.type === 'SUBSCRIPTION');
  const offers = mine.flatMap(p => p.offers);
  if (!offers.length) throw new Error('no premium offer in lava.top');
  offerCache = { at: Date.now(), offers };
  return offers;
}

// {month, year} in one currency, plus which offer carries each
export function pricesIn(offers, currency) {
  const out = {};
  for (const o of offers) for (const p of o.prices || []) {
    if (p.currency !== currency) continue;
    const plan = p.periodicity === 'MONTHLY' ? 'month' : p.periodicity === 'PERIOD_YEAR' ? 'year' : null;
    if (plan && out[plan] === undefined) { out[plan] = p.amount; out[plan + 'Offer'] = o.id; }
  }
  return out;
}

export const CURRENCIES = ['USD', 'RUB'];

export async function offerPrices(currency = 'USD') {
  const offers = await premiumOffers();
  const want = pricesIn(offers, currency);
  if (want.month !== undefined || want.year !== undefined) return { currency, month: want.month, year: want.year };
  const usd = pricesIn(offers, 'USD');
  return { currency: 'USD', month: usd.month, year: usd.year };
}

export async function createCheckout({ userId, email, plan, currency = 'USD' }) {
  if (!PERIOD[plan]) return { error: 'bad_plan' };
  const offers = await premiumOffers();
  let cur = CURRENCIES.includes(currency) ? currency : 'USD';
  let pr = pricesIn(offers, cur);
  if (!pr[plan + 'Offer']) { cur = 'USD'; pr = pricesIn(offers, cur); }
  if (!pr[plan + 'Offer']) return { error: 'plan_unavailable' };
  const body = {
    email,
    offerId: pr[plan + 'Offer'],
    currency: cur,
    periodicity: PERIOD[plan],
    // the owner wants the payment page in English for everyone
    buyerLanguage: 'EN',
  };
  let r = await gate('/api/v3/invoice', { method: 'POST', body });
  if (r.status === 404 || r.status === 405) r = await gate('/api/v2/invoice', { method: 'POST', body });
  if (!r.ok || !r.json?.paymentUrl) {
    console.error('[premium] invoice failed', r.status, r.text);
    return { error: r.status === 400 ? 'plan_unavailable' : 'pay_failed' };
  }
  const id = String(r.json.id || r.json.contractId || '');
  if (id) {
    await supa.from('premium_contracts').upsert({
      contract_id: id, user_id: userId, email: email.toLowerCase(), plan, status: 'new',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'contract_id' });
  }
  return { url: r.json.paymentUrl };
}

/* ---------- webhook ---------- */

async function userByEmail(email) {
  if (!email) return null;
  const { data } = await supa.rpc('find_auth_user', { p_email: email });
  const u = Array.isArray(data) ? data[0] : data;
  if (!u?.id) return null;
  const { data: prof } = await supa.from('profiles').select('id').eq('id', u.id).maybeSingle();
  return prof?.id || null;
}

// premium_until is the latest paid_until across the player's contracts, plus
// grace — recomputed rather than nudged, so a refund on one contract cannot
// cancel what another one paid for, and a replayed event cannot stack.
export async function refreshUser(userId) {
  if (!userId) return null;
  const { data } = await supa.from('premium_contracts')
    .select('paid_until, status').eq('user_id', userId).not('paid_until', 'is', null);
  let best = 0;
  for (const c of data || []) {
    if (c.status === 'refunded') continue;
    // slack only for a subscription that is about to renew itself; one that
    // will not ends at the exact minute it was paid until
    const slack = c.status === 'active' || c.status === 'past_due' ? GRACE_MS : 0;
    best = Math.max(best, new Date(c.paid_until).getTime() + slack);
  }
  const until = best ? new Date(best).toISOString() : null;
  await supa.from('profiles').update({ premium_until: until }).eq('id', userId);
  return until;
}

export async function handleWebhook(headers, body) {
  if (!secretMatches(headers['x-api-key'] || '', hookSecret())) return { status: 401 };
  const ev = body || {};
  const type = String(ev.eventType || '');
  const contractId = String(ev.contractId || '');
  if (!type || !contractId) return { status: 400 };
  const email = String(ev.buyer?.email || '').toLowerCase();

  // first sight of this (event, contract) or a retry of one already handled
  const { error: dup } = await supa.from('premium_events').insert({
    event_type: type, contract_id: contractId, email,
    amount: ev.amount ?? null, currency: ev.currency ?? null, payload: ev,
  });
  if (dup) {
    if (dup.code === '23505') return { status: 200, outcome: 'duplicate' };
    throw new Error(dup.message);
  }

  // whose is it: our invoice, the subscription it renews, or the email
  const parentId = ev.parentContractId ? String(ev.parentContractId) : null;
  const ids = [contractId, parentId].filter(Boolean);
  const { data: known } = await supa.from('premium_contracts')
    .select('contract_id, user_id, plan, paid_until').in('contract_id', ids);
  const own = (known || []).find(c => c.contract_id === contractId);
  const parent = (known || []).find(c => c.contract_id === parentId);
  const root = parent || own;
  const userId = root?.user_id || await userByEmail(email);
  const plan = root?.plan || planFromAmount(ev.amount, ev.currency);

  /* A new purchase made while premium is still running starts after it, not
     today: buying a second month on day 20 must give 20 + 30 days, not 30. */
  let base = root?.paid_until || null;
  if (userId && /payment\.success$/.test(type)) {
    const { data: mine } = await supa.from('premium_contracts').select('paid_until, status')
      .eq('user_id', userId).not('paid_until', 'is', null).neq('status', 'refunded')
      .order('paid_until', { ascending: false }).limit(1);
    const latest = mine?.[0]?.paid_until;
    if (latest && (!base || latest > base)) base = latest;
  }
  const d = decide(type, { paidUntil: base, plan });
  const now = new Date().toISOString();
  const rootId = root?.contract_id || contractId;

  if (d.action === 'extend') {
    await supa.from('premium_contracts').upsert({
      contract_id: rootId, user_id: userId, email, plan,
      status: 'active', paid_until: d.paidUntil.toISOString(), updated_at: now,
    }, { onConflict: 'contract_id' });
  } else if (d.action === 'revoke') {
    await supa.from('premium_contracts').update({ status: 'refunded', updated_at: now })
      .eq('contract_id', rootId);
  } else if (/cancel/i.test(type)) {
    await supa.from('premium_contracts').update({ status: 'cancelled', updated_at: now })
      .eq('contract_id', rootId);
  } else if (/failed/i.test(type) && root) {
    await supa.from('premium_contracts').update({ status: root.paid_until ? 'past_due' : 'failed', updated_at: now })
      .eq('contract_id', rootId);
  }

  const until = userId ? await refreshUser(userId) : null;
  const outcome = `${d.action}${userId ? '' : ':no_user'}`;
  await supa.from('premium_events').update({ outcome })
    .eq('event_type', type).eq('contract_id', contractId);
  console.log(`[premium] ${type} ${contractId} → ${outcome}${until ? ' until ' + until : ''}`);
  return { status: 200, outcome };
}

/* A payment made before the account existed, or under an email the webhook
   could not match at the time, waits in premium_contracts with no owner. The
   first time that email signs in, it is theirs. */
export async function claimByEmail(userId, email) {
  if (!dbEnabled || !userId || !email) return;
  const { data } = await supa.from('premium_contracts')
    .update({ user_id: userId }).is('user_id', null).eq('email', email.toLowerCase())
    .select('contract_id');
  if (data?.length) await refreshUser(userId);
}

export const isPremium = (until, now = Date.now()) => Boolean(until && new Date(until).getTime() > now);

/* The subscription that is paying for this player right now, and whether it
   will renew. "Renews" is what the profile shows next to the date. */
export async function premiumState(userId) {
  if (!dbEnabled || !userId) return null;
  const { data } = await supa.from('premium_contracts')
    .select('contract_id, email, status, paid_until').eq('user_id', userId)
    .not('paid_until', 'is', null).neq('status', 'refunded')
    .order('paid_until', { ascending: false }).limit(1);
  const c = data?.[0];
  if (!c) return null;
  return { contractId: c.contract_id, email: c.email, paidUntil: c.paid_until,
    renews: c.status === 'active' || c.status === 'past_due' };
}

/* Turning off auto-renewal from inside the game. lava.top stops charging;
   premium stays until the end of what was already paid, exactly as when the
   buyer cancels from lava.top's own email. Their webhook arrives as well and
   says the same thing. */
export async function cancelRenewal(userId) {
  const st = await premiumState(userId);
  if (!st) return { error: 'no_subscription' };
  if (!st.renews) return { ok: true, already: true };
  const q = new URLSearchParams({ contractId: st.contractId, email: st.email });
  const r = await gate('/api/v1/subscriptions?' + q, { method: 'DELETE' });
  if (!r.ok) {
    console.error('[premium] cancel failed', r.status, r.text);
    return { error: 'cancel_failed' };
  }
  await supa.from('premium_contracts').update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('contract_id', st.contractId);
  console.log(`[premium] renewal cancelled from the game ${st.contractId}`);
  return { ok: true };
}
