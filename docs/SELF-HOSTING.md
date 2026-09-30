# Self-hosting the relay on a plain server

Starling's default relay runs on Cloudflare Workers, at starlingmap.app. You
do not need Cloudflare, or any specific host, to run your own: the relay is
a small piece of code in `relay/src/index.js` that reads and writes one SQL
table, and `relay/server.mjs` runs that exact code under plain Node with a
file-backed SQLite database standing in for D1. It is the same code the test
suite runs against, in-process, on every commit (`test/relay.test.mjs`); the
plain server is a different way of getting requests to it, not a
reimplementation of it.

This is for a VPS, a home server, or a machine you already run something
else on, behind Apache or nginx. If you would rather use a Cloudflare
account, `relay/deploy.sh` still does that in one command; see the [main
README](../README.md#deploy).

## What you get, and what you do not

The relay stores ciphertext, pinned public keys, and timing, and never has a
decryption key for any of it, on Cloudflare or here. What changes when you
self-host: your server sees the source IP address and request timing that
would otherwise go to Cloudflare, and you hold the SQLite file instead of a
D1 database. Every row still expires after 24 hours (`TTL_MS` in
`app/js/wire.js`); that does not change either.

The relay does not serve the web app. `relay/server.mjs` answers `/api/v2/*`
and `/.well-known/assetlinks.json` only, the same routes the Worker answers.
Serving `app/` as static files is a separate job; run it behind the same
reverse proxy on another path, use any static host, or skip it and only run
the relay if your circle only needs the Android app.

## Requirements

- Node 24 or newer (`node --version`; the relay uses `node:sqlite`, and the
  package's `engines` field already pins 24 for the whole repo).
- A reverse proxy that terminates TLS: Apache or nginx both work, examples
  below. The wrapped apps' custom relay setting only accepts an `https://`
  URL (`normalizeRelay` in `app/js/env.js` rejects `http://` outright), so
  plain HTTP alone is not an option regardless of the proxy.
- A domain or subdomain with a certificate: an existing site's certificate,
  Let's Encrypt, your own CA if your circle already trusts it.

## Install and run

```
git clone https://github.com/munzzyy/starling.git
cd starling
npm ci
node relay/server.mjs
```

That starts the relay on `127.0.0.1:8788` with a database file at
`relay/data/starling.db`, created on first run. It listens on loopback only
by default; the reverse proxy is what faces the internet. Configuration is
environment variables, matching the vars a Cloudflare deploy sets in
`relay/wrangler.toml`:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8788` | TCP port to listen on |
| `HOST` | `127.0.0.1` | address to bind; keep this loopback behind a proxy |
| `STARLING_DB_PATH` | `relay/data/starling.db` | the SQLite file; created if missing |
| `TRUST_PROXY` | unset (off) | see below; set to `1` when running behind Apache or nginx |
| `PUBLIC_ORIGIN` | `http://<HOST>:<PORT>` | the origin the relay treats as its own, for the same-origin check `originAllowed` does. Set this to your public `https://` origin |
| `RATE_POST_MIN` | 256 | writes per channel per minute; see the comment above it in `relay/src/index.js` for the arithmetic |
| `RATE_GET_MIN` | 240 | requests per client address per minute, reads and writes together |
| `ALLOWED_ORIGINS` | unset | comma-separated origins allowed to POST, beyond the relay's own origin and the app wrapper origins |
| `SWEEP_INTERVAL_MS` | 600000 (10 min) | how often an idle-channel sweep runs |

Stop it with Ctrl-C or `kill -TERM <pid>`; it stops taking connections,
drops any still open (the apps retry), closes the database cleanly, and
exits. A crash or `kill -9` is not
graceful, but it is not destructive: SQLite's WAL mode (on automatically for
a file-backed database) means the file is never left half-written, only
possibly missing the last few seconds of writes.

### Running it as a service

A systemd unit, adjust the paths and user:

```ini
# /etc/systemd/system/starling-relay.service
[Unit]
Description=Starling relay
After=network.target

[Service]
Type=simple
User=starling
WorkingDirectory=/opt/starling
Environment=PORT=8788
Environment=HOST=127.0.0.1
Environment=STARLING_DB_PATH=/var/lib/starling/relay.db
Environment=TRUST_PROXY=1
Environment=PUBLIC_ORIGIN=https://relay.example.org
ExecStart=/usr/bin/node relay/server.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/starling
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```
sudo mkdir -p /var/lib/starling && sudo chown starling:starling /var/lib/starling
sudo systemctl daemon-reload
sudo systemctl enable --now starling-relay
```

## Client IP behind a reverse proxy: `TRUST_PROXY`

`RATE_GET_MIN` is a per-address budget, and by default the relay reads the
real TCP connection's address. Behind Apache or nginx every request instead
arrives from the proxy's own address, so without a change every visitor
would share one rate-limit bucket. `TRUST_PROXY=1` tells the relay to read
the client address from `X-Forwarded-For` instead, but only the **last**
entry: a client cannot append after the proxy does, so that entry is the one
thing in the header a single reverse proxy in front of this process can
actually vouch for. Leave it unset if the relay is reachable directly, with
no proxy in front; turning it on with no proxy in the picture would let any
client set its own rate-limit identity via the header.

## Apache

Requires `mod_proxy`, `mod_proxy_http`, and `mod_headers`.

```apache
<VirtualHost *:443>
    ServerName relay.example.org

    SSLEngine on
    SSLCertificateFile      /etc/letsencrypt/live/relay.example.org/fullchain.pem
    SSLCertificateKeyFile   /etc/letsencrypt/live/relay.example.org/privkey.pem

    ProxyRequests Off
    ProxyPreserveHost On

    ProxyPass        /api/         http://127.0.0.1:8788/api/
    ProxyPassReverse /api/         http://127.0.0.1:8788/api/
    ProxyPass        /.well-known/ http://127.0.0.1:8788/.well-known/
    ProxyPassReverse /.well-known/ http://127.0.0.1:8788/.well-known/

    RequestHeader set X-Forwarded-Proto "https"
    # mod_proxy appends the real client address to X-Forwarded-For itself.
</VirtualHost>
```

## nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name relay.example.org;

    ssl_certificate     /etc/letsencrypt/live/relay.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.org/privkey.pem;

    location ~ ^/(api|\.well-known)/ {
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

`$proxy_add_x_forwarded_for` appends the real client address to whatever
`X-Forwarded-For` arrived with the request, same as `mod_proxy` does, which
is what makes the last hop trustworthy under `TRUST_PROXY=1`.

## Pointing the app at it

The Android and iOS apps always have the Settings option for a custom relay:
enter your relay's `https://` origin (for example
`https://relay.example.org`), no trailing slash needed. Everyone you are
sharing with sets the same custom relay, the same way an invite already
requires everyone to be on the same circle secret.

