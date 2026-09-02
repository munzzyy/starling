# Starling threat model

Written before the code, kept honest after it. Claims here are backed by tests
where a test can back them (see `test/`), and marked as limits where it
cannot. This is protocol v2: forward secrecy, post-compromise security, and
cryptographic member removal, and as of 0.5.0 it is wired end to end, crypto
core through relay through storage through UI, on web and on Android. Read
[docs/AUDIT.md](AUDIT.md) for the file:line map of where each property lives
and for the questions we most want an independent auditor to attack first.
Nobody has done that audit yet; see "No human security audit" below.

## What changed from v1

- **Forward secrecy**, bounded by the history window. Content keys advance
  once per 10-minute epoch and the previous key is destroyed on the device
  that advanced past it. A device can only ever be made to give up the trail
  still inside its retained window (10 minutes to 24 hours, a user setting),
  never anything older.
- **Post-compromise security.** A re-key mixes fresh ECDH entropy into a new
  generation with its own chain and its own channel. Holding today's keys
  says nothing about tomorrow's, once someone re-keys.
- **Member removal is now cryptographic**, not advisory. Removing someone is
  a re-key that excludes them: they receive no wrap, derive no new seed, and
  cannot follow the circle to its next channel. A v1 removal only asked
  everyone else to rotate; it did not, by itself, stop the removed device
  from reading anything it already held.
- **Invites are one-time credentials**, not bearer tokens. A v1 invite link
  carried the circle secret itself, so anyone who ever saw the link held
  every past and future key it protected. A v2 invite bootstraps a pairwise
  handshake; the circle's actual key material is handed over only after a
  human accepts the joiner's safety number, and the invite is burned the
  moment that happens. The link also carries a 128-bit commitment to the
  inviter's keypair, and the joiner refuses a welcome from anybody else. That
  is what makes the direction nobody thinks about safe: without it, whoever
  else saw the link could answer it first, seal a circle of their own to the
  joiner, and own the joining device while the app said "You joined".
- **Beacon links are per-viewer and revocable, with an expiry that is
  actually enforced.** Each person you send help to gets their own secret and
  their own derived channel; revoking one stops posting to that channel and
  sends it a final `bye` without touching the others. Past its expiry the
  viewer page stops polling on its own, and the beacon stops posting to that
  viewer's channel, on both ends, independent of each other.

## What the relay can never learn

The relay (and anyone who compromises it, subpoenas it, or dumps its
database) gets ciphertext and metadata only:

- No positions. Locations are AES-256-GCM encrypted on the device with a key
  that never leaves member devices, per-epoch and per-sender so no two
  members and no two epochs ever share a key.
- No names, avatars, or circle names. All identity travels inside ciphertext.
  Member slots are ids derived from two public keys (signing and agreement),
  not from anything a relay chose or assigned.
- No accounts, phone numbers, emails, or push tokens. There is nothing to
  link a channel to a person except traffic metadata.
- No history beyond the TTL. Rows expire at 24 h and there are no backups by
  design. A full seizure of the relay yields at most one day of ciphertext,
  and less than that for any epoch a device has already advanced past.

## What the relay does learn, honestly

- **IP addresses and timing.** Each poll and post reveals a source IP and a
  cadence. On top of an always-on VPN or Tor this drops to the exit's IP.
  There is no cover traffic between members, no mixnet, no private
  information retrieval. A "steady cadence" setting exists and posts on a
  fixed interval whether or not a member has moved, which hides *when* a
  member moves; it is a real, smaller property, not a substitute for cover
  traffic, and it does nothing about the fact that the relay still sees a
  post arrive on that cadence from that IP.
- **How many members post to a channel.** Channel shape (member slot count,
  update rhythm) is visible; ciphertext sizes carry nothing, because every
  message type pads to the same fixed length regardless of what it is.
- **A correlation signal between an SOS and its circle.** Firing an SOS opens
  a second channel, on its own key material, from the same device, at the
  same instant, as the circle's own channel. The keys are unlinkable by
  construction; the timing is not. A relay operator watching arrival times
  does not need to break any cryptography to notice that two channels tend to
  update together from one IP address. This is a real gap, not a theoretical
  one, and nothing in the design closes it.
