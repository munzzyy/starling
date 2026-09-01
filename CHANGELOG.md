# Changelog

All notable changes to Starling are recorded here. Versions follow
[semantic versioning](https://semver.org).

## [0.3.0]

- Multiple circles. Keep family, friends, and the trip as separate circles
  and switch between them from the circle name at the top of the map. Each
  circle has its own secret, its own channel, and its own signing identity,
  so the relay cannot link them. Create and join now add a circle instead of
  replacing the one you have, invites you already accepted just switch, and
  settings grows a leave option with a typed confirm. With the app lock on,
  every circle secret and name seals under the same vault key.
- The hosted website is now a landing page and demo only: it refuses to
  create or open circles, shows invite links the way to the app, and offers
  an eraser for data stored by the old web app. Sharing is app-only; the
  full app still runs on localhost for development.
- The landing and privacy policy now spell out the IP story: members never
  see each other's IPs, and Orbot routing hides yours from the relay.

## [0.2.0]

- Android app: a hand-written Kotlin WebView wrapper around the same `app/`
  code, targeting both Google Play and F-Droid. Adds background sharing
  through a foreground service with a persistent notification, fingerprint
  or face unlock through the Android Keystore in place of WebAuthn PRF, a
  PanicKit responder for panic-button apps, and Orbot support (per-app VPN
  mode with no setup, plus an in-app SOCKS toggle for Orbot's Power User
  Mode).
- Custom relay setting, on both the web app and the Android wrapper, so
  anyone can point their client at a self-hosted relay instead of the
  default one. The relay's allowed origins now include the WebView asset
  origin and an optional operator-configured list for self-hosters.
- Leaflet moved from a vendored, committed copy to a normal npm dependency
  pinned by `package-lock.json`. `tools/sync-vendor.sh` copies the
  unminified build into `app/vendor/leaflet` at build time instead of that
  directory living in git, which is also what makes the app buildable from
  source for F-Droid.

## [0.1.0]

First release.

- End to end encrypted location sharing in circles: AES-256-GCM under an
  HKDF-derived key from a 32-byte circle secret that only travels in invite-link
  fragments. Per-device Ed25519 signing (P-256 fallback) with key pinning at the
  relay. Plaintext padded to a fixed 512 bytes so ciphertext size carries
  nothing.
- Zero-knowledge relay as a Cloudflare Worker over D1. Stores ciphertext and
  pinned keys only, pages the feed on server receive time, and expires every row
  after 24 hours. Non-enumerable channels, per-channel and per-IP rate limits,
  a same-origin write check, and uniform error responses.
- Installable PWA: live map with eased markers and trails, draggable member
  sheet, SOS hold-to-fire, check-ins, battery, coarse (neighborhood) mode, a
  privacy "Off-grid" basemap that makes zero network requests, an offline demo,
  and a panic wipe.
- App lock: optional at-rest encryption of the circle secret behind a passcode
  (PBKDF2-SHA-256, 600k iterations) and, where supported, biometric unlock via
  the WebAuthn PRF extension. Off by default, auto-lock, and locked on launch.
- Invite QR codes from an in-repo byte-mode encoder, proven matrix-identical to
  the reference library across every mask.
- 153 unit tests plus two headless-browser end to end suites, one of which dumps
  the relay database and asserts no name or coordinate appears in it.