The hosted web app at starlingmap.app cannot be pointed at a custom relay.
Its server sends a `Content-Security-Policy` header pinning `connect-src` to
`'self'` (`app/_headers`), and a page under two CSPs, a header and its own
`<meta>` tag, is bound by their intersection, so the page's own tag allowing
`https:` does not widen it. If you serve `app/` yourself, on any static host
or the same Apache vhost as the relay, without that header, only the `<meta>`
CSP applies and a custom relay works from the web app too. If you serve the
app on a different origin than the relay, add the app's origin to
`ALLOWED_ORIGINS` so the relay accepts its writes.

## Backups

The database is one file, `STARLING_DB_PATH` (plus `-wal` and `-shm`
siblings while running). Every row expires within 24 hours regardless, so a
backup restores very little that is still current.

## Updating

```
git pull
npm ci
sudo systemctl restart starling-relay   # or however you run it
```

The schema (`relay/schema.sql`) is applied on every start, the same file
`deploy.sh` runs against D1, and every statement in it is
`CREATE TABLE IF NOT EXISTS` plus a migration that only drops already-retired
tables, so restarting against an existing database file is always safe and
never loses current data.

## What your server sees

Matching what `docs/THREAT-MODEL.md` says about the default relay: your
server sees the source IP address and request timing of every poll and post,
channel ids (unguessable but not secret from the relay), and padded request
sizes. It never sees a position, a name, or a circle membership; that
boundary is the client, not whichever server it is pointed at. Self-hosting
moves who holds that observation from Cloudflare to you.
