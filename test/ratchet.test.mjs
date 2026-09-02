// The forward-secrecy ratchet: what it destroys, what it keeps, and what it
// refuses to do on the strength of a number that came off the wire.
//
// The one property worth the most here is negative. Once an epoch has left the
// history window there must be no path back to its key: not through keyFor, not
// through the retained chain, not through a snapshot taken afterwards. A test
// that only checks keyFor returns null would still pass against an
// implementation that kept the bytes lying around, so these go looking for the
// key by every route the module offers.
import test from "node:test";
import assert from "node:assert/strict";

import {
  EPOCH_MS,
  MAX_SKEW_EPOCHS,
  MAX_CATCHUP_EPOCHS,
  DEFAULT_HISTORY_EPOCHS,
  HISTORY_CHOICES,
  epochAt,
  createRatchet,
  chainInit,
  chainStep,
  nonceFor,
} from "../app/js/ratchet.js";
import { sealMessage, openMessage } from "../app/js/crypto.js";

const CHANNEL = "00112233445566778899aabbccddeeff";
const MEMBER = "ffeeddccbbaa99887766554433221100";
const OTHER = "00000000000000001111111111111111";

const E0 = 2980471;
const at = (e) => e * EPOCH_MS;
const seedBytes = (fill) => new Uint8Array(32).fill(fill);

async function ratchetAt(e0 = E0, historyEpochs = DEFAULT_HISTORY_EPOCHS, fill = 0x11) {
  return createRatchet({ e0, ck0: await chainInit(seedBytes(fill)), historyEpochs });
}

test("constants are the ones the spec names", () => {
  assert.equal(EPOCH_MS, 600_000);
  assert.equal(MAX_SKEW_EPOCHS, 2);
  assert.equal(MAX_CATCHUP_EPOCHS, 4320);
  assert.equal(DEFAULT_HISTORY_EPOCHS, 6);
  assert.deepEqual(
    HISTORY_CHOICES.map((c) => c.epochs),
    [1, 6, 36, 144],
  );
  assert.equal(epochAt(at(E0)), E0);
  assert.equal(epochAt(at(E0) + EPOCH_MS - 1), E0);
});

test("createRatchet rejects a malformed start", async () => {
  const ck0 = await chainInit(seedBytes(1));
  for (const bad of [-1, 1.5, NaN, "3", null, undefined]) {
    assert.throws(() => createRatchet({ e0: bad, ck0 }), /bad generation epoch/, String(bad));
  }
  for (const bad of [new Uint8Array(31), new Uint8Array(33), null, "x"]) {
    assert.throws(() => createRatchet({ e0: E0, ck0: bad }), /bad chain key/);
  }
});

test("an epoch key is gone once the window has moved past it", async () => {
  const r = await ratchetAt(E0, 6);
  const key = await r.keyFor(E0, MEMBER, at(E0));
  assert.ok(key, "the key exists while the epoch is current");
  const sealed = await sealMessage(key, CHANNEL, MEMBER, E0, at(E0) + 5, { v: 2, ts: at(E0) + 5, t: "loc" });

  // Still readable inside the window.
  await r.syncToClock(at(E0 + 5));
  const still = await r.keyFor(E0, MEMBER, at(E0 + 5));
  assert.ok(still, "six epochs of history means E0 is retained at E0+5");
  assert.ok(await openMessage(still, CHANNEL, MEMBER, E0, at(E0) + 5, sealed.n, sealed.c));

  // One epoch later it drops out, and there is no route back to it.
  await r.syncToClock(at(E0 + 6));
  assert.equal(await r.keyFor(E0, MEMBER, at(E0 + 6)), null, "keyFor gives nothing");
  assert.ok(!r.retainedEpochs().includes(E0), "the chain no longer holds it");
  assert.equal(r.snapshot().e0, E0 + 1, "a snapshot taken now starts after it");

  // The persisted form is the only thing a reload has, and it cannot reach back
  // either: rebuilding from the snapshot leaves E0 as unreachable as before.
  const snap = r.snapshot();
  const reloaded = createRatchet({ e0: snap.e0, ck0: snap.ck0, historyEpochs: 144 });
  assert.equal(await reloaded.keyFor(E0, MEMBER, at(E0 + 6)), null, "a reload cannot walk backwards");
  assert.equal(reloaded.retainedEpochs()[0], E0 + 1);

  // And the message that was readable a moment ago is not readable now, by any
  // key this device can still produce.
  for (const e of r.retainedEpochs()) {
    const k = await r.keyFor(e, MEMBER, at(E0 + 6));
    assert.equal(await openMessage(k, CHANNEL, MEMBER, E0, at(E0) + 5, sealed.n, sealed.c), null, `epoch ${e}`);
  }
});

