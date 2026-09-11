// Serves the real routes with a stubbed rating and checks what a crawler gets.
import express from 'express';
import { fileURLToPath } from 'url';
import { mountPages, _internals } from '../server/pages.js';

const PUB = fileURLToPath(new URL('../public', import.meta.url));

const app = express();
const STATS = { count: 843, avg: 4.6, spread: [] };
let fail = 0;
mountPages(app, { reviewStats: async () => STATS });
app.use(express.static(PUB));

const srv = app.listen(0);
const port = srv.address().port;
const get = async (p) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: r.status, ct: r.headers.get('content-type'), cc: r.headers.get('cache-control'), etag: r.headers.get('etag'), body: await r.text() };
};
const ok = (cond, msg) => { if (!cond) { fail++; console.log('  FAIL', msg); } else console.log('  ok  ', msg); };

/* A cold start with no database. The rating lives in a five-minute cache that
   deliberately keeps its last figure when the database goes away, so this can
   only be checked before anything has succeeded — hence its own process. */
if (!process.env.WR_COLD) {
  const { execFileSync } = await import('child_process');
  console.log('--- a cold start with the database down ---');
  const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, WR_COLD: '1' }, encoding: 'utf8',
  });
  process.stdout.write(out);
  if (/FAIL/.test(out)) fail++;
} else {
  const app2 = express();
  mountPages(app2, { reviewStats: async () => { throw new Error('db down'); } });
  app2.use(express.static(PUB));
  const s2 = app2.listen(0);
  const r = await fetch(`http://127.0.0.1:${s2.address().port}/`);
  const body = await r.text();
  ok(r.status === 200, 'the game is still served');
  ok(/<h1>WallRush<\/h1>/.test(body), 'and it is the game, not an error');
  const m = body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  let parsed = null; try { parsed = JSON.parse(m[1]); } catch {}
  ok(parsed && !parsed.aggregateRating, 'no rating invented out of nothing');
  ok(!/id="rating-pill"[^>]*>\s*<span/.test(body), 'and none printed on the screen');
  s2.close();
  console.log(fail ? `${fail} FAILURES` : '  (cold start fine)');
  process.exit(fail ? 1 : 0);
}

console.log('--- / (home) ---');
{
  const r = await get('/');
  ok(r.status === 200, 'serves 200');
  ok(r.cc === 'no-cache', `no-cache (got ${r.cc})`);
  ok(/"aggregateRating":\{"@type":"AggregateRating","ratingValue":"4.6","ratingCount":"843"/.test(r.body), 'rating is in the structured data');
  ok(/"maxValue": 4/.test(r.body), 'four players declared');
  ok(!/"maxValue": 2/.test(r.body), 'the stale "2" is gone');
  ok(/hreflang="ru" href="https:\/\/wallrush\.online\/ru"/.test(r.body), 'ru alternate points at /ru');
  ok(/<b>4\.6<\/b><small>843<\/small>/.test(r.body), 'rating is visible on the page');
  ok(!/id="rating-pill" href="\/reviews" hidden/.test(r.body), 'the pill is no longer hidden');
  ok(/href="\/rules" data-legal="rules"/.test(r.body), 'legal links are real links');
  // the JSON-LD must still parse after the injection
  const m = r.body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  let parsed = null;
  try { parsed = JSON.parse(m[1]); } catch (e) { }
  ok(parsed && parsed.aggregateRating.ratingValue === '4.6', 'JSON-LD still parses');
  // ETag / 304
  const again = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'if-none-match': r.etag } });
  ok(again.status === 304, 'returns 304 for a matching ETag');
}

