// What a receiving device will and will not believe.
//
// The circle key is symmetric: every member holds it, so a valid GCM tag
// proves only "someone in this circle wrote this", not "this member wrote
// this". Sender authenticity rests on the per-member signature, and these
// tests are the reason the receiver checks it itself instead of trusting the
// relay to have done so.
import test from "node:test";
import assert from "node:assert/strict";

import { createRoster } from "../app/js/net.js";
import { newCircleSecret, deriveChannelId, deriveEncKey, generateIdentity, sealMessage, buildPost } from "../app/js/crypto.js";
import { b64uEncode } from "../app/js/wire.js";

async function circle() {
  const secret = newCircleSecret();
  return { channelId: await deriveChannelId(secret), encKey: await deriveEncKey(secret) };
}

// One feed entry as the relay serves it: the member's pinned key plus points.
async function entryFor(c, identity, msgs) {
  const points = [];
  for (const msg of msgs) {
    const sealed = await sealMessage(c.encKey, c.channelId, identity.memberId, msg);
    const post = await buildPost(identity, c.channelId, sealed, msg.ts);
    points.push({ ts: post.ts, srv: post.ts, n: post.n, c: post.c, sig: post.sig });
  }
  return { m: identity.memberId, alg: identity.alg, pk: b64uEncode(identity.pk), points };
}

const at = (ts, extra = {}) => ({ v: 1, t: "loc", ts, lat: 44.98, lon: -93.27, name: "Real", ...extra });

test("an honest, signed point is ingested", async () => {
  const c = await circle();
  const alice = await generateIdentity();
  const roster = createRoster({ ...c, selfId: "self" });

  const now = Date.now();
  await roster.ingest([await entryFor(c, alice, [at(now)])], now);

  const rec = roster.get(alice.memberId);
  assert.ok(rec, "a correctly signed point must be accepted");
  assert.equal(rec.lat, 44.98);
});

test("a circle member cannot forge a point from another member", async () => {
  // The attack the signature exists to stop: Mallory is a real member, so
  // she holds encKey and can produce ciphertext that opens cleanly under
  // Alice's member slot. With a relay that serves whatever it is told, the
  // only thing standing between her and putting Alice on a fake corner is
  // the receiver checking Alice's signature.
  const c = await circle();
  const alice = await generateIdentity();
  const mallory = await generateIdentity();
  const now = Date.now();

  // Sealed under ALICE's slot (so AAD matches) but signed by MALLORY, and
  // served with Alice's id and Alice's real public key.
  const lie = at(now, { lat: 0, lon: 0, name: "Alice (forged)" });
  const sealed = await sealMessage(c.encKey, c.channelId, alice.memberId, lie);
  const post = await buildPost(mallory, c.channelId, sealed, now);
  const forged = {
    m: alice.memberId,
    alg: alice.alg,
    pk: b64uEncode(alice.pk),
    points: [{ ts: now, srv: now, n: post.n, c: post.c, sig: post.sig }],
  };

  const roster = createRoster({ ...c, selfId: "self" });
  await roster.ingest([forged], now);
  assert.equal(roster.get(alice.memberId), undefined, "a point Alice did not sign must never become Alice's position");
});

test("a point whose signature was stripped or corrupted is dropped", async () => {
  const c = await circle();
  const alice = await generateIdentity();
  const now = Date.now();
  const good = await entryFor(c, alice, [at(now)]);

  for (const mutate of [
    (e) => delete e.points[0].sig,
    (e) => (e.points[0].sig = ""),
    (e) => (e.points[0].sig = "!!!not base64!!!"),
    (e) => (e.points[0].sig = b64uEncode(new Uint8Array(64))),
  ]) {
    const entry = structuredClone(good);
    mutate(entry);
    const roster = createRoster({ ...c, selfId: "self" });
    await roster.ingest([entry], now);
    assert.equal(roster.get(alice.memberId), undefined, "unsigned or badly signed points must not be ingested");
  }
});

test("a signature valid for one field cannot be moved to another", async () => {
  // sigBase covers channel, member, ts, nonce and ciphertext together, so a
  // signature lifted from a real point does not authenticate a different
  // one. This catches a relay that shuffles points between timestamps.
  const c = await circle();
  const alice = await generateIdentity();
  const now = Date.now();
  const entry = await entryFor(c, alice, [at(now), at(now + 1000, { lat: 12.34 })]);

  entry.points[1].sig = entry.points[0].sig;
  const roster = createRoster({ ...c, selfId: "self" });
  await roster.ingest([entry], now + 2000);

  const rec = roster.get(alice.memberId);
  assert.ok(rec, "the untouched first point still lands");
  assert.equal(rec.ts, now, "the point wearing a borrowed signature must be dropped");
  assert.notEqual(rec.lat, 12.34);
});

test("a member id that does not hash from the served key is rejected outright", async () => {
  const c = await circle();
  const alice = await generateIdentity();
  const mallory = await generateIdentity();
  const now = Date.now();

  // Mallory signs her own points correctly but claims Alice's id.
  const entry = await entryFor(c, mallory, [at(now)]);
  entry.m = alice.memberId;

  const roster = createRoster({ ...c, selfId: "self" });
  await roster.ingest([entry], now);
  assert.equal(roster.list().length, 0, "member id is the hash of the key and is checked before anything else");
});
