#!/bin/bash
# One-command deploy for Starling: the relay worker plus the app as static
# assets, on one Cloudflare Worker. Idempotent, safe to re-run.
#
# Needs a Cloudflare API token with Workers Scripts:Edit, D1:Edit, and
# Account Settings:Read. Provide it either way:
#   export CLOUDFLARE_API_TOKEN=...     then run this
#   or run `wrangler login` first       (interactive browser auth)
#
#   bash deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

WORKER=starling
DB=starling
W=(npx --yes wrangler@latest)

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  T=$(secret-tool lookup service cloudflare-deploy 2>/dev/null || true)
  [ -n "$T" ] && export CLOUDFLARE_API_TOKEN="$T"
fi
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && ! "${W[@]}" whoami >/dev/null 2>&1; then
  echo "No Cloudflare auth. Set CLOUDFLARE_API_TOKEN or run: npx wrangler login"; exit 1
fi

echo "== 1/4 D1 database =="
DBID=$("${W[@]}" d1 list --json 2>/dev/null \
  | python3 -c "import sys,json;print(next((d['uuid'] for d in json.load(sys.stdin) if d.get('name')=='$DB'),''))" || true)
if [ -z "$DBID" ]; then
  OUT=$("${W[@]}" d1 create "$DB" 2>&1); echo "$OUT"
  DBID=$(printf '%s' "$OUT" | grep -oE '[0-9a-f-]{36}' | head -1)
fi
[ -n "$DBID" ] || { echo "could not resolve the D1 database id"; exit 1; }
echo "D1 $DB = $DBID"

# Pin the id into wrangler.toml so the binding resolves on deploy.
python3 - "$DBID" <<'PY'
import re, sys
p = "wrangler.toml"
s = open(p).read()
s = re.sub(r'database_id = ".*"', f'database_id = "{sys.argv[1]}"', s)
open(p, "w").write(s)
PY

echo "== 2/4 schema =="
"${W[@]}" d1 execute "$DB" --remote --yes --file schema.sql

echo "== 3/4 deploy =="
"${W[@]}" deploy

echo "== 4/4 health check =="
SUB=$("${W[@]}" whoami 2>/dev/null | grep -oE '[a-z0-9-]+\.workers\.dev' | head -1 || true)
URL="https://$WORKER.${SUB:-workers.dev}"
echo "trying $URL/api/v1/health"
for i in 1 2 3 4 5 6; do
  if curl -fsS "$URL/api/v1/health" 2>/dev/null | grep -q '"ok":true'; then
    echo "live: $URL"; exit 0
  fi
  echo "  not ready yet (new subdomains take a few minutes for TLS); retrying..."
  sleep 15
done
echo "Deployed. If the health check did not pass, the worker URL may still be provisioning TLS; open $URL shortly."
