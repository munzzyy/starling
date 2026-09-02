// Who a device lets into a circle, and who it lets speak for one.
//
// Every test here is a defect that was real. The invitation half is the one
// that mattered most: an invite link named nobody, so a welcome was whoever
// answered the link first, and the attacker always answers first because the
// real inviter has to be online and tap accept. The joining device would then
// stream live position to a channel the attacker owned while the app said
// "You joined".
import test from "node:test";
import assert from "node:assert/strict";

import {
  assembleWelcome,
  circleControl,
  inviterMatches,
  openWelcome,
  openWelcomeRecord,
  readWelcome,
  rosterConverged,
  rosterView,
  welcomeContext,
} from "../app/js/membership.js";
import {
  generateIdentity,
  generateEphemeral,
  inviterCommitment,
  newSeed,
  sealTo,
  sealMessage,
  buildPost,
} from "../app/js/crypto.js";
import { openGeneration, buildRekey, rekeyContext } from "../app/js/rekey.js";
import { createRoster } from "../app/js/net.js";
import { EPOCH_MS } from "../app/js/ratchet.js";
import { MAX_SKEW_EPOCHS, b64uEncode, rosterHash } from "../app/js/wire.js";

const CHAN = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const E0 = 2980471;
const at = (e) => e * EPOCH_MS;

const asFrom = (id) => ({
  memberId: id.memberId,
  alg: id.alg,
  pk: b64uEncode(id.pk),
  epk: b64uEncode(id.epk),
});

// A welcome exactly as a device posts one, with every claim under caller
// control so a test can lie about any single one of them.
async function welcome(joiner, { by, g = 4, e0 = E0, n = 1, seed, context }) {
  const eph = await generateEphemeral();
  const w = await sealTo(eph.privateKey, joiner.epk, CHAN, joiner.memberId, seed, context ?? welcomeContext({ by, g, e0 }));
  return { t: "welcome", g, e0, n, eph: b64uEncode(eph.pub), w: b64uEncode(w) };
}

async function memberRecord(joiner, { by, g = 4, e0 = E0, body, context }) {
  const eph = await generateEphemeral();
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const w = await sealTo(eph.privateKey, joiner.epk, CHAN, joiner.memberId, bytes, context ?? welcomeContext({ by, g, e0 }));
  return { t: "member", eph: b64uEncode(eph.pub), w: b64uEncode(w) };
}

// --- the welcome -----------------------------------------------------------

test("the real inviter's welcome opens and hands over the seed", async () => {
  const inviter = await generateIdentity();
  const joiner = await generateIdentity();
  const commit = await inviterCommitment(inviter.pk, inviter.epk);
  const seed = newSeed();

  const opened = await openWelcome({
    identity: joiner,
    chanId: CHAN,
    commit,
    from: asFrom(inviter),
    obj: await welcome(joiner, { by: inviter.memberId, seed: new Uint8Array(seed) }),
    epoch: E0,
  });

  assert.ok(opened, "the person the link committed to must be able to let someone in");
  assert.deepEqual(opened.seed, seed);
  assert.equal(opened.g, 4);
  assert.equal(opened.inviter.memberId, inviter.memberId);
});

