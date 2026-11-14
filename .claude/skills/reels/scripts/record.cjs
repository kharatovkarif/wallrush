/* Records one WallRush match as a vertical video for Reels / TikTok / Shorts.

   Plays as the bottom player against the game's own AI, on the 3D board with
   a slowly circling camera. Nothing here touches the live site or the
   database: it drives a local server (node server/index.js) in a headless
   browser and writes a .webm plus a small timing file next to it.

   usage: node record.cjs --url http://localhost:4777 --out /path/dir
          [--lang ru] [--level normal] [--theme light|dark] [--seconds 70] */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const URL = arg('url', 'http://localhost:4777');
const OUT = arg('out', process.cwd());
const LANG = arg('lang', 'ru');
const LEVEL = arg('level', 'easy');   // easy: the reel should end on a win
const THEME = arg('theme', 'light');
const MAX_S = Number(arg('seconds', 70));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // WebGL in headless Chromium, for the three.js board
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  // 9:16 at 540x960 CSS px, filmed frame by frame at 1080x1920. Playwright's
  // own recordVideo films CSS pixels, so on a 2x screen it got a quarter of
  // the page in a corner; the DevTools screencast sends real device pixels.
  const ctx = await browser.newContext({ viewport: { width: 540, height: 960 }, deviceScaleFactor: 2 });
  const t0 = Date.now();
  const mark = {};
  const page = await ctx.newPage();
  const framesDir = path.join(OUT, 'frames');
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  const frames = [];
  const cdp = await ctx.newCDPSession(page);
  cdp.on('Page.screencastFrame', async (f) => {
    const name = `f${String(frames.length).padStart(5, '0')}.jpg`;
    fs.writeFileSync(path.join(framesDir, name), Buffer.from(f.data, 'base64'));
    frames.push({ name, t: (Date.now() - t0) / 1000 });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1080, maxHeight: 1920, everyNthFrame: 1 });
  page.on('pageerror', e => console.error('page error:', e.message));

  // 3D is a Premium feature; for filming, switch the gate off in this browser only
  await page.route('**/js/app.js*', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    body = body.replace(/function b3dOn\(\) \{[^}]*\}/, 'function b3dOn() { return true; }');
    // a handle on the match for the filming player (this browser only)
    body += '\nwindow.__wr = { state: () => game && !game.over ? game.state : null, me: () => game ? game.myIndex : -1, submit: (m) => submitMove(m), view: (v) => Object.assign(b3d, v) };\n';
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'application/javascript' } });
  });
  await page.addInitScript(([lang, theme]) => {
    localStorage.setItem('wr_lang', lang);
    localStorage.setItem('wr_theme', theme);
    localStorage.setItem('wr_3d', '1');
    localStorage.setItem('wr_3d_view', JSON.stringify({ tilt: 48, spin: 0 }));
  }, [LANG, THEME]);

  await page.goto(URL);
  await page.waitForTimeout(1800);
  mark.home = (Date.now() - t0) / 1000;
  await page.click('#btn-ai'); await page.waitForTimeout(500);
  await page.click('#ai-' + LEVEL); await page.waitForTimeout(1500);
  mark.gameStart = (Date.now() - t0) / 1000;

  // a camera that keeps drifting round the board: the thing a flat screenshot cannot show
  await page.evaluate(() => {
    let spin = 0, t = 0;
    window.__cam = setInterval(() => {
      t += 1; spin += 0.35;
      window.__wr.view({ spin, tilt: 46 + Math.sin(t / 60) * 10, zoom: 1.05 + Math.sin(t / 90) * 0.12 });
    }, 40);
  });

  /* Our side is played by the game's own AI one level up from the opponent,
     so the reel shows real play — walls where they hurt, a path round them —
     and usually ends on a win. */
  const OUR_LEVEL = { easy: 'normal', normal: 'hard', hard: 'hardcore' }[LEVEL] || 'normal';
  await page.evaluate(async () => {
    const v = [...document.scripts].map(s => s.src).find(x => /app\.js\?v=/.test(x))?.split('v=')[1] || '';
    window.__ai = await import('/js/ai.js?v=' + v);
  });
  while ((Date.now() - t0) / 1000 < MAX_S) {
    const st = await page.evaluate(async (lvl) => {
      const s = window.__wr.state();
      if (!s) return 'over';
      if (s.winner !== null && s.winner !== undefined) return 'over';
      if (s.turn !== window.__wr.me()) return 'wait';
      await new Promise(r => setTimeout(r, 650 + Math.random() * 450));   // looks like thinking
      const m = window.__ai.aiMove(window.__wr.state(), lvl);
      if (m) window.__wr.submit(m);
      return 'moved';
    }, OUR_LEVEL);
    if (st === 'over') break;
    await page.waitForTimeout(st === 'wait' ? 200 : 350);
  }
  mark.gameEnd = (Date.now() - t0) / 1000;
  await page.waitForTimeout(2500);   // the result screen
  mark.end = (Date.now() - t0) / 1000;
  await cdp.send('Page.stopScreencast').catch(() => {});
  await ctx.close();
  await browser.close();
  // frames arrive only when something changes: hold each one until the next
  const list = frames.map((f, i) => {
    const next = frames[i + 1] ? frames[i + 1].t : f.t + 0.5;
    return `file '${path.join(framesDir, f.name)}'\nduration ${Math.max(0.001, next - f.t).toFixed(3)}`;
  });
  list.push(`file '${path.join(framesDir, frames[frames.length - 1].name)}'`);
  fs.writeFileSync(path.join(OUT, 'frames.txt'), list.join('\n') + '\n');
  const first = frames[0]?.t || 0;
  for (const k of Object.keys(mark)) mark[k] = Math.max(0, mark[k] - first);   // video time
  fs.writeFileSync(path.join(OUT, 'marks.json'), JSON.stringify(mark, null, 2));
  console.log(JSON.stringify({ frames: frames.length, ...mark }));
})();
