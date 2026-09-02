// Generations: post-compromise security and cryptographic removal.
//
// The ratchet can take away the past but never the future. Everything that
// takes away the future is here, and the test that matters most in this repo is
// "a removed member holding the old chain key cannot follow the re-key". A
// removal that is only advisory is not a removal, and someone using this app is
// removing a person they have a reason to be afraid of.
import test from "node:test";
import assert from "node:assert/strict";

import { openGeneration, buildRekey, applyRekey, rosterAgrees, rekeyContext } from "../app/js/rekey.js";
import { createRatchet, chainInit, chainStep, deriveAnchor, channelFromAnchor, EPOCH_MS } from "../app/js/ratchet.js";
import { generateIdentity, newSeed, randomBytes, openSealed, generateEphemeral, sealTo } from "../app/js/crypto.js";
import { b64uDecode, b64uEncode, bytesToHex, rosterHash } from "../app/js/wire.js";

const E0 = 2980471;
const at = (e) => e * EPOCH_MS;

// A circle: one generation, every member holding the same chain from the same
// seed, each with their own identity. `historyEpochs` is deliberately generous
// so a removed member is left in the strongest position it could ever be in.
async function circle(labels, { g = 0, e0 = E0, historyEpochs = 144 } = {}) {
  const seed = newSeed();
  const members = {};
  for (const label of labels) {
    members[label] = {
      identity: await generateIdentity(),
      gen: await openGeneration({ seed: new Uint8Array(seed), g, e0, historyEpochs }),
    };
  }
  return { seed: new Uint8Array(seed), members };
}

const recipientsFor = (circleState, labels) =>
  labels.map((l) => ({ memberId: circleState.members[l].identity.memberId, epk: circleState.members[l].identity.epk }));

test("a re-key reaches every recipient and lands them all on the same new channel", async () => {
  const c = await circle(["a", "b", "c", "d"]);
  const rotator = c.members.a;
  const now = at(E0 + 2);
  const built = await buildRekey({ identity: rotator.identity, gen: rotator.gen, recipients: recipientsFor(c, ["b", "c", "d"]), now });
  assert.ok(built);
  assert.equal(built.g, 1);
  assert.equal(built.posts.length, 3, "one post per recipient, all the same padded size");
  assert.deepEqual(
    built.posts.map((p) => p.to).sort(),
    ["b", "c", "d"].map((l) => c.members[l].identity.memberId).sort(),
  );

  const rotated = await openGeneration({ seed: new Uint8Array(built.seed), g: built.g, e0: built.e0, historyEpochs: 144 });

  for (const label of ["b", "c", "d"]) {
    const me = c.members[label];
    // A receiver reaches applyRekey through the roster, which has already
    // selected a key for the carried epoch and so has already ratcheted to it.
    await me.gen.ratchet.syncToClock(now);
    const post = built.posts.find((p) => p.to === me.identity.memberId);
    const applied = await applyRekey({
      identity: me.identity,
      gen: me.gen,
      msg: post,
      epoch: built.epoch,
      senderId: rotator.identity.memberId,
    });
    assert.ok(applied, `${label} could apply the re-key`);
    assert.equal(applied.g, 1);
    assert.equal(applied.by, rotator.identity.memberId, "the re-key is attributed to who signed it");
    assert.deepEqual(applied.removed, []);

    const next = await openGeneration({ seed: applied.seed, g: applied.g, e0: applied.e0, historyEpochs: 144 });
    assert.equal(next.channelId, rotated.channelId, `${label} landed on the rotator's channel`);
    assert.notEqual(next.channelId, me.gen.channelId, "and left the old one");
  }
});

