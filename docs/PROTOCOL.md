# Starling protocol v1

End to end encrypted location sharing. The relay stores ciphertext and learns as
little as we can manage. This file is the exact wire and crypto spec the code
implements; if code and spec disagree, that is a bug.

## Terms

- **Circle**: a sharing group. Created on one device, joined by invite.
- **Circle secret** `S`: 32 random bytes from `crypto.getRandomValues`. Lives only
  on member devices and inside invite links. The relay never sees it.
- **Member**: one device in a circle. A device generates its own signing keypair
  per circle; there are no accounts.

## Key derivation

All derivations are HKDF-SHA-256 over `S` with a zero salt and versioned info
strings, so a future v2 re-keys cleanly:

| value        | info string              | length | use                          |
|--------------|--------------------------|--------|------------------------------|
| `channel_id` | `starling/v1/channel-id` | 16 B   | relay channel name (hex)     |
| `enc_key`    | `starling/v1/enc`        | 32 B   | AES-256-GCM content key      |

`channel_id` works as a capability: it is unguessable (128 bits) and only
derivable from `S`. Knowing it lets you fetch ciphertext, which you cannot
decrypt without `S`. The relay indexes storage by `channel_id` and never learns
which circle it is, what it is called, or who is in it.

## Member identity

Each device generates a signing keypair when it creates or joins a circle:

- Preferred: Ed25519 (WebCrypto), public key exported raw (32 B).
- Fallback: ECDSA P-256 with SHA-256, public key exported raw (65 B), for
  browsers that still lack WebCrypto Ed25519.

`member_id` = first 16 hex chars of SHA-256(public key bytes). The relay checks
this binding on every write, so a member id cannot be claimed with a different
key. The first write to a channel pins `(member_id, pubkey)`; later writes must
verify against the pinned key. Key pinning is trust-on-first-use from the
relay's point of view; members authenticate each other by the content key, not
by the relay's word.

## Location message

Plaintext is JSON, then padded with trailing spaces to exactly 512 bytes so
ciphertext length reveals nothing about names or content:

```json
{"v":1,"t":"loc","ts":1756500000000,"lat":44.98,"lon":-93.27,"acc":12,
 "spd":0.4,"hdg":90,"bat":0.81,"name":"Cole","emoji":"🐦","hue":210,
 "mode":"precise","st":""}
```

- `t`: `loc`, `sos`, `checkin`, or `bye` (stopped sharing).
- `ts`: sender clock, ms. Receivers drop anything older than what they already
  hold for that member and anything more than 10 min in the future.
- `mode`: `precise` or `coarse`. Coarse mode rounds the position onto a ~1 km
  grid on the sender before encryption; the exact fix never leaves the device.
- Display name, emoji and color hue travel inside the ciphertext. The relay
  never sees who anyone is.

Encryption: AES-256-GCM, fresh random 12 B nonce per message, AAD =
`starling/v1|{channel_id}|{member_id}`. AAD binds a ciphertext to its channel
and sender slot, so a message cannot be replayed into another circle or under
another member.

## Wire API

Same origin as the app; JSON over HTTPS. All bodies are capped at 2048 bytes.

### `POST /api/v1/f/{channel}/loc`

```json
{"m":"<member_id>","alg":"ed25519|p256","pk":"<b64url raw pubkey>",
 "ts":1756500000000,"n":"<b64url nonce>","c":"<b64url ciphertext>",
 "sig":"<b64url signature>"}
```

`sig` is over the UTF-8 string `starling/v1|{channel}|{m}|{ts}|{n}|{c}`.

Relay checks, in order: body size and shape, `member_id` = hash(pk) binding,
pinned key match (pin on first write), signature, `ts` strictly greater than
the member's last stored `ts` (blocks whole-body replay), member cap (16 per
channel), rate limit. Then it stores `(channel, member, ts, n, c)` and prunes
that member's trail to the newest 240 points.

### `GET /api/v1/f/{channel}?since={ts}`

Returns every member's pinned key and their stored points newer than `since`:

```json
{"now":1756500000000,"members":[
  {"m":"...","alg":"ed25519","pk":"...","points":[{"ts":1,"n":"...","c":"..."}]}
]}
```

Readers poll this every 10 s while the app is visible. Receivers verify the
`member_id`/`pk` binding themselves, decrypt with `enc_key`, and drop anything
that fails to authenticate, so junk written by someone who scraped a
`channel_id` renders as nothing.

### Retention

Every row carries a server timestamp. Rows older than the channel TTL (24 h)
are deleted opportunistically on reads and writes. There is no long term
storage: the relay holds at most a day of ciphertext trail per member.

## Invites

```
https://<host>/#j=<b64url S>
```

The secret rides in the URL fragment, which browsers do not send to the server.
The app renders this link as a QR code, generated locally. Share the link over
a channel you already trust (Signal). Anyone with the link is in the circle:
that is the model, same as a Signal group link, and the UI says so.

## Leaving and removing

Stopping sharing posts a final `bye` message. Removing someone means rotating
the circle: create a fresh secret and re-invite everyone else. The old channel
decays off the relay within the TTL. There is no partial removal without
rekeying; pretending otherwise would be theater.

## What v1 deliberately leaves out

- Push notifications. Web push routes through Google or Apple infrastructure
  and mints per-device tokens; that is metadata we chose not to create. The app
  polls while open.
- Forward secrecy ratchets. The content key is static until you rotate the
  circle. Exposure is bounded instead by relay retention: 24 h of ciphertext.
- Guest or one time links. Planned as a separate short lived circle, not a flag
  on the main one.
