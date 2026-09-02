// What a receiving device will and will not believe.
//
// A content key is shared by nobody in v2 (it is per sender), but the CHAIN it
// comes from is shared by the whole circle, so any member can derive any other
// member's key and produce ciphertext that opens cleanly in their slot. Sender
// authenticity rests entirely on the per-member signature, and these tests are
// the reason the receiver checks it itself instead of trusting the relay to
// have done so.
//
// The other half of this file is replay. A hash ratchet provides no replay
// resistance and one key covers a whole epoch, so a recorded point stays
// decryptable for the rest of it. Replaying a location is not cosmetic: it puts
// someone where they no longer are.
import test from "node:test";
import assert from "node:assert/strict";

import { createRoster } from "../app/js/net.js";
import { openGeneration } from "../app/js/rekey.js";
import { generateIdentity, newSeed, sealMessage, buildPost } from "../app/js/crypto.js";
import { EPOCH_MS } from "../app/js/ratchet.js";
import { b64uEncode, b64uDecode } from "../app/js/wire.js";

const E0 = 2980471;
const at = (e) => e * EPOCH_MS;
const SELF = "0".repeat(32);

// One circle, two views of it: the sender's generation and the receiver's. Both
// come from the same seed, which is what being in a circle means.
async function circle({ historyEpochs = 144 } = {}) {
  const seed = newSeed();
  const send = await openGeneration({ seed: new Uint8Array(seed), g: 0, e0: E0, historyEpochs });
  const recv = await openGeneration({ seed: new Uint8Array(seed), g: 0, e0: E0, historyEpochs });
  return { send, recv, channelId: send.channelId };
}

const rosterFor = (c, opts = {}) =>
  createRoster({ channelId: c.channelId, ratchet: c.recv.ratchet, selfId: SELF, pinned: new Map(), ...opts });

// A pinned map that already knows these identities. Control messages are only
// acted on from a member pinned BEFORE the pass that carries them, so any test
// about re-keys has to start from a roster that has already seen the sender,
// which is also what happens in life: you see someone's positions long before
// they re-key.
const pinnedWith = (...ids) =>
  new Map(ids.map((i) => [i.memberId, { alg: i.alg, pk: b64uEncode(i.pk), epk: b64uEncode(i.epk), verified: false }]));

// One point, sealed and signed the way the sender would.
async function point(c, identity, e, ts, msg) {
  const key = await c.send.ratchet.keyFor(e, identity.memberId, at(e));
  const sealed = await sealMessage(key, c.channelId, identity.memberId, e, ts, msg);
  const post = await buildPost(identity, c.channelId, e, sealed, ts);
  return { e: post.e, ts: post.ts, srv: post.ts, n: post.n, c: post.c, sig: post.sig };
}

// One feed entry as the relay serves it: the member's pinned keys plus points.
async function entryFor(c, identity, msgs) {
  const points = [];
  for (const { e, msg } of msgs) points.push(await point(c, identity, e, msg.ts, msg));
  return {
    m: identity.memberId,
    alg: identity.alg,
    pk: b64uEncode(identity.pk),
    epk: b64uEncode(identity.epk),
    points,
  };
}

const loc = (ts, extra = {}) => ({ v: 2, t: "loc", ts, lat: 44.98, lon: -93.27, name: "Real", ...extra });

test("an honest, signed point is ingested", async () => {
  const c = await circle();
  const alice = await generateIdentity();
  const roster = rosterFor(c);

  const now = at(E0) + 1000;
  await roster.ingest([await entryFor(c, alice, [{ e: E0, msg: loc(now) }])], now);

  const rec = roster.get(alice.memberId);
  assert.ok(rec, "a correctly signed point must be accepted");
  assert.equal(rec.lat, 44.98);
  assert.equal(rec.trail.length, 1);
});

test("a circle member cannot forge a point from another member", async () => {
  // The attack the signature exists to stop. Mallory is a real member, so she
  // holds the chain and can derive Alice's content key for any epoch. Her
  // ciphertext opens cleanly under Alice's slot. With a relay that serves
  // whatever it is told, the only thing between her and putting Alice on a
  // corner of her choosing is the receiver checking Alice's signature.
  const c = await circle();
  const alice = await generateIdentity();
  const mallory = await generateIdentity();
  const now = at(E0) + 1000;

  const lie = loc(now, { lat: 0, lon: 0, name: "Alice (forged)" });
  const key = await c.send.ratchet.keyFor(E0, alice.memberId, at(E0));
  const sealed = await sealMessage(key, c.channelId, alice.memberId, E0, now, lie);
  // Sealed under Alice's slot so the AAD matches, but signed by Mallory and
  // served with Alice's real public keys.
  const post = await buildPost(mallory, c.channelId, E0, sealed, now);
  const forged = {
    m: alice.memberId,
    alg: alice.alg,
    pk: b64uEncode(alice.pk),
    epk: b64uEncode(alice.epk),
    points: [{ e: E0, ts: now, srv: now, n: post.n, c: post.c, sig: post.sig }],
  };

  const roster = rosterFor(c);
  await roster.ingest([forged], now);
  assert.equal(roster.get(alice.memberId), undefined, "a point Alice did not sign must never become Alice's position");
});