test("A REMOVED MEMBER HOLDING THE OLD CHAIN KEY CANNOT DERIVE THE NEW SEED OR THE NEW CHANNEL", async () => {
  // Mallory is not an outsider. She was a full member: she holds the
  // generation's seed-derived chain, every epoch key in a 24 hour window, the
  // channel id, every other member's public keys, and every byte of the re-key
  // that went past her on the relay. Removal has to hold anyway.
  const c = await circle(["alice", "bob", "mallory"], { historyEpochs: 144 });
  const alice = c.members.alice;
  const bob = c.members.bob;
  const mallory = c.members.mallory;
  const now = at(E0 + 3);

  // She is genuinely holding the live chain key, not a stale one.
  await mallory.gen.ratchet.syncToClock(now);
  const mixEpoch = await alice.gen.ratchet.currentEpoch(now);
  assert.ok(mallory.gen.ratchet.retainedEpochs().includes(mixEpoch), "Mallory holds CK at the mix epoch");
  const witness = randomBytes(32);
  const mallorySeedSameNs = await mallory.gen.ratchet.nextSeed(witness, mixEpoch);
  const aliceSeedSameNs = await alice.gen.ratchet.nextSeed(witness, mixEpoch);
  assert.deepEqual(
    mallorySeedSameNs,
    aliceSeedSameNs,
    "sanity: with the SAME fresh bytes she would land in the same place, so the chain key is not what stops her",
  );

  const built = await buildRekey({
    identity: alice.identity,
    gen: alice.gen,
    recipients: recipientsFor(c, ["bob"]),
    removed: [mallory.identity.memberId],
    now,
  });
  assert.ok(built);
  const newGen = await openGeneration({ seed: new Uint8Array(built.seed), g: built.g, e0: built.e0, historyEpochs: 144 });

  // Bob follows.
  await bob.gen.ratchet.syncToClock(now);
  const bobPost = built.posts.find((p) => p.to === bob.identity.memberId);
  const bobApplied = await applyRekey({
    identity: bob.identity,
    gen: bob.gen,
    msg: bobPost,
    epoch: built.epoch,
    senderId: alice.identity.memberId,
  });
  assert.ok(bobApplied);
  const bobGen = await openGeneration({ seed: bobApplied.seed, g: bobApplied.g, e0: bobApplied.e0, historyEpochs: 144 });
  assert.equal(bobGen.channelId, newGen.channelId);

  // Nothing on the wire is addressed to her.
  assert.equal(built.posts.length, 1);
  assert.ok(!built.posts.some((p) => p.to === mallory.identity.memberId));
  assert.deepEqual(built.posts[0].rm, [mallory.identity.memberId], "and the removal is named, not hidden");

  // She sees Bob's wrap go past on the relay and can do nothing with it. Not
  // with her own key, not by claiming to be Bob, not by naming a channel she
  // does control: the recipient is in the wrap's info string AND in its AAD.
  const eph = b64uDecode(built.posts[0].eph);
  const wrapped = b64uDecode(built.posts[0].w);
  for (const [what, memberId, channelId] of [
    ["her own slot", mallory.identity.memberId, alice.gen.channelId],
    ["Bob's slot", bob.identity.memberId, alice.gen.channelId],
    ["Alice's slot", alice.identity.memberId, alice.gen.channelId],
    ["a channel of her choosing", bob.identity.memberId, "f".repeat(32)],
  ]) {
    assert.equal(
      await openSealed(mallory.identity, eph, channelId, memberId, wrapped),
      null,
      `Mallory must not open Bob's wrap by naming ${what}`,
    );
  }

  // applyRekey refuses it outright, before any crypto: it is not hers.
  assert.equal(
    await applyRekey({
      identity: mallory.identity,
      gen: mallory.gen,
      msg: built.posts[0],
      epoch: built.epoch,
      senderId: alice.identity.memberId,
    }),
    null,
    "a re-key addressed to Bob is not a re-key for Mallory",
  );

  // She cannot compute the seed either. The chain key is not the secret, NS is,
  // and NS never came near her, so every seed she can produce is the wrong one.
  const guesses = [
    new Uint8Array(32),
    new Uint8Array(32).fill(0xff),
    wrapped.subarray(0, 32),
    wrapped.subarray(wrapped.length - 32),
    eph.subarray(1, 33),
    eph.subarray(33, 65),
    b64uDecode(built.posts[0].rh).subarray(0, 32),
    new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", wrapped)),
    new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", eph)),
    ...Array.from({ length: 16 }, () => randomBytes(32)),
  ];
  const target = bytesToHex(built.seed);
  const targetChannel = newGen.channelId;
  for (const epoch of mallory.gen.ratchet.retainedEpochs()) {
    for (const guess of guesses) {
      const seed = await mallory.gen.ratchet.nextSeed(new Uint8Array(guess), epoch);
      if (!seed) continue;
      assert.notEqual(bytesToHex(seed), target, `epoch ${epoch}: a guessed NS must never hit the real seed`);
      const anchor = await deriveAnchor(new Uint8Array(seed));
      assert.notEqual(await channelFromAnchor(anchor), targetChannel, `epoch ${epoch}: nor the real channel`);
    }
  }

  // Nor can she walk the old chain into the new channel. Every channel
  // reachable from the generation she is still on is one she is alone on,
  // because the new channel is not a function of that chain alone.
  let ck = await chainInit(new Uint8Array(c.seed));
  for (let i = 0; i < 200; i++) {
    const anchor = await deriveAnchor(new Uint8Array(ck));
    assert.notEqual(await channelFromAnchor(anchor), targetChannel, `chain step ${i} is not the new channel`);
    ck = await chainStep(ck);
  }

  // And the generation she is still on is the one nobody else is on.
  assert.notEqual(mallory.gen.channelId, newGen.channelId);
  assert.equal(mallory.gen.g, 0);
  assert.equal(bobGen.g, 1);
});