console.log('--- /ru ---');
{
  const r = await get('/ru');
  ok(r.status === 200, 'serves 200');
  ok(/<html lang="ru">/.test(r.body), 'declared as Russian');
  ok(/кворидор/i.test(r.body), 'the word "кворидор" is in the HTML');
  ok(/игра со стенками/i.test(r.body), '"игра со стенками" is in the HTML');
  ok(/велруш/i.test(r.body), '"велруш" is in the HTML');
  ok(/rel="canonical" href="https:\/\/wallrush\.online\/ru"/.test(r.body), 'canonical');
  ok(/4\.6/.test(r.body) && /843 оценок/.test(r.body), 'the rating is printed');
  const lds = [...r.body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));
  ok(lds.length === 1 && lds[0]['@type'] === 'VideoGame' && lds[0].aggregateRating.ratingCount === '843', 'VideoGame + rating');
  const words = r.body.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(w => /[а-яё]/i.test(w)).length;
  ok(words > 400, `${words} Russian words of real text`);
  ok(r.cc === 'public, max-age=300', 'cached for five minutes');
}

console.log('--- the documents ---');
for (const spec of _internals.DOCS) {
  const r = await get(spec.path);
  const body = r.body;
  const bad = [];
  if (r.status !== 200) bad.push('status ' + r.status);
  if (!new RegExp(`<html lang="${spec.lang}">`).test(body)) bad.push('lang');
  if (!body.includes(`rel="canonical" href="https://wallrush.online${spec.path}"`)) bad.push('canonical');
  if (!body.includes(`hreflang="${spec.lang === 'ru' ? 'en' : 'ru'}" href="https://wallrush.online${spec.alt}"`)) bad.push('alternate');
  if (!/<h2>/.test(body)) bad.push('no headings rendered');
  if (/&amp;lt;|&amp;amp;/.test(body)) bad.push('double-escaped');
  if (/undefined|\[object/.test(body)) bad.push('undefined leaked');
  const lds = [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  let ldOk = true;
  for (const m of lds) { try { JSON.parse(m[1]); } catch { ldOk = false; } }
  if (!ldOk) bad.push('broken JSON-LD');
  if (spec.faq && !lds.some(m => JSON.parse(m[1])['@type'] === 'FAQPage')) bad.push('no FAQPage');
  if (spec.dated && !/Редакция от|Revision of|revision/i.test(body)) bad.push('no revision date');
  const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  ok(bad.length === 0, `${spec.path} (${text.length} chars)${bad.length ? ' — ' + bad.join(', ') : ''}`);
}

console.log('--- FAQ extraction ---');
{
  const faq = _internals.faqLd('## Нужна ли регистрация\nНет. Нажми кнопку.\n\n## Второй вопрос\nОтвет.');
  ok(faq.mainEntity.length === 2, 'two questions found');
  ok(faq.mainEntity[0].name === 'Нужна ли регистрация', 'question text');
  ok(faq.mainEntity[0].acceptedAnswer.text === 'Нет. Нажми кнопку.', 'answer text');
  ok(_internals.faqLd('no headings here') === null, 'nothing invented from a body with no questions');
}

console.log('--- renderDoc ---');
{
  const html = _internals.renderDoc('## Заголовок\n• первый\n• второй\n\nАбзац с <b>разметкой</b> и @Karoboev');
  ok(html.includes('<h2>Заголовок</h2>'), 'heading');
  ok(html.includes('<ul><li>первый</li><li>второй</li></ul>'), 'list');
  ok(html.includes('&lt;b&gt;'), 'markup in the text is escaped, not run');
  ok(html.includes('<a href="https://t.me/Karoboev">@Karoboev</a>'), 'telegram is a link');
}

console.log('--- sitemap ---');
{
  const r = await get('/sitemap.xml');
  ok(r.status === 200 && /application\/xml/.test(r.ct), 'served as XML');
  for (const p of ['/', '/ru', '/reviews', '/rules', '/help', '/terms', '/privacy', '/ru/pravila', '/ru/pomosh', '/ru/usloviya', '/ru/konfidencialnost']) {
    ok(r.body.includes(`<loc>https://wallrush.online${p}</loc>`), `lists ${p}`);
  }
}

console.log('--- static files still work ---');
{
  const r = await get('/manifest.json');
  ok(r.status === 200, 'manifest.json');
  const c = await get('/css/style.css?v=152');
  ok(c.status === 200 && /rating-pill/.test(c.body), 'style.css carries the pill');
}

srv.close();
console.log(fail ? `\n${fail} FAILURES` : '\nall good');
process.exit(fail ? 1 : 0);