test("a point whose signature was stripped or corrupted is dropped", async () => {
  const c = await circle();
  const alice = await generateIdentity();
  const now = at(E0) + 1000;
  const good = await entryFor(c, alice, [{ e: E0, msg: loc(now) }]);

  for (const mutate of [
    (e) => delete e.points[0].sig,
    (e) => (e.points[0].sig = ""),
    (e) => (e.points[0].sig = "!!!not base64!!!"),
    (e) => (e.points[0].sig = b64uEncode(new Uint8Array(64))),
  ]) {
    const entry = structuredClone(good);
    mutate(entry);
    const roster = rosterFor(c);
    await roster.ingest([entry], now);
    assert.equal(roster.get(alice.memberId), undefined, "unsigned or badly signed points must not be ingested");
  }
});

test("a signature valid for one field cannot be moved to another", async () => {
  // sigBase covers channel, member, epoch, ts, nonce and ciphertext together,
  // so a signature lifted from a real point does not authenticate a different
  // one. This catches a relay that shuffles points between timestamps.
  const c = await circle();
  const alice = await generateIdentity();
  const now = at(E0) + 1000;
  const entry = await entryFor(c, alice, [
    { e: E0, msg: loc(now) },
    { e: E0, msg: loc(now + 1000, { lat: 12.34 }) },
  ]);

  entry.points[1].sig = entry.points[0].sig;
  const roster = rosterFor(c);
  await roster.ingest([entry], now + 2000);

  const rec = roster.get(alice.memberId);
  assert.ok(rec, "the untouched first point still lands");
  assert.equal(rec.ts, now, "the point wearing a borrowed signature must be dropped");
  assert.notEqual(rec.lat, 12.34);
});

test("a signature cannot be carried into another epoch", async () => {
  const c = await circle();
  const alice = await generateIdentity();
  const now = at(E0) + 1000;
  const entry = await entryFor(c, alice, [{ e: E0, msg: loc(now) }]);
  entry.points[0].e = E0 + 1;

  const roster = rosterFor(c);
  await roster.ingest([entry], at(E0 + 1) + 1000);
  assert.equal(roster.get(alice.memberId), undefined, "the epoch is inside the signed string");
});

test("a member id that does not hash from the served keys is rejected outright", async () => {
  const c = await circle();
  const alice = await generateIdentity();
  const mallory = await generateIdentity();
  const now = at(E0) + 1000;

  // Mallory signs her own points correctly but claims Alice's id.
  const entry = await entryFor(c, mallory, [{ e: E0, msg: loc(now) }]);
  entry.m = alice.memberId;

  const roster = rosterFor(c);
  await roster.ingest([entry], now);
  assert.equal(roster.list().length, 0, "member id is the hash of the keys and is checked before anything else");
});

test("the id binds the agreement key too, so an epk cannot be substituted", async () => {
  // The v2 attack the id length and the double binding exist to stop: a relay
  // that cannot forge Alice's signature swaps in an agreement key of its own,
  // and then re-key material sealed to "Alice" is sealed to the relay.
  const c = await circle();
  const alice = await generateIdentity();
  const mallory = await generateIdentity();
  const now = at(E0) + 1000;

  const entry = await entryFor(c, alice, [{ e: E0, msg: loc(now) }]);
  entry.epk = b64uEncode(mallory.epk);

  const roster = rosterFor(c);
  await roster.ingest([entry], now);
  assert.equal(roster.list().length, 0, "the id no longer commits to the pair, so nothing is believed");
});