- **That you use Starling at all** (from the origin you talk to).

## Adversaries considered

| adversary | result |
|---|---|
| Relay operator, or attacker with full DB read | ciphertext plus the metadata above; no positions, no identities, and no epoch older than what a device's retained history window still holds |
| Attacker who scrapes a `channel_id` (128-bit, unguessable; would require relay compromise) | can fetch ciphertext they cannot decrypt without a device's retained keys; can write junk rows that fail GCM authentication on every member's device and render as nothing; cannot overwrite real members (writes are signature-checked against pinned keys) |
| Network attacker replaying captured requests | blocked by the strictly-increasing `(epoch, ts)` rule receivers enforce themselves, independent of the relay; cross-channel and cross-member replay blocked by AAD binding, which now also binds the epoch |
| Malicious circle member | already trusted with your location while you share; can spam or lie about their own position, and can trigger a re-key to remove other members (any member may re-key by design, see `docs/PROTOCOL.md`, "Re-keying"). Cannot speak as another member: receivers verify each sender's signature against that member's pinned key. Remedy for a member you no longer trust is removal via re-key, which is cryptographically complete, not a request they can ignore |
| Malicious member colluding with the relay | still cannot forge another member's position, and still cannot un-remove itself after the rest of the circle re-keys without it, because the next generation's seed is mixed from ECDH entropy delivered only to retained members |
| A stranger who claims a member seat by posting to the circle channel first | refused: a `member` record is only ever honoured on an invite channel, sealed to a verified inviter's welcome context, never on a circle channel (`app/js/membership.js`, `circleControl`). A circle channel carries exactly one control type, `rekey`, and a re-key is only ever accepted from a sender already pinned before that ingest pass began (`app/js/net.js`, `wasPinned`), so a first-seen sender cannot pin itself and be obeyed in the same breath |
| Malicious server operator shipping poisoned app JS | fatal, as for every web app including web clients of E2EE messengers. Mitigations: no third party scripts, strict CSP, subresource-free single origin, service worker pins the app shell. Real fix is a store-distributed native wrapper; the Android app already ships that way, though not yet through an app store, see "Distribution, honestly" below |
| Stolen unlocked phone, app lock OFF | attacker sees what the app shows and holds the circle's current keys. Panic wipe clears local state; rotating the circle from another device cuts the stolen device off at the next re-key, and everything older than the stolen device's own retained window was already gone before it was stolen |
| Stolen unlocked phone, app lock ON | the circle secret is AES-256-GCM encrypted at rest under a random vault key, itself wrapped by a PBKDF2-SHA-256 (600,000 iterations) key from the passcode and, optionally, a WebAuthn PRF secret or (Android) a Keystore key gated behind biometrics. A locked app holds no plaintext secret, vault key, or channel id in memory or on disk. `test/e2e_lock.py` asserts the plaintext secret is deleted the moment lock turns on and that a reload comes back with no derivable channel |
| A device that missed more than 30 days of a generation's traffic | cannot advance that generation's ratchet further on its own (`MAX_CATCHUP_EPOCHS` refuses the jump); recovery is a fresh invite, the same path as a new member, not a silent failure that looks like a working app |
| Malicious server operator shipping poisoned app JS on Android | does not apply the same way: the Android app's assets ship inside the signed APK, not fetched from the server on every load |
| Malicious server operator targeting one visitor to `/help` (the beacon viewer, the one page the hosted site still serves for security-relevant work) | not stopped, only made checkable: `script-src 'self'`, no third party code, and published per-release asset hashes (`tools/asset-hashes.mjs`) turn a targeted swap into a detectable event for anyone who diffs the live page against the manifest, not a prevented one. See [docs/WEB-INTEGRITY.md](WEB-INTEGRITY.md) for why this is the honest ceiling and why circles never go through the browser at all |

## Design consequences (privacy first, opposite defaults to Life360)

