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
import { sendUserPush } from './push.js';

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

/* Roubles shown as dollars. The owner wants every price on screen in $,
   while a Russian card can only be charged in roubles — so the dollar figure
   is the rouble price at today's rate, and the rouble amount that will
   actually be charged is printed under it. Rate from a free public source,
   kept for 12 hours; if it cannot be reached the last good one is used, and
   with none at all the screen shows roubles rather than a made-up number. */
let rateCache = { at: 0, rates: null };
// units of each currency per one dollar
export async function usdRates() {
  if (rateCache.rates && Date.now() - rateCache.at < 12 * 3600_000) return rateCache.rates;
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const rub = Number(j?.rates?.RUB);
    if (rub > 10 && rub < 1000) rateCache = { at: Date.now(), rates: j.rates };
  } catch (e) { console.error('[premium] rate', e.message); }
  return rateCache.rates || null;
}
export async function usdRub() { return Number((await usdRates())?.RUB) || 0; }
export const rubToUsd = (rub, rate) => rate ? Math.round(rub / rate * 100) / 100 : null;

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

/* Every call lava.top makes is written down before anything is decided —
   including the ones turned away. The first real payment (13 Nov 2026) left
   no trace at all: a rejected call returned 401 or 400 and vanished. Header
   names are kept, never their values, so the secret is not stored. */
async function logHook(headers, body, status, reason) {
  try {
    await supa.from('premium_hooks').insert({
      status, reason, header_names: Object.keys(headers || {}), body: body ?? null,
    });
  } catch (e) { console.error('[premium] hook log failed', e.message); }
}

// the secret, wherever lava.top chose to put it
export function hookKeyFrom(headers = {}) {
  const h = (k) => String(headers[k] || '').trim();
  const auth = h('authorization').replace(/^(bearer|token|apikey|api-key)\s+/i, '');
  return h('x-api-key') || h('api-key') || h('apikey') || h('x-auth-token') || auth;
}

// a JSON body, even when it arrived as text
export function hookBody(raw) {
  if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  try { return JSON.parse(text); } catch { return { _raw: text.slice(0, 4000) }; }
}

export async function handleWebhook(headers, rawBody) {
  const ev = hookBody(rawBody);
  if (!secretMatches(hookKeyFrom(headers), hookSecret())) {
    await logHook(headers, ev, 401, hookSecret() ? 'bad_secret' : 'no_secret_set');
    return { status: 401 };
  }
  const type = String(ev.eventType || ev.event_type || ev.type || '');
  const contractId = String(ev.contractId || ev.contract_id || ev.invoiceId || ev.id || '');
  if (!type || !contractId) {
    await logHook(headers, ev, 400, 'no_type_or_contract');
    return { status: 400 };
  }
  await logHook(headers, ev, 200, 'accepted');
  return processEvent(ev, type, contractId);
}

/* One payment event, from the webhook or from asking lava.top directly
   (syncFromLava). Either way it goes through the same door, keyed by
   (event, contract), so the two routes can never count a payment twice. */
export async function processEvent(ev, type, contractId) {
  const email = String(ev.buyer?.email || ev.email || '').toLowerCase();

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
  // a period runs from when it was paid, not from when we heard about it
  const paidAt = Date.parse(ev.timestamp || ev.datetime || '');
  const at = Number.isFinite(paidAt) && paidAt < Date.now() ? new Date(paidAt) : new Date();
  const d = decide(type, { paidUntil: base, plan, now: at });
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
    .select('contract_id, email, status, paid_until, plan').eq('user_id', userId)
    .not('paid_until', 'is', null).neq('status', 'refunded')
    .order('paid_until', { ascending: false }).limit(1);
  const c = data?.[0];
  if (!c) return null;
  return { contractId: c.contract_id, email: c.email, paidUntil: c.paid_until, status: c.status, plan: c.plan,
    renews: c.status === 'active' || c.status === 'past_due',
    // switched off in the game but not yet cancelled at lava.top: one tap undoes it
    resumable: c.status === 'renew_off' };
}

/* Turning off auto-renewal from inside the game. lava.top stops charging;
   premium stays until the end of what was already paid, exactly as when the
   buyer cancels from lava.top's own email. Their webhook arrives as well and
   says the same thing. */
/* Auto-renewal as a switch the player can flip back.

   lava.top can cancel a subscription but cannot un-cancel one. So "off" in the
   game is only remembered (status renew_off) and the subscription is left
   alone until CANCEL_AHEAD before the next charge; only then does the server
   cancel it at lava.top (cancelDueRenewals, every 10 minutes with the sync).
   Until that moment "on" again costs nothing. Inside that window "off" goes
   to lava.top at once, because there may be no later run in time. */
const CANCEL_AHEAD = 2 * 86400_000;

