# Starling protocol v2

End to end encrypted location sharing. The relay stores ciphertext and learns as
little as we can manage. This file is the exact wire and crypto spec the code
implements; if code and spec disagree, that is a bug.

v2 is a hard break from v1. It exists to provide three properties v1 did not
have: forward secrecy, post compromise security, and cryptographic removal of a
member. Section [What v2 deliberately leaves out](#what-v2-deliberately-leaves-out)
is as load bearing as the rest and should be read before the wire format.

## Terms

- **Circle**: a sharing group. Created on one device, joined by invitation.
- **Member**: one device in a circle. A device generates its own keypairs per
  circle; there are no accounts.
- **Epoch** `e`: a 10 minute slice of a circle's life. Content keys advance once
  per epoch and the previous key is destroyed.
- **Generation** `g`: a re-key. Every generation has its own channel, its own
  chain, and its own member list. Generations are numbered from 0.
- **Chain key** `CK`: the 32 byte secret a generation's content keys hash out of.
- **Anchor** `A`: 32 bytes naming a generation's relay channel. Derives the
  channel id and nothing else.

## Constants

| name                  | value               | meaning                                          |
|-----------------------|---------------------|--------------------------------------------------|
| `PROTO`               | `starling/v2`       | domain separation prefix on every derived value  |
| `EPOCH_MS`            | 600000 (10 min)     | content key lifetime                             |
| `MAX_SKEW_EPOCHS`     | 2 (±20 min)         | tolerated clock disagreement between members     |
| `MAX_CATCHUP_EPOCHS`  | 4320 (30 days)      | hard cap on forward ratcheting in one operation  |
| `HISTORY_EPOCHS`      | 6 (1 h), settable   | how many past epoch keys a device keeps          |
| `PAD_LEN`             | 512                 | every plaintext padded to exactly this           |
| `MEMBER_CAP`          | 16                  | member slots per channel                         |
| `TTL_MS`              | 86400000 (24 h)     | relay retention                                  |
| `INVITE_TTL_MS`       | 3600000 (1 h)       | how long an unaccepted invitation stays valid    |
| `FUTURE_SKEW_MS`      | 600000 (10 min)     | how far ahead of a clock a `ts` may be           |
| `TRAIL_CAP`           | 240                 | points kept per member, on the relay and on a device |
| `MAX_BODY`            | 2048                | largest POST body the relay reads                |

These live in `app/js/wire.js`, which the relay imports too, so a client and a
relay cannot drift apart on a bound they both enforce. `MAX_CATCHUP_EPOCHS` and
the history window choices are client only and live in `app/js/ratchet.js`.
`EPOCH_MS` and `MAX_SKEW_EPOCHS` are deliberately written out in both files
rather than imported one from the other, so the relay never has to pull in the
client ratchet to bounds check an epoch index.

All key derivation is HKDF-SHA-256 with a salt of 32 zero bytes. The info
string is written below for each value and always begins with `PROTO`. Nothing
is derived from a bare secret without a label.

## Key schedule

A generation begins with a 32 byte `seed`, and everything in that generation
hangs off it:

| value       | derivation                                  | length | use                            |
|-------------|---------------------------------------------|--------|--------------------------------|
| `A`         | `HKDF(seed, "starling/v2/anchor")`          | 32 B   | names the channel              |
| `channel`   | `HKDF(A, "starling/v2/channel-id")`, hex    | 16 B   | relay channel name             |
| `CK_0`      | `HKDF(seed, "starling/v2/chain")`           | 32 B   | first epoch's chain key        |
| `CK_{e+1}`  | `HKDF(CK_e, "starling/v2/step")`            | 32 B   | next epoch's chain key         |
| `MK(e, m)`  | `HKDF(CK_e, "starling/v2/msg\|" + m)`       | 32 B   | AES-256-GCM key, member `m`    |

Two properties do the work here.

**The chain only runs one way.** `CK_{e+1}` is a SHA-256 based KDF output of
`CK_e`, so holding `CK_{e+1}` says nothing about `CK_e`. A device that has
advanced to epoch `e` and destroyed everything before it cannot decrypt epoch
`e-1` traffic, and neither can anyone who takes the device.

**The content key is per sender.** `MK` mixes the sender's member id into the
info string, so no two members ever encrypt under the same key. A shared epoch
key with 16 senders would make nonce collision a live risk; per sender keys
remove the whole class. See [Nonces](#nonces).

`seed` itself is destroyed as soon as `A` and `CK_0` exist. Nothing in the system
ever needs it again, and keeping it would let a seized device recompute the whole
generation from `CK_0` forward, including epochs it had already dropped.

### The epoch index is carried, never guessed

The epoch is a field on the wire, inside the signature and inside the AEAD's
associated data. A receiver selects the key by the carried index. Its own clock
bounds that index from above and nothing else does:

- reject if `e > now_epoch + MAX_SKEW_EPOCHS`
- reject if `e` is below `e0`, the epoch the generation opened in
- reject if the chain key for `e` is no longer retained
- ratchet forward at most `MAX_CATCHUP_EPOCHS` in one operation, then give up

Downwards there is no clock bound at all; the retained window is the whole of
it. A point that spent three epochs in the relay's backlog opens at the default
window and is refused at the High risk setting, where the window is a single
epoch, which is that setting doing exactly what it says rather than a skew
check firing. An old index is never measured against the clock, because a
delayed point is ordinary and the only question that matters is whether its key
still exists.

A separate, symmetric test, `|e - now_epoch| <= MAX_SKEW_EPOCHS`, is applied by
the relay on the way in and by a receiver reading an invite channel, where
there is no chain of its own to sanity check a welcome against. It bounds an
index; it never selects a key.

Deriving the key from the receiver's own clock instead would mean a member whose
clock runs slow becomes silently unreadable to everyone else. Trying several
candidate keys instead would be worse: AES-GCM is not key committing, so an
observable accept/reject across candidate keys is a partitioning oracle of the
kind Len, Grubbs and Ristenpart demonstrated against Shadowsocks. Exactly one key
is ever tried.

### History window and destruction

A device keeps `HISTORY_EPOCHS` past keys and destroys the rest. On every app
start and every epoch boundary it ratchets to the current epoch and drops
everything older than the window. The window is a user setting, because it is
exactly the trade the user should be making:

| setting        | `HISTORY_EPOCHS` | trail you can still read | what a seized device gives up |
|----------------|------------------|--------------------------|-------------------------------|
| High risk      | 1                | 10 minutes               | almost nothing                |
| Default        | 6                | 1 hour                   | the last hour                 |
| Longer         | 36               | 6 hours                  | the last 6 hours              |
| Full retention | 144              | 24 hours                 | everything the relay still has|

A point older than the window is not shown, and the client sets its feed cursor
to the start of the window so it does not even fetch what it cannot read.

**When catching up is not possible.** A device that comes back after longer
than `MAX_CATCHUP_EPOCHS` cannot walk its chain to the current epoch, and the
walk is refused rather than performed. It does not stop there: the chain
destroys itself. Bailing out and keeping the state would be the worst of both
worlds, a device that still cannot read anything current and is now holding a
month of chain keys for whoever picks it up, and everything it holds at that
point is older than the relay's own `TTL_MS`, so nothing it could decrypt still
exists anywhere. The circle is gone from that device and only a fresh
invitation brings it back.

That is the catch-up self-destruct referred to further down. It is the reason
every epoch a sender gets to choose is bounded on receipt: an unbounded opening
epoch inside a re-key or a welcome is a remote wipe of everybody else's
circle, and it was one. See [Re-keying](#re-keying).

**What "destroy" means in a browser, honestly.** The chain key is a
`Uint8Array` we overwrite with zeroes and drop. JavaScript engines garbage
collect rather than zeroise, so a copy may survive in a heap the page cannot
reach; IndexedDB overwrites go through SQLite and a flash translation layer, so
the old bytes may physically remain until the block is reused. Long lived keys
are held as non extractable `CryptoKey` objects wherever the API allows, which
keeps them out of script readable memory. Forward secrecy here is therefore a
claim about what the application retains, not a claim that the bytes are
physically unrecoverable from the device. RFC 9420 §9.2 requires deletion on
consumption; this is as close as a web platform gets, and the gap is stated
rather than papered over.

## Member identity

Each device generates two keypairs per circle:

- **Signing**: Ed25519 where available (Safari 17+, Chrome 137+, Firefox 130+),
  ECDSA P-256 otherwise. Public key exported raw, 32 B or 65 B.
- **Key agreement**: ECDH P-256, always. Public key exported raw, 65 B. P-256 is
  the only curve WebCrypto offers for ECDH everywhere, and having exactly one
  agreement algorithm means there is no negotiation to downgrade.

Both private keys are non extractable and persist by structured clone.

```
member_id = SHA-256("starling/v2/member" || pk || epk) truncated to 128 bits, hex
```

The id commits to **both** public keys. Pinning an id therefore pins the
signing key and the agreement key together, so a relay cannot substitute an
agreement key for a member whose signing key it cannot forge.

128 bits, not 64: this binding is the whole of a receiver's trust in "who sent
this". At 64 bits a second preimage is within reach of anyone who can rent
enough hashing, and finding one lets an attacker occupy a member's slot with
keys they control.

### Safety numbers

Members are pinned on first sight, which on its own is trust on first use. A
safety number makes that verifiable out of band:

```
fp(m) = SHA-256("starling/v2/fp" || pk || epk)
```

rendered from the first 18 bytes of that digest: each group of three bytes is
read as a 24 bit big endian integer, reduced mod 100000 and padded to five
digits, giving six groups of five joined by single spaces. Thirty digits, for
example `79320 91948 00309 34269 25169 66015`. Worth about 99.6 bits to
compare, and `test/vectors/identity.json` pins the exact strings.

Two members compare the pair of numbers in person or over a channel they already
trust, and mark each other verified. Verification is local state; the protocol
carries no "verified" bit, because a bit an attacker controls the transport for
is not evidence of anything.

When a pinned member's keys change, the client does **not** silently re-pin. It
surfaces the change, drops that member's points until a human accepts it, and
keeps showing the old safety number alongside the new one. Accepting re-pins
the new pair as **unverified**, so the number has to be compared again before
that member counts as checked, and the new agreement key is validated as a real
point on the way in: a person tapping accept must not be how a malformed key
gets pinned.

## Location message

Plaintext is JSON, padded to exactly `PAD_LEN` bytes with trailing spaces
(`JSON.parse` ignores them), then sealed with AES-256-GCM under `MK(e, m)`.

```json
{ "v": 2, "ts": 1788282959714, "t": "loc", "lat": 43.3, "lon": -90.4,
  "acc": 12, "name": "Ana", "emoji": "🦊", "hue": 210, "bat": 0.62,
  "mode": "precise" }
```

On a circle channel `t` is one of `loc`, `checkin`, `sos`, `bye` or `rekey`. On
an invite channel it is `join`, `ack`, `welcome` or `member`; a `member` record
is refused anywhere else, see [Member records are
welcome-only](#member-records-are-welcome-only). Every message type is padded to
the same length, so the relay cannot tell a location update from a re-key by
size, or a welcome from the `ack` before it.

A receiver ignores fields it does not know rather than rejecting the message,
so a field added later does not partition a circle across app versions. `v` is
2 on everything this version sends and nothing gates on it: the version is
pinned by `PROTO` inside the AAD and the signed string, where it cannot be
edited without breaking both.

### Nonces

12 bytes: 4 random bytes then `ts` as a 64 bit big endian integer.

`MK` is unique per (generation, epoch, member), and `ts` is strictly increasing
per member and persisted, so the counter half cannot repeat under one key during
normal operation. The 4 random bytes are a reuse guard in the sense of RFC 9420
§9: if persisted state is ever rolled back by a restored backup or a failed
IndexedDB write, a repeated `ts` then also needs the four guard bytes to
collide, which is 1 in 2^32 per repeated `ts`.

Stated exactly, because nonce reuse under GCM leaks the XOR of the plaintexts
and the GHASH key: the counter makes reuse impossible during normal operation,
and the guard makes it unlikely after a state rollback. It does not make it
impossible. Avoiding the rollback is what actually carries this property, and
that is why `ts` is persisted before it is used.

### Associated data and the signed string

```
aad     = "starling/v2|" + channel + "|" + member + "|" + e + "|" + ts
sigBase = "starling/v2|" + channel + "|" + member + "|" + e + "|" + ts + "|" + n + "|" + c
```

Both bind the epoch, so a point cannot be replayed into another epoch, another
channel, or another member's slot.

### What a receiver checks, in order

Every one of these runs on the receiving device, on every point, before
anything is believed, and in this order. The relay repeats some of them to keep
junk out of storage, and a receiver takes none of them on the relay's word.

1. `member_id` recomputed from the presented `pk || epk` equals `m`.
2. The signing algorithm is a **function of the public key**, taken from its
   length (32 bytes is Ed25519, 65 is P-256), never read from the `alg` field
   on the wire. `alg` is not covered by the member id, so a relay can flip it.
   It used to be trusted, and flipping it silently erased that member from
   everyone's map, which a safety number cannot detect either, because the
   safety number does not cover `alg` any more than the id does.
3. `epk` imports as a real P-256 point. Length checking a base64url string is
   not enough: a malformed key that is merely the right length can be pinned,
   and then every later re-key throws when ECDH tries to import it, which
   disables re-keying, removal and joining for the whole circle, permanently.
4. `MEMBER_CAP` is enforced here as well as at the relay. Without it a hostile
   relay could pin unlimited fabricated members into a durable roster at no
   cost to itself.
5. A pinned member whose keys changed is **not** re-pinned. The point is
   dropped and the change is surfaced to a person.
6. The signature verifies over `sigBase` against the pinned signing key. GCM
   alone says only that somebody holding a key of this circle wrote this; the
   signature says which member did.
7. Exactly one content key, selected by the carried epoch.
8. The `ts` sealed inside the plaintext equals the `ts` on the header, and is
   no more than `FUTURE_SKEW_MS` ahead of the receiver's clock. Without the
   first of those a relay could re-file a ciphertext under a different header.
9. Replay, below.

### Replay

A hash ratchet provides no replay resistance, and with epoch keys one key covers
a whole epoch, so a recorded point stays decryptable for the rest of it. For
location data a replay is a real attack, not a cosmetic one: it puts someone
where they no longer are.

Positions and control messages are deduplicated differently, and the difference
is deliberate.

**Positions**: a receiver keeps one high water mark per member and requires
`(e, ts)` to be strictly greater than the last one it accepted from that
member. It is a mark, not a set, and it is in memory only: a reload rebuilds it
by polling from the start of the retained window, which is safe precisely
because acceptance is monotonic, so a replayed old point after a reload cannot
walk a member's displayed position backwards.

**Control messages** (`rekey`) get their own bounded set of `(member, e, ts)`,
capped at 512 entries, and deliberately do not share the position mark. Sharing
it handed an untrusted relay a way to suppress one member's re-key for good:
serve a later position first, the mark moves past the re-key, and the re-key is
then refused forever when it finally arrives. Withholding a message is a power
the relay always has; making the client refuse it afterwards turns a temporary
withholding into a permanent one.

The poller keeps a third, larger set keyed on `member|e|ts|nonce`, capped at
4096, so a point the relay serves again inside one session is not re-opened.
That one is bandwidth, not a security boundary.

The relay's own monotonicity check is a courtesy; it is untrusted and its
verdict is not relied on.

## Joining

v1 invites were bearer tokens: the link carried the circle secret, so anyone who
ever saw the link held every past and future key, and no amount of ratcheting
above it changed that. v2 invites are one-time credentials that bootstrap a
pairwise channel instead, and the group's key material is replaced at the moment
of joining.

An invitation is 32 random bytes `IS` plus a commitment to the inviter's
identity. Both travel in the link fragment:

```
#j=<b64u(IS)>.<b64u(C)>
C = SHA-256("starling/v2/inviter" || pk || epk) truncated to 128 bits
```

where `pk` and `epk` are the inviter's circle keypairs, the same pair its member
id and its safety number commit to. Both halves are unpadded base64url, so the
fragment is exactly 43 characters, a dot, and 22 characters. A fragment that is
not that shape is not a v2 invitation and the app refuses it rather than
treating it as an unauthenticated one: accepting it would keep the whole v1
attack alive for anyone who kept an old link.

From `IS`:

| value             | derivation                                        | length | use                |
|-------------------|---------------------------------------------------|--------|--------------------|
| `invite_channel`  | `HKDF(IS, "starling/v2/invite-channel")`, hex     | 16 B   | rendezvous channel |
| `invite_key`      | `HKDF(IS, "starling/v2/invite-enc")`              | 32 B   | seals the handshake, AES-256-GCM |

1. **Request.** The joiner generates its keypairs and posts
   `{t:"join", pk, epk, name}` to `invite_channel`, sealed under `invite_key`
   and signed by its own new signing key. It then waits.
2. **Review.** The inviter, next time it is online, checks the request before
   a person ever sees it: the member id has to commit to the keys presented,
   the keys inside the request have to be the keys the post was signed with,
   and `epk` has to import as a real P-256 point. A request from an id already
   in the circle, or a second one from an id already waiting, is dropped. Only
   then is the joiner's safety number shown for a human to compare and accept.
3. **Admit.** On accept the inviter first checks its own circle has room:
   `MEMBER_CAP` counts the pinned roster plus this device, and a full circle
   refuses rather than admits. That check is separate from the one the
   rendezvous channel enforces and from the one a receiver applies to the
   relay's feed; without it a circle could admit a seventeenth member who then
   found no slot left on the circle channel and silently stopped being able to
   post, with nothing on any screen saying which of them it was. Then the
   inviter posts a short `ack` to `invite_channel`, which claims its member
   slot there, and only then performs a
   [re-key](#re-keying) that includes the new member. The re-key is what stops a
   joiner reading the epoch they joined during: they are handed a generation
   that did not exist a moment ago, so there is no backlog for them to decrypt.

   That order is part of the protocol, not an implementation detail. A channel
   holds at most `MEMBER_CAP` members, whoever holds the link can fill those
   slots with identities of their own, and the inviter has never posted on the
   rendezvous channel before this point, so the welcome is the post the cap
   turns away. The re-key cannot be taken back, so nothing irreversible happens
   until the channel has accepted a post from the inviter: otherwise the circle
   admits somebody it has no way left to tell.
4. **Welcome.** The inviter posts to `invite_channel`, **signed by the circle
   identity `C` commits to**, the new generation's `seed`, its generation
   number `g`, its opening epoch `e0`, and a count `n` of the member records
   that follow:

   ```json
   { "t": "welcome", "g": 4, "e0": 2963805, "n": 2,
     "eph": "<b64u eph pub>", "w": "<b64u nonce||ct>" }
   ```

   `g` and `e0` name the generation the admitting re-key has just opened, not
   the one it left. One `member` record per existing member goes with it, each
   carrying that member's `alg`, `pk`, `epk` and their name if it fits inside
   `PAD_LEN`:

   ```json
   { "t": "member", "eph": "<b64u eph pub>", "w": "<b64u nonce||ct>" }
   ```

   and the sealed plaintext inside `w` is the record itself:

   ```json
   { "alg": "ed25519", "pk": "<b64u>", "epk": "<b64u>", "name": "Ana" }
   ```

   The joiner is filtered out of the list, so `n` counts everybody else,
   the inviter included.

   The records are posted FIRST and the welcome LAST, and that order is part of
   the protocol. One message cannot hold sixteen key pairs, so a delivery is
   several posts and any of them can be the one the network eats. Posted
   welcome-first, a delivery that stopped partway left a welcome standing on
   the rendezvous channel with its records missing: the joiner opens that same
   stale welcome on every later poll, so a complete delivery posted behind it
   is never looked at and the retry below can never finish, and the next person
   to open the link sees a welcome they cannot open. Posted last, the welcome
   is the commit point. A record means nothing without a welcome to name its
   context, so orphaned records are inert to everybody, and once the welcome
   lands every record it commits to is already there.

   Every wrap is sealed to the joiner's `epk` by ECDH under a context that
   names the inviter:

   ```
   context = "starling/v2/welcome|" + inviter_member_id + "|" + g + "|" + e0
   WK      = HKDF(Z, "starling/v2/wrap|" + invite_channel + "|" + joiner_id)
   wrap    = AES-GCM(WK, nonce,
                     aad = "starling/v2/rekey|" + invite_channel + "|"
                           + joiner_id + "|" + context).seal(...)
   ```

   The context starts with `PROTO` and stops at `e0`. There is no trailing
   separator and nothing else in it; `test/vectors/session.json` records the
   exact string for the session it replays, and it is the file to check an
   implementation against rather than this paragraph. The AAD label says
   `rekey` for a welcome too, because a welcome wrap and a re-key wrap are one
   construction, and what tells them apart is the context inside, which is
   where the difference belongs. Same reason as a re-key's: a wrap only opens
   under the exact claims it was made for. One record per message, each padded
   to `PAD_LEN`.
5. **Verify.** Before using any of it the joiner checks the welcome's sender
   against `C` from the link: the sender's `pk` and `epk` must hash to the
   member id it posted under **and** to the commitment. That check happens at
   the door, when the message is buffered, not only when it is opened, so a
   stranger's message never occupies space the real welcome needs. A welcome
   that fails either check is refused, counted, and reported to the joiner as
   somebody other than their inviter answering the link. A welcome the
   committed inviter DID sign and this device cannot open is not that: it is a
   welcome sealed to a different joiner, which is what a link that has been
   answered once leaves behind, and it is refused without being counted.
   `member` records are
   only opened after that, under the verified welcome's context, so a record
   from any other sender is refused too. The welcome's opening epoch `e0` must
   also be within `MAX_SKEW_EPOCHS` of the epoch its own header was signed
   under, the same bound a re-key's `e0` carries and for the same reason: `e0`
   is bound into the wrap, but the sender writes the context, so an unbounded
   one lets an inviter open the joiner's ratchet at epoch zero, which the first
   clock sync reads as decades offline and answers with the catch-up
   self-destruct.
6. **Complete or refuse.** If fewer than `n` records open within a minute of
   the welcome itself opening, the join is abandoned and the person is told
   why. A joiner with a partial roster would decrypt the circle fine and be
   unable to attribute a single re-key, dropping every one of them in silence.

   At most 128 unopened messages are held per poll, and only from the device
   the link committed to. Counting everybody's messages was itself the jam:
   anyone holding the link could post 128 well formed `member` messages before
   the inviter tapped accept, the real welcome fell off the end of the buffer,
   and the joiner waited forever on a circle that had already admitted them and
   burned the invitation.
7. **Burn, or undo.** Once the welcome has gone out, the inviter destroys `IS`.
   A second `join` on that channel is ignored, and an invitation not accepted
   within `INVITE_TTL_MS` expires.

   A welcome that failed to send is the one case where the link is left alive,
   and it is also the one case where the admission is taken back: the inviter
   re-keys again, this time removing the member it just admitted. The seed for
   the failed attempt is already zeroed, so the joiner cannot be reached on
   that generation by any route, and the retry that a live link buys lives only
   as long as the inviter's memory does. A lock or a restart empties the
   request list, and the joiner's half of the handshake is in memory too, so
   re-opening the link produces a fresh keypair under a fresh member id rather
   than the one in the roster. Without the undo the circle is left holding a
   member nobody can reach, indistinguishable in the roster from anybody else,
   holding a seat and putting every later re-key's roster hash out of every
   other device's reach. The link stays live because it was live a second ago,
   it still expires on its own, and the person accepting again is the whole
   recovery. If the undo re-key fails in turn the app says so and names the
   only way out, which is removing that member by hand.

   Because a second accept can therefore land on a member who is still pinned,
   a re-key's recipient list is a set: an admission of somebody already in the
   roster replaces nothing and adds nothing, so the second accept commits to
   the same membership as the first. A duplicate would put the roster hash out
   of reach of every device in the circle, since the hash is taken over the
   sorted member ids and nothing dedupes them.

   A circle holds one live invitation at a time and minting a new one destroys
   the old, because two live credentials are two chances for the wrong person
   to be holding one. An invitation also names the identity that minted it, and
   a device holding several circles answers a link only from the circle that
   issued it.

After joining, the app shows the joiner the inviter's safety number next to
their own, because that is the one identity in the circle the link gave them
any way to check.

A stolen link is therefore worth something only in the window before the real
joiner uses it, and only if a human accepts a safety number they did not expect.
Whoever holds it cannot answer with a welcome of their own: the commitment names
the inviter's keys, and forging one means a second preimage on 128 bits.

The cost is honest and worth naming twice.

**An invitation needs the inviter to come back online and accept it.** The
request waits on the relay for up to `TTL_MS`, so nobody has to be online at the
same moment, but somebody does have to say yes.

**The inviter's signing key appears on both the rendezvous channel and the
circle channel.** The relay can therefore link the two. An earlier version
signed the welcome with a throwaway identity to avoid exactly that, and it cost
the whole handshake: with no identity named, a welcome was whoever posted one
first, and the attacker wins that race every time because the real inviter has
to be present and tap accept. An authenticated welcome and a linkable key is the
better of the two trades, and it is the one implemented.

### Member records are welcome-only

`{t:"member"}` is meaningful only inside a welcome, on an invite channel, from
the verified inviter. On a circle channel it is refused outright. A circle
channel carries exactly one kind of control message, `rekey`.

The reason is that a member record adds a member. Any member can post an
ordinary padded signed message on the circle channel, so honouring one there
would let any member graft a keypair of their own onto every device's roster,
with nobody asked. Removing the member who did it would not remove the graft,
because a re-key wraps to whoever is pinned, and removal is the only defence
this threat model offers against a compromised member.

Pinning and authority are separate, and the difference is what makes this
work. A device pins a member the first time a point of theirs opens and
verifies, which takes this generation's chain key, so a stranger cannot pin
themselves by posting; it will not pin past `MEMBER_CAP` members either. What a
pin does not confer is the right to move the circle. A newly pinned member may
not re-key until the generation's own roster hash names them, so a device
learns that somebody exists from a verified point or from a verified welcome,
and learns that they may re-key only from a rotator that named them (see
[Re-keying](#re-keying)).

## Re-keying

A re-key ends one generation and starts the next. It is what provides post
compromise security and what removes a member; a symmetric ratchet alone can do
neither, because hashing forward introduces no entropy an attacker who holds the
current state does not already have.

Triggered by: a member joining, a member being removed, a manual "new keys now",
or a daily timer. The timer is 24 hours plus a per device delay of up to an
hour, derived from that device's own member id. Every device runs the same
timer, and two of them rotating in the same breath would leave the circle split
across two generations that cannot talk, so the offset decides it: one device
fires, its re-key resets everyone else's clock, and the rest never fire at all.

The rotator samples 32 fresh bytes `NS` and derives the next generation:

```
seed_{g+1} = HKDF(CK_me || NS, "starling/v2/rekey")
```

Mixing the current chain key in means a relay that has never held circle key
material cannot inject a generation, and mixing `NS` in means a former member
who holds `CK_me` cannot compute the next one.

`NS` is delivered to each retained member `m` over a fresh ephemeral ECDH:

```
Z       = ECDH(eph_priv, epk_m)                                (P-256, 32 B x-coordinate)
WK      = HKDF(Z, "starling/v2/wrap|" + channel + "|" + m)     (32 B)
context = by + "|" + g + "|" + e0 + "|" + me + "|" + rh + "|" + rm
wrap    = AES-GCM(WK, nonce,
                  aad = "starling/v2/rekey|" + channel + "|" + m
                        + "|" + context).seal(NS)              (12 B nonce || ciphertext)
```

`channel` is the generation the re-key is being posted on, the one it is about
to end. `context` is every claim the message around the wrap makes:

| term | is |
|---|---|
| `by` | the rotator's member id |
| `g` | the new generation number |
| `e0` | the new generation's opening epoch |
| `me` | the epoch whose chain key was mixed |
| `rh` | the roster hash, or the empty string if there is none |
| `rm` | the removal list, sorted, comma separated, empty string for none |

**The context is load bearing, and leaving it out was a live bug.** Binding
only the recipient is not enough. The outer message is signed by whoever posted
it, but the wrap is an opaque blob: any member could lift another member's wrap,
re-post it under their own signature with a different removal list, and be
believed. The recipient would unwrap it fine, land on the correct new
generation, and be told the wrong person had re-keyed and the wrong person had
been removed. Nothing about the keys breaks, and that is the point: the members
screen is the trust surface of this app, so a member who can frame another
member on it has broken something that matters. With `context` in the AAD the
splice fails to decrypt. An implementation that omits it reproduces the
vulnerability exactly, and `test/vectors/session.json` carries the literal
context string for every wrap it records.

Posted as one message per recipient on the **current** channel:

```json
{ "t": "rekey", "g": 4, "e0": 2963805, "me": 2963804, "to": "<member id>",
  "eph": "<b64u eph pub>", "w": "<b64u nonce||ct>",
  "rm": ["<removed member id>"], "rh": "<b64u roster hash>" }
```

Every field except `eph` and `w` is bound into the wrap's associated data: `to`
as the recipient term, the rest through `context`. Editing any of them in
flight leaves a wrap that does not open.

`me` is on the wire rather than derived from the header's epoch because a
re-key is built at one moment and posted at another. The mix happens when the
rotator runs; the POST can land after the next epoch boundary. Reading the mix
epoch off the header meant rotator and recipients mixed different chain keys
whenever a re-key straddled a boundary, which produced two generations that
could not see each other and split the circle with nothing to report it.

Receivers:

1. drop it unless the sender is pinned **and** in this generation's founding
   roster, because a re-key from a key nobody had seen before is never pinned
   by the re-key itself (see below);
2. drop it unless `to` is their own member id;
3. require `g` to be exactly one greater than the generation they are in. A
   higher `g` means the generation in between never arrived, and its seed
   cannot be guessed, so the circle has moved on without this device and only a
   fresh invitation brings it back. Equal or lower is a replay;
4. require `e0` to be within `MAX_SKEW_EPOCHS` of the epoch this very message
   was sent in;
5. require `me` to be a non-negative integer no greater than the message's own
   epoch, and one whose chain key is still retained. An epoch that has left the
   window means no seed, and the device has to be re-invited rather than guess;
6. rebuild `context` from the message's own fields, unwrap, and require exactly
   32 bytes of `NS`. Rebuilding is literal: `rm` is filtered to well formed
   member ids and sorted, a missing or non-string `rh` becomes the empty
   string, and everything else is taken as it arrived. A rotator that puts
   anything else in `rm` produces a wrap nobody can open;
7. derive `seed_{g+1}`, open the generation, move to the new channel;
8. recompute the roster hash and, if it disagrees, keep the new generation but
   surface the disagreement rather than silently accept a different membership.

**Why `e0` is bounded.** It was not, and it was the worst bug in the protocol.
Every other epoch on the wire is checked against a clock; `e0` was checked only
for being a non-negative integer. It sits inside the context, so it is bound
into the wrap, but the **sender** computes that context, so sealing `e0 = 0`
produces a wrap that opens perfectly on every receiver. Their new ratchet then
opens at epoch 0, the next clock sync sees a jump of three million epochs, and
the catch-up self-destruct erases the circle from memory and from disk. One
signed message from any member permanently destroyed everyone else's circle,
and the victim was told their own phone had been offline too long. The bound is
against the message's own epoch rather than the receiver's clock deliberately:
a rotator opens the generation at the moment it sends, so the two are the same
instant, the header epoch is already bounded by the time the message is read,
and a re-key sitting in a relay backlog stays valid while leaving the sender
nothing to steer.

### The roster hash

```
rh = b64u(SHA-256(utf8("starling/v2/roster|" + ids.sort().join(","))))
```

`ids` is the set the rotator wrapped to: the next generation's membership minus
the rotator itself, with anybody being admitted included and anybody being
removed left out. The exact string matters, because a hash that is nearly right
is a circle that warns about its own membership forever: one `|` between the
label and the list, one `,` between ids, no trailing separator, ids lowercase
hex so the sort is a byte sort, the whole thing hashed as UTF-8, and the digest
rendered base64url with no padding.

A receiver's matching view is its own pinned roster, minus the rotator, plus
itself. A device does not pin its own identity, so it has to add it back to
compare.

A member who receives no wrap gets nothing: no `NS`, no new channel, and the
generation they are still on goes quiet. That is removal, and it is
cryptographic rather than advisory.

### Who may re-key a generation, and how an admission converges

A re-key is honoured only from a member the current generation opened with, not
from anyone in the pinned roster. The roster pins a member the first time one of
their points verifies, and a control message arriving in that same pass would
otherwise satisfy its own "is the sender pinned" check with a key nobody had
ever seen. That set travels with the generation on disk, so a restart does not
widen it back out to every id this device has ever pinned.

That leaves the newly admitted member. They are in the rotator's roster hash and
in nobody else's roster, so every other device disagrees with `rh` until the new
member posts something. Two things follow from that, and both are behaviour, not
alarm:

- the disagreement is **held, not surfaced**, for a grace period of five
  minutes. An admission and an impersonation would otherwise produce the same
  warning, and they are not the same event.
- once the newcomer is pinned, the device recomputes its own roster hash. When
  it now equals the `rh` the rotator sealed inside the wrap, the rotator has
  named exactly these members, so they are adopted as the generation's roster
  and the newcomer may re-key in turn.

Nothing is guessed here: the device hashes the roster it actually holds and
compares once. `rh` is inside the wrap's associated data, so only the rotator
could have produced it, and occupying a slot this way would mean finding a
member id that completes the rotator's set, which is a second preimage on 128
bits.

A disagreement that never resolves is a real one and is shown to a person.

A device that has just joined announces itself with a `checkin` on the circle
channel. Everyone else was told a new member exists by the re-key that admitted
it, but only its own posts carry its keys, and until one lands nobody can
attribute anything it signs, including a re-key of its own.

Because the channel is derived from the generation's own anchor, every re-key
also moves the circle to a fresh channel id. A removed member cannot follow, and
the long lived identifier a relay operator could otherwise correlate across
months is replaced at least daily.

**Who may re-key: any member.** They are already trusted with everyone's live
position, so a member who wants to grief the circle has easier ways. Every
re-key is attributed in the UI to the member who signed it, and removals are
named. There is no admin role, because there is no server to hold one and a
device that is lost would take the role with it.

## Wire API

All endpoints are under `/api/v2/`. `/api/v1/` returns `410 Gone` with
`{"error":"protocol v1 retired","upgrade":"https://starlingmap.app"}` so a v1
client fails loudly instead of syncing into silence against a channel nobody
else is on. `{channel}` must be 32 lowercase hex characters or the request is a
`404` before anything else happens; a circle channel, an invite channel and a
beacon channel are the same kind of name and the relay cannot tell them apart.

Two limiters run before any storage read, any signature check, and the body
read itself: per address, 240 requests a minute shared by reads and writes, and
per channel, 256 posts a minute. They are sliding one minute windows in two
separate maps, and the separation matters, because channel ids are attacker
chosen and unlimited: one shared map would let a sprayer evict every address
bucket and hand itself an unlimited budget. Both are per isolate, so they bound
a single worker instance rather than the world, and both are configurable for
self-hosters.

Writes are also origin checked: no `Origin` header, the relay's own origin, the
Android wrapper's asset origin, or an origin a self-hoster listed. That stops
drive-by writes from arbitrary web pages and nothing else; every post is
signature checked regardless.

### `POST /api/v2/f/{channel}/loc`

```json
{ "m": "<member id>", "alg": "ed25519", "pk": "<b64u>", "epk": "<b64u>",
  "e": 2963805, "ts": 1788282959714, "n": "<b64u nonce>", "c": "<b64u ct>",
  "sig": "<b64u>" }
```

Answers `{"ok":true,"now":<relay clock>}`. The relay: refuses a body over
`MAX_BODY`; shape-checks; recomputes `member_id` from `pk || epk` and requires
it to equal `m`; requires `ts` not more than `FUTURE_SKEW_MS` ahead of its own
clock; requires `e` to be within `MAX_SKEW_EPOCHS` of its own clock; pins
`(alg, pk, epk)` on first write for that channel and rejects any later
mismatch; requires `ts` to be greater than the last it stored for that member;
verifies `sig` over `sigBase`; then writes. The member row and the point are
inserted in one D1 batch, which is one transaction: `MEMBER_CAP` is enforced
inside it rather than by the read before it, so concurrent admissions serialize
and a request the cap refuses writes nothing at all. The same batch trims that
member to the newest `TRAIL_CAP` points and runs the TTL sweep. `last_ts` moves
forward only (`MAX(old, new)` on conflict), so two racing posts from one member
cannot walk the pin backwards and re-open the window it exists to close.

| status | means |
|---|---|
| `400 bad request` | malformed body, or a `ts` too far ahead |
| `400 clock` | the epoch is outside `MAX_SKEW_EPOCHS` of the relay's clock |
| `403 forbidden` | origin, member id mismatch, key mismatch against the pin, member cap, or a bad signature |
| `409 conflict` | `ts` not greater than the last stored for that member |
| `413 too large` | body over `MAX_BODY` |
| `429 rate limited` | either limiter |

`400 clock` is its own string rather than a generic `400` because of what it
means to the person holding the phone: a device whose clock is wrong by more
than the skew tolerance is invisible to its circle, and the only thing worse
than that is it happening silently while somebody is relying on being seen. The
client turns this one into "your clock is wrong", never "network error".

A receiver repeats every one of these that it can and adds the ones the relay
cannot make, starting with reading the algorithm off the key rather than the
`alg` field; see [What a receiver checks](#what-a-receiver-checks-in-order).
The relay checks to keep junk out of storage, not because anyone trusts the
result.

### `GET /api/v2/f/{channel}?since={srv}`

```json
{ "now": 1788282959800,
  "members": [ { "m": "<member id>", "alg": "ed25519", "pk": "<b64u>",
                 "epk": "<b64u>",
                 "points": [ { "e": 2963805, "ts": 1788282959714,
                               "srv": 1788282959750, "n": "<b64u>",
                               "c": "<b64u>", "sig": "<b64u>" } ] } ] }
```

`sig` and `e` travel with every point so receivers verify and pick their own
key rather than taking the relay's word for either. The cursor is the relay's
own receive time (`srv`), never a client's claimed `ts`, so one member's skewed
clock cannot filter another member's honest points out of the feed. `srv` is
not unique per insert, so the filter is inclusive (`srv >= since`) and the
client deduplicates on `member|e|ts|nonce`: that refetches the boundary
millisecond and never loses a point.

Reads are not origin checked. Reading requires the unguessable channel id, and
a foreign origin the write check would allow gets CORS headers so the wrapper's
WebView can read its own relay.

### `GET /api/v2/health`

`{"ok":true}`. The one endpoint that says which protocol a deployment speaks.

### Retention

Rows are deleted after `TTL_MS`. The sweep runs on every feed request and
inside every write batch; there is no cron and no background job to fail
silently.

## Emergency beacon

An SOS mints, **per viewer**, a fresh 32 byte secret, a fresh signing identity
and its own channel, under their own info strings (`starling/v2/help-channel-id`
and `starling/v2/help-enc`), so a beacon and a circle can never produce
overlapping material and the relay cannot link the two channels by key or by
name.

v2 makes beacon links **per viewer and revocable**. Each person you send help to
gets their own link deriving its own channel, and the beacon posts the same
position to each live viewer channel. Two people who compare links cannot tell
they are watching the same emergency. Revoking one viewer stops posting to that
channel and sends it a final `bye`; the others are unaffected.

There is no ratchet on a beacon channel. One emergency, one key, one sender:
re-keying exists to heal from a compromise over time and to remove a member
later, and neither applies to a channel that lives for an hour and has one
writer. The epoch still travels on every point, inside the AAD and the
signature, it just never changes which key answers for it. A beacon lives in
memory only; if the app process dies the beacon dies with it and the viewer
sees the trail go stale rather than a silent blank.

The link is a fragment carrying three fields: the 32 byte secret, an expiry, and
the member id of the signing identity that beacon minted for this viewer.

```
#b=<b64u secret>.<expiresAt>.<member id>
```

The commitment is load bearing. A beacon secret is symmetric, so everyone the
link was ever forwarded to can derive the channel and the content key and seal
something that opens cleanly on the viewer page: a false position, or a `bye`
that tells a helper the emergency ended while it has not. GCM says only that
someone holding the link wrote this; the signature says who, and the committed
member id is what names the signing key that signature must belong to. The
viewer accepts points from that id and no other, and it drops everything else
before ingest rather than after, so nothing the wrong sender wrote reaches the
map or the status line. Trust on first use is not an option here, because the
attacker can be first: they hold the link before the person in trouble has
posted anything. A link with the commitment missing does not parse, so stripping
the field is not a downgrade path.

The expiry is enforced at both ends. Past it, the viewer page stops polling and
says the link is over, and the beacon retires that viewer before its next post,
so no position is left on the relay for a link that is supposed to be dead. An
expired viewer gets no `bye`: its page already says the link is over, and a
`bye` would be one more write to a channel whose own link declares it dead.

The viewer page derives its content key with **decrypt** usage only and the
beacon derives the same bytes with **encrypt** only. That does not stop anyone
holding the link from sealing something in their own code, which is what the
commitment is for; what it buys is narrower and still worth having: a page that
parses attacker reachable input on a device we do not control holds a key that
cannot encrypt at all.

The trade is visible in the traffic: `k` viewers means `k` posts per position.
`k` is small and it is an emergency, and uniform padding means the relay sees `k`
identical writes rather than anything that describes the emergency.

## Leaving and removing

Stopping sharing posts a final `bye`. **Removing** someone is a re-key that
omits them, and it is complete: they do not learn the next generation's seed,
cannot derive its channel, and their existing key material expires with the
current epoch.

## What v2 deliberately leaves out

- **A ratchet per message.** Epochs are 10 minutes. WhatsApp built a
  multi-dimensional chain because a linear ratchet is too slow at live-location
  message rates; at one step per 10 minutes a linear chain costs a few thousand
  HKDF calls for a month offline, so the simpler construction is the right one
  here. Simplicity is a security property in a codebase this new.
- **Metadata hiding beyond padding and rotation.** The relay sees IP addresses,
  timing, and how many members are posting to a channel. Tor moves the IP; the
  timing and the count remain. There is no cover traffic between members, no
  mixnet, no private information retrieval.
- **Deniability.** Signatures are non-repudiable by design. A content key is
  per sender, but every member of the circle can derive every other member's,
  so the AEAD says only that somebody in the circle wrote this; the signature
  is the only thing that says which member did, and that mattered more here
  than deniability.
- **Server-side membership.** There is no authority that knows who is in a
  circle, so there is nothing to subpoena and nothing to enforce an admin role.
- **Recovery.** No key escrow, no backup of circle state, no account recovery.
  Lose every device in a circle and the circle is gone.
- **Post-quantum anything.** P-256 and Ed25519 throughout. A harvest-now
  decrypt-later adversary is in scope for the threat model and not addressed by
  the cryptography; the 24 hour retention is what bounds it.
- **Protection against a member.** Everyone in a circle sees everyone's position.
  A member who is compromised compromises the circle's present, and re-keying
  after removing them is what bounds its future.

## Test vectors

`test/vectors/` holds machine readable vectors an independent implementation can
replay:

- `hkdf.json`, every info string in the protocol with a fixed input and its
  exact output;
- `chain.json`, a chain advance including a 1000 step jump;
- `keys.json`, epoch and member to content key;
- `identity.json`, member ids and safety numbers for seven keypairs, including
  the awkward ones;
- `strings.json`, the exact `aad` and `sigBase` byte strings, in hex;
- `session.json`, one recorded multi-member session covering a join, a re-key,
  a removal, an out of order delivery, and a replay that must be rejected, with
  the literal welcome and re-key context strings for every wrap in it.

`npm test` replays all of them against the live code. Where this document and a
vector disagree, the vector is right and this document is the bug: the vectors
are generated from the implementation by `tools/gen-vectors.mjs`.
