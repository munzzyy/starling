# starling

Private location sharing for your circle. End to end encrypted, no accounts, no
phone numbers, and a relay that stores nothing it could ever read.

[![CI](https://github.com/munzzyy/starling/actions/workflows/ci.yml/badge.svg)](https://github.com/munzzyy/starling/actions/workflows/ci.yml)

**Live:** [starling.munzzyy.workers.dev](https://starling.munzzyy.workers.dev) ·
open it on your phone and add it to your home screen.

Life360 works by shipping everyone's location to a company. Starling keeps the
Life360 features people actually want (live map of your people, SOS, check-ins,
battery, invite links) and drops the surveillance: positions are encrypted on
your device with a key the server never sees, and the relay holds at most 24
hours of ciphertext.

![The map with your circle on it](test/screenshots/hero-dark-map.png)

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
- Optional app lock encrypts the circle secret at rest behind a passcode
  (PBKDF2-SHA-256, 600k iterations) and, where the browser supports it, a
  biometric unlock through the WebAuthn PRF extension. A locked device holds no
  readable secret in memory or on disk.

The exact wire format and crypto are in [docs/PROTOCOL.md](docs/PROTOCOL.md).
What the relay can and cannot learn, stated honestly, is in
[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md). If the code and those files ever
disagree, that is a bug.

## What it looks like

Dark-first UI, installable as a PWA. Draggable member sheet, live markers with
eased motion, trails, SOS hold-to-fire, check-ins, coarse mode (your device
rounds your position to about 1 km before encrypting), panic wipe, and a demo
you can run without sharing anything: open the app and hit Watch the demo.

| Onboarding | The demo | Invite | App lock |
|---|---|---|---|
| ![](test/screenshots/01-onboarding.png) | ![](test/screenshots/06-demo.png) | ![](test/screenshots/03-invite-qr.png) | ![](test/screenshots/07-lock.png) |

The `test/screenshots/` set is regenerated on every end to end run.

## Sharing model

Sharing is off until you turn it on, and stopping posts a signed goodbye so
your circle sees "stopped" instead of a stale dot. This is live-when-open
sharing like Signal's, not an always-on tracker: when the OS suspends the tab,
sharing pauses. That is the honest ceiling of the web platform, and the app
says so instead of pretending otherwise.

## Run it

No build step, no dependencies to install. Needs Node 24 or newer.

```
# all 153 unit tests (crypto, wire, relay, QR, UI logic, lock, manifest)
node --test test/*.test.mjs

# local dev server (app + relay on one origin)
node test/serve_local.mjs 8899

# the two headless-Firefox end to end suites
python3 test/e2e_marionette.py   # sharing: create, invite, join, SOS, stop
python3 test/e2e_lock.py         # the app-lock lifecycle
```

The sharing e2e drives two headless Firefox profiles through create, invite,
join, live sharing, SOS, and stop, then dumps the relay database and asserts no
name and no coordinate appears anywhere in it.

## Deploy

The relay and the app ship as one Cloudflare Worker with static assets. With a
Cloudflare API token in `CLOUDFLARE_API_TOKEN` (Workers Scripts, D1, and Account
Settings read), one command creates the database, applies the schema, and
deploys:

```
bash relay/deploy.sh
```

It is idempotent, so re-running it just ships the latest code. Serve it on any
origin with HTTPS and install it from the browser menu. Geolocation needs a
secure context, so plain HTTP will not work.

## QR codes

Invite QR codes are generated on-device by a from-scratch byte-mode encoder
(versions 1-10, EC level M, all masks). The test suite proves every matrix
byte-identical to the Python qrcode library across all mask patterns, so the
codes are correct by construction, not by eyeball.

## What it does not do

Being clear about the edges is part of the point.

- **It is live-when-open, not an always-on tracker.** When the OS suspends the
  tab, sharing pauses. A wake-lock toggle helps while the screen is on; true
  background location needs a native app.
- **The relay still sees metadata.** It cannot see your position or who you are,
  but it sees IP addresses, timing, and how many members a channel has. On top
  of a VPN or Tor this drops to the exit's IP. See the threat model.
- **No forward secrecy within a circle's lifetime yet.** The content key is
  static until you rotate the circle; exposure is bounded by the 24-hour relay
  retention instead. A group ratchet is roadmap.
- **An invite link is a bearer capability.** Anyone with the link is in the
  circle. Share it over something you trust, and rotate if it leaks.
- **It is a web app.** If someone serves you poisoned JavaScript, that is fatal,
  the same as for any web client of any encrypted service. The mitigations are a
  strict CSP, no third party scripts, and a service worker that pins the shell;
  the real fix is a store-distributed wrapper.

## Roadmap

- Group ratchet for forward secrecy inside a circle's lifetime
- Argon2id (memory-hard) app-lock KDF via a vetted WASM build
- One-time guest links as short-lived side circles
- A store-distributed wrapper so app delivery is pinned, not fetched

## License

MIT