test("a pinned member whose keys change is surfaced, never silently re-pinned", async () => {
  const c = await circle();
  const alice = await generateIdentity();
  const impostor = await generateIdentity();
  const now = at(E0) + 1000;

  const pinned = new Map();
  const changes = [];
  const roster = createRoster({
    channelId: c.channelId,
    ratchet: c.recv.ratchet,
    selfId: SELF,
    pinned,
    onKeyChange: (id, keys) => changes.push([id, keys]),
  });

  await roster.ingest([await entryFor(c, alice, [{ e: E0, msg: loc(now) }])], now);
  assert.equal(pinned.size, 1, "first sight pins");
  assert.equal(pinned.get(alice.memberId).verified, false, "and pinning is not verification");

  // Same member id, different keys: only possible if someone is lying, since
  // the id is a hash of the keys. Rewriting the pin here would be the whole of
  // the "burgle into the group" attack.
  pinned.set(alice.memberId, { alg: impostor.alg, pk: b64uEncode(impostor.pk), epk: b64uEncode(impostor.epk), verified: true });
  const before = roster.get(alice.memberId).ts;
  await roster.ingest([await entryFor(c, alice, [{ e: E0, msg: loc(now + 5000, { lat: 1 }) }])], now + 5000);
  assert.equal(changes.length, 1, "the change is reported");
  assert.equal(changes[0][0], alice.memberId);
  assert.equal(roster.get(alice.memberId).ts, before, "and the points are dropped until a human accepts it");
  assert.equal(pinned.get(alice.memberId).pk, b64uEncode(impostor.pk), "the pin is not rewritten by the roster");
});

test("the same point delivered twice is accepted once", async () => {
  const c = await circle();
  const alice = await generateIdentity();
  const now = at(E0) + 1000;
  const entry = await entryFor(c, alice, [{ e: E0, msg: loc(now) }]);

  const roster = rosterFor(c);
  await roster.ingest([entry], now);
  const rec = roster.get(alice.memberId);
  assert.equal(rec.trail.length, 1);
  assert.equal(rec.ts, now);

  // The exact same bytes again. Everything about them still verifies and still
  // decrypts; only the receiver's (e, ts) high-water mark stops them.
  await roster.ingest([structuredClone(entry)], now + 1000);
  assert.equal(roster.get(alice.memberId).trail.length, 1, "the replay must add nothing");
  assert.equal(roster.get(alice.memberId).ts, now);

  // Ten more times, including inside a batch with a genuinely new point: the
  // new one lands, the replays do not.
  const fresh = await entryFor(c, alice, [{ e: E0, msg: loc(now + 2000, { lat: 12.5 }) }]);
  for (let i = 0; i < 10; i++) await roster.ingest([structuredClone(entry)], now + 2000);
  await roster.ingest([{ ...fresh, points: [...entry.points, ...fresh.points] }], now + 2000);
  const after = roster.get(alice.memberId);
  assert.equal(after.trail.length, 2, "exactly one new point got through");
  assert.equal(after.lat, 12.5);
});

test("a replayed control message is delivered exactly once", async () => {
  // The position record has its own "newer than what I have" rule, so a
  // replayed location is stopped twice over. A control message has no such
  // rule: it goes straight to the handler. Replaying a re-key is therefore the
  // case that rests on the per-member (e, ts) high-water mark alone, and it is
  // the one worth being sure about, because acting on a re-key twice is how a
  // circle gets dragged onto a generation somebody has already collected.
  const c = await circle();
  const alice = await generateIdentity();
  const now = at(E0) + 1000;
  const control = [];
  const roster = rosterFor(c, {
    pinned: pinnedWith(alice),
    onControl: (from, obj) => control.push([from, obj.t, obj.ts]),
  });

  const entry = await entryFor(c, alice, [
    { e: E0, msg: { v: 2, t: "rekey", ts: now, g: 1, to: SELF, rm: [] } },
  ]);
  await roster.ingest([entry], now);
  assert.equal(control.length, 1, "the first delivery is acted on");

  for (let i = 0; i < 5; i++) await roster.ingest([structuredClone(entry)], now + 1000 * i);
  assert.equal(control.length, 1, "and no replay of it ever is");

  // A genuinely later control message still gets through.
  const next = await entryFor(c, alice, [
    { e: E0, msg: { v: 2, t: "rekey", ts: now + 5000, g: 2, to: SELF, rm: [] } },
  ]);
  await roster.ingest([next], now + 5000);
  assert.equal(control.length, 2);
  assert.deepEqual(control.map((x) => x[2]), [now, now + 5000]);
});