test("the history window retains exactly what it promises", async () => {
  for (const choice of HISTORY_CHOICES) {
    const r = await ratchetAt(E0, choice.epochs);
    const head = E0 + 200;
    await r.syncToClock(at(head));
    const retained = r.retainedEpochs();
    assert.equal(retained.length, choice.epochs, `${choice.id} keeps ${choice.epochs} epochs`);
    assert.equal(retained.at(-1), head, `${choice.id} keeps the current epoch`);
    assert.equal(retained[0], head - choice.epochs + 1, `${choice.id} keeps no more than it says`);
    assert.ok(await r.keyFor(retained[0], MEMBER, at(head)), `${choice.id} oldest retained epoch is usable`);
    assert.equal(await r.keyFor(retained[0] - 1, MEMBER, at(head)), null, `${choice.id} one older is gone`);
  }
});

test("shrinking the window destroys immediately, growing it does not resurrect", async () => {
  const r = await ratchetAt(E0, 36);
  await r.syncToClock(at(E0 + 50));
  assert.equal(r.retainedEpochs().length, 36);

  r.setHistoryEpochs(1, at(E0 + 50));
  assert.deepEqual(r.retainedEpochs(), [E0 + 50], "the drop happens when the setting changes, not later");

  r.setHistoryEpochs(36, at(E0 + 50));
  assert.deepEqual(r.retainedEpochs(), [E0 + 50], "widening the window cannot bring a key back");
  assert.equal(await r.keyFor(E0 + 49, MEMBER, at(E0 + 50)), null);

  // A window is at least one epoch: a zero or negative setting would leave the
  // device unable to read its own traffic.
  r.setHistoryEpochs(0, at(E0 + 50));
  assert.equal(r.historyEpochs, 1);
  r.setHistoryEpochs(-5, at(E0 + 50));
  assert.equal(r.historyEpochs, 1);
});

test("advanceTo refuses a jump beyond MAX_CATCHUP_EPOCHS", async () => {
  const r = await ratchetAt(E0, 6);
  assert.equal(await r.advanceTo(E0 + MAX_CATCHUP_EPOCHS + 1), false, "one past the cap is refused");
  assert.equal(r.head, E0, "and the refusal costs nothing: the head did not move");

  assert.equal(await r.advanceTo(E0 + MAX_CATCHUP_EPOCHS), true, "the cap itself is allowed");
  assert.equal(r.head, E0 + MAX_CATCHUP_EPOCHS);

  // Backwards and sideways are no-ops, not errors: a point from an epoch we
  // already passed is handled by the window, not by rewinding the head.
  assert.equal(await r.advanceTo(E0), true);
  assert.equal(r.head, E0 + MAX_CATCHUP_EPOCHS);
  for (const bad of [NaN, 1.5, "9", null]) assert.equal(await r.advanceTo(bad), true, String(bad));
  assert.equal(r.head, E0 + MAX_CATCHUP_EPOCHS);
});

test("keyFor refuses an epoch beyond MAX_SKEW_EPOCHS ahead of the clock", async () => {
  const r = await ratchetAt(E0, 6);
  const now = at(E0);
  assert.ok(await r.keyFor(E0 + MAX_SKEW_EPOCHS, MEMBER, now), "the skew tolerance itself is allowed");
  assert.equal(await r.keyFor(E0 + MAX_SKEW_EPOCHS + 1, MEMBER, now), null, "one past it is not");
  // A hostile index is refused without ratcheting toward it, so it costs the
  // receiver nothing.
  assert.equal(await r.keyFor(E0 + 10_000_000, MEMBER, now), null);
  assert.equal(r.head, E0 + MAX_SKEW_EPOCHS, "the head only moved as far as the allowed epoch");

  for (const bad of [-1, 1.5, NaN, "3", null, undefined, E0 - 1]) {
    assert.equal(await r.keyFor(bad, MEMBER, now), null, String(bad));
  }
});

