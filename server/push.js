// Web push: the only way to reach a player who has closed the game.
//
// Two rules shape everything here. Permission can be asked exactly once — a
// refusal is permanent and cannot be undone by us — so the client asks late,
// after someone has played enough to want it. And nobody gets more than one
// notification a day, sent in their own evening, because the fastest way to
// lose a subscriber is to be noisy.
import webpush from 'web-push';
import { dbEnabled, supa } from './db.js';

const SUBJECT = 'mailto:support@wallrush.online';
let publicKey = null;
let ready = false;

// The keypair is generated once and kept in the database, so a redeploy never
// invalidates existing subscriptions and no secret has to be pasted into the
// hosting panel by hand.
export async function initPush() {
  if (!dbEnabled) return;
  try {
    const { data } = await supa.from('app_settings').select('key, value')
      .in('key', ['vapid_public', 'vapid_private']);
    const map = new Map((data || []).map(r => [r.key, r.value]));
    let pub = map.get('vapid_public');
    let priv = map.get('vapid_private');
    if (!pub || !priv) {
      const keys = webpush.generateVAPIDKeys();
      pub = keys.publicKey;
      priv = keys.privateKey;
      await supa.from('app_settings').upsert([
        { key: 'vapid_public', value: pub },
        { key: 'vapid_private', value: priv },
      ]);
      console.log('push: generated a new VAPID keypair');
    }
    webpush.setVapidDetails(SUBJECT, pub, priv);
    publicKey = pub;
    ready = true;
    console.log('push: ready');
  } catch (e) {
    console.error('push init failed:', e.message);
  }
}

export function pushPublicKey() { return publicKey; }

export async function saveSub(sub, { deviceId, tzOffset, lang }) {
  if (!dbEnabled || !sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return false;
  try {
    await supa.from('push_subs').upsert({
      endpoint: sub.endpoint,
      device_id: deviceId,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      tz_offset: Number.isFinite(tzOffset) ? tzOffset : 0,
      lang: lang || null,
      fails: 0,
    }, { onConflict: 'endpoint' });
    return true;
  } catch (e) {
    console.error('saveSub failed:', e.message);
    return false;
  }
}

export async function dropSub(endpoint) {
  if (!dbEnabled || !endpoint) return;
  try { await supa.from('push_subs').delete().eq('endpoint', endpoint); } catch { /* ignore */ }
}

// A 404 or 410 from the push service means the browser threw the subscription
// away — that one is dead for good. Anything else may be temporary, so the row
// is kept and only retired after it has failed repeatedly.
async function deliver(row, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      JSON.stringify(payload),
      { TTL: 6 * 3600 },
    );
    await supa.from('push_subs')
      .update({ last_sent: new Date().toISOString(), fails: 0 })
      .eq('endpoint', row.endpoint);
    return true;
  } catch (e) {
    const code = e?.statusCode;
    if (code === 404 || code === 410) {
      await dropSub(row.endpoint);
    } else {
      await supa.from('push_subs').update({ fails: (row.fails || 0) + 1 }).eq('endpoint', row.endpoint);
      if ((row.fails || 0) + 1 >= 5) await dropSub(row.endpoint);
    }
    return false;
  }
}

// What the message says is decided per person and only from things that are
// true for them. "Everyone is waiting for you" would be a lie; "your streak
// ends in three hours" is not, and it is the reason they would come back.
const TEXTS = {
  ru: {
    streak: (d) => ({ title: `🔥 Серия ${d} ${plural(d, 'день', 'дня', 'дней')} под угрозой`, body: 'Одна партия сегодня — и серия продолжится.' }),
    online: (n) => ({ title: `⚡ Сейчас онлайн ${n}`, body: 'Соперник найдётся за пару секунд.' }),
  },
  en: {
    streak: (d) => ({ title: `🔥 Your ${d}-day streak is about to end`, body: 'One match today keeps it alive.' }),
    online: (n) => ({ title: `⚡ ${n} players online right now`, body: 'A match starts in seconds.' }),
  },
};

function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}

const textsFor = (lang) => TEXTS[String(lang || '').slice(0, 2)] || TEXTS.en;

// Pure decision: given a subscriber, what they have done, and the moment,
// decide whether to write to them and what to say. Kept apart from the
// sending so it can be reasoned about and tested on its own.
export function pickMessage(sub, visitor, now, onlineNow) {
  const local = new Date(now - (sub.tz_offset || 0) * 60000);
  const hour = local.getUTCHours();
  if (hour < 19 || hour >= 21) return null;              // not their evening
  const today = local.toISOString().slice(0, 10);
  const yesterday = new Date(local.getTime() - 86400e3).toISOString().slice(0, 10);
  const T = textsFor(sub.lang);

  if (visitor?.streak_day === today) return null;        // already played today
  if (visitor && visitor.streak > 0 && visitor.streak_day === yesterday) {
    return { ...T.streak(visitor.streak), url: '/?go=quick' };
  }
  return { ...T.online(onlineNow), url: '/?go=quick' };
}

// Runs hourly. Picks the people for whom it is currently early evening, whose
// streak is alive but not yet extended today, and who have not been messaged
// in the last 20 hours.
export async function pushTick(onlineNow) {
  if (!ready || !dbEnabled) return;
  try {
    const now = Date.now();
    const cutoff = new Date(now - 20 * 3600e3).toISOString();
    const { data: subs } = await supa.from('push_subs')
      .select('endpoint, device_id, p256dh, auth, tz_offset, lang, fails, last_sent')
      .or(`last_sent.is.null,last_sent.lt.${cutoff}`)
      .limit(2000);
    if (!subs?.length) return;

    // only those whose local clock is in the evening window
    const evening = subs.filter((s) => {
      const local = new Date(now - (s.tz_offset || 0) * 60000);
      const h = local.getUTCHours();
      return h >= 19 && h < 21;
    });
    if (!evening.length) return;

    const { data: rows } = await supa.from('visitors')
      .select('device_id, streak, streak_day')
      .in('device_id', evening.map(s => s.device_id));
    const byDevice = new Map((rows || []).map(r => [r.device_id, r]));

    let sent = 0;
    for (const s of evening) {
      const payload = pickMessage(s, byDevice.get(s.device_id), now, onlineNow);
      if (!payload) continue;
      if (await deliver(s, payload)) sent++;
      if (sent >= 400) break;                    // gentle on the free tier
    }
    if (sent) console.log(`push: sent ${sent} notifications`);
  } catch (e) {
    console.error('pushTick failed:', e.message);
  }
}
