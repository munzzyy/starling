# Audit guide

This is the file that turns "nobody has reviewed this" into "here is exactly
where to start." It maps every security property to the code that implements
it, states every key's lifetime, and lists the questions we most want an
auditor to attack first. Everything in it was checked against the code in
this repository, not against `docs/PROTOCOL.md`'s intent. The spec was
re-checked against the code in the same pass, section by section; what it had
wrong is listed under [Implementation status](#implementation-status) rather
than quietly fixed, because the divergences are themselves a finding.

If you are the auditor: start with
[Implementation status](#implementation-status) below. It will save you from
re-discovering something we already know about.

## Implementation status

Protocol v2 (`docs/PROTOCOL.md`) is now wired end to end: crypto core, relay,
multi-circle storage, app orchestration, and the Android wrapper all speak
v2. This is a change from earlier snapshots of this document, which described
a crypto core that was internally consistent but not yet called by the rest
of the app. That gap is closed. What follows is what was actually re-checked
to say that, so the next reader can re-check it too rather than take the
claim on faith.

**What's checkable in under a minute:**

```
node --test test/*.test.mjs
```

399 tests, 0 failures, from a run while this was written. (`CHANGELOG.md` and
older copies of this file say 351. That number is stale; the suite grows, so
run it rather than trust any figure written down here, this one included.) This includes `test/vectors.test.mjs`, which
replays every file in `test/vectors/` (HKDF labels, a chain advance including
a long jump, epoch/member-to-key and nonce derivation, exact `aad` and
`sigBase` byte strings, and one recorded multi-member session covering a join,
a re-key, a removal, an out-of-order delivery, and a replay that must be
rejected) against the live code, not against a description of it. Run
`node tools/gen-vectors.mjs` to see how the vectors themselves are produced,
from fixed, non-secret, in-file keys, not from anything a person uses.

`bash tools/check-clean.sh` passes (no em/en dashes, no AI attribution
anywhere in the tree).

**The spec was re-checked against the code, section by section.** Round five
of review found `docs/PROTOCOL.md` had drifted, and every divergence is now
closed. What it had wrong is worth knowing, because it is the shape of thing
to look for next time:

- the re-key wrap's AAD was documented **without** the `context` term, which
  is exactly the construction that was a live bug (a member could lift
  another member's wrap and re-post it with a different removal list). An
  implementer working from that document would have shipped the vulnerable
  version.
- the re-key message was documented without `e0` and `me`, both of which are
  on the wire and both of which are load bearing.
- the roster hash formula, its separator, its encoding and the member set it
  covers were all wrong.
- the welcome wrap's context was missing its `starling/v2/` prefix and had a
  trailing `||` the code does not produce.
- the safety number was described as "the first 30 decimal digits of the
  digest", which is not what `wire.js` renders.

The vectors in `test/vectors/` agreed with the code throughout; the document
was the odd one out every time. That is the ordering to trust: code, then
vectors, then prose.

**What is wired but not something you can check with a one-line command:**
`app/js/main.js` calls `openGeneration`, `buildRekey`, and `applyRekey` from
`rekey.js`, and `assembleWelcome` and `rosterConverged` from `membership.js`,
at the points in the app's control flow described in
["Where each security property lives"](#where-each-security-property-lives)
below. `app/js/circles.js` stores a v2 generation (`genMeta`, a chain key, a
pinned roster) per circle, not a flat v1 secret. `relay/src/index.js` and
`relay/schema.sql` speak only `/api/v2/*` against `members_v3`/`points_v3`,
and answer `/api/v1/*` with `410 Gone` rather than syncing a v1 client into
silence. Two headless-Firefox suites (`test/e2e_marionette.py`,
`test/e2e_v2_ui.py`) exercise this wiring as a running app talking to a
running local relay: create, invite, a byte-for-byte safety number
comparison (`test/e2e_v2_ui.py` asserts the string the inviter is shown
equals the string the joiner read out loud, not just that both are
non-empty), accept, re-key (attributed to the member who triggered it),
cross-visibility, check-in, SOS, the help viewer including per-viewer
revocation, and the app-lock lifecycle.

**A caveat about what "wired" does not claim.** These suites are not wired
into CI (`.github/workflows/ci.yml` runs `node --test test/*.test.mjs` and
`tools/check-clean.sh` only; the e2e suites need a real headless Firefox and
are run by hand). Re-run them yourself rather than trust a stale claim that
they passed on some earlier date:

```
node test/serve_local.mjs 8899 &
python3 test/e2e_marionette.py
python3 test/e2e_v2_ui.py
python3 test/e2e_lock.py
```

**A caveat about what "wired" does not claim, part two: deployment.** The
code in this repository is not automatically what `starlingmap.app` is
answering right now. `relay/deploy.sh` ships `relay/src/index.js` to the live
Worker; until it is run against this tree, the live relay may still be
running whatever it was last deployed with. Check for yourself before relying
on this:

```
curl -s https://starlingmap.app/api/v2/health   # {"ok":true} once v2 is deployed
curl -s https://starlingmap.app/api/v1/health   # {"ok":true} if still on v1, 410 once v2 is deployed
```

Re-checked while writing this: `/api/v1/health` still answers
`200 {"ok":true}` and `/api/v2/health` answers `404 {"error":"not found"}`.
The deploy has not happened. This is an operational fact, not a code defect,
and it is worth re-running rather than assuming either way, because it is the
claim in this document most likely to be out of date by the time you read it.

One thing here that earlier copies of this file got wrong: `relay/deploy.sh`'s
post-deploy health check does **not** poll a retired path. It polls
`/api/v2/health` (`relay/deploy.sh:73-79`), which is correct for a v2 relay.
That finding is retracted.

An auditor's first pass, before touching the crypto at all, is confirming
every claim in this section is still accurate, since those are the facts most
likely to have changed since this was written.

## Where each security property lives

Line numbers are from the tree this file ships in and were resolved from the
source, not remembered. If one lands in the wrong place the file has moved
under it; the function names are the durable half.

| property | implementation | key check |
|---|---|---|
| Forward secrecy (epoch keys, one-way chain) | `app/js/ratchet.js:57-59` (`deriveAnchor`, `chainInit`, `chainStep`), `ratchet.js:69-73` (`messageKey`), driven by `createRatchet` at `ratchet.js:101-229` | `chainStep` is HKDF over the current key only; nothing in the file can run backward |
| History window / destruction | `ratchet.js:114-136` (`forget`, `trim`), called from `advanceTo` (`ratchet.js:142-151`) and `syncToClock` (`ratchet.js:210-226`) | keys leaving the window are `zero()`d (`ratchet.js:39-40`) and `Map.delete`d, not just dropped; `trim` anchors on the clock, never on `head`, so a peer running fast cannot drag another device's window forward |
| Exactly-one-key selection (no partitioning oracle) | `ratchet.js:162-176` (`keyFor`) | the epoch comes off the wire; the function never tries a second candidate |
| Catch-up cliff and self-destruct | `ratchet.js:142-151` (`advanceTo` refuses a jump over `MAX_CATCHUP_EPOCHS`), `ratchet.js:210-226` (`syncToClock` calls `destroyAll` rather than bail) | a device too far behind destroys its chain instead of holding a month of keys it cannot use; surfaced as `state.chainDestroyed`/`state.chainWiped` (`main.js:171-179`) |
| Post-compromise security / re-keying | `app/js/rekey.js:49-89` (`buildRekey`), `ratchet.js:254-264` (`nextSeed`) | `seed_{g+1}` mixes `CK_me` (denies a keyless relay) with fresh `NS` (denies a former member) |
| Cryptographic member removal | `rekey.js:49-89`: a removed member is simply not in `recipients`, so it receives no wrap and no `NS` | absence, not a flag; nothing to spoof |
| The mix epoch travels (`me`) | `rekey.js:63` and `rekey.js:80` (sealed into `context`, and posted), `rekey.js:130` (bounded on receipt), `ratchet.js:254-264` (`nextSeed` takes a named epoch) | rotator and receiver mix the same `CK`; deriving it from the header epoch split the circle whenever a re-key straddled an epoch boundary |
| The new generation's opening epoch is bounded (`e0`) | `rekey.js:125-126` (re-key), `membership.js:81-82` (welcome) | unbounded, `e0 = 0` was a remote wipe of every other member's circle via the catch-up self-destruct; bounded against the message's own epoch, not the receiver's clock |
| Re-key sender authentication (crypto layer) | `rekey.js:99-164` (`applyRekey`) requires a `senderId` the caller has already verified is pinned; the precondition is stated in the function's own comment | verify the caller upholds it: see the app-layer row below, which is stricter than the crypto layer requires |
| Re-key sender authentication (app layer) | `app/js/main.js:1409-1463` (`onControl`) requires `state.genRoster.has(senderId) && state.pinned.has(senderId)` (`main.js:1445`) before calling `applyRekey` at `main.js:1458`; `net.js:130,169` (`createRoster`'s `ingest`) only invokes the `onControl` callback for a sender pinned before the current ingest pass began (`wasPinned`) | two independent gates: `net.js` won't hand a control message to the app for an unpinned sender, and `main.js` won't act on it even if pinned unless the sender is in the generation's own founding roster (`genRoster`), not merely the device's full historical pinned set |
| Member identity binding (pk + epk) | `wire.js:67-69` (`memberIdFromKeys`), enforced on receive at `net.js:107` inside `ingest()`, on the invite channel at `main.js:2658`, and at the relay on write (`relay/src/index.js:192`) | id is `SHA-256("starling/v2/member" \|\| pk \|\| epk)` truncated to 128 bits, checked by a receiver and by the relay independently |
| Signing algorithm is a function of the key, never a wire field | `wire.js:103-105` (`algFromPk`), used at `net.js:109` before anything is pinned | `alg` is not covered by the member id, so a relay can flip it; it used to be read off the response, and flipping it silently erased that member from every map, which a safety number cannot detect either |
| An agreement key must be a real point | `wire.js:113-117` (`validEcdhKey`), enforced at `net.js:113`, at `main.js:1541` (`addPinned`) and three times on the join path (`main.js:2798` when the request arrives, `main.js:2853` and `main.js:2875` at the moment somebody is let in) | a length-checked but malformed `epk` can be pinned and then makes every later ECDH throw, which disables re-keying, removal and joining for the whole circle |
| Member cap enforced by the receiver too | `net.js:121` for the feed, `main.js:2836` for an admission | the relay's cap is untrusted, and it counts a different channel; without the second one a full circle could admit a seventeenth member who then found no slot on the circle channel and went silently unheard |
| Trust-on-first-use pinning, no silent re-pin | `net.js:130-137` | a key change on an already-pinned member drops the point and calls `onKeyChange`, never overwrites |
| Sender signature verification (receiver side) | `net.js:155` inside `ingest()`, and `main.js:2672` for the invite channel | called on every point before decryption; this is the property an earlier audit found missing, and it stayed present through the v2 rewrite |
| Sender signature verification (relay side, advisory only) | `relay/src/index.js:226-227` | the relay checks too, to keep junk out of storage; a receiver never relies on this, per the file's own header comment |
| Sealed `ts` must equal the header `ts` | `net.js:167` and `main.js:2681` | otherwise a relay could re-file a ciphertext under a different header, and the header is what selects the nonce and the AAD |
| Nonce construction / reuse guard | `ratchet.js:87-92` (`nonceFor`), with the sender's monotonic `ts` persisted at `main.js:1286-1287` | 4 random bytes then `ts` as big-endian 64-bit; per-sender key plus strictly increasing `ts` means the counter half cannot repeat in normal operation |
| AAD / signed string binding channel, member, epoch | `wire.js:129-135` (`sigBase`, `aadFor`) | epoch is inside both, so a point cannot be replayed into a different epoch, channel, or member slot |
| Replay defense (receiver, positions) | `net.js:82-89` (`accepted`) | strictly increasing `(e, ts)` per member, enforced independent of the relay's own check |
| Replay defense (receiver, control messages) | `net.js:69-79` (`controlSeen`, `controlFresh`), marked only for messages actually dispatched (`net.js:169-181`) | a bounded set rather than the position watermark, so a relay serving a later position first cannot make an earlier re-key permanently unacceptable |
| Replay defense (relay, advisory) | `relay/src/index.js:206-212`, `index.js:249-250`, plus the `points_v3` primary key `(channel, member, ts)` in `relay/schema.sql` | `last_ts` moves forward only, `MAX(members_v3.last_ts, excluded.last_ts)` on conflict, so two racing posts from one member cannot walk the pin backward; still not what a receiver relies on |
| Member cap enforced atomically at the relay | `relay/src/index.js:238-272` | the cap lives inside the same D1 batch as the insert, so concurrent admissions serialize and a refused request writes nothing; the `COUNT` at `index.js:216-217` is a fast path, not the guard |
| Rate limiting ahead of any work | `relay/src/index.js:51-97` (two maps, sliding window), applied at `index.js:161-167` before the body read, the storage reads and the signature check | separate maps per namespace: channel ids are attacker-chosen and unlimited, so one shared map would let a sprayer evict every address bucket |
| Padding (message-type hiding) | `crypto.js:91-104` (`sealMessage`) | every plaintext padded to exactly `PAD_LEN` (512) with trailing spaces before encryption, on every channel, including the `ack` that claims a welcome slot |
| One-time invites | `crypto.js:216-258` (secret, channel, and commitment derivation; fragment parse refuses a link with no commitment), wired into the app at `main.js:2699` (`inviteLinkFor`), `main.js:2729-2734` (`burnInvite`), and `main.js:3108` (the `t:"join"` post) | a fragment without the 128-bit commitment is not treated as an unauthenticated v2 invite, it is refused outright (`crypto.js:257-258`) |
| Welcome / invite handshake (who may answer a link) | `app/js/membership.js:45-56` (`inviterMatches`) and `membership.js:105-112` (`openWelcome`): the sender's `pk`/`epk` must both hash to its claimed member id **and** to the commitment the link carries; also applied at the door, before a message is buffered, at `main.js:3178-3182` | verification happens before the wrap is opened, never after; an unverified sender's bytes are never handled as key material, and never occupy the joiner's buffer |
| Welcome wrap context | `membership.js:37-38` (`welcomeContext`), sealed at `main.js:3031`, opened at `membership.js:109` and `membership.js:123` | `starling/v2/welcome\|by\|g\|e0`, bound into the wrap's AAD, so a welcome only opens as the identity the link committed to and a `member` record cannot be lifted out of a different welcome |
| Welcome completeness (no silent partial roster) | `membership.js:67-88` (`readWelcome`'s `n` field), assembled by `membership.js:151-171` (`assembleWelcome`), gated in the app by `main.js:3146-3147` (`WELCOME_GRACE_MS` = 60 s, `WELCOME_MSG_CAP` = 128) and `main.js:3211-3221` (refuse rather than join on an incomplete roster after the grace period) | a joiner that decrypts the seed but never receives every promised `member` record is told why and does not silently join half-informed |
| Welcome slot claimed before the re-key | `main.js:2989-3003` (`openWelcomeChannel` posts an `ack` first at `main.js:2998`), called before `doRekey` at `main.js:2921` | the re-key cannot be taken back, so nothing irreversible happens until the rendezvous channel has accepted a post from the inviter; a jammed channel burns the link instead (`main.js:2911`) |
| Roster convergence after an admission | `membership.js:198-218` (`rosterView`, `rosterConverged`), applied at `main.js:1484-1507` (`reconcileRoster`) and gated by `main.js:1469` (`ROSTER_GRACE_MS` = 5 min) | a disagreement right after an admission is held, not alarmed, until the new member posts and the hash recomputes to match; a disagreement that never resolves inside the grace period is surfaced (`main.js:1504-1505`) |
| Member records are welcome-only, never from the circle channel | `membership.js:188-189` (`circleControl`) returns `"rekey"` for a `rekey` message and `null` for everything else, including `member`; `main.js:1427-1428` drops a `member` record seen on the circle channel and logs it rather than acting on it | the one place `member` is ever honoured is inside a verified welcome (`membership.js:119-128`, `openWelcomeRecord`), sealed under that welcome's own context |
| Re-key delivery (ECDH wrap) | `crypto.js:147-203` (`generateEphemeral`, `sealTo`, `openSealed`; the AAD is built at `crypto.js:177`), context built by `rekey.js:39-40` (`rekeyContext`) | fresh ephemeral key per wrap; the AAD binds the recipient's member id and, through `context`, who rotated, which generation, which epoch was mixed, the roster hash and who was dropped, so a wrap cannot be replayed at another member or reattributed to a different rotator |
| Roster hash | `wire.js:88-90` (`rosterHash`), built at `rekey.js:60`, compared at `rekey.js:172-174` and `membership.js:216-218` | `b64u(SHA-256("starling/v2/roster\|" + sorted ids joined by ","))` over the set the rotator wrapped to, which is the next generation minus the rotator itself |
| Beacon channel unlinkability, per viewer | `crypto.js:277` and `crypto.js:290` (`deriveHelpChannelId`, `deriveHelpEncKey`) use `starling/v2/help-*` HKDF labels, separate from the circle domain, one secret per viewer; wired into `app/js/beacon.js:48-89` (one secret, one channel and one signing identity per viewer) | each viewer's link derives its own channel; the relay cannot link two viewers' channels to each other by key material |
| Beacon sender pinning (viewer side) | `app/js/helpview.js:52-55` (`onlyFrom`), applied at `helpview.js:138` | the link commits to the beacon's member id and the viewer filters before ingest, so a false position from anyone else the link reached never touches the roster, the map or the status line |
| Beacon expiry, enforced both ends | `crypto.js:303-316` (`beaconFragment`/`parseBeaconFragment`, no fallback for a commitment-free link), `app/js/beacon.js:100-120` (retiring a viewer past `expiresAt` before the next post), `app/js/helpview.js:31-32` and `helpview.js:116` (`isExpired`, checked before render and again in the poll loop) | both the sender and the viewer stop independently at the same deadline; neither trusts the other to enforce it |
| Beacon viewer key cannot encrypt | `crypto.js:290` (usages are the caller's to name), `helpview.js:128` passes `["decrypt"]`, `beacon.js:55` passes `["encrypt"]` | narrow, and stated narrowly: it does not stop a link holder sealing something in their own code, it stops a bug in the viewer page becoming a post |
| App-lock at-rest encryption | `app/js/lock.js:65` (`sealUnderVault`), `lock.js:71` (`openUnderVault`), `lock.js:91` (`makePasscodeRecord`), `lock.js:242` (`makeBioRecord`), `PBKDF2_ITERS = 600000` (`lock.js:25`) | unchanged by the v2 migration; wraps whatever the storage layer currently calls the circle secret, which since v2 is the retained chain key, not a permanent root |
| Multi-circle storage (v2 shape) | `app/js/circles.js:73-129` (`packGenMeta`/`readGenMeta`, pinned roster pack/read at `circles.js:110`), `circles.js:188` (the staged generation record) | a circle record is a generation (`g`, `e0`, `ckEpoch`, `channelId`, `genRoster`) plus a pinned roster, not a flat 32-byte secret; see the file's own header comment for why the storage slot is still named `secret` |
| Panic wipe (web) | `app/js/store.js:83` (`wipeAll`) | deletes IndexedDB, clears localStorage and Cache Storage, unregisters the service worker; the code's own comment notes the browser's HTTP tile cache is unreachable from page JS and is not wiped |
| Panic wipe (Android, PanicKit) | `android/app/src/main/kotlin/app/starlingmap/PanicActivity.kt:54-69` (`wipeEverything`) | checks the sender is the paired app before acting (`receivedTriggerFromConnectedApp`, line 27), then `clearApplicationUserData()` |

## Key lifetime table

| key | derives from | maximum lifetime | forces early rotation | device that misses rotation |
|---|---|---|---|---|
| `seed` (generation) | random (create) or `HKDF(CK_e \|\| NS)` (re-key), `ratchet.js:254-264` (`nextSeed`), matching `docs/PROTOCOL.md`, "Re-keying" | none held; destroyed the instant `A` and `CK_0` are derived (`rekey.js:23-32`, `openGeneration`) | n/a, it never persists | n/a |
| `A` (anchor) / `channel` | `HKDF(seed, ...)` (`deriveAnchor` at `ratchet.js:57`, `channelFromAnchor` at `ratchet.js:61-62`) | life of the generation | a re-key (new generation, new anchor, new channel) | cannot follow a re-key it did not receive; goes quiet on the old channel |
| `CK_e` (chain key) | `HKDF(CK_{e-1}, "step")` or `chainInit(seed)` for `CK_0` | one `EPOCH_MS` (10 min); retained for `HISTORY_EPOCHS` past epochs (user setting: 10 min / 1 h / 6 h / 24 h) | epoch boundary (automatic); history-window setting lowered by the user | keys older than the window are already destroyed on this device; nothing to miss, the data is gone by design |
| `MK(e, m)` (message key) | `HKDF(CK_e, "msg\|" + m)` (`ratchet.js:69-73`) | same as its `CK_e`; derived lazily and cached per `(epoch, member)`, evicted with the epoch (`ratchet.js:114-136`, `forget`) | same as `CK_e` | same as `CK_e` |
| Signing keypair (identity) | `subtle.generateKey` (Ed25519 or P-256), `crypto.js:56-77` | life of membership in the circle; there is no rotation event for this key short of leaving and rejoining as a new member | member removal via re-key (the whole identity is dropped, not rotated) | a device that never learns it was removed keeps a signing key that is simply no longer admitted to new generations; it cannot forge its way back in |
| ECDH agreement keypair (`epk`) | `subtle.generateKey` (P-256), minted by the same call, `crypto.js:56-77` | paired 1:1 with the signing keypair above, same lifetime | same as signing keypair | same as signing keypair |
| `member_id` | `SHA-256("starling/v2/member" \|\| pk \|\| epk)` (`wire.js:67-69`) | derived, not stored independently; lives as long as the keypair pair it commits to | n/a (recomputed, never rotated on its own) | n/a |
| `NS` (re-key entropy) | random 32 bytes, minted by the rotator (`rekey.js:49-89`, `buildRekey`) | single use; consumed into `seed_{g+1}` and never stored | n/a | a recipient who never receives its wrap never gets `NS`; this is what removal means |
| Invite secret `IS` | random 32 bytes (`crypto.js:216`) | `INVITE_TTL_MS` (1 h) if unaccepted, or one accepted use, whichever comes first (`main.js:2729-2734`, `burnInvite`), and only once the welcome has actually gone out (`main.js:2955`) | burned by the inviter on accept | an invite a device never redeemed in time simply expires; the link is inert afterward |
| Beacon secret | random 32 bytes per viewer (`crypto.js` `randomBytes(32)` via `beacon.js`) | memory only; ends on check-in, stop-sharing, app lock, revocation of that one viewer, or process death (`beacon.js:100-120`, `beacon.js:157-163`) | any of the above events, per viewer independently | nothing to miss; it was never written to disk |
| Vault key `K` (app lock) | random 32 bytes, minted when lock is first enabled (`lock.js:36`) | until the lock is disabled; re-wrapped, not regenerated, when the passcode changes or a biometric is added | user disables and re-enables the lock | a device that misses nothing here; `K` does not expire on its own, it is only as strong as the passcode/biometric wrapping it |
| Passcode/biometric wrap key | derived fresh on each unlock attempt (PBKDF2 or PRF/Keystore), never stored | single use (one unlock) | n/a | a wrong passcode or failed biometric fails AES-GCM authentication and returns null; there is no separate lockout counter, the KDF cost is the only throttle |

## Deletion schedule, honestly

- **Content keys.** `HISTORY_EPOCHS` past epochs retained, everything older
  destroyed on every app start and every epoch boundary (`ratchet.js:114-136`,
  `210-226`). Destruction is `Uint8Array.fill(0)` (`ratchet.js:39-40`) followed
  by removal from the in-memory `Map`.
- **What "destroyed" cannot mean in a browser.** JavaScript garbage collects,
  it does not zeroise; a copy of a key may persist in heap the page can no
  longer reach until the collector reclaims it. IndexedDB writes go through
  SQLite and, on most devices, a flash translation layer, so an overwritten
  record's old bytes may physically remain on the storage medium until that
  block is reused. Long-lived keys are held as non-extractable `CryptoKey`
  objects wherever WebCrypto allows it (every `generateKey` call in
  `crypto.js:56-77` passes `extractable: false`;
  `messageKey` at `ratchet.js:69-73` does the same), which keeps them out of script-readable
  memory but does not change either fact above. This is the same gap
  `docs/PROTOCOL.md` states in its own "History window and destruction"
  section, citing RFC 9420 §9.2: forward secrecy here is a claim about what
  the application retains and requests, not a claim about what is physically
  recoverable from a seized device.
- **Relay retention.** `TTL_MS` (24 h), swept on every read and write
  (`relay/src/index.js:101-103` builds the sweep statements; `handlePost`
  runs them in the same batch as every write, `handleGet` runs them before
  every read). No cron, no background job that can silently stop running.
- **Panic wipe (web).** `store.js:83-115` deletes the IndexedDB database,
  clears `localStorage` and every Cache Storage cache, and unregisters the
  service worker. It does **not** reach the browser's own HTTP cache (map
  tiles); the code says so in its own comment, and the in-app panic copy
  should say so too.
- **Panic wipe (Android).** `clearApplicationUserData()` plus an explicit,
  synchronous Keystore key delete before the async system wipe runs
  (`PanicActivity.kt:54-69`), because the system's own Keystore cleanup is
  fire-and-forget and its failures are swallowed.

## Normative requirements

Written as "must," because these are the properties a re-implementation has
to preserve, not just describe.

- **Skipped-key policy.** There is no per-message skipped-key cache the way a
  Double Ratchet or Megolm needs. Content keys are per `(epoch, member)`, not
  per message, so a receiver never needs to remember a key for a message it
  has not seen yet. When a receiver must jump forward across epochs, it walks
  the chain one `chainStep` at a time from its current head to the target
  (`ratchet.js:142-151`, `advanceTo`), discarding every intermediate epoch
  below the retained window as it goes, and MUST refuse the jump outright if
  it exceeds `MAX_CATCHUP_EPOCHS` (`ratchet.js:145`), returning failure rather
  than performing an unbounded walk. A hostile epoch index far in the future
  is the attack this bound exists for: without it, a single message could
  force thousands of needless HKDF calls.
- **Replay/dedup window.** A receiver MUST reject a point whose `(e, ts)` for
  a given member is not strictly greater than the last accepted `(e, ts)` for
  that member (`net.js:82-89`). This state is in-memory only and is rebuilt
  from a fresh poll starting at the retained window's oldest epoch on every
  reload (`net.js:230-233`, `windowStart`); that is safe specifically because
  acceptance is monotonic, so replaying an older point after a reload cannot
  move a member's displayed state backward. A second, independent dedup layer
  in the poller (`net.js:244-257`, keyed on
  `member|epoch|ts|nonce`, capped at 4096 entries) exists only to avoid re-ingesting a point the relay resends
  inside one polling session; it is not the security boundary, `accepted()`
  is. Control messages (`rekey`) get their own separate, bounded dedup set
  (`net.js:69-79`, `controlSeen`, capped at 512), deliberately not sharing the
  position watermark: an untrusted relay withholding a later position must
  not be able to permanently poison a member's ability to accept an earlier
  re-key once it finally arrives.
- **Membership-authentication rule (control messages).** A re-key MUST be
  attributed to, and only accepted from, a sender who was already pinned
  *before* the ingest pass that delivered the control message began
  (`net.js:130`, `169`, `wasPinned`), and the app layer
  narrows this further to a sender in the generation's own founding roster
  (`main.js:1445`, `state.genRoster.has(senderId)`). Pinning a new member on the strength of a
  re-key message, or accepting a re-key from a member the *current*
  generation never admitted, would let an attacker forge their way into a
  generation without a valid signature ever being checked against them at the
  moment they claim authority over it.
- **Member records MUST be refused outside a verified welcome.** A `member`
  record arriving on a circle channel is dropped unconditionally
  (`membership.js:188-189`, `main.js:1427-1428`), regardless of whether its
  sender is pinned, verified, or even a real member. The only path a `member`
  record can take into the roster is via `openWelcomeRecord`
  (`membership.js:119-128`), sealed under a welcome context that itself
  required the sending device's keys to hash to the commitment the invite
  link named (`membership.js:45-56`, `inviterMatches`).
- **Clock-skew tolerance.** `MAX_SKEW_EPOCHS` = 2 (plus/minus 20 minutes)
  bounds how far an epoch index may sit from a device's own clock before it
  is rejected outright (`wire.js:195-197`, `epochPlausible`; enforced inside
  `ratchet.js:162-176`, `keyFor`). `FUTURE_SKEW_MS` = 10 minutes separately
  bounds the sealed `ts` field a receiver will accept
  (`net.js:168`). Both exist so that a member with a fast clock cannot starve
  every other member's points from the feed (`net.js`'s cursor pages on the
  relay's own receive time, `srv`, never a client-claimed `ts`).

## How to run the test vectors

`test/vectors/` (`chain.json`, `hkdf.json`, `identity.json`, `keys.json`,
`session.json`, `strings.json`) holds machine-readable vectors an independent
implementation can replay: HKDF labels, a chain advance including a long
jump, epoch/member-to-key and nonce mappings, exact `aad`/`sigBase` byte
strings, and one recorded multi-member session (join, re-key, removal,
out-of-order delivery, a replay that must be rejected).

```
npm test                          # everything, vectors included; 399 at the last run
node --test test/vectors.test.mjs # just the vectors
node tools/gen-vectors.mjs        # regenerates test/vectors/ from fixed, non-secret keys
```

`gen-vectors.mjs` names every substitution it relies on in its own header
comment (frozen pkcs8 keys, a counter stream standing in for
`getRandomValues`), because the file's own claim is that a vector whose
inputs are secret is not a vector. Read it alongside `test/vectors.test.mjs`
to see the derivation checked, not just its output.

## Questions we most want an auditor to attack first

The wiring-completeness questions from earlier drafts of this document are
resolved (see [Implementation status](#implementation-status)) and are not
repeated here. What follows targets the newest code, the code least covered by
a unit test in isolation, and the things round five turned up.

### From round five

1. **Build a second implementation from `docs/PROTOCOL.md` alone, then
   run it against `test/vectors/`.** Round five found five places where
   the document and the code disagreed, and in three of them the
   document understated a defence that exists, most seriously the re-key
   wrap AAD, which was written without its `context` term. That is the
   exact construction of a bug this project already fixed once. The
   document is now corrected, but the failure mode is structural:
   nothing mechanically ties the prose to the code, and the vectors are
   the only artifact that does. Writing an implementation from the prose
   and replaying the vectors is the cheapest way to find the next one.
   Anywhere they disagree, the code and the vectors are right.
2. **A re-key that outlives the receiver's history window.** A re-key is
   an ordinary padded message on the circle channel, so it is read with
   the key for the epoch it was sent in. At the High risk history
   setting the window is a single epoch
   (`ratchet.js:162-176` returns null
   once the chain key is gone), so a re-key that spends more than about
   ten minutes in a relay backlog cannot be opened at all. For a
   position that is the design working. For a control message it looks
   different: the circle moves to a new channel, this device keeps
   polling the old one, and `state.missedRekey` is only ever set by a
   *later* re-key arriving on the channel it is still watching
   (`main.js:1454`), which nobody will post there. Work
   out whether that leaves a device silently stranded, how long it takes
   anyone to notice, and whether the relay withholding a re-key for one
   epoch is enough to cause it deliberately.
3. **Cross-protocol confusion between the two wrap types.** A welcome
   wrap and a re-key wrap share the AAD label `starling/v2/rekey` and
   the same HKDF label shape; what separates them is the channel id
   (invite versus circle) and the shape of `context`
   (`starling/v2/welcome|by|g|e0` versus `by|g|e0|me|rh|rm`). A rotator
   id is validated as a 32-hex member id before a context is rebuilt, so
   the two shapes should not be able to collide. Confirm that, and
   confirm there is no third caller of `sealTo`/`openSealed` that could
   be made to open one as the other.
4. **How much freedom `me` gives a rotator.** `me` may name any epoch
   the receiver still retains, up to the message's own epoch
   (`rekey.js:130`). Normally it is the current epoch.
   Work out whether naming an older one buys an attacker anything,
   especially against members whose history window is shorter than the
   rotator's, and whether the resulting "your device cannot follow this
   re-key" outcome is distinguishable from an honest one.
5. **The invitation that is deliberately not burned.** When the welcome
   fails to send, the link is now left alive so the joiner can try
   again, because by then the re-key has happened and the joiner is
   pinned into a generation nobody handed them
   (`main.js:2911` and the block below it). That is a live
   credential in a window where the circle has already changed keys.
   Confirm the window is bounded only by `INVITE_TTL_MS`, that a second
   accept on the same link cannot admit a *different* identity than the
   one already pinned, and that the person is told clearly enough to
   notice.
6. **Three member caps counting three different sets.** The relay caps
   pinned senders per channel, a receiver caps its own durable roster
   (`net.js:121`), and the admitting device caps the circle it
   is admitting into (`main.js:2836`, pinned plus self).
   They count different things and are enforced at different moments.
   Look for the arrangement where all three pass and the circle still
   ends up with a member who has no slot on some channel, which is the
   failure the third one was added for.

### Standing

7. **The imposter count as a trust signal.** `assembleWelcome`
   (`membership.js:151-171`) counts
   every `t:"welcome"` message that fails to verify as an "imposter,"
   the join watcher counts strangers at the door as well
   (`main.js:3178-3182`), and
   `main.js` surfaces the total to the joiner while they wait
   (`main.js:667`,
   `main.js:813`). Ordinary network noise, a stale
   retry, or a device replaying an old welcome attempt from a *previous*
   invite on the same channel would also fail to verify and increment
   the same counter. Confirm the count cannot be driven up by anything
   short of an actual competing welcome, and that the UI copy does not
   read as a stronger claim ("someone is attacking you") than the data
   supports ("someone or something posted a welcome that did not
   verify").
8. **Welcome-channel flood cost.** `WELCOME_MSG_CAP`
   (`main.js:3147`) caps `pending` at 128 messages per
   batch before `assembleWelcome` runs, and only messages from the
   committed inviter are buffered at all. The relay independently caps a
   channel at `MEMBER_CAP` (16) pinned senders and `TRAIL_CAP` (240)
   points per sender. An attacker who already has the invite link (the
   only way to know the invite channel id) could pin up to 16 throwaway
   member rows and post up to 240 garbage points each, all of which cost
   the joiner's device a signature check before the commitment check
   rejects them. Work out whether that is a meaningful cost multiplier
   over what the relay's own per-channel caps already bound, and whether
   it matters given that anyone who can reach this attack already has
   the link and a shot at the more direct race.
9. **Roster convergence grace period vs. a fast second re-key.** A newly
   admitted member is adopted into `genRoster` only once this device's
   own roster hash matches the rotator's
   (`main.js:1484-1507`,
   `reconcileRoster`). `ROSTER_GRACE_MS` is 5 minutes
   (`main.js:1469`). Confirm there is no path where the
   newcomer re-keys again (a manual "new keys now," for instance) inside
   that 5-minute window, before every existing member's device has
   independently converged on the first admission, in a way that leaves
   some members accepting the second re-key and others still waiting on
   the first, with no message that ever reconciles the two views.
10. **The 30-day catch-up cliff.** A device offline longer than
    `MAX_CATCHUP_EPOCHS` cannot advance that generation's ratchet again
    and destroys it instead
    (`ratchet.js:210-226`); recovery
    requires a fresh invite. Confirm the app surfaces this as "you need
    to be re-invited" (`state.chainDestroyed` and `state.chainWiped`,
    `main.js:171-179`), and that
    neither that path nor the missed-generation path
    (`main.js:1454`) can end in a silent stuck spinner.
11. **Re-key authority and races.** Any member may re-key, including to
    remove another member. Confirm there is no path where a member who
    is mid-removal from one re-key can race a second, competing re-key
    to stay in the circle, given that `applyRekey` requires `msg.g` to
    be exactly `gen.g + 1`
    (`rekey.js:99-164`) and so should
    reject a second, delayed re-key built against a generation that has
    already advanced; confirm this holds under out-of-order delivery,
    not just in-order.
12. **Nonce collision math under load.** The reuse guard is 4 random
    bytes (`ratchet.js:87-92`). With
    up to `MEMBER_CAP` (16) senders and a chain that can retain up to
    144 epochs at the longest history setting, work the birthday bound
    on that guard across the plausible message volume and confirm it
    still lands where the design claims it does.
13. **The SOS/circle correlation signal.** Firing an SOS starts a beacon
    channel from the same IP, in the same instant, as the circle
    channel. The keys are unlinkable, but a relay operator watching
    arrival timing does not need the keys. Is uniform padding (already
    true) enough, or is a deliberate delay before the beacon's first
    post cheap enough to be worth adding.

### One thing we know is wrong and is not a security finding

`app/js/main.js` says, where a freshly joined device announces itself, that
"a check-in carries no position." `sendMsg` includes `lat`/`lon` whenever the
device already has a fix (`main.js:3960`), so on a device
that was already sharing in another circle that comment is not true. Nothing
downstream depends on it. It is listed here because a comment that says a
message carries less than it does is the kind of thing an auditor should be
able to trust, and this one cannot be.
