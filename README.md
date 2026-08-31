# starling

Private location sharing for your circle. End to end encrypted, no accounts, no
phone numbers, and a relay that stores nothing it could ever read.

Life360 works by shipping everyone's location to a company. Starling keeps the
Life360 features people actually want (live map of your people, SOS, check-ins,
battery, invite links) and drops the surveillance: positions are encrypted on
your device with a key the server never sees, and the relay holds at most 24
hours of ciphertext.

## How it works

- Creating a circle generates a 32 byte secret on your device. It travels only
  inside invite links, in the URL fragment, which browsers never send to any
  server. Share the link over something you already trust, like Signal.
- Locations are AES-256-GCM encrypted with a key derived from that secret
  (HKDF-SHA-256). Names, avatars, and statuses ride inside the ciphertext too.
  Every plaintext is padded to exactly 512 bytes so message sizes carry nothing.
- Each device signs its posts with its own Ed25519 key (P-256 fallback). The
  relay pins the key on first write, so nobody can overwrite your slot, and a
  strictly increasing timestamp rule kills replays.
- The relay is a small Cloudflare Worker with a D1 table of ciphertext rows.
  It knows channel ids, ciphertext sizes, timing, and IPs. It never learns
  where you are or who your circle is. Rows expire after 24
  hours, deterministically, on every request.
- No push tokens, no analytics, no third party requests. The only external
  fetch in the whole app is OpenStreetMap tiles, and only when a street basemap
  is on; the Off-grid basemap renders locally and makes zero requests.

The exact wire format and crypto are in [docs/PROTOCOL.md](docs/PROTOCOL.md).
What the relay can and cannot learn, stated honestly, is in
[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md). If the code and those files ever
disagree, that is a bug.

## What it looks like

Dark-first UI, installable as a PWA. Draggable member sheet, live markers with
eased motion, trails, SOS hold-to-fire, check-ins, coarse mode (your device
rounds your position to about 1 km before encrypting), panic wipe, and a demo
you can run without sharing anything: open the app and hit Watch the demo.

Screenshots the test suite takes on every e2e run are in `test/screenshots/`.

## Sharing model

Sharing is off until you turn it on, and stopping posts a signed goodbye so
your circle sees "stopped" instead of a stale dot. This is live-when-open
sharing like Signal's, not an always-on tracker: when the OS suspends the tab,
sharing pauses. That is the honest ceiling of the web platform, and the app
says so instead of pretending otherwise.

## Run it

No build step, no dependencies to install.

```
# all 138 tests (crypto, wire, relay, QR, UI logic, manifest)
node --test test/*.test.mjs

# full two-browser e2e against the real relay code, plus screenshots
python3 test/e2e_marionette.py

# local dev server (app + relay on one origin)
node test/serve_local.mjs 8899
```

The e2e drives two headless Firefox profiles through create, invite, join,
live sharing, SOS, and stop, then dumps the relay database and asserts no
name and no coordinate appears anywhere in it.

## Deploy

The relay and the app ship as one Cloudflare Worker with static assets:

```
cd relay
wrangler d1 create starling        # put the id in wrangler.toml
wrangler d1 execute starling --file schema.sql --remote
wrangler deploy
```

Serve it on any domain with HTTPS and install it from the browser menu.
Geolocation needs a secure context, so plain HTTP will not work.

## QR codes

Invite QR codes are generated on-device by a from-scratch byte-mode encoder
(versions 1-10, EC level M, all masks). The test suite proves every matrix
byte-identical to the Python qrcode library across all mask patterns, so the
codes are correct by construction, not by eyeball.

## Roadmap

- Group ratchet for forward secrecy inside a circle's lifetime
- One-time guest links as short-lived side circles
- A store-distributed wrapper so app delivery is pinned, not fetched

## License

MIT
