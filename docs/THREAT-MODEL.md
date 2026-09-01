# Starling threat model

Written before the code, kept honest after it. Claims here are backed by tests
where a test can back them (see `test/`), and marked as limits where it cannot.

## What the relay can never learn

The relay (and anyone who compromises it, subpoenas it, or dumps its database)
gets ciphertext and metadata only:

- No positions. Locations are AES-256-GCM encrypted on the device with a key
  derived from the circle secret, which never leaves member devices.
  `test/e2e` asserts the relay database contains no plaintext coordinates or
  names after a real share session.
- No names, avatars, or circle names. All identity travels inside ciphertext.
  Member slots are random-looking ids derived from per-device public keys.
- No accounts, phone numbers, emails, or push tokens. There is nothing to link
  a channel to a person except traffic metadata.
- No history beyond the TTL. Rows expire at 24 h and there are no backups by
  design. A full seizure of the relay yields at most one day of ciphertext.

## What the relay does learn, honestly

- **IP addresses and timing.** Each poll and post reveals a source IP and a
  cadence. On top of an always-on VPN or Tor this drops to the exit's IP.
  This is the same residual metadata as any relay without mixnet padding.
- **Channel shape.** How many member slots a channel has, ciphertext sizes
  (fixed at 512 B plaintext exactly so sizes carry nothing), and update rhythm.
- **That you use Starling at all** (from the origin you talk to).

## Adversaries considered

| adversary | result |
|---|---|
| Relay operator, or attacker with full DB read | ciphertext + the metadata above; no positions, no identities |
| Attacker who scrapes a `channel_id` (128-bit, unguessable; would require relay compromise) | can fetch ciphertext they cannot decrypt; can write junk rows that fail GCM authentication on every member's device and render as nothing; cannot overwrite real members (writes are signature-checked against pinned keys) |
| Network attacker replaying captured requests | whole-body replay blocked at the relay by the strictly-increasing `ts` rule; cross-channel and cross-member replay blocked by AAD binding; stale-point replay dropped by receivers |
| Malicious circle member | already trusted with your location while you share; can spam or lie about their own position. Remedy is rotation: new secret, re-invite. Same trust model as a Signal group |
| Stolen unlocked phone, app lock OFF | attacker sees what the app shows and holds the circle secret. Panic wipe clears local state; rotating the circle from another device cuts the stolen device off within one TTL |
| Stolen unlocked phone, app lock ON | the circle secret is AES-256-GCM encrypted at rest under a random vault key, which is itself wrapped by a PBKDF2-SHA-256 (600k iterations) key from the passcode and, optionally, by a WebAuthn PRF secret gated behind device biometrics. A locked app holds no plaintext secret, vault key, or channel id in memory or on disk. The attacker must defeat the passcode (brute force bounded by the KDF) or the OS biometric to read anything, and a dump of IndexedDB yields only ciphertext. `test/e2e_lock.py` asserts the plaintext secret is deleted the moment lock turns on and that a reload comes back with no derivable channel |
| Malicious server operator shipping poisoned app JS | fatal, as for every web app including web clients of E2EE messengers. Mitigations: no third party scripts, strict CSP, subresource-free single origin, service worker pins the app shell. Real fix is a store-distributed native wrapper; out of scope for v1 |

## Design consequences (privacy first, opposite defaults to Life360)

- Sharing is **off** until you turn it on, and the UI always shows a live
  sharing indicator while it is on.
- Coarse mode degrades your position on your device before encryption, so even
  circle members only get neighborhood accuracy when that is what you chose.
- Stopping sharing is one tap and posts an authenticated `bye` so others see
  "stopped" instead of a silently stale dot.
- Map tiles come from a tile server when a basemap is on; that reveals your
  viewport to the tile host. The privacy basemap ("Off-grid") renders locally
  and makes zero tile requests. The settings screen explains this trade.
- No analytics, no telemetry, no crash reporting, no third party requests of
  any kind from the app origin.
