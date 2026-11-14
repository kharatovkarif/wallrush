---
name: reels
description: Make a vertical 9:16 promo video (Instagram Reels, TikTok, YouTube Shorts) of a real WallRush match on the 3D board, with a circling camera, captions and an end card. Use when the owner asks for a reel, a promo video, a TikTok/Shorts clip or content for social media.
---

# Reels for WallRush

Makes a finished MP4 (1080×1920, 30 fps, H.264, silent AAC track so every app
accepts it) from a match played locally in a headless browser. Nothing touches
the live site, the database or any account: the server runs locally without
Supabase (guest mode), and 3D is unlocked only inside the filming browser.

## Steps

```bash
cd /home/user/wallrush
(PORT=4777 node server/index.js > /dev/null 2>&1 &) ; sleep 3
OUT=<scratchpad>/reel-$(date +%s)
node .claude/skills/reels/scripts/record.cjs --url http://localhost:4777 --out $OUT --lang ru --seconds 90
pkill -f "node server/index.js"
bash .claude/skills/reels/scripts/edit.sh $OUT "Перекрой ему путь" "Играй бесплатно: wallrush.online"
```

Result: `$OUT/reel.mp4`. Look at a few frames before sending
(`ffmpeg -ss <t> -i reel.mp4 -frames:v 1 -vf scale=360:-1 f.png`), then send it
to the owner with SendUserFile. The owner posts it; I cannot post anywhere.

## Options

- `record.cjs`: `--lang ru|en|es|fr|tr|fa` (game language on screen),
  `--level easy|normal|hard` (the opponent; our side is played by the game's
  AI one level higher, so the board fills with real walls and we usually win),
  `--theme light|dark`, `--seconds N` (hard stop).
- `edit.sh <dir> "<hook>" "<call to action>" [speed]`: hook shows for the first
  3 s at the top, the call to action stays at the bottom, then a 2 s blue end
  card "WallRush / wallrush.online". Speed defaults to `auto` (match squeezed to
  about 24 s, never slower than 1.4×).

## How it works (and what to keep in sync)

- Filming uses the DevTools screencast (real device pixels). Playwright's own
  `recordVideo` films CSS pixels and put the page in a quarter of the frame.
- `record.cjs` rewrites `app.js` in the filming browser only: `b3dOn()` → true,
  and appends `window.__wr` (state, myIndex, submitMove). If those names change
  in app.js, update the regex and the appended line.
- The camera is driven by setting `#board` transform and `--tilt/--spin` — the
  same formula as `applyB3d()` / `b3dScale()` in app.js.
- Hook ideas that fit the game: «Перекрой ему путь», «Сможешь пройти?»,
  «Только стены и смекалка», «Он думал, что прошёл…». Keep to ~25 characters
  so the line fits at 74 px.

## Known limits

- A match can run past `--seconds` and then the reel ends before the win; give
  it 90–120 s, or record again.
- No music: platforms add their own trending audio, which also helps reach.
