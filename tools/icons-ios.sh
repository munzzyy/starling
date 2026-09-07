#!/bin/bash
# Regenerates the iOS app icon from the SVG source. iOS wants a full-bleed
# opaque square; the app background fills the corners invisibly and iOS
# applies its own mask.
set -euo pipefail
cd "$(dirname "$0")/.."
magick -size 1024x1024 xc:'#0a0d14' \
  \( -background none app/icons/starling.svg -resize 1024x1024 \) \
  -composite -alpha off ios/Assets.xcassets/AppIcon.appiconset/AppIcon1024.png
echo "ios icon regenerated"