test("anyone else holding the link cannot forge a welcome", async () => {
  // The link was posted in a group chat, or read off a screen. Mallory derives
  // the invite channel from it, reads the joiner's agreement key out of the
  // join request, and seals a seed of her own choosing to it. She wins the race
  // because the real inviter is asleep and has to tap accept.
  const inviter = await generateIdentity();
  const mallory = await generateIdentity();
  const joiner = await generateIdentity();
  const commit = await inviterCommitment(inviter.pk, inviter.epk);
  const evil = newSeed();

  // Her best attempt: a welcome built exactly as the app builds one, naming
  // herself, signed by keys she holds. It is refused because the link does not
  // commit to her.
  const hers = await welcome(joiner, { by: mallory.memberId, seed: new Uint8Array(evil) });
  assert.equal(
    await openWelcome({ identity: joiner, chanId: CHAN, commit, from: asFrom(mallory), obj: hers, epoch: E0 }),
    null,
    "a welcome from a device the link did not commit to must be refused",
  );

  // So she serves the same bytes under the inviter's public keys, which she can
  // copy from anywhere. The commitment matches now and the wrap does not open:
  // it was sealed under a context naming her.
  assert.equal(
    await openWelcome({ identity: joiner, chanId: CHAN, commit, from: asFrom(inviter), obj: hers, epoch: E0 }),
    null,
    "a wrap sealed as one identity must not open as another's",
  );

  // And the shape the app used to post, sealed under the default empty
  // context, opens as nobody at all.
  const bare = await welcome(joiner, { by: mallory.memberId, seed: new Uint8Array(evil), context: "" });
  for (const from of [asFrom(mallory), asFrom(inviter)]) {
    assert.equal(await openWelcome({ identity: joiner, chanId: CHAN, commit, from, obj: bare, epoch: E0 }), null);
  }
});

test("a welcome cannot be lifted into another identity's, generation or epoch", async () => {
  const inviter = await generateIdentity();
  const joiner = await generateIdentity();
  const commit = await inviterCommitment(inviter.pk, inviter.epk);
  const seed = newSeed();
  const real = await welcome(joiner, { by: inviter.memberId, g: 4, e0: E0, seed: new Uint8Array(seed) });

  for (const [what, obj] of [
    ["generation", { ...real, g: 5 }],
    ["opening epoch", { ...real, e0: E0 + 1 }],
  ]) {
    assert.equal(
      await openWelcome({ identity: joiner, chanId: CHAN, commit, from: asFrom(inviter), obj, epoch: E0 }),
      null,
      `a welcome whose ${what} was altered must not open`,
    );
  }

  // The wrap is bound to the joiner as well, so a second device that used the
  // same link gets nothing out of a welcome addressed to the first.
  const other = await generateIdentity();
  assert.equal(
    await openWelcome({ identity: other, chanId: CHAN, commit, from: asFrom(inviter), obj: real, epoch: E0 }),
    null,
  );
});

test("an inviter cannot use the welcome to wipe the joiner's phone", async () => {
  // The same defect applyRekey had, on the other side of the handshake. e0 is
  // inside the context, so it is bound into the wrap, but the INVITER writes
  // the context: a welcome claiming e0 = 0 opens perfectly, the joiner's
  // ratchet starts three million epochs behind the clock, and the first sync
  // reads that as a phone that has been off for sixty years and erases the
  // circle it just joined. Accepting an invitation must not be a way to be
  // wiped by whoever sent it.
  const inviter = await generateIdentity();
  const joiner = await generateIdentity();
  const commit = await inviterCommitment(inviter.pk, inviter.epk);
  const seed = newSeed();
  const open = (obj, epoch) =>
    openWelcome({ identity: joiner, chanId: CHAN, commit, from: asFrom(inviter), obj, epoch });

  const wipe = await welcome(joiner, { by: inviter.memberId, e0: 0, seed: new Uint8Array(seed) });
  assert.equal(readWelcome(wipe, E0), null, "a welcome opening at epoch zero is not a welcome");
  assert.equal(await open(wipe, E0), null, "and the seed inside it is never handled");

  // The far side of the same lie: an opening epoch years ahead, which walks
  // the joiner past every key the circle will ever use.
  const ahead = await welcome(joiner, { by: inviter.memberId, e0: E0 + 100000, seed: new Uint8Array(seed) });
  assert.equal(await open(ahead, E0), null);

  // The bound is the message's own epoch, exactly as applyRekey's is, so a
  // welcome that straddles an epoch boundary still opens and one a couple of
  // epochs out of step still does.
  for (const d of [-MAX_SKEW_EPOCHS, -1, 0, 1, MAX_SKEW_EPOCHS]) {
    const obj = await welcome(joiner, { by: inviter.memberId, e0: E0 + d, seed: new Uint8Array(seed) });
    const opened = await open(obj, E0);
    assert.ok(opened, `a welcome ${d} epochs from its header must still open`);
    assert.deepEqual(opened.seed, seed);
  }
  for (const d of [MAX_SKEW_EPOCHS + 1, -(MAX_SKEW_EPOCHS + 1)]) {
    const obj = await welcome(joiner, { by: inviter.memberId, e0: E0 + d, seed: new Uint8Array(seed) });
    assert.equal(await open(obj, E0), null, `a welcome ${d} epochs from its header must be refused`);
  }

  // And a caller that cannot say when the message was sent gets nothing: a
  // bound nobody passes is a bound nobody has.
  const good = await welcome(joiner, { by: inviter.memberId, seed: new Uint8Array(seed) });
  for (const epoch of [undefined, null, "2980471", 1.5, NaN]) {
    assert.equal(readWelcome(good, epoch), null);
    assert.equal(await open(good, epoch), null);
  }
});

