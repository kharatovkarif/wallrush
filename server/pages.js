/* ---------- pages a search engine can actually read ----------

   The game is one address with everything drawn by JavaScript. That is fine
   for playing and useless for being found: a crawler that fetches
   wallrush.online is handed a title, one paragraph, and nothing else. And the
   Russian half of the audience searches in Russian — for "кворидор онлайн",
   "игра со стенками", "коридор игра" — words that appear nowhere in a file
   written in English.

   So: real addresses with real text, finished on the server and shipped as
   HTML. The words are the game's own. Rules, help, terms and privacy come
   straight out of the translation file the app reads, so the page and the
   dialog can never drift apart, and a translator who fixes one fixes both.

   The home page gets one thing added on its way out: the live rating. Google
   will print stars only for a rating that real people left and that the page
   itself shows, so the number in the markup is read from the database and the
   same number is put on the screen. That injection is why this module sits in
   front of the static middleware rather than beside it. */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { I18N } from '../public/js/i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, '../public');
const SITE = 'https://wallrush.online';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Telegram and the advertising address are the only contacts in these
// documents, and on a page they should be tappable.
const linkify = (s) => s
  .replace(/@Karoboev/g, '<a href="https://t.me/Karoboev">@Karoboev</a>')
  .replace(/ads@wallrush\.online/g, '<a href="mailto:ads@wallrush.online">ads@wallrush.online</a>');

/* The same three markers renderDoc() understands inside the app — "## " a
   heading, "• " a list item, a blank line a paragraph break — so a document
   reads the same here as it does in the game. */
function renderDoc(text, h = 'h2') {
  const out = [];
  let list = null;
  const flush = () => { if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; } };
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (line.startsWith('## ')) { flush(); out.push(`<${h}>${linkify(esc(line.slice(3)))}</${h}>`); }
    else if (line.startsWith('• ')) { (list ||= []).push(`<li>${linkify(esc(line.slice(2)))}</li>`); }
    else { flush(); out.push(`<p>${linkify(esc(line))}</p>`); }
  }
  flush();
  return out.join('\n');
}

/* The help documents are already questions and answers — every "## " line is
   a question a player actually asked. Handing that shape over verbatim costs
   nothing and lets a search engine, or an assistant reading through one,
   answer "does WallRush need an account?" without guessing. */
function faqLd(text) {
  const items = [];
  let q = null;
  let a = [];
  const push = () => {
    if (q && a.length) {
      items.push({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a.join(' ') } });
    }
  };
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (line.startsWith('## ')) { push(); q = line.slice(3); a = []; }
    else if (line) a.push(line.replace(/^• /, ''));
  }
  push();
  return items.length ? { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: items } : null;
}

/* ---------- the live rating ----------
   One read every five minutes, shared by every page that shows it. A database
   that is down leaves the last figure standing rather than a dash, and if
   there has never been one the rating is simply left out — an empty
   aggregateRating is worse than none. */

const RATING_TTL = 5 * 60 * 1000;
const RATING_MIN = 5;       // below this an average says nothing
let rating = { at: 0, val: null };

async function liveRating(reviewStats) {
  if (Date.now() - rating.at < RATING_TTL) return rating.val;
  try {
    const { count, avg } = await reviewStats();
    rating = { at: Date.now(), val: count >= RATING_MIN ? { count, avg } : null };
  } catch (e) {
    rating = { at: Date.now(), val: rating.val };   // keep what we had
  }
  return rating.val;
}

const ratingLd = (r) => (r ? {
  '@type': 'AggregateRating',
  ratingValue: r.avg.toFixed(1),
  ratingCount: String(r.count),
  bestRating: '5',
  worstRating: '1',
} : null);

const starRow = (n) => '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);

/* ---------- the home page ----------
   Read from disk (with an mtime check, so an edit shows up without a restart)
   and handed back with two holes filled: the rating in the structured data,
   and the same rating in the pill on the first screen. Both holes are written
   so that the untouched file is still a valid page — if this route ever
   throws, express.static serves the file as it stands and the game works. */

const LD_ANCHOR = '"@type": "VideoGame",';
const PILL_ANCHOR = '<a class="rating-pill" id="rating-pill" href="/reviews" hidden></a>';

