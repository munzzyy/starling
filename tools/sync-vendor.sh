#!/bin/bash
# Populate app/vendor from npm packages. The vendor directory is generated,
# not committed: F-Droid and CI fetch dependencies from the npm registry with
# lockfile integrity pins and run this, so no prebuilt blob lives in git.
# The unminified build ships everywhere (web and Android alike): identical
# bytes on both hosts, and anyone auditing the APK reads real source.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=node_modules/leaflet/dist
DST=app/vendor/leaflet

[ -f "$SRC/leaflet-src.js" ] || { echo "leaflet is not installed. Run: npm ci"; exit 1; }

mkdir -p "$DST"
rm -rf "$DST/images"
cp "$SRC/leaflet-src.js" "$DST/leaflet.js"
# The file's sourceMappingURL trailer names leaflet-src.js.map; ship it under
# that name so devtools resolve it instead of logging 404s.
cp "$SRC/leaflet-src.js.map" "$DST/leaflet-src.js.map"
cp "$SRC/leaflet.css" "$DST/leaflet.css"
cp -r "$SRC/images" "$DST/images"

echo "vendor synced: leaflet $(node -p 'require("leaflet/package.json").version') (unminified)"