test("inviterMatches needs the id to commit to the keys AND the keys to match the link", async () => {
  const inviter = await generateIdentity();
  const other = await generateIdentity();
  const commit = await inviterCommitment(inviter.pk, inviter.epk);

  assert.equal(await inviterMatches(commit, asFrom(inviter)), true);
  assert.equal(await inviterMatches(commit, asFrom(other)), false);
  // The keys presented are the inviter's, but the id they were served under is
  // not the one those keys hash to.
  assert.equal(await inviterMatches(commit, { ...asFrom(inviter), memberId: other.memberId }), false);
  // The id is the inviter's, but the agreement key is somebody else's, which
  // is the substitution the id commits to both keys to prevent.
  assert.equal(await inviterMatches(commit, { ...asFrom(inviter), epk: b64uEncode(other.epk) }), false);
  for (const junk of [null, undefined, new Uint8Array(15), new Uint8Array(16)]) {
    assert.equal(await inviterMatches(junk, asFrom(inviter)), false);
  }
  assert.equal(await inviterMatches(commit, { ...asFrom(inviter), pk: "!!!" }), false);
});

test("a welcome must say how many member records follow", async () => {
  // Without the count, a welcome delivered with its member records stripped
  // leaves the joiner holding a circle it can decrypt and nobody it can
  // attribute a re-key to: every future re-key is dropped, in silence, for
  // ever. The count is what makes a short delivery visible.
  const inviter = await generateIdentity();
  const joiner = await generateIdentity();
  const commit = await inviterCommitment(inviter.pk, inviter.epk);
  const seed = newSeed();
  const good = await welcome(joiner, { by: inviter.memberId, n: 3, seed: new Uint8Array(seed) });

  assert.equal(readWelcome(good, E0).n, 3);
  for (const n of [undefined, null, 0, -1, 1.5, "3", 65]) {
    const obj = { ...good };
    if (n === undefined) delete obj.n;
    else obj.n = n;
    assert.equal(readWelcome(obj, E0), null, `a welcome claiming n=${String(n)} must not be a welcome`);
    assert.equal(
      await openWelcome({ identity: joiner, chanId: CHAN, commit, from: asFrom(inviter), obj, epoch: E0 }),
      null,
    );
  }
  assert.equal(readWelcome({ ...good, t: "member" }, E0), null);
  assert.equal(readWelcome(null, E0), null);
});