test("a re-key one generation out of step is rejected", async () => {
  const c = await circle(["a", "b"]);
  const now = at(E0 + 1);
  const built = await buildRekey({ identity: c.members.a.identity, gen: c.members.a.gen, recipients: recipientsFor(c, ["b"]), now });
  const post = built.posts[0];
  const b = c.members.b;
  await b.gen.ratchet.syncToClock(now);

  const apply = (msg) =>
    applyRekey({ identity: b.identity, gen: b.gen, msg, epoch: built.epoch, senderId: c.members.a.identity.memberId });

  assert.ok(await apply(post), "the real one applies");
  // Exactly one greater. Anything else is either a replay dragging the circle
  // back onto keys someone has since collected, or a jump past a generation.
  for (const g of [0, 1 - 1, 2, 5, -1, 1.5, NaN, "1", null, undefined]) {
    if (g === 1) continue;
    assert.equal(await apply({ ...post, g }), null, `g=${String(g)}`);
  }
  assert.equal(await apply({ ...post, e0: -1 }), null);
  assert.equal(await apply({ ...post, e0: 1.5 }), null);
  assert.equal(await apply({ ...post, t: "loc" }), null, "only a rekey body is a rekey");
  assert.equal(await apply(null), null);
});

test("a re-key addressed to someone else is rejected", async () => {
  const c = await circle(["a", "b", "d"]);
  const now = at(E0 + 1);
  const built = await buildRekey({ identity: c.members.a.identity, gen: c.members.a.gen, recipients: recipientsFor(c, ["b", "d"]), now });
  const forB = built.posts.find((p) => p.to === c.members.b.identity.memberId);
  const forD = built.posts.find((p) => p.to === c.members.d.identity.memberId);
  for (const l of ["b", "d"]) await c.members[l].gen.ratchet.syncToClock(now);

  const applyAs = (who, msg) =>
    applyRekey({
      identity: c.members[who].identity,
      gen: c.members[who].gen,
      msg,
      epoch: built.epoch,
      senderId: c.members.a.identity.memberId,
    });

  assert.ok(await applyAs("b", forB));
  assert.equal(await applyAs("b", forD), null, "D's wrap is not B's");
  // Rewriting the `to` field does not help: the recipient is bound inside the
  // wrap's key derivation and its AAD, not just written on the outside.
  assert.equal(await applyAs("b", { ...forD, to: c.members.b.identity.memberId }), null);
  assert.equal(await applyAs("b", { ...forB, to: c.members.d.identity.memberId }), null);
  // Nor does splicing a real wrap onto another recipient's ephemeral key.
  assert.equal(await applyAs("b", { ...forB, eph: forD.eph }), null);
  assert.equal(await applyAs("b", { ...forB, w: forD.w }), null);

  for (const bad of ["", "!!!", b64uEncode(new Uint8Array(64)), b64uEncode(new Uint8Array(66))]) {
    assert.equal(await applyAs("b", { ...forB, eph: bad }), null, `eph=${bad.slice(0, 8)}`);
  }
  assert.equal(await applyAs("b", { ...forB, w: b64uEncode(new Uint8Array(12)) }), null, "a wrap with no ciphertext");
  assert.equal(
    await applyRekey({ identity: c.members.b.identity, gen: c.members.b.gen, msg: forB, epoch: built.epoch, senderId: "nope" }),
    null,
    "an unpinned sender is not a sender",
  );
});

