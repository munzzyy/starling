# Changelog

All notable changes to Starling are recorded here. Versions follow
[semantic versioning](https://semver.org).

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