- Optional app lock encrypts the circle secret at rest. It is off by default
  (like Signal's screen lock), turns on with a passcode, and can add biometric
  unlock where the browser supports the WebAuthn PRF extension. Auto-lock
  relocks after a chosen idle delay in the background, and every launch starts
  locked. The passcode is always the guaranteed unlock path; biometrics are an
  additive convenience that is only offered when it produces real key material.

## Known limits, stated plainly

1. **No forward secrecy within a circle's lifetime.** A device compromise plus a
   relay compromise within the same 24 h window exposes that window's
   ciphertext trail. Bounded by TTL, fixed properly only by a group ratchet,
   which is roadmap, not v1.
2. **Availability is not guaranteed.** The relay can drop or delay messages.
   It cannot forge or alter them (GCM + signatures), and staleness is visible
   in the UI ("last seen 4 min ago").
3. **A circle invite is a bearer capability.** Anyone holding the link joins
   silently. Share it over a trusted channel and rotate if it leaks. The invite
   screen says exactly this.
4. **Web platform ceiling.** Background sharing ends when the OS suspends the
   tab. Starling is honest about being live-when-open (plus a wake lock
   toggle), rather than pretending to be an always-on tracker.
5. **No external audit.** The constructions are deliberately boring
   (AES-GCM, HKDF, Ed25519, all through WebCrypto), the tests are real, and
   this document tries to be honest, but nobody independent has reviewed any
   of it. Until someone has, weigh every claim here accordingly.
6. **App-lock passcode strength is the user's.** The at-rest encryption is only
   as strong as the passcode behind it; PBKDF2 raises the cost of each guess but
   a four-digit PIN is still a four-digit PIN. There is no passcode recovery by
   design: a forgotten passcode means erasing the device and rejoining from an
   invite, because the secret is genuinely unrecoverable without it. Biometric
   unlock needs the WebAuthn PRF extension; where it is missing the app offers
   passcode only and says so rather than faking a biometric gate. PBKDF2 is the
   WebCrypto-native choice; an Argon2id (memory-hard) upgrade is roadmap and
   would require shipping a vetted WASM build and a narrow CSP allowance for it.

## Multiple circles

Since 0.3.0 a device can hold several circles, one active at a time. Each
circle has its own 32-byte secret, its own channel, and its own signing
identity, created fresh on join; the relay sees no link between the channels
a device belongs to. Polling and sharing happen only for the active circle.
At rest, inactive circles' names, secrets, profiles, and timestamps live in
one sealed blob under the same vault key as the active secret when the app
lock is on; their signing keys are non-extractable CryptoKeys stored beside
it, which means a locked device still reveals how many identities it holds
(exactly as it always has for the active one) but no names, secrets, or
channel ids. The ACTIVE circle's name and last-sent timestamp remain
plaintext at rest under lock, exactly as they always have for the single
circle; only inactive circles' names ride inside the sealed blob. Mid-switch
crash safety is duplicate-not-lose: the array grows to hold both circles
before the active slots change hands and shrinks only afterwards, lock
transitions make the destination form durable before the lock flag flips,
and boot and unlock reconciliation drop whatever duplicate a crash strands.

## The hosted web page does not open circles

As of 0.2.x the page at starlingmap.app is a landing plus the demo. It hides
the create and join paths, never decrypts a stored circle, and points invite
links at the app. Rationale: the web delivery channel is the weakest link in
this design (the poisoned-JS row above), and the browser offers no
OS-keystore-backed storage for a long-lived circle secret. Removing circles
from the hosted surface removes its value as a target. The full app still
runs on localhost for development, and the test suites exercise it there.

## Android app deltas

The Android app is the same `app/` code inside a native WebView wrapper.
Everything above still applies; this section states what changes and why
none of it weakens the core claim (the relay never sees a position).

- **Asset origin, no service worker.** App assets are bundled into the APK
  and served locally through `WebViewAssetLoader` at
  `https://appassets.androidplatform.net/`, which WebView treats as a
  secure context, so WebCrypto and IndexedDB behave the same as on the web.
  `sw.js` is never registered in the wrapper: there is nothing to cache
  offline when the app itself already ships as the offline copy. This also
  removes the service-worker-pins-the-shell mitigation the web threat model
  leans on for a compromised-server scenario, but the wrapper does not need
  it, since its assets ship in the signed APK rather than being fetched
  from the server on every load.
- **Keystore-backed biometric wrap, not WebAuthn PRF.** A plain WebView has
  no `navigator.credentials`, so the wrapper cannot use the web app's
  WebAuthn PRF path. It substitutes a native bridge: an AES-GCM key held in
  the Android Keystore with `setUserAuthenticationRequired(true)`, unlocked
  through `BiometricPrompt` with a `CryptoObject`. This is hardware-gated
  the same way PRF is (the key material never leaves secure hardware), and
  Android invalidates the Keystore key automatically when the user's
  biometric enrollment changes, closing the same "new fingerprint added by
  an attacker" gap PRF closes on the web. The passcode path (PBKDF2-SHA-256,
  600k iterations) is unchanged and remains the guaranteed unlock method.
- **Foreground service visibility.** Background location sharing runs as an
  Android foreground service, which Android requires to show a persistent,
  non-dismissible notification the entire time it runs. This is a design
  constraint the app leans into rather than works around: sharing is never
  silent, matching the same "always show a live sharing indicator"
  principle from the web app's design consequences above. The service
  requests fine and coarse location while-in-use only; it does not request
  `ACCESS_BACKGROUND_LOCATION`, and it only starts while the app has
  foreground state to begin with.
- **Panic trigger via PanicKit.** The app responds to
  `info.guardianproject.panic` `ACTION_TRIGGER` from a paired app (for
  example Ripple) by immediately wiping IndexedDB, localStorage, and
  WebView's storage and cache, with no confirmation step, then closing the
  activity. Pairing itself (`ACTION_CONNECT`) is a visible, user-initiated
  step, and the trigger handler checks the sender package against the
  paired app before acting, so an arbitrary app on the device cannot fire a
  wipe by sending the intent. This is the same effect as the in-app panic
  wipe button, reachable without unlocking the app first.
- **Tile fetches and relay visibility unchanged.** The Android app talks to
  the same relay over the same protocol, so everything in "What the relay
  does learn, honestly" above applies without modification: IP addresses,
  timing, and channel shape, never positions or identities. Map tile
  requests to `tile.openstreetmap.org` behave identically to the web app,
  including the Off-grid basemap's zero-request alternative.
- **Custom relay trust boundary.** The Android app exposes the same
  self-hosted relay setting as the web app. Pointing the app at a relay run
  by someone else, malicious or not, does not change what that relay can
  learn: ciphertext, IPs, and timing, the same set described above for the
  default relay. A malicious custom relay cannot read positions or
  identities any more than a malicious default-relay operator could,
  because the encryption boundary is the client, not the server a client
  happens to be configured to talk to. It could, however, refuse to expire
  data, drop or delay messages, or log metadata more aggressively than the
  default relay does; those are availability and metadata-retention risks,
  not confidentiality risks, and are the user's own choice when they pick a
  relay to trust.