test("the mix epoch travels, so a re-key that straddles an epoch boundary still converges", async () => {
  // The rotator mixes the chain key at the moment buildRekey runs, but the
  // POST can land after the next epoch boundary, so the epoch in the message
  // header is not reliably the epoch that was mixed. Deriving from the header
  // used to give the two sides different seeds, which produced two generations
  // that could not see each other and split the circle with nothing reporting
  // it. The mix epoch is carried as `me` and both sides use that.
  const c = await circle(["a", "b"]);
  const now = at(E0 + 4);
  const built = await buildRekey({
    identity: c.members.a.identity,
    gen: c.members.a.gen,
    recipients: recipientsFor(c, ["b"]),
    now,
  });
  assert.equal(built.posts[0].me, built.epoch, "the message names the epoch that was mixed");

  const b = c.members.b;
  await b.gen.ratchet.syncToClock(at(E0 + 9));
  const apply = (epoch, msg = built.posts[0]) =>
    applyRekey({ identity: b.identity, gen: b.gen, msg, epoch, senderId: c.members.a.identity.memberId });

  // The header epoch is whatever the post happened to land in. None of these
  // may change where the circle ends up.
  // The header epoch is signed at build time, so it cannot drift on the way;
  // what can differ is the mix epoch, because currentEpoch clamps to our own
  // last send. Vary the header within the tolerance the e0 bound allows.
  for (const headerEpoch of [built.epoch, built.epoch + 1, built.epoch + 2]) {
    const got = await apply(headerEpoch);
    assert.ok(got, `a re-key posted in epoch ${headerEpoch} still applies`);
    assert.deepEqual(got.seed, built.seed, "and lands on the same seed the rotator computed");
  }

  // Claiming a different mix epoch is not a way in: it is bound into the wrap.
  const tampered = { ...built.posts[0], me: built.posts[0].me - 1 };
  assert.equal(await apply(built.epoch, tampered), null, "a rewritten mix epoch does not open the wrap");

  // Nor is naming an epoch we have not reached.
  const future = { ...built.posts[0], me: built.epoch + 5 };
  assert.equal(await apply(built.epoch, future), null, "a mix epoch in the future is refused");

});