test("(epoch, ts) must strictly increase per member", async () => {
  const c = await circle();
  const alice = await generateIdentity();
  const now = at(E0 + 1) + 1000;

  const roster = rosterFor(c);
  await roster.ingest([await entryFor(c, alice, [{ e: E0 + 1, msg: loc(now, { lat: 10 }) }])], now);
  assert.equal(roster.get(alice.memberId).lat, 10);

  // An earlier ts in the same epoch, an equal ts, and an earlier epoch with a
  // LATER ts: all replays of one shape or another.
  await roster.ingest([await entryFor(c, alice, [{ e: E0 + 1, msg: loc(now - 1, { lat: 20 }) }])], now);
  await roster.ingest([await entryFor(c, alice, [{ e: E0, msg: loc(now + 10_000, { lat: 30 }) }])], now);
  assert.equal(roster.get(alice.memberId).lat, 10, "nothing behind the high-water mark is accepted");

  // Forward is fine.
  await roster.ingest([await entryFor(c, alice, [{ e: E0 + 1, msg: loc(now + 1, { lat: 40 }) }])], now + 1);
  assert.equal(roster.get(alice.memberId).lat, 40);

  // And the high-water mark is per member, not global: Bob is not held back by
  // Alice's clock.
  const bob = await generateIdentity();
  await roster.ingest([await entryFor(c, bob, [{ e: E0, msg: loc(now - 5000, { lat: 50 }) }])], now + 1);
  assert.equal(roster.get(bob.memberId).lat, 50);
});

test("the sealed ts must be the one the header committed to", async () => {
  const c = await circle();
  const alice = await generateIdentity();
  const now = at(E0) + 1000;
  // Seal claiming one ts, sign and serve under another. The AAD binds them, so
  // this cannot even be built without the signature or the tag failing.
  const key = await c.send.ratchet.keyFor(E0, alice.memberId, at(E0));
  const sealed = await sealMessage(key, c.channelId, alice.memberId, E0, now, loc(now + 60_000));
  const post = await buildPost(alice, c.channelId, E0, sealed, now);
  const roster = rosterFor(c);
  await roster.ingest(
    [{
      m: alice.memberId,
      alg: alice.alg,
      pk: b64uEncode(alice.pk),
      epk: b64uEncode(alice.epk),
      points: [{ e: E0, ts: now, srv: now, n: post.n, c: post.c, sig: post.sig }],
    }],
    now,
  );
  assert.equal(roster.get(alice.memberId), undefined, "a re-filed point is dropped");
});

test("a point from an epoch that has left the window is dropped", async () => {
  const c = await circle({ historyEpochs: 6 });
  const alice = await generateIdentity();
  const ts = at(E0) + 1000;
  const entry = await entryFor(c, alice, [{ e: E0, msg: loc(ts) }]);

  const roster = rosterFor(c);
  const late = at(E0 + 20);
  await c.recv.ratchet.syncToClock(late);
  await roster.ingest([entry], late);
  assert.equal(roster.get(alice.memberId), undefined, "the key is gone, so the point is not shown");
});

test("a re-key from a sender we have never seen is dropped, not obeyed", async () => {
  // The burgle-into-the-group attack, and it was live until this was fixed.
  // A stranger posts a valid, correctly signed re-key. The receiver pins an
  // unknown sender the first time one of their points verifies, so if that
  // pin counted within the same pass, the stranger's re-key would satisfy its
  // own "is the sender pinned" check and move the circle onto a channel the
  // attacker owns. A control message is only ever acted on from a member who
  // was pinned before the pass that carried it.
  const c = await circle();
  const stranger = await generateIdentity();
  const now = at(E0) + 1000;
  const control = [];
  const roster = rosterFor(c, {
    pinned: new Map(),
    onControl: (from, obj) => control.push([from, obj.t]),
  });

  const entry = await entryFor(c, stranger, [
    { e: E0, msg: { v: 2, ts: now, t: "rekey", g: 1, to: SELF } },
  ]);
  await roster.ingest([entry], now);
  assert.strictEqual(control.length, 0, "a stranger's re-key must not reach onControl");

  // And the same sender, once genuinely known, is obeyed: the rule is about
  // when we learned the key, not a blanket refusal.
  const known = rosterFor(c, {
    pinned: pinnedWith(stranger),
    onControl: (from, obj) => control.push([from, obj.t]),
  });
  await known.ingest([entry], now);
  assert.deepStrictEqual(control, [[stranger.memberId, "rekey"]]);
});