test("member records open only from the verified inviter, under that welcome", async () => {
  const inviter = await generateIdentity();
  const mallory = await generateIdentity();
  const joiner = await generateIdentity();
  const bob = await generateIdentity();
  const commit = await inviterCommitment(inviter.pk, inviter.epk);
  const seed = newSeed();

  const opened = await openWelcome({
    identity: joiner,
    chanId: CHAN,
    commit,
    from: asFrom(inviter),
    obj: await welcome(joiner, { by: inviter.memberId, n: 1, seed: new Uint8Array(seed) }),
    epoch: E0,
  });

  const body = { alg: bob.alg, pk: b64uEncode(bob.pk), epk: b64uEncode(bob.epk), name: "Bob" };
  const rec = await memberRecord(joiner, { by: inviter.memberId, body });
  assert.deepEqual(
    await openWelcomeRecord({ identity: joiner, chanId: CHAN, welcome: opened, from: asFrom(inviter), obj: rec }),
    body,
  );

  // Mallory can post on the invite channel too. Her record is not part of the
  // welcome that was verified, so it never becomes a member of this circle.
  const hers = await memberRecord(joiner, { by: mallory.memberId, body: { ...body, name: "Mallory" } });
  assert.equal(
    await openWelcomeRecord({ identity: joiner, chanId: CHAN, welcome: opened, from: asFrom(mallory), obj: hers }),
    null,
  );
  // Nor does it work by serving it under the inviter's keys: the context names
  // whoever sealed it.
  assert.equal(
    await openWelcomeRecord({ identity: joiner, chanId: CHAN, welcome: opened, from: asFrom(inviter), obj: hers }),
    null,
  );
  // A record from a different generation of the same inviter does not open
  // into this welcome either.
  const stale = await memberRecord(joiner, { by: inviter.memberId, g: 3, body });
  assert.equal(
    await openWelcomeRecord({ identity: joiner, chanId: CHAN, welcome: opened, from: asFrom(inviter), obj: stale }),
    null,
  );
});

test("a welcome delivered without its member records is refused, not joined", async () => {
  // The silent one. The seed opens, the app says "You joined", and the device
  // holds a circle it can decrypt and a roster of nobody: every re-key after
  // that is dropped for coming from a member it was never told about, and
  // nothing anywhere says so. The count in the welcome is what makes the
  // shortfall visible.
  const inviter = await generateIdentity();
  const joiner = await generateIdentity();
  const bob = await generateIdentity();
  const carol = await generateIdentity();
  const commit = await inviterCommitment(inviter.pk, inviter.epk);
  const seed = newSeed();
  const by = inviter.memberId;
  const from = asFrom(inviter);

  const head = { obj: await welcome(joiner, { by, n: 3, seed: new Uint8Array(seed) }), from, epoch: E0 };
  const recFor = async (m) => ({
    obj: await memberRecord(joiner, {
      by,
      body: { alg: m.alg, pk: b64uEncode(m.pk), epk: b64uEncode(m.epk), name: "x" },
    }),
    from,
    epoch: E0,
  });
  const records = [await recFor(inviter), await recFor(bob), await recFor(carol)];
  const open = (messages) => assembleWelcome({ identity: joiner, chanId: CHAN, commit, messages });

  // The seed alone, which is exactly what the relay can serve by dropping the
  // rest of the burst.
  const bare = await open([head]);
  assert.equal(bare.welcome.members.length, 0);
  assert.equal(bare.welcome.complete, false, "a welcome with no member records is not a welcome");

  const short = await open([head, ...records.slice(0, 2)]);
  assert.equal(short.welcome.complete, false);
  assert.equal(short.welcome.members.length, 2);

  const whole = await open([head, ...records]);
  assert.equal(whole.welcome.complete, true);
  assert.equal(whole.welcome.members.length, 3);
  assert.deepEqual(whole.welcome.seed, seed);
  assert.equal(whole.imposters, 0);
});