async function cancelAtLava(contractId, email) {
  const q = new URLSearchParams({ contractId, email });
  const r = await gate('/api/v1/subscriptions?' + q, { method: 'DELETE' });
  if (!r.ok) {
    console.error('[premium] cancel failed', contractId, r.status, r.text);
    // kept where the admin page reads it: a player who switched renewal off
    // must not be charged, so a cancel lava.top refused has to be seen
    await logHook({}, { contractId, status: r.status, answer: r.json ?? r.text }, r.status, 'cancel_failed');
    return false;
  }
  await supa.from('premium_contracts').update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('contract_id', contractId);
  console.log(`[premium] cancelled at lava.top ${contractId}`);
  return true;
}

export async function cancelRenewal(userId) {
  const st = await premiumState(userId);
  if (!st) return { error: 'no_subscription' };
  if (!st.renews) return { ok: true, already: true };
  if (st.status === 'manual') return { ok: true, already: true };
  const left = new Date(st.paidUntil).getTime() - Date.now();
  if (left > CANCEL_AHEAD) {
    await supa.from('premium_contracts').update({ status: 'renew_off', updated_at: new Date().toISOString() })
      .eq('contract_id', st.contractId);
    console.log(`[premium] renewal switched off in the game ${st.contractId}`);
    return { ok: true, resumable: true };
  }
  return (await cancelAtLava(st.contractId, st.email)) ? { ok: true, resumable: false } : { error: 'cancel_failed' };
}

export async function resumeRenewal(userId) {
  const st = await premiumState(userId);
  if (!st) return { error: 'no_subscription' };
  if (st.renews) return { ok: true, already: true };
  if (!st.resumable) return { error: 'cannot_resume' };
  await supa.from('premium_contracts').update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('contract_id', st.contractId).eq('status', 'renew_off');
  await refreshUser(userId);
  console.log(`[premium] renewal switched back on ${st.contractId}`);
  return { ok: true };
}

// switched off in the game and the charge is near: now really cancel it
export async function cancelDueRenewals() {
  const soon = new Date(Date.now() + CANCEL_AHEAD + 15 * 60_000).toISOString();
  const { data } = await supa.from('premium_contracts').select('contract_id, email')
    .eq('status', 'renew_off').lte('paid_until', soon).limit(50);
  for (const c of data || []) await cancelAtLava(c.contract_id, c.email);
}

/* ---------- asking lava.top instead of waiting to be told ----------

   The first real payment (13 Nov 2026) never reached the webhook. So the game
   also asks: the list of completed invoices, every few minutes and whenever
   the admin opens the Premium page. Each one goes through processEvent like a
   webhook would, so whichever route sees a payment first wins and the other
   finds it already done. */
const DONE = new Set(['COMPLETED', 'SUCCESS', 'PAID']);
let lastSync = { at: 0, ok: null, found: 0, applied: 0, error: null };
export const syncState = () => ({ ...lastSync });

function invoiceItems(json) {
  if (Array.isArray(json)) return json;
  return json?.items || json?.content || json?.data || json?.invoices || [];
}

export async function syncFromLava({ sample = false } = {}) {
  if (!dbEnabled || !premiumConfigured()) return syncState();
  const out = { at: Date.now(), ok: false, found: 0, applied: 0, error: null };
  try {
    let items = [];
    const r = await gate('/api/v1/invoices?invoiceStatuses=COMPLETED&size=100&page=0');
    if (sample || !r.ok) await logHook({}, { status: r.status, sample: r.json ?? r.text }, r.status, 'sync_list');
    if (r.ok) items = invoiceItems(r.json);
    else {
      // no list: ask about each of our own invoices still waiting
      const since = new Date(Date.now() - 14 * 86400_000).toISOString();
      const { data: waiting } = await supa.from('premium_contracts').select('contract_id')
        .eq('status', 'new').gte('created_at', since).limit(200);
      for (const w of waiting || []) {
        const one = await gate('/api/v1/invoices/' + encodeURIComponent(w.contract_id));
        if (one.ok && one.json) items.push(one.json);
      }
    }
    const paid = items.filter(i => DONE.has(String(i.status || '').toUpperCase()))
      // only this game's subscription, should the account ever sell anything else
      // lava.top names the product "Subscription <id>" and puts our title in offer
      .filter(i => !i.product || /wallrush|premium|subscription/i.test(`${i.product.name || ''} ${i.product.offer || ''}`));
    out.found = paid.length;
    if (paid.length) {
      const ids = paid.map(i => String(i.id));
      const { data: seen } = await supa.from('premium_events').select('contract_id').in('contract_id', ids);
      const known = new Set((seen || []).map(x => x.contract_id));
      for (const i of paid) {
        const id = String(i.id);
        if (known.has(id)) continue;
        // the first payment of a subscription names itself as its own parent
        const pid = i.parentInvoice?.id || i.parentContractId || null;
        const parent = pid && String(pid) !== id ? String(pid) : null;
        const ev = {
          eventType: parent ? 'subscription.recurring.payment.success' : 'payment.success',
          contractId: id, parentContractId: parent,
          buyer: { email: i.buyer?.email || i.email || '' },
          amount: i.receipt?.amount ?? i.amount ?? null,
          currency: i.receipt?.currency ?? i.currency ?? null,
          timestamp: i.datetime || i.createdAt || null,
          source: 'sync', invoice: i,
        };
        const res = await processEvent(ev, ev.eventType, id);
        if (res.outcome && res.outcome !== 'duplicate') out.applied++;
      }
    }
    out.ok = true;
  } catch (e) {
    out.error = e.message;
    console.error('[premium] sync failed:', e.message);
  }
  try { await cancelDueRenewals(); } catch (e) { console.error('[premium] due cancels failed:', e.message); }
  try { await remindRenewals(); } catch (e) { console.error('[premium] reminders failed:', e.message); }
  lastSync = out;
  return syncState();
}