test("a member cannot remotely wipe the circle by sealing a far-off e0", async () => {
  // The worst bug this protocol had. e0 was validated only as a non-negative
  // integer. It is bound into the wrap, so REWRITING it on a good message
  // fails, and a test that only rewrites proves nothing. The real attack is a
  // rotator who SEALS the value it wants: the context then matches, the wrap
  // opens on every receiver, their ratchet opens at epoch 0, the next clock
  // sync sees a jump of three million epochs, and the catch-up self-destruct
  // erases the circle from memory and from disk. One signed message from any
  // member, and the victim is told their own phone had been offline too long.
  const c = await circle(["a", "b"]);
  const now = at(E0 + 4);
  const a = c.members.a;
  const b = c.members.b;
  const epoch = await a.gen.ratchet.currentEpoch(now);

  // Build it the way a patched client would, sealing the hostile e0 itself.
  const forge = async (e0) => {
    const ns = randomBytes(32);
    const g = a.gen.g + 1;
    const rh = await rosterHash([b.identity.memberId]);
    const context = rekeyContext({ by: a.identity.memberId, g, e0, me: epoch, rh, rm: [] });
    const eph = await generateEphemeral();
    const w = await sealTo(eph.privateKey, b.identity.epk, a.gen.channelId, b.identity.memberId, ns, context);
    return { t: "rekey", g, e0, me: epoch, to: b.identity.memberId, eph: b64uEncode(eph.pub), w: b64uEncode(w), rm: [], rh };
  };
  // B has to hold the chain key for the mix epoch, which in the app happens
  // because the poller advanced it before the re-key was ingested.
  await b.gen.ratchet.syncToClock(now);
  const apply = (msg) =>
    applyRekey({ identity: b.identity, gen: b.gen, msg, epoch, senderId: a.identity.memberId });

  // Sanity: an honest e0 built exactly this way DOES apply, so the refusals
  // below are about e0 and not about the hand-rolled message.
  assert.ok(await apply(await forge(epoch)), "an honest e0 still applies");

  for (const bad of [0, 1, epoch - 3, epoch + 3, 9_000_000]) {
    assert.equal(await apply(await forge(bad)), null, `a sealed e0 of ${bad} is refused`);
  }
});


test("buildRekey gives up when the epoch it would mix from has left the window", async () => {
  const c = await circle(["a", "b"], { historyEpochs: 1 });
  const gen = c.members.a.gen;
  // MAX_CATCHUP_EPOCHS is 4320; a jump past it leaves the ratchet unable to
  // reach the current epoch at all, so there is no chain key to mix.
  const built = await buildRekey({ identity: c.members.a.identity, gen, recipients: recipientsFor(c, ["b"]), now: at(E0 + 100_000) });
  assert.equal(built, null, "no seed is better than a seed nobody else can compute");
});

test("roster hash disagreement is detected, and does not pretend to be fatal", async () => {
  const c = await circle(["a", "b", "d"]);
  const ids = ["a", "b", "d"].map((l) => c.members[l].identity.memberId);
  const built = await buildRekey({ identity: c.members.a.identity, gen: c.members.a.gen, recipients: recipientsFor(c, ["b", "d"]), now: at(E0 + 1) });
  const claimed = built.posts[0].rh;

  assert.equal(claimed, await rosterHash([ids[1], ids[2]]), "the hash covers the recipients the rotator wrapped to");
  assert.equal(await rosterAgrees(claimed, [ids[1], ids[2]]), true);
  assert.equal(await rosterAgrees(claimed, [ids[2], ids[1]]), true, "order does not matter, the ids are sorted");
  assert.equal(await rosterAgrees(claimed, ids), false, "a member we think is in and they do not");
  assert.equal(await rosterAgrees(claimed, [ids[1]]), false, "a member they think is in and we do not");
  assert.equal(await rosterAgrees(claimed, []), false);

  // A re-key that carries no hash is not a disagreement, it is silence: the
  // generation is still cryptographically sound and there is nothing to report.
  assert.equal(await rosterAgrees(null, ids), true);
  assert.equal(await rosterAgrees("", ids), true);
  assert.equal(await rosterAgrees(undefined, ids), true);
});

test("openGeneration destroys the seed it was handed", async () => {
  const seed = newSeed();
  const copy = new Uint8Array(seed);
  const gen = await openGeneration({ seed, g: 0, e0: E0 });
  assert.deepEqual(Array.from(seed), Array(32).fill(0), "the caller's seed is zeroed, not just dropped");
  // Keeping it would let a seized device recompute CK_0 and walk forward
  // through every epoch the chain had already thrown away.
  const again = await openGeneration({ seed: copy, g: 0, e0: E0 });
  assert.equal(again.channelId, gen.channelId, "the same seed always names the same channel");

  for (const bad of [new Uint8Array(31), null, "x"]) {
    await assert.rejects(() => openGeneration({ seed: bad, g: 0, e0: E0 }), /bad seed/);
  }
  await assert.rejects(() => openGeneration({ seed: newSeed(), g: -1, e0: E0 }), /bad generation/);
  await assert.rejects(() => openGeneration({ seed: newSeed(), g: 0, e0: -1 }), /bad generation epoch/);
});