test("assembling a welcome ignores everything the inviter did not send, and counts it", async () => {
  const inviter = await generateIdentity();
  const mallory = await generateIdentity();
  const joiner = await generateIdentity();
  const bob = await generateIdentity();
  const commit = await inviterCommitment(inviter.pk, inviter.epk);
  const good = newSeed();
  const evil = newSeed();

  // Mallory posts first, as she would: she does not have to wait for anyone.
  const messages = [
    { obj: await welcome(joiner, { by: mallory.memberId, n: 1, seed: new Uint8Array(evil) }), from: asFrom(mallory), epoch: E0 },
    {
      obj: await memberRecord(joiner, {
        by: mallory.memberId,
        body: { alg: mallory.alg, pk: b64uEncode(mallory.pk), epk: b64uEncode(mallory.epk), name: "Mallory" },
      }),
      from: asFrom(mallory),
      epoch: E0,
    },
    { obj: await welcome(joiner, { by: inviter.memberId, n: 1, seed: new Uint8Array(good) }), from: asFrom(inviter), epoch: E0 },
    {
      obj: await memberRecord(joiner, {
        by: inviter.memberId,
        body: { alg: bob.alg, pk: b64uEncode(bob.pk), epk: b64uEncode(bob.epk), name: "Bob" },
      }),
      from: asFrom(inviter),
      epoch: E0,
    },
  ];

  const { welcome: out, imposters } = await assembleWelcome({ identity: joiner, chanId: CHAN, commit, messages });
  assert.deepEqual(out.seed, good, "the seed must be the one the person who sent the link chose");
  assert.equal(out.complete, true);
  assert.equal(out.members.length, 1);
  assert.equal(out.members[0].name, "Bob", "Mallory's record must not become a member of the circle");
  assert.equal(imposters, 1, "the joiner is told somebody else answered their link");

  // Mallory alone gets nowhere, and is still counted.
  const alone = await assembleWelcome({ identity: joiner, chanId: CHAN, commit, messages: messages.slice(0, 2) });
  assert.equal(alone.welcome, null);
  assert.equal(alone.imposters, 1);
});

test("the welcome context names its own fields and cannot be confused with a re-key", () => {
  const by = "a".repeat(32);
  // It used to borrow rekeyContext's shape, which meant every welcome context
  // carried the literal text "undefined" where a re-key's mix epoch goes. It
  // was symmetric so nothing broke, but a bound claim that reads as a bug is
  // worthless to an auditor. It states its own fields now.
  assert.equal(welcomeContext({ by, g: 4, e0: 9 }), "starling/v2/welcome|" + by + "|4|9");
  assert.ok(!welcomeContext({ by, g: 4, e0: 9 }).includes("undefined"));
  // Distinct from a re-key's context, so a re-key wrap can never be presented
  // as a welcome even if the two ever shared a channel.
  assert.notEqual(welcomeContext({ by, g: 4, e0: 9 }), rekeyContext({ by, g: 4, e0: 9, me: 9 }));
});


// --- control on the circle channel -----------------------------------------

test("a member record posted on the circle channel is not a control message", async () => {
  // The graft: any member can post an ordinary padded signed message, and a
  // {t:"member"} body used to be handed straight to the pinning code. Every
  // device in the circle pinned the poster's spare keypair, nobody was asked,
  // and removing the member who did it did not remove the graft, because a
  // re-key wraps to whoever is pinned.
  const seed = newSeed();
  const send = await openGeneration({ seed: new Uint8Array(seed), g: 0, e0: E0, historyEpochs: 144 });
  const recv = await openGeneration({ seed: new Uint8Array(seed), g: 0, e0: E0, historyEpochs: 144 });
  const mallory = await generateIdentity();
  const spare = await generateIdentity();
  const now = at(E0) + 1000;

  const graft = {
    v: 2,
    t: "member",
    ts: now,
    memberId: spare.memberId,
    alg: spare.alg,
    pk: b64uEncode(spare.pk),
    epk: b64uEncode(spare.epk),
    name: "Not a real person",
  };
  const key = await send.ratchet.keyFor(E0, mallory.memberId, at(E0));
  const sealed = await sealMessage(key, send.channelId, mallory.memberId, E0, now, graft);
  const post = await buildPost(mallory, send.channelId, E0, sealed, now);

  const acted = [];
  const roster = createRoster({
    channelId: recv.channelId,
    ratchet: recv.ratchet,
    selfId: "0".repeat(32),
    // Mallory is a full member, pinned long before this pass.
    pinned: new Map([
      [mallory.memberId, { alg: mallory.alg, pk: b64uEncode(mallory.pk), epk: b64uEncode(mallory.epk), verified: false }],
    ]),
    // Exactly what main.js does with a control message on the circle channel.
    onControl: async (senderId, msg) => {
      if (circleControl(msg) !== "rekey") return;
      acted.push(msg);
    },
  });

  await roster.ingest(
    [
      {
        m: mallory.memberId,
        alg: mallory.alg,
        pk: b64uEncode(mallory.pk),
        epk: b64uEncode(mallory.epk),
        points: [{ e: E0, ts: now, srv: now, n: post.n, c: post.c, sig: post.sig }],
      },
    ],
    now,
  );

  assert.deepEqual(acted, [], "a member record must never graft a member onto a circle channel");
  assert.equal(circleControl({ t: "rekey", g: 1 }), "rekey");
  for (const msg of [{ t: "member" }, { t: "loc" }, { t: "welcome" }, {}, null, undefined]) {
    assert.equal(circleControl(msg), null, JSON.stringify(msg));
  }
});

