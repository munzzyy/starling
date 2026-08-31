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
| Stolen unlocked phone | attacker sees what the app shows and holds the circle secret. Panic wipe clears local state; rotating the circle from another device cuts the stolen device off within one TTL |
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
