#!/bin/bash
# Rebuild tools/adblock-generic-rules.txt from the upstream filter lists.
# Needs network. Run it every few months, or when a new asset name feels risky.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

for u in https://easylist.to/easylist/easyprivacy.txt \
         https://easylist.to/easylist/easylist.txt \
         https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt \
         https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt; do
  curl -sfL --max-time 60 "$u" -o "$tmp/$(basename "$u")" || { echo "fetch failed: $u"; exit 1; }
done

# Keep only rules that match on filename alone: no domain anchor, no options,
# no cosmetic selector, no exception. Those are the ones that can hit a
# first-party asset on any site.
cat "$tmp"/*.txt \
  | grep -v '^!' | grep -v '##' | grep -v '^@@' | grep -v '^||' \
  | grep -E '^/[a-z0-9_.-]+\.(js|css|gif|png|jpg|jpeg|svg|json|php|html|htm)$' \
  | sort -u > "$tmp/rules"

head -14 tools/adblock-generic-rules.txt | grep '^#' > "$tmp/out"
sed -i "s|^# Extracted [0-9-]* from|# Extracted $(date +%F) from|" "$tmp/out"
cat "$tmp/rules" >> "$tmp/out"
mv "$tmp/out" tools/adblock-generic-rules.txt
echo "adblock-generic-rules.txt: $(grep -c '^/' tools/adblock-generic-rules.txt) rules"