test("a generation's chain is the one its seed names, and nobody else's", async () => {
  const seedA = newSeed();
  const seedB = newSeed();
  const a = await openGeneration({ seed: new Uint8Array(seedA), g: 0, e0: E0 });
  const b = await openGeneration({ seed: new Uint8Array(seedB), g: 0, e0: E0 });
  assert.notEqual(a.channelId, b.channelId);

  const fromSeed = createRatchet({ e0: E0, ck0: await chainInit(new Uint8Array(seedA)), historyEpochs: 6 });
  const mine = await a.ratchet.keyFor(E0, "0".repeat(32), at(E0));
  const theirs = await fromSeed.keyFor(E0, "0".repeat(32), at(E0));
  const { sealMessage, openMessage } = await import("../app/js/crypto.js");
  const sealed = await sealMessage(mine, a.channelId, "0".repeat(32), E0, at(E0), { v: 2, ts: at(E0), t: "loc" });
  assert.ok(await openMessage(theirs, a.channelId, "0".repeat(32), E0, at(E0), sealed.n, sealed.c));
});

// A cross-model audit found that the wrap carrying the fresh entropy NS was
// bound only to the recipient and the channel, not to who claimed to be
// rotating or what they claimed the removal list was. Any circle member could
// lift another member's wrap, re-post it under their own signature with a
// different `rm`, and the recipient would unwrap it fine and be told the wrong
// person re-keyed and the wrong person was removed. Nothing about the keys
// broke; the members screen, which is this app's trust surface, did.
test("a wrap sealed for one re-key claim does not open under a different one", async () => {
  const c = await circle(["a", "b"]);
  const now = at(E0 + 1);
  const built = await buildRekey({ identity: c.members.a.identity, gen: c.members.a.gen, recipients: recipientsFor(c, ["b"]), now });
  const post = built.posts[0];
  const eph = b64uDecode(post.eph);
  const wrapped = b64uDecode(post.w);

  const realContext = rekeyContext({ by: c.members.a.identity.memberId, g: post.g, e0: post.e0, me: post.me, rh: post.rh, rm: post.rm });
  // Sanity: the real context, rebuilt the same way applyRekey rebuilds it,
  // actually opens the wrap. If this failed the rest of the test would prove
  // nothing.
  assert.ok(
    await openSealed(c.members.b.identity, eph, c.members.a.gen.channelId, c.members.b.identity.memberId, wrapped, realContext),
    "the wrap opens under the claim it was actually sealed for",
  );

  // Every other claim about the same message, however plausible, fails.
  const wrongClaims = [
    { by: c.members.b.identity.memberId, g: post.g, e0: post.e0, me: post.me, rh: post.rh, rm: post.rm }, // different rotator
    { by: c.members.a.identity.memberId, g: post.g + 1, e0: post.e0, me: post.me, rh: post.rh, rm: post.rm }, // different generation
    { by: c.members.a.identity.memberId, g: post.g, e0: post.e0 + 1, me: post.me, rh: post.rh, rm: post.rm }, // different epoch
    { by: c.members.a.identity.memberId, g: post.g, e0: post.e0, me: post.me, rh: post.rh, rm: [c.members.b.identity.memberId] }, // different removal list
    { by: c.members.a.identity.memberId, g: post.g, e0: post.e0, me: post.me, rh: "different", rm: post.rm }, // different roster hash
    { by: c.members.a.identity.memberId, g: post.g, e0: post.e0, me: post.me + 1, rh: post.rh, rm: post.rm }, // different mix epoch
  ];
  for (const claim of wrongClaims) {
    const wrongContext = rekeyContext(claim);
    assert.notEqual(wrongContext, realContext, "the claim under test must actually differ");
    assert.equal(
      await openSealed(c.members.b.identity, eph, c.members.a.gen.channelId, c.members.b.identity.memberId, wrapped, wrongContext),
      null,
      `a wrap must not open under an altered claim: by=${claim.by} g=${claim.g} e0=${claim.e0} rm=${claim.rm}`,
    );
  }

  // And the empty (welcome-path) context is a different context too, not a
  // fallback that quietly works for everything.
  assert.equal(
    await openSealed(c.members.b.identity, eph, c.members.a.gen.channelId, c.members.b.identity.memberId, wrapped),
    null,
    "the default empty context is not this wrap's context",
  );
});