test("control messages go to onControl and never into a member's trail", async () => {
  const c = await circle();
  const alice = await generateIdentity();
  const now = at(E0) + 1000;
  const control = [];
  const roster = rosterFor(c, {
    pinned: pinnedWith(alice),
    onControl: (from, obj, e) => control.push([from, obj.t, e]),
  });

  await roster.ingest(
    [await entryFor(c, alice, [
      { e: E0, msg: { v: 2, t: "rekey", ts: now, g: 1, to: SELF } },
      { e: E0, msg: { v: 2, t: "member", ts: now + 1, alg: "ed25519" } },
      { e: E0, msg: loc(now + 2) },
    ])],
    now + 2,
  );
  assert.deepEqual(control.map((x) => x[1]), ["rekey", "member"]);
  assert.equal(control[0][0], alice.memberId);
  assert.equal(control[0][2], E0, "the epoch the control message was sent in");
  const rec = roster.get(alice.memberId);
  assert.equal(rec.trail.length, 1, "only the location point is a position");
  assert.equal(rec.type, "loc");
});

test("our own points are ignored, and drop clears the replay memory with the member", async () => {
  const c = await circle();
  const alice = await generateIdentity();
  const now = at(E0) + 1000;

  const roster = createRoster({
    channelId: c.channelId,
    ratchet: c.recv.ratchet,
    selfId: alice.memberId,
    pinned: new Map(),
  });
  await roster.ingest([await entryFor(c, alice, [{ e: E0, msg: loc(now) }])], now);
  assert.equal(roster.list().length, 0, "a device does not learn its own position from the relay");

  // With a different selfId the same entry lands, and dropping the member takes
  // the seen set with it: after a re-key the member is a fresh slate.
  const other = rosterFor(c);
  await other.ingest([await entryFor(c, alice, [{ e: E0, msg: loc(now) }])], now);
  assert.ok(other.get(alice.memberId));
  other.drop(alice.memberId);
  assert.equal(other.get(alice.memberId), undefined);
  await other.ingest([await entryFor(c, alice, [{ e: E0, msg: loc(now) }])], now);
  assert.ok(other.get(alice.memberId), "the same ts is accepted again once the member was dropped");
});

test("a control message we refuse is not burned, so a resend still works", async () => {
  // The dedup mark used to be set before the pinned check, which meant a
  // newcomer's very first re-key was dropped (they are pinned by that same
  // pass, so they were not pinned before it) AND remembered as seen, so when
  // they sent it again THIS SAME DEVICE refused it forever and the circle
  // split with nothing reporting it. Only messages we act on get marked.
  //
  // One roster throughout, because the dedup set belongs to the roster. Two
  // rosters would pass against the bug and prove nothing.
  const c = await circle();
  const alice = await generateIdentity();
  const now = at(E0) + 1000;
  const control = [];
  const pinned = new Map();
  const roster = rosterFor(c, { pinned, onControl: (from, obj) => control.push([from, obj.t]) });
  const entry = await entryFor(c, alice, [
    { e: E0, msg: { v: 2, ts: now, t: "rekey", g: 1, to: SELF } },
  ]);

  await roster.ingest([entry], now);
  assert.equal(control.length, 0, "we do not act on a sender we had never seen");

  // That pass pinned her, which is how we come to know a member at all. Her
  // resend must now be acted on rather than refused as already seen.
  assert.ok(pinned.has(alice.memberId), "the pass that refused the re-key still pinned the sender");
  await roster.ingest([entry], now);
  assert.deepEqual(control, [[alice.memberId, "rekey"]], "the resend is acted on");
});

test("a key the relay respells is the same key, not a member whose keys changed", async () => {
  // base64url leaves two unused bits in the last character of a 32 or 65 byte
  // key, so four different strings decode to the same bytes. Comparing the
  // relay's text meant a re-encoding read as "this member's keys changed":
  // their points stopped being ingested and they went quiet on the map, for
  // something nobody did. The pinned record is canonical, so the presented key
  // is re-encoded before the comparison.
  const c = await circle();
  const alice = await generateIdentity();
  const now = at(E0) + 1000;
  const changes = [];
  const pinned = pinnedWith(alice);
  const roster = rosterFor(c, { pinned, onKeyChange: (id) => changes.push(id) });

  // Same bytes, a spelling the encoder would never choose: flip the unused
  // low bits of the final base64url character.
  const canonical = pinned.get(alice.memberId).pk;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet.indexOf(canonical[canonical.length - 1]);
  const respelled = canonical.slice(0, -1) + alphabet[last ^ 1];
  assert.notEqual(respelled, canonical, "the two spellings really are different strings");
  assert.deepEqual(b64uDecode(respelled), b64uDecode(canonical), "and they really are the same key");

  const entry = await entryFor(c, alice, [{ e: E0, msg: loc(now) }]);
  await roster.ingest([{ ...entry, pk: respelled }], now);

  assert.deepEqual(changes, [], "no member changed their keys");
  assert.ok(roster.get(alice.memberId), "and their position was ingested rather than dropped");
});