let home = { mtime: 0, raw: '', key: '', html: '', etag: '' };

function homePage(r) {
  const p = path.join(PUB, 'index.html');
  const mtime = fs.statSync(p).mtimeMs;
  if (mtime !== home.mtime) home = { ...home, mtime, raw: fs.readFileSync(p, 'utf8'), key: '' };

  const key = r ? `${r.avg}/${r.count}` : 'none';
  if (key === home.key) return home;

  let html = home.raw;
  if (r) {
    html = html.replace(LD_ANCHOR, `${LD_ANCHOR}"aggregateRating":${JSON.stringify(ratingLd(r))},`);
    html = html.replace(PILL_ANCHOR,
      `<a class="rating-pill" id="rating-pill" href="/reviews" aria-label="${r.avg.toFixed(1)} of 5, ${r.count} ratings">`
      + `<span class="rp-star">★</span><b>${r.avg.toFixed(1)}</b><small>${r.count}</small></a>`);
  }
  home = { ...home, key, html, etag: `"${createHash('sha1').update(html).digest('base64').slice(0, 22)}"` };
  return home;
}

/* ---------- the shared page frame ----------
   Deliberately one file with the styles inside it: these pages exist to be
   read by something that fetched them once, and a second request for a
   stylesheet buys nothing. Same palette as /reviews so the two feel like one
   site. */

const CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0e1015; color: #eef1f7; font: 16px/1.62 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 22px 18px 64px; }
  a { color: #8ab4ff; }
  .top { display: flex; gap: 14px; flex-wrap: wrap; font-size: 14px; color: #6f7787; margin-bottom: 22px; }
  .top a { text-decoration: none; }
  h1 { font-size: 28px; line-height: 1.25; margin: 0 0 10px; }
  h2 { font-size: 20px; margin: 30px 0 8px; }
  h3 { font-size: 17px; margin: 20px 0 6px; color: #c7cddb; }
  p, ul { margin: 10px 0; }
  ul { padding-left: 22px; }
  li { margin: 5px 0; }
  .lede { color: #b7bfcf; font-size: 17.5px; }
  .play { display: inline-block; margin: 18px 0 6px; background: #4c7dff; color: #fff; text-decoration: none; font-weight: 600; padding: 14px 26px; border-radius: 12px; font-size: 17px; }
  .score { display: flex; align-items: center; gap: 16px; background: #171a22; border: 1px solid #232838; border-radius: 16px; padding: 16px 18px; margin: 22px 0; flex-wrap: wrap; }
  .score b { font-size: 34px; line-height: 1; }
  .score .stars { color: #ffc531; letter-spacing: 2px; }
  .score small { color: #9aa3b2; display: block; }
  .facts { border-collapse: collapse; width: 100%; margin: 14px 0; font-size: 15px; }
  .facts th, .facts td { text-align: left; padding: 9px 10px; border-bottom: 1px solid #232838; vertical-align: top; }
  .facts th { color: #9aa3b2; font-weight: 500; width: 42%; }
  .more { background: #171a22; border: 1px solid #232838; border-radius: 14px; padding: 4px 18px 14px; margin: 30px 0 0; }
  footer { margin-top: 34px; color: #6f7787; font-size: 14px; line-height: 1.75; border-top: 1px solid #232838; padding-top: 16px; }
  @media (max-width: 460px) { h1 { font-size: 24px; } .facts th { width: 46%; } }
`;

function frame({ lang, rtl, title, desc, canon, alts, ld, top, body, footer }) {
  const head = [
    `<link rel="canonical" href="${SITE}${canon}">`,
    ...alts.map(([code, href]) => `<link rel="alternate" hreflang="${code}" href="${SITE}${href}">`),
  ].join('\n');
  const scripts = ld.filter(Boolean).map(o => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join('\n');
  return `<!doctype html>
<html lang="${lang}"${rtl ? ' dir="rtl"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
${head}
<meta property="og:type" content="website">
<meta property="og:site_name" content="WallRush">
<meta property="og:url" content="${SITE}${canon}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${SITE}/icons/icon-512.png">
<link rel="icon" href="/icons/icon-192.png">
${scripts}
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<nav class="top">${top}</nav>
${body}
<footer>${footer}</footer>
</div>
</body>
</html>`;
}

/* ---------- what goes on each page ----------
   A row of links at the top of every page and a line at the bottom, in the
   language of the page. Internal links are how a crawler finds the rest of
   this, so every page points at every other one. */

const NAV = {
  ru: [['/', '← Играть'], ['/ru', 'О игре'], ['/ru/pravila', 'Правила'], ['/ru/pomosh', 'Помощь'], ['/reviews', 'Отзывы']],
  en: [['/', '← Play'], ['/rules', 'Rules'], ['/help', 'Help'], ['/reviews', 'Reviews'], ['/ru', 'Русский']],
};
const navRow = (lang, here) => NAV[lang]
  .map(([href, label]) => (href === here ? `<span>${label}</span>` : `<a href="${href}">${label}</a>`))
  .join('');

const FOOT = {
  ru: `WallRush — бесплатная онлайн-игра «Кворидор». <a href="/">Играть</a> · <a href="/ru/usloviya">Условия</a> · <a href="/ru/konfidencialnost">Конфиденциальность</a><br>Telegram: <a href="https://t.me/Karoboev">@Karoboev</a> · Реклама: <a href="mailto:ads@wallrush.online">ads@wallrush.online</a>`,
  en: `WallRush — a free online game of Quoridor. <a href="/">Play</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a><br>Telegram: <a href="https://t.me/Karoboev">@Karoboev</a> · Advertising: <a href="mailto:ads@wallrush.online">ads@wallrush.online</a>`,
};

// The one thing that is not translated text: the game itself, described for a
// machine. Every content page carries it, so whichever page a search engine
// decides to rank already knows what it is looking at.
const gameLd = (r, lang, url) => ({
  '@context': 'https://schema.org',
  '@type': 'VideoGame',
  name: 'WallRush',
  alternateName: ['Wall Rush', 'Кворидор', 'Quoridor'],
  url: `${SITE}${url}`,
  image: `${SITE}/icons/icon-512.png`,
  genre: ['Strategy', 'Board Game'],
  gamePlatform: ['Web browser', 'Android', 'iOS'],
  playMode: ['MultiPlayer', 'SinglePlayer'],
  numberOfPlayers: { '@type': 'QuantitativeValue', minValue: 1, maxValue: 4 },
  applicationCategory: 'GameApplication',
  operatingSystem: 'Any',
  inLanguage: lang,
  isAccessibleForFree: true,
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
  ...(r ? { aggregateRating: ratingLd(r) } : {}),
});

// The rating, printed where a reader can see it. Nothing is claimed here that
// /reviews does not list one by one.
const scoreBox = (r, lang) => {
  if (!r) return '';
  const word = lang === 'ru'
    ? `${r.count} ${r.count % 10 === 1 && r.count % 100 !== 11 ? 'оценка' : 'оценок'}`
    : `${r.count} rating${r.count === 1 ? '' : 's'}`;
  const link = lang === 'ru' ? 'Читать отзывы' : 'Read the reviews';
  return `<div class="score">
  <div><b>${r.avg.toFixed(1)}</b></div>
  <div><div class="stars">${starRow(Math.round(r.avg))}</div><small>${word} · <a href="/reviews">${link}</a></small></div>
</div>`;
};

/* ---------- the Russian landing page ----------
   Not a translation of the home screen: a page for someone who has typed the
   name of a board game into a search box and has not heard of us. It answers
   what the game is, how a turn works, who they would be playing, and where
   the rules are — and then gets out of the way with a button. */
function ruLanding(r) {
  const body = `
<h1>Кворидор онлайн — играть бесплатно в браузере</h1>
<p class="lede">WallRush (велруш) — бесплатная онлайн-версия настольной игры «Кворидор», её же называют «Коридор» или просто «игра со стенками». Открывается прямо в браузере телефона и компьютера: ничего не скачивать, регистрироваться не нужно.</p>
<a class="play" href="/">▶ Играть сейчас</a>
${scoreBox(r, 'ru')}

<h2>Суть игры за минуту</h2>
<p>У вас фишка, у соперника фишка. Надо первым дойти до противоположного края поля. За ход вы делаете либо одно, либо другое: шаг на соседнюю клетку — или ставите одну стену. Совместить нельзя.</p>
<p>Стена мешает не вам, а сопернику: перепрыгнуть её нельзя, только обойти. Но стен у каждого ограниченное число, поэтому это не гонка «кто быстрее бежит», а разговор о том, кто вовремя потратил стену и кто угадал, куда соперник пойдёт.</p>
<p>Запереть соперника наглухо нельзя: путь к цели должен оставаться всегда, и ход, который его отнимает, игра просто не примет. Партия занимает две-три минуты. Правила объясняются за минуту — играть в это можно годами.</p>
<p><a href="/ru/pravila">Полные правила</a> — со всеми режимами, прыжками через соперника, временем на ход и начислением очков.</p>

<h2>С кем играть</h2>
<ul>
<li><b>С живыми людьми.</b> «Быстрая игра» находит соперника за несколько секунд — в игре люди из десятков стран, круглые сутки.</li>
<li><b>С другом.</b> Создаёте комнату, получаете короткий код, отправляете его другу. Он вводит код — и вы за одной доской, в каких бы городах ни находились.</li>
<li><b>Против компьютера.</b> Четыре уровня: от «для первых партий» до «без пощады». Хороший способ разобраться, прежде чем выходить к людям.</li>
<li><b>Вчетвером.</b> Отдельный режим на четырёх игроков — в онлайн-кворидоре его почти нигде нет.</li>
</ul>

<h2>Три режима</h2>
<h3>Дуэль — поле 9×9</h3>
<p>Классика, та самая настольная. Двое стартуют с противоположных сторон, у каждого по 10 стен, и каждому надо дойти до края соперника.</p>
<h3>Гонка — поле 9×13</h3>
<p>Поле длиннее, и оба стартуют снизу: бежите в одну сторону, рядом друг с другом. Стен больше, и мешать сопернику куда проще — партии выходят злее.</p>
<h3>Четверо — поле 11×11</h3>
<p>За столом четыре игрока, каждый посередине своей стороны, и все бегут к одной золотой клетке в самом центре. У каждого по 7 стен, и правило «запереть нельзя» действует сразу для всех четверых. Побеждает один — тот, кто дошёл до центра первым.</p>

<h2>Очки, звания и таблица лидеров</h2>
<p>За победы над живыми соперниками начисляются очки, из очков складывается звание: Новичок → Ученик → Стратег → Мастер стен → Про → Легенда → GOAT 🐐. Звание соперника видно прямо в матче, а лучшие игроки стоят в общей таблице лидеров.</p>
<p>Тренировка против компьютера и партия с другом по коду на рейтинг не влияют — они для удовольствия, а не для очков.</p>

<h2>Нужна ли регистрация</h2>
<p>Нет. Нажали «Быстрая игра» — уже играете, ник выдаётся автоматически. Аккаунт нужен только затем, чтобы очки не остались в одном браузере: с аккаунтом прогресс переезжает с вами на любое устройство, а всё набранное до регистрации переносится само.</p>

<h2>Как поставить игру на телефон</h2>
<p>Отдельного приложения качать не нужно — игра ставится из браузера. На Android появится кнопка «Установить», на iPhone в Safari нужно нажать «Поделиться» ⬆️ и выбрать «На экран „Домой“». После этого WallRush открывается с иконки и ведёт себя как обычное приложение.</p>

<h2>На каких языках</h2>
<p>Русский, English, فارسی, Türkçe, Français, Español. Язык переключается в игре одним нажатием на 🌐 — в любой момент, без перезахода.</p>

<h2>Коротко о главном</h2>
<table class="facts">
<tr><th>Что это</th><td>Кворидор («Коридор») онлайн — игра со стенками, один на один или вчетвером</td></tr>
<tr><th>Сколько стоит</th><td>Бесплатно, полностью</td></tr>
<tr><th>Регистрация</th><td>Не нужна</td></tr>
<tr><th>Где играть</th><td>В браузере: Android, iPhone, компьютер</td></tr>
<tr><th>Игроков</th><td>2 или 4</td></tr>
<tr><th>Поля</th><td>9×9 (дуэль), 9×13 (гонка), 11×11 (четверо)</td></tr>
<tr><th>Партия длится</th><td>2–5 минут</td></tr>
<tr><th>Соперники</th><td>Живые люди, друг по коду или компьютер</td></tr>
</table>

<div class="more">
<h2>Что дальше</h2>
<ul>
<li><a href="/ru/pravila">Правила</a> — как ходить, как ставить стены, как считаются очки.</li>
<li><a href="/ru/pomosh">Помощь</a> — регистрация, игра с другом, установка на телефон, удаление аккаунта.</li>
<li><a href="/reviews">Отзывы игроков</a> — все оценки и все слова, хорошие и плохие.</li>
<li><a href="/ru/usloviya">Условия</a> и <a href="/ru/konfidencialnost">Конфиденциальность</a>.</li>
</ul>
<a class="play" href="/">▶ Открыть игру</a>
</div>`;
  return frame({
    lang: 'ru',
    title: 'Кворидор онлайн — играть бесплатно | WallRush',
    desc: 'Кворидор («Коридор») онлайн бесплатно и без регистрации. Игра со стенками один на один или вчетвером: доведите фишку до края поля и перекройте путь сопернику. Живые соперники, игра с другом по коду и компьютер — прямо в браузере.',
    canon: '/ru',
    alts: [['ru', '/ru'], ['en', '/'], ['x-default', '/']],
    ld: [gameLd(r, 'ru', '/ru')],
    top: navRow('ru', '/ru'),
    body,
    footer: FOOT.ru,
  });
}

/* ---------- the documents ----------
   Four each side, and every one of them a real address. Beyond being readable
   by a crawler this settles something practical: every app store asks for a
   privacy policy at a public URL before it will take a submission. */

const DOCS = [
  {
    path: '/rules', lang: 'en', key: 'rules',
    title: 'WallRush rules — how to play Quoridor online',
    desc: 'The full rules of WallRush: move or place a wall, jump your opponent, never block them off completely. Duel 9×9, Race 9×13 and the four-player 11×11 table, with move times and how points are scored.',
    alt: '/ru/pravila',
  },
  {
    path: '/help', lang: 'en', key: 'help',
    title: 'WallRush help — answers for players',
    desc: 'Do you need an account, how to play with a friend by code, how to install the game on a phone, what happens when an opponent disappears, and how to delete an account.',
    alt: '/ru/pomosh', faq: true,
  },
  {
    path: '/terms', lang: 'en', key: 'terms',
    title: 'WallRush — terms of use',
    desc: 'The terms on which WallRush is offered: fair play, nicknames, points and ranks, advertising, accounts and deletion.',
    alt: '/ru/usloviya', dated: true,
  },
  {
    path: '/privacy', lang: 'en', key: 'privacy',
    title: 'WallRush — privacy policy',
    desc: 'What WallRush collects, why, who it is shared with, how long it is kept, and how to delete an account in one step.',
    alt: '/ru/konfidencialnost', dated: true,
  },
  {
    path: '/ru/pravila', lang: 'ru', key: 'rules',
    title: 'Правила кворидора — как играть в WallRush',
    desc: 'Полные правила игры со стенками: за ход либо шаг, либо стена; стену нельзя перепрыгнуть, только обойти; запереть соперника нельзя. Дуэль 9×9, Гонка 9×13 и стол на четверых 11×11, время на ход и начисление очков.',
    alt: '/rules',
  },
  {
    path: '/ru/pomosh', lang: 'ru', key: 'help',
    title: 'WallRush — помощь игрокам',
    desc: 'Нужна ли регистрация, как играть с другом по коду, как поставить игру на телефон, что делать, если соперник пропал посреди партии, и как удалить аккаунт.',
    alt: '/help', faq: true,
  },
  {
    path: '/ru/usloviya', lang: 'ru', key: 'terms',
    title: 'WallRush — условия использования',
    desc: 'На каких условиях работает WallRush: честная игра, никнеймы, очки и звания, реклама, аккаунт и его удаление.',
    alt: '/terms', dated: true,
  },
  {
    path: '/ru/konfidencialnost', lang: 'ru', key: 'privacy',
    title: 'WallRush — политика конфиденциальности',
    desc: 'Какие данные собирает WallRush и зачем, кому они передаются, сколько хранятся и как удалить аккаунт в один шаг.',
    alt: '/privacy', dated: true,
  },
];

function docPage(spec, r) {
  const dict = I18N[spec.lang] || I18N.en;
  const text = dict[`${spec.key}_body`] || '';
  const h1 = dict[`${spec.key}_title`] || spec.title;
  const dated = spec.dated ? `<p class="lede">${esc(dict.doc_updated || '')}</p>` : '';
  const home = spec.lang === 'ru'
    ? `<div class="more"><h2>Об игре</h2><p>WallRush — бесплатный кворидор онлайн: один на один или вчетвером, без регистрации, прямо в браузере. <a href="/ru">Что это за игра</a> · <a href="/reviews">Отзывы игроков</a></p><a class="play" href="/">▶ Играть</a></div>`
    : `<div class="more"><h2>About the game</h2><p>WallRush is free online Quoridor — one on one or four at a table, no signup, straight in the browser. <a href="/reviews">What players say</a></p><a class="play" href="/">▶ Play</a></div>`;
  return frame({
    lang: spec.lang,
    title: spec.title,
    desc: spec.desc,
    canon: spec.path,
    alts: [[spec.lang, spec.path], [spec.lang === 'ru' ? 'en' : 'ru', spec.alt], ['x-default', '/']],
    ld: [gameLd(r, spec.lang, spec.path), spec.faq ? faqLd(text) : null],
    top: navRow(spec.lang, spec.path),
    body: `<h1>${esc(h1)}</h1>${dated}${renderDoc(text)}${home}`,
    footer: FOOT[spec.lang],
  });
}

/* ---------- mounting ----------
   Called before express.static, because "/" has to be ours before the
   middleware answers it with the file on disk. Everything here is read-only
   and cached; a throw anywhere falls through to the static file, so the worst
   an outage in this module can do is cost us the stars in a search result. */

export function mountPages(app, { reviewStats }) {
  const send = (res, html, etag, req, maxAge) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', maxAge ? `public, max-age=${maxAge}` : 'no-cache');
    res.set('ETag', etag);
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.send(html);
  };

  // The game itself. no-cache, exactly as the static middleware served it, so
  // a deploy still reaches a browser that has the old file.
  app.get(['/', '/index.html'], async (req, res, next) => {
    try {
      const { html, etag } = homePage(await liveRating(reviewStats));
      send(res, html, etag, req, 0);
    } catch (e) {
      console.error('[home]', e && e.stack ? e.stack : e);
      next();
    }
  });

  // The content pages. Five minutes of caching: the only thing on them that
  // moves is the rating.
  const cache = new Map();
  const serve = (build, id) => async (req, res, next) => {
    try {
      const r = await liveRating(reviewStats);
      const key = `${id}|${r ? `${r.avg}/${r.count}` : 'none'}`;
      let hit = cache.get(key);
      if (!hit) {
        const html = build(r);
        hit = { html, etag: `"${createHash('sha1').update(html).digest('base64').slice(0, 22)}"` };
        cache.clear();            // one page, one rating — never a third copy
        cache.set(key, hit);
      }
      send(res, hit.html, hit.etag, req, 300);
    } catch (e) {
      console.error(`[page ${id}]`, e && e.stack ? e.stack : e);
      next();
    }
  };

  app.get('/ru', serve(ruLanding, 'ru'));
  for (const spec of DOCS) app.get(spec.path, serve((r) => docPage(spec, r), spec.path));

  // Written rather than kept in public/, so a new page cannot be added without
  // its address appearing here.
  const urls = [
    ['/', 'daily', '1.0'],
    ['/ru', 'weekly', '0.9'],
    ['/reviews', 'daily', '0.7'],
    ...DOCS.map(d => [d.path, 'monthly', d.key === 'rules' || d.key === 'help' ? '0.6' : '0.3']),
  ];
  app.get('/sitemap.xml', (req, res) => {
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(([loc, freq, pri]) => `  <url><loc>${SITE}${loc}</loc><changefreq>${freq}</changefreq><priority>${pri}</priority></url>`).join('\n')}
</urlset>`);
  });
}

// for the tests
export const _internals = { renderDoc, faqLd, ruLanding, docPage, DOCS, LD_ANCHOR, PILL_ANCHOR, homePage };