test("the honest re-key still works: fixing the splice does not just make everything fail", async () => {
  const c = await circle(["a", "b", "c"]);
  const now = at(E0 + 1);
  const built = await buildRekey({ identity: c.members.a.identity, gen: c.members.a.gen, recipients: recipientsFor(c, ["b", "c"]), now });
  for (const l of ["b", "c"]) await c.members[l].gen.ratchet.syncToClock(now);

  for (const l of ["b", "c"]) {
    const post = built.posts.find((p) => p.to === c.members[l].identity.memberId);
    const applied = await applyRekey({
      identity: c.members[l].identity,
      gen: c.members[l].gen,
      msg: post,
      epoch: built.epoch,
      senderId: c.members.a.identity.memberId,
    });
    assert.ok(applied, `${l} applies the honestly-sealed re-key`);
    assert.deepEqual(applied.seed, built.seed);
  }
});

test("M cannot splice A's wrap to B into a re-key M signs with a different removal list", async () => {
  // A is rotating and removing D. M is a full member, not the rotator or the
  // target, and takes A's wrap addressed to B off the relay verbatim. M then
  // posts a re-key body claiming to be the rotator (`by: M`) and naming a
  // different removal list (kicking C instead of D), but reusing A's `eph` and
  // `w` unchanged, because M does not have D's or C's fresh entropy, only what
  // it saw go past on the wire.
  const c = await circle(["a", "b", "c", "d", "m"]);
  const alice = c.members.a;
  const bob = c.members.b;
  const mallory = c.members.m;
  const now = at(E0 + 1);

  const built = await buildRekey({
    identity: alice.identity,
    gen: alice.gen,
    recipients: recipientsFor(c, ["b", "c", "m"]),
    removed: [c.members.d.identity.memberId],
    now,
  });
  const genuineForBob = built.posts.find((p) => p.to === bob.identity.memberId);
  assert.ok(genuineForBob);

  await bob.gen.ratchet.syncToClock(now);

  // The forged message: same wrap, same `to`, but a different signer and a
  // different removal list. If the wrap does not know what it was sealed for,
  // this looks to Bob exactly like a re-key from Mallory removing Charlie.
  const forged = {
    ...genuineForBob,
    rm: [c.members.c.identity.memberId],
  };

  const applied = await applyRekey({
    identity: bob.identity,
    gen: bob.gen,
    msg: forged,
    epoch: built.epoch,
    senderId: mallory.identity.memberId,
  });
  assert.equal(applied, null, "Bob must not be told Mallory rotated and Charlie was removed");

  // The genuine, unaltered message from Alice still applies cleanly: the fix
  // rejects the forgery, not the honest post it was forged from.
  const genuineApplied = await applyRekey({
    identity: bob.identity,
    gen: bob.gen,
    msg: genuineForBob,
    epoch: built.epoch,
    senderId: alice.identity.memberId,
  });
  assert.ok(genuineApplied, "the same wrap still applies when the claim matches what it was sealed for");
  assert.deepEqual(genuineApplied.removed, [c.members.d.identity.memberId], "the real removal, not the forged one");
});
