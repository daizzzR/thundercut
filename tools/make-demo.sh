#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Original geometric/text demonstration; no downloaded assets.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'color=c=0x171d34:s=960x540:d=5:r=24' \
  -f lavfi -i 'sine=frequency=440:duration=5' \
  -vf "drawbox=x=0:y=0:w=iw:h=12:color=0xa8f073:t=fill,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='PLOT TWIST':fontcolor=0xa8f073:fontsize=76:x=(w-tw)/2:y=170,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='Your local clip goes here.':fontcolor=white:fontsize=30:x=(w-tw)/2:y=280" \
  -af 'volume=0.06,afade=t=in:d=0.15,afade=t=out:st=4.4:d=0.6' \
  -c:v libvpx-vp9 -b:v 350k -c:a libopus -shortest extension/videos/default.webm