- Sharing is **off** until you turn it on, and the UI always shows a live
  sharing indicator while it is on.
- Coarse mode degrades your position on your device before encryption, so
  even circle members only get neighborhood accuracy when that is what you
  chose.
- Stopping sharing is one tap and posts an authenticated `bye` so others see
  "stopped" instead of a silently stale dot.
- Map tiles come from a tile server when a basemap is on; that reveals your
  viewport to the tile host. The privacy basemap ("Off-grid") renders locally
  and makes zero tile requests. The settings screen explains this trade.
- No analytics, no telemetry, no crash reporting, no third party requests of
  any kind from the app origin.
- Optional app lock encrypts the circle secret at rest. It is off by default
  (like Signal's screen lock), turns on with a passcode, and can add
  biometric unlock where the platform supports it. Auto-lock relocks after a
  chosen idle delay in the background, and every launch starts locked.

## Known limits, stated plainly

1. **No human security audit, and that gap is not theoretical.** The
   constructions are deliberately boring (AES-GCM, HKDF-SHA-256,
   Ed25519/P-256, all through WebCrypto), the design is written down before
   the code, and 351 unit tests replay committed test vectors an independent
   implementation could check itself against. None of that is a substitute
   for an independent reviewer. What verification exists: negative controls
   run against the load-bearing security tests (deliberately breaking the
   implementation and confirming the matching test fails, so a passing suite
   is evidence the check is wired to something real, not just present),
   headless-browser end to end suites driving real Firefox through create,
   invite, a byte-for-byte safety number comparison, accept, re-key,
   cross-visibility, check-in, SOS, the help viewer, revocation, and app
   lock, two rounds of multi-agent adversarial review with independent
   refutation, and a cross-model audit using a different model family than
   the one that wrote the code. The second adversarial round found about
   thirty real defects in code the first round had already passed over and
   marked reviewed; the cross-model audit found two more real bugs after
   that. That trajectory is itself the evidence: more review kept finding
   real bugs, not diminishing returns, and there is no reason to believe the
   pattern stopped because the reviewing stopped. Weigh every other claim in
   this document accordingly, and see [docs/AUDIT.md](AUDIT.md) for exactly
   where to start looking.
2. **Forward secrecy is bounded by the history window, not absolute.** A
   device that has advanced past an epoch has destroyed that epoch's key;
   anything still inside its retained window (10 minutes to 24 hours,
   depending on the user's setting) is still on the device, in memory or on
   disk, because that is the trail the user chose to be able to read. A
   device compromise that catches the key before it is destroyed exposes
   only what remains in that window, never the full circle history.
3. **Post-compromise security requires an actual re-key.** Holding a
   compromised device's current keys is not automatically remediated; someone
   has to trigger a re-key (removing the compromised device, or a manual "new
   keys now") for the circle to heal. Nothing detects a compromise on its
   own.
4. **The relay still learns metadata.** IP addresses, timing, and how many
   members post to a channel. There is no cover traffic and no mixnet. On top
   of a VPN or Tor this drops to the exit's IP; the timing and the count
   remain regardless. The steady-cadence setting hides only *when* a member
   moves, not that the relay sees traffic from them at all.
5. **An SOS is a correlation signal, even though its keys are unlinkable.** A
   circle channel and a beacon channel from the same device update at the
   same time from the same IP. A relay operator watching traffic does not
   need to break anything to notice that.
6. **Bus factor is one, and there are close to zero real users.** This is one
   person's design and one person's code review. There is no team, no second
   reviewer, no institution behind it, and no track record yet of running
   under real adversarial conditions.
7. **A browser cannot zeroise memory or guarantee a storage overwrite erases
   anything.** Deleted keys are `.fill(0)`'d and dropped, but JavaScript
   garbage collects rather than zeroises, and IndexedDB writes go through a
   database engine and, usually, a flash translation layer that may leave old
   bytes physically present until the underlying block is reused. Forward
   secrecy is a claim about what the application retains and requests to
   read, not a claim about what is physically recoverable from a seized
   device. See `docs/PROTOCOL.md`, "History window and destruction," and
   `docs/AUDIT.md`, "Deletion schedule, honestly," for the specifics.
8. **Anyone in a circle sees everyone in it.** There is no sub-grouping and
   no per-member visibility control. A member who is compromised compromises
   the circle's present; the design's answer is fast, complete removal via
   re-key, not preventing that member from having seen anything up to the
   point they are removed.
9. **No post-quantum protection.** P-256 and Ed25519 throughout. A
   harvest-now-decrypt-later adversary who records today's ciphertext and
   waits for a cryptographically relevant quantum computer is in scope for
   this threat model and not addressed by the cryptography here. It is
   bounded only by the relay's 24-hour retention: nothing recorded off the
   wire can be decrypted later even with unlimited future compute, because
   the relay itself does not keep it past a day, and a device's own retained
   window is shorter than that for most settings.
10. **A circle invite still needs a human to say yes.** v2 removes the
    bearer-token weakness of a v1 invite, but the cost is real: the inviter
    has to come back online and accept the joiner's safety number before the
    joiner gets any key material. A stolen link is inert until then, and
    inert afterward too unless a human accepts a safety number they were not
    expecting. Whoever holds a stolen link also cannot answer it: the
    commitment in the fragment names the inviter's keys, so forging a welcome
    means a second preimage on 128 bits rather than being quick.
11. **Web platform ceiling.** Background sharing ends when the OS suspends
    the tab. Starling is honest about being live-when-open (plus a wake lock
    toggle) on the web, rather than pretending to be an always-on tracker;
    the Android app's foreground service is what actually solves this, at
    the cost of a persistent notification.
12. **App-lock passcode strength is the user's.** The at-rest encryption is
    only as strong as the passcode behind it; PBKDF2 raises the cost of each
    guess but a four-digit PIN is still a four-digit PIN. There is no
    passcode recovery by design: a forgotten passcode means erasing the
    device and rejoining from an invite, because the secret is genuinely
    unrecoverable without it.
13. **There is no iOS app, and that is a deliberate omission, not a gap to
    fill with the web page.** The hosted site deliberately does not open
    circles on any platform, iOS included: see "The hosted web page does not
    open circles" below and [docs/WEB-INTEGRITY.md](WEB-INTEGRITY.md). Every
    integrity mechanism Safari ships (Subresource Integrity, the new
    Integrity-Policy header) checks served bytes against a reference the
    origin itself supplies, so none of them help against a hostile or
    coerced origin, and the tools that make a targeted swap detectable on
    other platforms, browser extensions that diff served code against a
    published manifest, do not exist on iOS at all. An iOS user has no way to
    hold a long-lived circle secret that a store-distributed app gives them
    on Android.
14. **F-Droid has never actually built Starling.** Reproducible F-Droid
    packaging is configured in an open merge request
    (`docs/fdroid/app.starlingmap.yml`) that has not been merged. Until it
    is, F-Droid is not a distribution channel for this app in any sense,
    reproducible or otherwise: the only ways to get Starling today are the
    GitHub release and the direct APK download at starlingmap.app. Anyone
    telling you otherwise is wrong, and if this file says otherwise after
    that MR merges, that is now the stale claim.

## Emergency beacon

An SOS mints a beacon: a separate share, on its own channel, under its own
secret and its own fresh signing identity, for people outside the circle. The
link opens in any browser with no app and no account.

What it is good for: the neighbour, the colleague, the friend three blocks
away who is not in your circle and will not install anything in the next two
minutes.

Its properties, as wired:

- A help link is a **bearer capability for one emergency, scoped to one
  viewer**. Whoever holds it watches that session's positions and nothing
  else in the system: not the circle, not its other members, not any
  history, and not any other viewer's link.
- Each viewer gets an **independent secret and derived channel**. The relay
  cannot link two viewers' channels to each other or to the circle by key
  material. Revoking one viewer ends only that channel, with a final `bye`
  so the helper sees "session ended" rather than a frozen dot; the others
  keep receiving positions.
- **Expiry is enforced at both ends.** Past a viewer's `expiresAt`, the
  viewer page stops polling and says the link is over, and the beacon stops
  posting to that viewer's channel independently, so a link that says it is
  dead has nothing left on the relay to read even if the viewer page were
  bypassed.
- The beacon is **memory-only** and ends on check-in, stop-sharing, app lock,
  or process death, sending `bye` to every still-live viewer. A new SOS mints
  new secrets for every viewer, so an old link stays dead.
- The relay learns that some number of beacon channels exist and their
  posting cadence. It cannot link any of them to a circle by key material or
  member id, though a relay watching traffic timing can see a beacon channel
  and a circle channel updating together from one address at the same
  instant, as described above.
- Anyone the link reaches can **forward it**. That is inherent to a link that
  works with no account, and it is the trade being made: reachability in an
  emergency, in exchange for not controlling who ends up watching a link
  once it is sent. Revocation stops a specific viewer's *channel*; it does
  not un-send a link that person already forwarded again before you revoked.

## Multiple circles

Since 0.3.0 a device can hold several circles, one active at a time. As of
0.5.0 the storage layer (`app/js/circles.js`) holds each circle as a v2
generation, not a flat secret: a `genMeta` record naming the generation
(`g`, `e0`, the epoch the retained chain key belongs to, the channel id), the
retained chain key itself (still called `secret` in the storage layer, for
continuity with every crash-window rule already proven around that slot, but
now the oldest chain key the ratchet still holds rather than a permanent
root), and the pinned member roster with both keys per member.

Each circle has its own generation, its own channel, and its own signing
identity, created fresh on join; the relay sees no link between the channels
a device belongs to. Polling and sharing happen only for the active circle.
At rest, inactive circles' names, generation metadata, pinned rosters,
profiles, and timestamps live in one sealed blob under the same vault key as
the active circle's state when the app lock is on; their signing and
agreement keypairs are non-extractable CryptoKeys stored beside it, which
means a locked device still reveals how many identities it holds but no
names, keys, or channel ids. Mid-switch crash safety is duplicate-not-lose:
the array grows to hold both circles before the active slots change hands and
shrinks only afterwards, and boot and unlock reconciliation drop whatever
duplicate a crash strands.

## The hosted web page does not open circles

The page at starlingmap.app is a landing plus the demo. It hides the create
and join paths, never decrypts a stored circle, and points invite links at
the app, on every platform including iOS, which has no other Starling app to
point at. Rationale: the web delivery channel is the weakest link in this
design, and the browser offers no OS-keystore-backed storage for a long-lived
circle secret. Removing circles from the hosted surface removes its value as
a target. The full app still runs on localhost for development, and the test
suites exercise it there.

The one page the hosted site does serve for security-relevant work is
`/help`, the beacon viewer, because a beacon secret is short-lived and scoped
to one emergency rather than long-lived and scoped to a whole circle's
history. [docs/WEB-INTEGRITY.md](WEB-INTEGRITY.md) states exactly what a
strict CSP and published asset hashes buy for that page (a targeted swap
becomes detectable) and what they do not (prevented, or automatically
caught): the honest state of the art here is a deterrent, not a guarantee,
and that is why circles stay off the web entirely rather than getting the
same trade.

## Distribution, honestly

- **GitHub release and the direct APK at starlingmap.app.** Both work today
  and are signed with the same key (`AllowedAPKSigningKeys` in
  `docs/fdroid/app.starlingmap.yml`).
- **F-Droid.** Not live. The submission is an open, unmerged merge request;
  see "F-Droid has never actually built Starling" above.
- **Google Play.** In progress, not live as of this writing.
- **iOS.** No app exists and none is planned as a wrapper around the web
  page; see the iOS limit above.

## Android app deltas

The Android app is the same `app/` code inside a native WebView wrapper.
Everything above still applies; this section states what changes on Android
and why none of it weakens the core claim (the relay never sees a position).

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
  600,000 iterations) is unchanged and remains the guaranteed unlock method.
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