export function startPremiumSync() {
  if (!premiumConfigured()) return;
  // first look with a sample of what lava.top answers, then quietly every 10 min
  setTimeout(() => syncFromLava({ sample: true }), 20_000);
  setInterval(() => syncFromLava(), 10 * 60_000).unref?.();
}

/* ---------- a week's notice before a yearly charge ----------

   A year is long enough to forget a subscription exists, and several places
   require a reminder before an annual renewal. Seven days ahead the player is
   told, once per period: a notification if they have them on, and the same
   notice inside the game (the client reads premium_notice from /api/profile).
   reminded_for holds the paid_until it was sent for, so the next year gets its
   own reminder and a restart does not send this one twice. */
export const REMIND_AHEAD = 7 * 86400_000;

export function needsReminder(c, now = Date.now()) {
  if (!c || c.plan !== 'year') return false;
  if (c.status !== 'active' && c.status !== 'past_due') return false;
  const end = new Date(c.paid_until).getTime();
  if (!(end > now) || end - now > REMIND_AHEAD) return false;
  return !c.reminded_for || new Date(c.reminded_for).getTime() !== end;
}

const REMIND_TEXT = {
  ru: (d, p) => ({ title: '👑 Premium продлится через ' + d + ' дн.', body: `Спишется ${p} за год. Отключить автопродление можно в игре: Профиль → Premium.` }),
  en: (d, p) => ({ title: `👑 Premium renews in ${d} days`, body: `${p} for a year will be charged. You can turn auto-renewal off in the game: Profile → Premium.` }),
  es: (d, p) => ({ title: `👑 Premium se renueva en ${d} días`, body: `Se cobrarán ${p} por un año. Puedes desactivar la renovación en el juego: Perfil → Premium.` }),
  fr: (d, p) => ({ title: `👑 Premium se renouvelle dans ${d} jours`, body: `${p} pour un an seront prélevés. Tu peux désactiver le renouvellement dans le jeu : Profil → Premium.` }),
  tr: (d, p) => ({ title: `👑 Premium ${d} gün içinde yenileniyor`, body: `Bir yıllık ${p} tahsil edilecek. Otomatik yenilemeyi oyunda kapatabilirsin: Profil → Premium.` }),
  fa: (d, p) => ({ title: `👑 Premium تا ${d} روز دیگر تمدید می‌شود`, body: `${p} برای یک سال برداشت می‌شود. تمدید خودکار را در بازی خاموش کن: پروفایل ← Premium.` }),
};

// what the last charge on this subscription was, to name the amount
export async function lastCharge(email) {
  if (!email) return null;
  const { data } = await supa.from('premium_events').select('amount, currency')
    .eq('email', email.toLowerCase()).like('event_type', '%success').not('amount', 'is', null)
    .order('id', { ascending: false }).limit(1);
  const e = data?.[0];
  return e ? { amount: Number(e.amount), currency: e.currency } : null;
}
export const chargeText = (c) => !c ? '' : c.currency === 'RUB' ? `${Math.round(c.amount)} ₽` : `$${c.amount}`;

export async function remindRenewals() {
  const soon = new Date(Date.now() + REMIND_AHEAD).toISOString();
  const { data } = await supa.from('premium_contracts')
    .select('contract_id, user_id, email, plan, status, paid_until, reminded_for')
    .eq('plan', 'year').in('status', ['active', 'past_due']).lte('paid_until', soon).limit(100);
  for (const c of (data || []).filter(x => needsReminder(x))) {
    const days = Math.max(1, Math.ceil((new Date(c.paid_until).getTime() - Date.now()) / 86400_000));
    const price = chargeText(await lastCharge(c.email)) || 'the yearly price';
    const sent = c.user_id ? await sendUserPush(c.user_id, (l) => (REMIND_TEXT[l] || REMIND_TEXT.en)(days, price)) : 0;
    await supa.from('premium_contracts').update({ reminded_for: c.paid_until }).eq('contract_id', c.contract_id);
    console.log(`[premium] renewal reminder ${c.contract_id}: ${days} days, ${sent} device(s)`);
  }
}
