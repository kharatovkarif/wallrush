// Web push: the only way to reach a player who has closed the game.
//
// Two rules shape everything here. Permission can be asked exactly once — a
// refusal is permanent and cannot be undone by us — so the client asks late,
// after someone has played enough to want it. And nobody gets more than one
// notification a day, sent in their own evening, because the fastest way to
// lose a subscriber is to be noisy.
import webpush from 'web-push';
import { dbEnabled, supa } from './db.js';
import { I18N } from '../public/js/i18n.js';
import ES from '../public/js/lang/es.js';
import FA from '../public/js/lang/fa.js';
import FR from '../public/js/lang/fr.js';
import TR from '../public/js/lang/tr.js';
import { RANKS } from '../public/js/ranks.js';
import { taskForDay } from '../public/js/daily.js';
import { localDay } from '../public/js/streak.js';

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
async function deliver(row, payload, kind) {
  try {
    await webpush.sendNotification(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      JSON.stringify(payload),
      { TTL: 6 * 3600 },
    );
    await supa.from('push_subs')
      .update({ last_sent: new Date().toISOString(), fails: 0, last_kind: kind || null })
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
//
// There used to be two of these, and one of them — the number of people
// online — went to nine subscribers out of ten, every evening, forever. That
// is a message about the game rather than about the person reading it, and a
// line seen thirty evenings in a row stops being read at all. The rest of
// these are about them: their friend, their streak, their task, their rank.
const TEXTS = {
  ru: {
    friend: (nick) => ({ title: `🤝 ${nick} сейчас играет`, body: 'Позвать на партию?' }),
    streak: (d) => ({ title: `🔥 Серия ${d} ${plural(d, 'день', 'дня', 'дней')} под угрозой`, body: 'Одна партия сегодня — и серия продолжится.' }),
    streak2: (d) => ({ title: `🔥 ${d} ${plural(d, 'день', 'дня', 'дней')} подряд`, body: `Сделаешь ${d + 1}-й?` }),
    daily: (task) => ({ title: '🎯 Задача дня ещё не выполнена', body: `${task} — до полуночи успеешь.` }),
    rank: (name, n) => ({ title: `🏆 До звания «${name}» осталось ${n} ${plural(n, 'очко', 'очка', 'очков')}`, body: 'Пара побед — и ты там.' }),
    winback: (d) => ({ title: `👋 Тебя не было ${d} ${plural(d, 'день', 'дня', 'дней')}`, body: 'Соперники на месте. Возвращайся.' }),
    online: (n) => ({ title: `⚡ Сейчас онлайн ${n}`, body: 'Соперник найдётся за пару секунд.' }),
    online2: (n) => ({ title: '⚡ Партия за минуту', body: `Сейчас играют ${n} человек.` }),
  },
  en: {
    friend: (nick) => ({ title: `🤝 ${nick} is playing right now`, body: 'Call them into a game?' }),
    streak: (d) => ({ title: `🔥 Your ${d}-day streak is about to end`, body: 'One match today keeps it alive.' }),
    streak2: (d) => ({ title: `🔥 ${d} days in a row`, body: `Make it ${d + 1}?` }),
    daily: (task) => ({ title: '🎯 Today’s task is still open', body: `${task} — there is time before midnight.` }),
    rank: (name, n) => ({ title: `🏆 ${n} points to ${name}`, body: 'A couple of wins and you are there.' }),
    winback: (d) => ({ title: `👋 You have been away ${d} days`, body: 'The opponents are still here. Come back.' }),
    online: (n) => ({ title: `⚡ ${n} players online right now`, body: 'A match starts in seconds.' }),
    online2: (n) => ({ title: '⚡ A game in under a minute', body: `${n} people are playing right now.` }),
  },
  fa: {
    friend: (nick) => ({ title: `🤝 ${nick} همین حالا بازی می‌کند`, body: 'دعوتش کنی؟' }),
    streak: (d) => ({ title: `🔥 زنجیره ${d} روزه‌ات در خطر است`, body: 'یک بازی امروز و زنجیره ادامه پیدا می‌کند.' }),
    streak2: (d) => ({ title: `🔥 ${d} روز پیاپی`, body: `روز ${d + 1} را هم می‌سازی؟` }),
    daily: (task) => ({ title: '🎯 مأموریت امروز هنوز باز است', body: `${task} — تا نیمه‌شب وقت داری.` }),
    rank: (name, n) => ({ title: `🏆 ${n} امتیاز تا «${name}»`, body: 'دو برد و رسیدی.' }),
    winback: (d) => ({ title: `👋 ${d} روز نبودی`, body: 'حریف‌ها سر جایشان هستند. برگرد.' }),
    online: (n) => ({ title: `⚡ الان ${n} نفر آنلاین‌اند`, body: 'حریف در چند ثانیه پیدا می‌شود.' }),
    online2: (n) => ({ title: '⚡ یک بازی در کمتر از یک دقیقه', body: `الان ${n} نفر در حال بازی‌اند.` }),
  },
  es: {
    friend: (nick) => ({ title: `🤝 ${nick} está jugando ahora`, body: '¿Le invitas a una partida?' }),
    streak: (d) => ({ title: `🔥 Tu racha de ${d} días está por terminar`, body: 'Una partida hoy y sigue viva.' }),
    streak2: (d) => ({ title: `🔥 ${d} días seguidos`, body: `¿Haces el ${d + 1}?` }),
    daily: (task) => ({ title: '🎯 El reto de hoy sigue pendiente', body: `${task} — te da tiempo antes de medianoche.` }),
    rank: (name, n) => ({ title: `🏆 Te faltan ${n} puntos para ${name}`, body: 'Un par de victorias y ya está.' }),
    winback: (d) => ({ title: `👋 Llevas ${d} días sin aparecer`, body: 'Los rivales siguen aquí. Vuelve.' }),
    online: (n) => ({ title: `⚡ ${n} jugadores en línea ahora`, body: 'Encuentras rival en segundos.' }),
    online2: (n) => ({ title: '⚡ Una partida en menos de un minuto', body: `${n} personas están jugando ahora.` }),
  },
  fr: {
    friend: (nick) => ({ title: `🤝 ${nick} joue en ce moment`, body: 'Tu l’invites à une partie ?' }),
    streak: (d) => ({ title: `🔥 Ta série de ${d} jours va s’éteindre`, body: 'Une partie aujourd’hui et elle continue.' }),
    streak2: (d) => ({ title: `🔥 ${d} jours d’affilée`, body: `On fait le ${d + 1}e ?` }),
    daily: (task) => ({ title: '🎯 Le défi du jour n’est pas fait', body: `${task} — tu as jusqu’à minuit.` }),
    rank: (name, n) => ({ title: `🏆 ${n} points avant ${name}`, body: 'Deux victoires et c’est bon.' }),
    winback: (d) => ({ title: `👋 Ça fait ${d} jours`, body: 'Les adversaires sont toujours là. Reviens.' }),
    online: (n) => ({ title: `⚡ ${n} joueurs en ligne maintenant`, body: 'Un adversaire en quelques secondes.' }),
    online2: (n) => ({ title: '⚡ Une partie en moins d’une minute', body: `${n} personnes jouent en ce moment.` }),
  },
  tr: {
    friend: (nick) => ({ title: `🤝 ${nick} şu an oynuyor`, body: 'Bir maça çağırayım mı?' }),
    streak: (d) => ({ title: `🔥 ${d} günlük serin bitmek üzere`, body: 'Bugün bir maç, seri devam etsin.' }),
    streak2: (d) => ({ title: `🔥 ${d} gün üst üste`, body: `${d + 1}. günü de yapar mısın?` }),
    daily: (task) => ({ title: '🎯 Günün görevi hâlâ açık', body: `${task} — gece yarısına kadar vaktin var.` }),
    rank: (name, n) => ({ title: `🏆 ${name} rütbesine ${n} puan kaldı`, body: 'Birkaç galibiyet yeter.' }),
    winback: (d) => ({ title: `👋 ${d} gündür yoksun`, body: 'Rakipler burada. Geri dön.' }),
    online: (n) => ({ title: `⚡ Şu an ${n} oyuncu çevrimiçi`, body: 'Rakip birkaç saniyede bulunur.' }),
    online2: (n) => ({ title: '⚡ Bir dakikadan kısa sürede maç', body: `Şu an ${n} kişi oynuyor.` }),
  },
};

function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}

const textsFor = (lang) => TEXTS[String(lang || '').slice(0, 2)] || TEXTS.en;

// The game's own words, so a rank or a task reads in a notification exactly as
// it reads on screen.
const WORDS = { ...I18N, es: ES, fa: FA, fr: FR, tr: TR };
const word = (lang, key) => (WORDS[String(lang || '').slice(0, 2)] || WORDS.en)[key] || WORDS.en[key] || key;

/* Pure decision: given a subscriber, everything true about them, and the
   moment, decide whether to write and what to say. Kept apart from the sending
   so it can be reasoned about and tested on its own.

   ctx: { visitor, friendNick, daily: {taskId, target}, rank: {name, need} } */
export function pickMessage(sub, ctx, now, onlineNow) {
  const visitor = ctx?.visitor || null;
  const local = new Date(now - (sub.tz_offset || 0) * 60000);
  const hour = local.getUTCHours();
  if (hour < 19 || hour >= 21) return null;              // not their evening
  const today = local.toISOString().slice(0, 10);
  const yesterday = new Date(local.getTime() - 86400e3).toISOString().slice(0, 10);
  const T = textsFor(sub.lang);

  if (visitor?.streak_day === today) return null;        // already played today

  // Gone for a month and a half: stop writing. Nothing here will bring them
  // back, and mail nobody wants is how a sender ends up marked as spam.
  const away = visitor?.last_seen ? Math.floor((now - new Date(visitor.last_seen).getTime()) / 86400e3) : 0;
  if (away > 45) return null;

  const streak = visitor?.streak || 0;
  const alive = streak > 0 && visitor?.streak_day === yesterday;

  // Most personal first. Each one is only offered when it is actually true.
  const options = [];
  if (ctx?.friendNick) options.push({ kind: 'friend', msg: T.friend(ctx.friendNick), url: '/?go=friends' });
  if (alive) {
    options.push({ kind: 'streak', msg: T.streak(streak), url: '/?go=quick' });
    options.push({ kind: 'streak2', msg: T.streak2(streak), url: '/?go=quick' });
  }
  if (ctx?.daily) {
    const line = word(sub.lang, 'task_' + ctx.daily.taskId).replace('%n', ctx.daily.target);
    options.push({ kind: 'daily', msg: T.daily(line), url: '/?go=quick' });
  }
  if (ctx?.rank) options.push({ kind: 'rank', msg: T.rank(ctx.rank.name, ctx.rank.need), url: '/?go=quick' });
  if (away >= 3) options.push({ kind: 'winback', msg: T.winback(away), url: '/?go=quick' });
  options.push({ kind: 'online', msg: T.online(onlineNow), url: '/?go=quick' });
  options.push({ kind: 'online2', msg: T.online2(onlineNow), url: '/?go=quick' });

  // Never the same wording two evenings running: that is what turned the
  // online count into wallpaper.
  const fresh = options.filter(o => o.kind !== sub.last_kind);
  const chosen = (fresh.length ? fresh : options)[0];
  return { ...chosen.msg, url: chosen.url, kind: chosen.kind };
}

// Runs hourly. Picks the people for whom it is currently early evening and
// who have not been written to in the last twenty hours, gathers what is true
// about each of them — in one query per fact, not one per person — and lets
// pickMessage choose the words.
export async function pushTick(onlineNow, onlineUserIds = new Set()) {
  if (!ready || !dbEnabled) return;
  try {
    const now = Date.now();
    const cutoff = new Date(now - 20 * 3600e3).toISOString();
    const { data: subs } = await supa.from('push_subs')
      .select('endpoint, device_id, p256dh, auth, tz_offset, lang, fails, last_sent, last_kind')
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

    const devices = evening.map(s => s.device_id);
    const { data: rows } = await supa.from('visitors')
      .select('device_id, user_id, streak, streak_day, points, last_seen')
      .in('device_id', devices);
    const byDevice = new Map((rows || []).map(r => [r.device_id, r]));

    /* ---- who has a friend online right now ---- */
    const withAccount = (rows || []).filter(r => r.user_id && onlineUserIds.size);
    const friendNickOf = new Map();   // device_id -> nick
    if (withAccount.length) {
      const { data: fr } = await supa.from('friends')
        .select('user_id, friend_id')
        .in('user_id', withAccount.map(r => r.user_id));
      const online = new Map();       // user_id -> a friend of theirs who is online
      for (const f of fr || []) {
        if (!online.has(f.user_id) && onlineUserIds.has(f.friend_id)) online.set(f.user_id, f.friend_id);
      }
      if (online.size) {
        const { data: profs } = await supa.from('profiles')
          .select('id, nick').in('id', [...new Set(online.values())]);
        const nicks = new Map((profs || []).map(p => [p.id, p.nick]));
        for (const r of withAccount) {
          const fid = online.get(r.user_id);
          if (fid && nicks.get(fid)) friendNickOf.set(r.device_id, nicks.get(fid));
        }
      }
    }

    /* ---- whose task of the day is still open ---- */
    const keyOf = (r) => (r.user_id ? 'u:' + r.user_id : 'd:' + r.device_id);
    const keys = (rows || []).map(keyOf);
    const doneKeys = new Set();
    if (keys.length) {
      const { data: dp } = await supa.from('daily_progress')
        .select('key, day, done')
        .in('key', keys)
        .gte('day', new Date(now - 2 * 86400e3).toISOString().slice(0, 10));
      for (const d of dp || []) if (d.done) doneKeys.add(d.key + '|' + d.day);
    }

    let sent = 0;
    for (const s of evening) {
      const v = byDevice.get(s.device_id) || null;
      const day = localDay(s.tz_offset || 0);
      const task = taskForDay(day);
      const daily = v && !doneKeys.has(keyOf(v) + '|' + day)
        ? { taskId: task.id, target: task.target } : null;

      // how far off the next rank they are, when it is within reach
      let rank = null;
      const pts = v?.points || 0;
      const next = RANKS.find(r => r.min > pts);
      if (next && next.min - pts <= 60) {
        rank = { name: word(s.lang, next.key), need: next.min - pts };
      }

      const payload = pickMessage(s, { visitor: v, friendNick: friendNickOf.get(s.device_id), daily, rank }, now, onlineNow);
      if (!payload) continue;
      const { kind, ...body } = payload;
      if (await deliver(s, body, kind)) sent++;
      if (sent >= 400) break;                    // gentle on the free tier
    }
    if (sent) console.log(`push: sent ${sent} notifications`);
  } catch (e) {
    console.error('pushTick failed:', e.message);
  }
}
