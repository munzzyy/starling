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

The relay stores ciphertext, pinned public keys, and timing. It never has a
decryption key for anything it stores, on Cloudflare or here; that is a
property of the client-side encryption, not of who hosts the relay, and it
does not change when you self-host. What does change: your server sees the
source IP address and request timing that would otherwise go to Cloudflare,
and you hold the SQLite file instead of a D1 database, so a backup, a leak,
or a subpoena aimed at your server gets exactly what one aimed at Cloudflare
would: ciphertext, pinned keys, and timing, nothing that decrypts a position
or names a circle member. Every row still expires after 24 hours
(`TTL_MS` in `app/js/wire.js`); nothing here changes that either.

The relay does not serve the web app. `relay/server.mjs` answers `/api/v2/*`
and `/.well-known/assetlinks.json` only, the same routes the Worker answers,
because those are the paths a signature check and a request-shape check
actually guard. Serving `app/` as static files is a separate job; run it
behind the same reverse proxy on another path, use any static host, or skip
it and only run the relay if your circle only needs the Android app.

## Requirements

- Node 24 or newer (`node --version`; the relay uses `node:sqlite`, and the
  package's `engines` field already pins 24 for the whole repo).
- A reverse proxy that terminates TLS: Apache or nginx both work, examples
  below. The app's custom relay setting only accepts an `https://` URL
  (`normalizeRelay` in `app/js/env.js` rejects `http://` outright), so
  plain HTTP alone is not an option regardless of the proxy.
- A domain or subdomain with a certificate. Anything that gets you a cert
  works: an existing site's certificate, Let's Encrypt, your own CA if your
  circle already trusts it.

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
| `SWEEP_INTERVAL_MS` | 600000 (10 min) | how often an idle-channel sweep runs; see "The TTL sweep" below |

Stop it with Ctrl-C or `kill -TERM <pid>`; it finishes in-flight requests,
closes the database cleanly, and exits. A crash or `kill -9` is not
graceful, but it is not destructive either: SQLite's WAL mode (turned on
automatically for a file-backed database) means the file is never left in a
half-written state, only possibly missing the last few seconds of writes.

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

`RATE_GET_MIN` is a per-address budget. Every request that reaches the relay
process directly from a browser or the app carries the real client address
on the TCP connection, and that is what the relay uses by default. Put
Apache or nginx in front and every request instead arrives from the proxy's
own address, on the proxy's own connection to the relay: without a change,
every visitor your proxy serves would share one rate-limit bucket, and a
few circles behind it would trip `RATE_GET_MIN` for everyone.

Both Apache and nginx solve this by appending the real client address to an
`X-Forwarded-For` header on the request they forward. `TRUST_PROXY=1` tells
the relay to read that header, but only the **last** entry in it, the one
your proxy appended: a client cannot append after the proxy does, so that
entry is the one thing in the header a single reverse proxy in front of this
process can actually vouch for. Anything earlier in the header, including a
client-supplied first hop, is never trusted; a client could put anything
there.

Leave `TRUST_PROXY` unset if the relay is reachable directly, with no
reverse proxy in front. Turning it on with no proxy in the picture would let
any client set its own rate-limit identity via the header.

## Apache

Requires `mod_proxy`, `mod_proxy_http`, and `mod_headers`.

```apache
<VirtualHost *:443>
    ServerName relay.example.org

    SSLEngine on
    SSLCertificateFile      /etc/letsencrypt/live/relay.example.org/fullchain.pem
    SSLCertificateKeyFile   /etc/letsencrypt/live/relay.example.org/privkey.pem

    # The relay answers small JSON in one shot; buffering does not help it
    # and only adds latency to a poll loop that already runs every few
    # seconds.
    ProxyRequests Off
    ProxyPreserveHost On
    SSLProxyEngine on
    ProxyIOBufferSize 8192

    ProxyPass        /api/         http://127.0.0.1:8788/api/
    ProxyPassReverse /api/         http://127.0.0.1:8788/api/
    ProxyPass        /.well-known/ http://127.0.0.1:8788/.well-known/
    ProxyPassReverse /.well-known/ http://127.0.0.1:8788/.well-known/

    RequestHeader set X-Forwarded-Proto "https"
    # mod_proxy sets X-Forwarded-For itself, appending the real client
    # address; nothing to configure for TRUST_PROXY to have something
    # correct to read.
</VirtualHost>
```

## nginx

```nginx
server {
    listen 443 ssl http2;
    server_name relay.example.org;

    ssl_certificate     /etc/letsencrypt/live/relay.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.org/privkey.pem;

    location ~ ^/(api|\.well-known)/ {
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # The relay's answers are tiny JSON bodies; buffering just adds
        # latency to a poll loop that already runs every few seconds.
        proxy_buffering off;
    }
}
```

`$proxy_add_x_forwarded_for` appends the real client address to whatever
`X-Forwarded-For` arrived with the request, same as `mod_proxy` does, which
is what makes the last hop trustworthy under `TRUST_PROXY=1`.

## Pointing the app at it

In the app, open Settings and enter your relay's `https://` origin (for
example `https://relay.example.org`), no trailing slash needed, no path
beyond an optional prefix if you proxied it under one. This is the same
setting the Android and web apps have always had for a custom relay; nothing
about this self-hosted relay needs a different client, an older protocol
version, or a special build. Everyone you are sharing with needs to set the
same custom relay, the same way an invite already requires everyone to be
on the same circle secret.

## Backups

The whole database is one file, `STARLING_DB_PATH` (plus `-wal` and `-shm`
siblings while the process is running). Back it up like any SQLite file: a
copy taken while the server is running can miss the last few seconds of
writes sitting in the WAL, which does not matter here, because every row is
gone again within 24 hours regardless. There is nothing worth restoring from
an old backup: a restored file just replays already-expired, already-deleted
positions, so the honest answer is that backing this database up buys you
very little. Keep one only if you want a paper trail that the relay was
running.

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

Worth saying plainly, matching what `docs/THREAT-MODEL.md` says about the
default relay: your server, and anything with access to it, sees the source
IP address and request timing of every poll and post that reaches it,
because something has to move ciphertext between devices and that requires
knowing where to send it. It sees channel ids, which are unguessable but not
secret from the relay itself, and it sees request sizes (the wire format
pads every message to a fixed length precisely so this is not informative).
It never sees a position, a name, a circle membership, or anything that
decrypts any of those; that boundary is the client, not whichever server the
client happens to be pointed at. Self-hosting moves who holds that
observation from Cloudflare to you; it does not remove the observation
itself, and this document is not trying to imply otherwise.