// --- roster convergence ----------------------------------------------------

test("a legitimate admission converges instead of splitting the circle", async () => {
  // Alice admits Dave. Every other member disagrees with her roster hash until
  // Dave posts something, because Dave is in her roster and nobody else's.
  // Before this, that disagreement was a permanent one: Bob alarmed, and Bob
  // then dropped every re-key Dave ever signed, because Dave was not one of
  // the members Bob's generation opened with.
  const alice = await generateIdentity();
  const bob = await generateIdentity();
  const carol = await generateIdentity();
  const dave = await generateIdentity();

  const gen = await openGeneration({ seed: newSeed(), g: 0, e0: E0, historyEpochs: 144 });
  const built = await buildRekey({
    identity: alice,
    gen,
    recipients: [bob, carol, dave].map((m) => ({ memberId: m.memberId, epk: m.epk })),
    now: at(E0) + 1000,
  });
  const rh = built.rh;
  assert.equal(rh, await rosterHash([bob.memberId, carol.memberId, dave.memberId]));

  const self = bob.memberId;
  const by = alice.memberId;
  // Bob's roster the moment the re-key lands: Alice and Carol, no Dave.
  const before = [alice.memberId, carol.memberId];
  assert.deepEqual(rosterView({ pinned: before, self, by }), [carol.memberId, self]);
  assert.equal(await rosterConverged({ pinned: before, self, by, rh }), false);

  // Dave posts, Bob pins him, and Alice's own sealed hash now names exactly
  // the people Bob holds. Dave may re-key.
  const after = [...before, dave.memberId];
  assert.equal(await rosterConverged({ pinned: after, self, by, rh }), true);

  // A stranger who simply turns up does not convert into a member this way.
  const eve = await generateIdentity();
  assert.equal(await rosterConverged({ pinned: [...after, eve.memberId], self, by, rh }), false);
  assert.equal(await rosterConverged({ pinned: [...before, eve.memberId], self, by, rh }), false);
  // And a re-key that carried no hash converges nothing.
  for (const junk of [null, undefined, "", 7]) {
    assert.equal(await rosterConverged({ pinned: after, self, by, rh: junk }), false);
  }
});

test("rosterView is the rotator's view of the circle, from a receiver's seat", () => {
  const a = "a".repeat(32);
  const b = "b".repeat(32);
  const me = "c".repeat(32);
  // A rotator hashes everyone it wrapped to, which is the circle minus itself.
  assert.deepEqual(rosterView({ pinned: [a, b], self: me, by: a }), [b, me]);
  assert.deepEqual(rosterView({ pinned: new Set([a, b]), self: me, by: b }), [a, me]);
  assert.deepEqual(rosterView({ pinned: [], self: me, by: a }), [me]);
});