test("keys are per sender, and stable for the same sender and epoch", async () => {
  const r = await ratchetAt(E0, 6);
  const now = at(E0);
  const mine = await r.keyFor(E0, MEMBER, now);
  const again = await r.keyFor(E0, MEMBER, now);
  assert.equal(mine, again, "the same key object comes back, not a fresh derivation");

  const theirs = await r.keyFor(E0, OTHER, now);
  const sealed = await sealMessage(mine, CHANNEL, MEMBER, E0, now, { v: 2, ts: now, t: "loc" });
  assert.equal(await openMessage(theirs, CHANNEL, MEMBER, E0, now, sealed.n, sealed.c), null, "another member's key must not open it");

  const next = await r.keyFor(E0 + 1, MEMBER, at(E0 + 1));
  assert.equal(await openMessage(next, CHANNEL, MEMBER, E0, now, sealed.n, sealed.c), null, "nor the next epoch's");
});

test("currentEpoch and syncToClock move the head forward and never back", async () => {
  const r = await ratchetAt(E0, 6);
  assert.equal(await r.currentEpoch(at(E0 + 3)), E0 + 3);
  assert.equal(r.head, E0 + 3);
  // A clock that steps backwards must not rewind the chain: that would hand a
  // seized device epochs it had already destroyed.
  assert.equal(await r.currentEpoch(at(E0)), E0 + 3);
  assert.equal(await r.syncToClock(at(E0)), E0 + 3);
  assert.equal(r.head, E0 + 3);
});

test("nextSeed is null outside the window and refuses anything but 32 bytes", async () => {
  const r = await ratchetAt(E0, 6);
  await r.syncToClock(at(E0 + 10));
  const ns = new Uint8Array(32).fill(9);

  assert.ok(await r.nextSeed(ns, E0 + 10), "the head epoch works");
  assert.ok(await r.nextSeed(ns, E0 + 5), "the oldest retained epoch works");
  assert.equal(await r.nextSeed(ns, E0 + 4), null, "an epoch that has left the window does not");
  assert.equal(await r.nextSeed(ns, E0 - 1), null);
  assert.equal(await r.nextSeed(ns, E0 + 11), null, "an epoch we have not reached does not");

  for (const bad of [new Uint8Array(31), new Uint8Array(33), null, "x".repeat(32), undefined]) {
    assert.equal(await r.nextSeed(bad, E0 + 10), null);
  }
});

test("the same (ns, epoch) gives two devices the same seed, a different ns does not", async () => {
  // The rotator and every receiver derive the next generation independently.
  // If they disagreed on either input they would land on different channels and
  // the circle would silently split in half.
  const rotator = await ratchetAt(E0, 6);
  const receiver = await ratchetAt(E0, 6);
  await rotator.syncToClock(at(E0 + 4));
  await receiver.syncToClock(at(E0 + 9)); // further along, still holds E0+4

  const ns = new Uint8Array(32).fill(0x5a);
  const a = await rotator.nextSeed(ns, E0 + 4);
  const b = await receiver.nextSeed(ns, E0 + 4);
  assert.deepEqual(a, b, "same chain key, same NS, same seed");

  const other = new Uint8Array(32).fill(0x5a);
  other[31] ^= 0x01; // one bit
  const c = await rotator.nextSeed(other, E0 + 4);
  assert.notDeepEqual(c, a, "one bit of NS changes the whole seed");

  // A different epoch is a different chain key, so it is a different seed too.
  const d = await rotator.nextSeed(ns, E0 + 5);
  assert.notDeepEqual(d, a);

  // And a different chain entirely never collides.
  const stranger = await ratchetAt(E0, 6, 0x22);
  await stranger.syncToClock(at(E0 + 4));
  assert.notDeepEqual(await stranger.nextSeed(ns, E0 + 4), a);
});

