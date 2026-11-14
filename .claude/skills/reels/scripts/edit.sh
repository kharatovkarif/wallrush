#!/usr/bin/env bash
# Turns the frames from record.cjs into a finished 9:16 reel (H.264 MP4, 30 fps).
#
#   edit.sh <dir-with-raw.webm-and-marks.json> "<hook text>" "<call to action>" [speed]
#
# - cuts the menu clicks off the front and keeps the match + the result screen
# - speeds the match up to about 24 s (or a given factor) so it reads as a highlight
# - hook text across the top for the first 3 seconds, the call to action across
#   the bottom the whole time, then a 2-second end card with the address
# - a silent audio track, so every app accepts it (people add music in the app)
set -euo pipefail
DIR="$1"; HOOK="${2:-Перекрой ему путь}"; CTA="${3:-Играй бесплатно: wallrush.online}"; SPEED="${4:-auto}"
# auto: whatever speed brings the match to about 24 seconds (never slower than 1.4x)
if [ "$SPEED" = "auto" ]; then
  SPEED=$(node -e "const m=require('$DIR/marks.json'); console.log(Math.max(1.4, (m.end - m.gameStart) / 24).toFixed(2))")
fi
FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
START=$(node -e "const m=require('$DIR/marks.json'); console.log(Math.max(0, m.gameStart - 0.3))")
END=$(node -e "const m=require('$DIR/marks.json'); console.log(m.end)")

# drawtext wants its text in files when it carries spaces, colons or Cyrillic
printf '%s' "$HOOK" > "$DIR/hook.txt"
printf '%s' "$CTA" > "$DIR/cta.txt"
printf '%s' "wallrush.online" > "$DIR/site.txt"
printf '%s' "WallRush" > "$DIR/name.txt"

# the frames as one even 30 fps stream first, then cut and speed it up
ffmpeg -y -loglevel error -f concat -safe 0 -i "$DIR/frames.txt" -vf "fps=30,scale=1080:1920:flags=lanczos" -c:v libx264 -preset veryfast -crf 16 -pix_fmt yuv420p "$DIR/raw.mp4"
ffmpeg -y -loglevel error -ss "$START" -to "$END" -i "$DIR/raw.mp4" -vf "\
setpts=PTS/$SPEED,fps=30,\
drawbox=x=0:y=0:w=iw:h=260:color=0x1d2440@0.85:t=fill:enable='lt(t,3)',\
drawtext=fontfile=$FONT:textfile=$DIR/hook.txt:fontsize=74:fontcolor=white:x=(w-tw)/2:y=90:enable='lt(t,3)',\
drawbox=x=0:y=ih-230:w=iw:h=230:color=0x2f6df6@0.92:t=fill,\
drawtext=fontfile=$FONT:textfile=$DIR/cta.txt:fontsize=50:fontcolor=white:x=(w-tw)/2:y=h-145" \
  -an -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p "$DIR/body.mp4"

# end card: the game's blue, the name, the address
ffmpeg -y -loglevel error -f lavfi -i "color=c=0x2f6df6:s=1080x1920:d=2:r=30" -vf "\
drawtext=fontfile=$FONT:textfile=$DIR/name.txt:fontsize=150:fontcolor=white:x=(w-tw)/2:y=(h/2)-170,\
drawtext=fontfile=$FONT:textfile=$DIR/site.txt:fontsize=80:fontcolor=white@0.92:x=(w-tw)/2:y=(h/2)+40" \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p "$DIR/end.mp4"

printf "file '%s'\nfile '%s'\n" "$DIR/body.mp4" "$DIR/end.mp4" > "$DIR/list.txt"
ffmpeg -y -loglevel error -f concat -safe 0 -i "$DIR/list.txt" \
  -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -shortest \
  -c:v copy -c:a aac -b:a 128k -movflags +faststart "$DIR/reel.mp4"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$DIR/reel.mp4" | xargs printf 'reel.mp4: %.1f s\n'