test("the chain only runs one way", async () => {
  // Holding CK_{e+1} says nothing about CK_e. There is no inverse in the module
  // and there must not be one in the derivation either.
  const ck0 = await chainInit(seedBytes(3));
  const ck1 = await chainStep(ck0);
  const ck2 = await chainStep(ck1);
  assert.notDeepEqual(ck0, ck1);
  assert.notDeepEqual(ck1, ck2);
  assert.equal(ck1.length, 32);
  // Stepping is deterministic, so a receiver catching up lands where the sender
  // is rather than somewhere near it.
  assert.deepEqual(await chainStep(await chainInit(seedBytes(3))), ck1);
});

test("destroy takes the keys with it", async () => {
  const r = await ratchetAt(E0, 6);
  assert.ok(await r.keyFor(E0, MEMBER, at(E0)));
  r.destroy();
  assert.equal(await r.keyFor(E0, MEMBER, at(E0)), null);
  assert.equal(await r.nextSeed(new Uint8Array(32), E0), null);
  assert.equal(await r.advanceTo(E0 + 1), false);
  assert.deepEqual(r.retainedEpochs(), []);
  assert.equal(r.snapshot(), null);
});

test("trim is anchored to the clock, not to whatever epoch a peer's message claims", async () => {
  // HISTORY_EPOCHS = 1 is the High risk setting: exactly one epoch is ever
  // retained. A peer's post can carry an epoch ahead of this device's own
  // clock and still be inside MAX_SKEW_EPOCHS, and keyFor has to walk the
  // chain forward to serve it. That walk must not cost this device its own
  // current epoch: trimming on the highest epoch seen let one peer running
  // fast push the head forward and take the one-epoch window with it,
  // destroying the receiver's own key and blinding it to the whole circle.
  const r = await ratchetAt(E0, 1);
  const now = at(E0);
  assert.ok(await r.keyFor(E0, MEMBER, now), "the receiver's own current-epoch key exists to start");

  // A peer posts from E0 + MAX_SKEW_EPOCHS. This device's own clock has not
  // moved at all: `now` is still at(E0).
  const theirs = await r.keyFor(E0 + MAX_SKEW_EPOCHS, OTHER, now);
  assert.ok(theirs, "the peer's epoch, still inside the skew tolerance, is served");
  assert.equal(r.head, E0 + MAX_SKEW_EPOCHS, "the head follows the wire epoch, as it must to serve it");

  // The device's own current epoch, per its own unmoved clock, must survive.
  assert.ok(await r.keyFor(E0, MEMBER, now), "the receiver's own current-epoch key must not be destroyed by a peer's clock");
  assert.ok(r.retainedEpochs().includes(E0), "and it is still in the retained set, not just cached");
});

test("nonceFor lays the counter out big-endian after the guard", () => {
  const ts = 1788282659714;
  const n = nonceFor(ts);
  assert.equal(n.length, 12);
  assert.equal(new DataView(n.buffer, n.byteOffset).getBigUint64(4, false), BigInt(ts));
  // The guard is random, so two nonces for the same ts differ. That is what
  // makes a rolled-back ts survivable rather than a key-recovery event.
  const guards = new Set();
  for (let i = 0; i < 64; i++) guards.add(nonceFor(ts).subarray(0, 4).join(","));
  assert.ok(guards.size > 32, "the guard is drawn fresh every time");
});

test("our send epoch follows our own clock, never a peer's", async () => {
  // head moves whenever a peer's message arrives from a later epoch inside the
  // skew tolerance. currentEpoch used to take max(head, now), so one member
  // with a fast clock dragged everyone else's send epoch forward with them,
  // and a receiver on a short history window could not read any of it.
  const r = await ratchetAt(E0, 1);
  const now = at(E0);

  // A peer two epochs ahead, which is the most the skew rules allow.
  assert.ok(await r.keyFor(E0 + 2, MEMBER, now), "the peer's epoch is accepted");
  assert.equal(r.head, E0 + 2, "and it moved the head");

  assert.equal(await r.currentEpoch(now), E0, "but we still send in our own epoch");

  // And our own epoch stays monotonic when the clock steps backwards, because
  // a receiver refuses a member whose (epoch, ts) does not strictly increase.
  await r.currentEpoch(at(E0 + 3));
  assert.equal(await r.currentEpoch(at(E0 + 1)), E0 + 3, "a backwards clock does not walk us back");
});
