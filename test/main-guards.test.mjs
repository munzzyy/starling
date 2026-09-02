// The guards in main.js, run against main.js.
//
// Every defect these cover shipped past a test suite, and they had one thing
// in common: the rule was checked somewhere other than where the app runs it.
// A member cap was verified against a bare Map while setupNet passed a
// duck-typed store with no size on it. A key check was installed on one of
// three pinning paths. So these load the real module against a fake page
// (dom-harness.mjs) and drive the real functions.
import test from "node:test";
import assert from "node:assert/strict";

import { installDom, loadApp, settle } from "./dom-harness.mjs";

const harness = installDom();
const { internals, api } = await loadApp(harness);
const state = internals.state;

// boot() refuses to run at all without IndexedDB, and Node has none, so every
// defect that only shows up on a launch was out of reach of this file. store.js
// already falls back to an in-memory map when the database will not open, so a
// database that always refuses to open is exactly the shape wanted here: the
// real boot runs, and its reads and writes land in the same store the rest of
// these checks drive.
globalThis.indexedDB ??= {
  open() {
    throw new Error("no indexeddb in the harness");
  },
  // wipeAll asks for the database to be dropped; there is none, and its
  // callback contract is the only thing that has to hold.
  deleteDatabase() {
    const req = {};
    setTimeout(() => req.onsuccess?.(), 0);
    return req;
  },
};

const { openGeneration } = await import("../app/js/rekey.js");
const {
  generateIdentity,
  generateEphemeral,
  newSeed,
  newInviteSecret,
  deriveInviteChannelId,
  deriveInviteKey,
  inviterCommitment,
  sealMessage,
  sealTo,
  openMessage,
  buildPost,
} = await import("../app/js/crypto.js");
const { epochAt, EPOCH_MS, MAX_CATCHUP_EPOCHS } = await import("../app/js/ratchet.js");
const { createRoster } = await import("../app/js/net.js");
const { welcomeContext, rosterConverged } = await import("../app/js/membership.js");
const { newVaultKey, sealUnderVault, openUnderVault, makePasscodeRecord, openPasscodeRecord } = await import("../app/js/lock.js");
const { GEN_SLOT, PINNED_SLOT, packGenMeta, writeRecordAtRest, writeCirclesAtRest } = await import("../app/js/circles.js");
const { dbGet, dbSet, dbDel, wipeAll } = await import("../app/js/store.js");
const { MEMBER_CAP, INVITE_TTL_MS, b64uEncode, b64uDecode, memberIdFromKeys } = await import("../app/js/wire.js");

const te = new TextEncoder();

test.after(() => harness.stopTimers());

// A clean, unlocked device holding one live circle and nothing else.
//
// The disk is emptied first. A self-destruct now finishes as a real leave, so
// it leaves a journal, a mark and a closed-slot fence behind it, and a check
// that inherits any of those from the check before it is testing something
// nobody can name.
async function freshCircle({ e0 = epochAt(Date.now()) } = {}) {
  await wipeAll();
  state.circles = [];
  state.chainWiped = null;
  state.locked = false;
  state.lock = null;
  state.vaultKey = null;
  state.demo = false;
  state.chainDestroyed = false;
  state.sharing = false;
  state.pinned = new Map();
  state.genRoster = new Set();
  state.keyChanges.clear();
  state.rosterPending = null;
  state.invite = null;
  state.joining = null;
  state.joinRequests = [];
  state.identity = await generateIdentity();
  // On disk as well as in memory: persistCircle writes the identity before the
  // generation record precisely so the leave fence can tell a real arrival
  // from the tail of a write decided before a leave, and a circle that only
  // exists in memory cannot satisfy it.
  await dbSet("identity", state.identity);
  const gen = await openGeneration({ seed: newSeed(), g: 0, e0 });
  gen.at = Date.now();
  state.gen = gen;
  window.__starlingErrors.length = 0;
  return gen;
}

// A P-256 point in its 33-byte compressed form. Every check on the join path
// passes it: the relay bounds `epk` only as a short base64url string, and the
// member id hashes whatever it is handed. WebCrypto imports it happily, so the
// inviter can even seal a re-key to it. validEcdhKey is the only thing in the
// app that says no.
async function compressedEcdhKey() {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const out = new Uint8Array(33);
  out[0] = 2 + (raw[64] & 1);
  out.set(raw.subarray(1, 33), 1);
  return out;
}

// ---------------------------------------------------------------- lock bypass

test("a re-key that lands after the app locks does not put the map back on screen", async () => {
  await freshCircle();
  await internals.enterCircle();
  await settle();
  assert.equal(state.screen, "map", "the circle is live before the lock falls");

  state.lock = { enabled: true, autolockMs: 60000 };
  internals.lockNow();
  assert.equal(state.screen, "lock");
  assert.equal(state.gen, null, "locking took the generation with it");

  // What onControl hands over once applyRekey has opened somebody else's wrap.
  const applied = {
    seed: new Uint8Array(32).fill(9),
    g: 1,
    e0: epochAt(Date.now()),
    rh: null,
    removed: [],
    by: "a".repeat(32),
  };
  const adopted = await internals.adoptRekey(applied, "a".repeat(32));

  assert.equal(adopted, false, "the re-key was refused while locked");
  assert.equal(state.screen, "lock", "the lock screen is still up");
  assert.equal(state.gen, null, "no generation was armed behind the lock screen");
  assert.equal(state.locked, true);
  assert.ok(
    applied.seed.every((b) => b === 0),
    "the refused seed was zeroed rather than left in memory",
  );
});

test("enterCircle refuses to build a live circle while the lock screen is up", async () => {
  const gen = await freshCircle();
  state.lock = { enabled: true, autolockMs: 60000 };
  state.locked = true;
  state.screen = "lock";
  state.gen = gen;

  await internals.enterCircle();

  assert.equal(state.screen, "lock", "no screen change");
  assert.equal(api.state.netStatus !== "ok", true, "no poller was started");
});

// --------------------------------------------------------- vault key on error

test("a failed unlock on a damaged record leaves no vault key in memory", async () => {
  state.locked = true;
  state.lock = { enabled: true, autolockMs: 60000 };
  state.gen = null;
  state.identity = null;
  state.vaultKey = null;

  const K = newVaultKey();
  const before = Uint8Array.from(K);
  const ck = new Uint8Array(32).fill(7);
  await dbSet("vaultSecret", await sealUnderVault(K, ck));
  await dbSet("identity", { memberId: "b".repeat(32) });
  // The generation record is present and will not authenticate: a damaged or
  // tampered install, which is the case that used to skip the zeroing.
  await dbSet("vaultGenMeta", { v: 1, nonce: new Uint8Array(12).fill(3), ct: new Uint8Array(48).fill(4) });

  await assert.rejects(
    () => internals.unlockWith(async () => K),
    "a sealed record that will not open throws rather than reporting a wrong passcode",
  );

  assert.ok(before.some((b) => b !== 0), "the key really had bytes in it");
  assert.ok(K.every((b) => b === 0), "the vault key was zeroed on the throwing exit");
  assert.equal(state.vaultKey, null, "and nothing kept a reference to it");
  assert.equal(state.locked, true, "the device is still locked");

  await dbDel("vaultSecret");
  await dbDel("vaultGenMeta");
  await dbDel("identity");
});

// ---------------------------------------------------------------- member cap

test("the receiver member cap fires through the store setupNet actually passes", async () => {
  // Not a bare Map. pinnedStore is the object main.js hands createRoster, and
  // a cap checked against a Map is exactly what let the last one ship dead.
  const gen = await freshCircle();
  const e = gen.e0;
  const channelId = gen.channelId;
  const sendGen = await openGeneration({ seed: new Uint8Array(32), g: 0, e0: e });
  void sendGen;

  const roster = createRoster({
    channelId,
    ratchet: gen.ratchet,
    selfId: state.identity.memberId,
    pinned: internals.pinnedStore,
  });

  const entries = [];
  for (let i = 0; i < MEMBER_CAP + 1; i++) {
    const id = await generateIdentity();
    const ts = e * EPOCH_MS + 1000 + i;
    const key = await gen.ratchet.keyFor(e, id.memberId, ts);
    const sealed = await sealMessage(key, channelId, id.memberId, e, ts, {
      v: 2,
      t: "loc",
      ts,
      lat: 1 + i / 1000,
      lon: 2,
    });
    const post = await buildPost(id, channelId, e, sealed, ts);
    entries.push({
      m: id.memberId,
      alg: id.alg,
      pk: b64uEncode(id.pk),
      epk: b64uEncode(id.epk),
      points: [{ e: post.e, ts: post.ts, srv: post.ts, n: post.n, c: post.c, sig: post.sig }],
    });
  }

  await roster.ingest(entries, e * EPOCH_MS + 5000);

  assert.equal(internals.pinnedStore.size, MEMBER_CAP - 1, "the store reports a size at all");
  // Others only: this device holds one of the relay's MEMBER_CAP seats.
  assert.equal(
    state.pinned.size,
    MEMBER_CAP - 1,
    `a relay serving ${MEMBER_CAP + 1} members pins ${MEMBER_CAP - 1} others`,
  );
});

// ------------------------------------------------------- validating epk pins

test("addPinned refuses a member whose agreement key is not a real point", async () => {
  await freshCircle();
  const id = await generateIdentity();
  const comp = await compressedEcdhKey();

  const bad = await internals.addPinned({ alg: id.alg, pk: b64uEncode(id.pk), epk: b64uEncode(comp), name: "M" });

  assert.equal(bad, null, "a 33-byte compressed key is refused");
  assert.equal(state.pinned.size, 0, "and nothing was written into the roster");

  const good = await internals.addPinned({
    alg: id.alg,
    pk: b64uEncode(id.pk),
    epk: b64uEncode(id.epk),
    name: "Real",
  });
  assert.ok(good, "a real key still pins");
  assert.equal(state.pinned.size, 1);
});

test("acceptJoin refuses a request whose agreement key is not a real point", async () => {
  const gen = await freshCircle();
  await internals.enterCircle();
  await settle();

  const now = Date.now();
  state.invite = {
    secret: newInviteSecret(),
    commit: await inviterCommitment(state.identity.pk, state.identity.epk),
    by: state.identity.memberId,
    createdAt: now,
    expiresAt: now + INVITE_TTL_MS,
  };

  const joiner = await generateIdentity();
  const comp = await compressedEcdhKey();
  const req = {
    memberId: await memberIdFromKeys(joiner.pk, comp),
    alg: joiner.alg,
    pk: b64uEncode(joiner.pk),
    epk: b64uEncode(comp),
    name: "Mallory",
  };

  const accepted = await api.acceptJoin(req);

  assert.equal(accepted, false, "the request was refused");
  assert.equal(state.pinned.has(req.memberId), false, "nobody was pinned");
  assert.equal(state.pinned.size, 0);
  assert.equal(state.gen.g, gen.g, "and the circle was not re-keyed to admit them");
  assert.ok(state.invite, "the invitation was not burned on a refusal");
});

test("acceptKeyChange refuses new keys that are not a real point", async () => {
  await freshCircle();
  const id = await generateIdentity();
  const comp = await compressedEcdhKey();
  state.pinned.set(id.memberId, {
    memberId: id.memberId,
    alg: id.alg,
    pk: b64uEncode(id.pk),
    epk: b64uEncode(id.epk),
    verified: true,
    name: "Ada",
  });
  state.keyChanges.set(id.memberId, {
    presented: { alg: id.alg, pk: b64uEncode(id.pk), epk: b64uEncode(comp) },
    was: null,
    oldSafety: null,
    newSafety: null,
    at: Date.now(),
  });

  const ok = await internals.acceptKeyChange(id.memberId);

  assert.equal(ok, false);
  assert.equal(state.pinned.get(id.memberId).epk, b64uEncode(id.epk), "the pinned key is untouched");
});

// ------------------------------------------------------------------ join jam

// One post on an invite channel, sealed under the invite key and signed by the
// identity that wrote it, exactly as inviteSender builds it.
async function invitePost(identity, chanId, key, obj, ts) {
  const e = epochAt(ts);
  const sealed = await sealMessage(key, chanId, identity.memberId, e, ts, { v: 2, ts, ...obj });
  const post = await buildPost(identity, chanId, e, sealed, ts);
  return { e: post.e, ts: post.ts, srv: post.ts, n: post.n, c: post.c, sig: post.sig };
}

const feedEntry = (identity, points) => ({
  m: identity.memberId,
  alg: identity.alg,
  pk: b64uEncode(identity.pk),
  epk: b64uEncode(identity.epk),
  points,
});

// The joining device, waiting on a rendezvous channel whose link an attacker
// also holds.
async function waitingJoiner() {
  state.locked = false;
  state.lock = null;
  state.vaultKey = null;
  state.demo = false;
  state.chainDestroyed = false;
  state.gen = null;
  state.identity = null;
  state.pinned = new Map();
  state.genRoster = new Set();
  state.circles = [];
  window.__starlingErrors.length = 0;
  return joinSession();
}

// The waiting half on its own, saying nothing about what circle this device is
// already in: a rendezvous channel, the inviter the link commits to, and the
// state.joining a device holds until a welcome lands.
async function joinSession() {
  const secret = newInviteSecret();
  const chanId = await deriveInviteChannelId(secret);
  const key = await deriveInviteKey(secret);
  const inviter = await generateIdentity();
  const joiner = await generateIdentity();
  state.joining = {
    status: "waiting",
    since: Date.now(),
    safety: "11111 22222",
    secret: new Uint8Array(secret),
    commit: await inviterCommitment(inviter.pk, inviter.epk),
    imposters: 0,
    identity: joiner,
    chanId,
    key,
    circleName: "Test circle",
  };
  return { chanId, key, inviter, joiner };
}

// A real welcome from the real inviter, posted the way sendWelcome posts one:
// the sealed seed, then one member record for the inviter themselves.
async function welcomeFeed({ chanId, key, inviter, joiner, g = 4, e0 = epochAt(Date.now()) }) {
  const context = welcomeContext({ by: inviter.memberId, g, e0 });
  const sealFor = async (bytes) => {
    const eph = await generateEphemeral();
    const w = await sealTo(eph.privateKey, joiner.epk, chanId, joiner.memberId, bytes, context);
    return { eph: b64uEncode(eph.pub), w: b64uEncode(w) };
  };
  const now = Date.now();
  const head = await invitePost(
    inviter,
    chanId,
    key,
    { t: "welcome", g, e0, n: 1, ...(await sealFor(new Uint8Array(32).fill(11))) },
    now,
  );
  const rec = await invitePost(
    inviter,
    chanId,
    key,
    {
      t: "member",
      ...(await sealFor(
        te.encode(
          JSON.stringify({
            alg: inviter.alg,
            pk: b64uEncode(inviter.pk),
            epk: b64uEncode(inviter.epk),
            name: "Ada",
          }),
        ),
      )),
    },
    now + 1,
  );
  return feedEntry(inviter, [head, rec]);
}

// The 128 well-formed t:"member" messages a link holder can post before the
// inviter ever taps accept.
async function junkFlood(attacker, chanId, key, count) {
  const eph = await generateEphemeral();
  const points = [];
  for (let i = 0; i < count; i++) {
    points.push(
      await invitePost(
        attacker,
        chanId,
        key,
        { t: "member", eph: b64uEncode(eph.pub), w: b64uEncode(new Uint8Array(80).fill(i & 255)) },
        Date.now() - 60000 + i,
      ),
    );
  }
  return feedEntry(attacker, points);
}

test("a link holder cannot crowd the real welcome out of the join buffer", async () => {
  const { chanId, key, inviter, joiner } = await waitingJoiner();
  const attacker = await generateIdentity();

  const g = 4;
  const e0 = epochAt(Date.now());
  const context = welcomeContext({ by: inviter.memberId, g, e0 });
  const sealFor = async (bytes) => {
    const eph = await generateEphemeral();
    const w = await sealTo(eph.privateKey, joiner.epk, chanId, joiner.memberId, bytes, context);
    return { eph: b64uEncode(eph.pub), w: b64uEncode(w) };
  };
  const seed = new Uint8Array(32).fill(11);
  const welcomePoint = await invitePost(
    inviter,
    chanId,
    key,
    { t: "welcome", g, e0, n: 1, ...(await sealFor(seed)) },
    Date.now(),
  );
  const recordPoint = await invitePost(
    inviter,
    chanId,
    key,
    {
      t: "member",
      ...(await sealFor(
        te.encode(
          JSON.stringify({
            alg: inviter.alg,
            pk: b64uEncode(inviter.pk),
            epk: b64uEncode(inviter.epk),
            name: "Ada",
          }),
        ),
      )),
    },
    Date.now() + 1,
  );

  // The attacker's flood is served first, which is the relay's choice to make.
  const flood = await junkFlood(attacker, chanId, key, 128);
  harness.onFetch(async (url) => {
    if (!url.includes(chanId)) return null;
    return {
      ok: true,
      status: 200,
      json: async () => ({ members: [flood, feedEntry(inviter, [welcomePoint, recordPoint])] }),
    };
  });

  internals.startJoinWatch();
  await settle(200);
  harness.onFetch(null);

  assert.equal(state.joining, null, "the join finished rather than waiting forever");
  assert.ok(state.gen, "a generation was opened from the real welcome");
  assert.equal(state.gen.g, g);
  assert.ok(state.pinned.has(inviter.memberId), "the inviter was pinned from the welcome");
});

test("junk from a link holder is counted and shown, not swallowed", async () => {
  const { chanId, key } = await waitingJoiner();
  const attacker = await generateIdentity();
  const flood = await junkFlood(attacker, chanId, key, 12);
  harness.onFetch(async (url) => {
    if (!url.includes(chanId)) return null;
    return { ok: true, status: 200, json: async () => ({ members: [flood] }) };
  });

  internals.startJoinWatch();
  await settle(200);
  harness.onFetch(null);

  assert.ok(state.joining, "still waiting, because no real welcome came");
  assert.equal(state.joining.imposters, 12, "every stranger message is counted");
  // A device with no circle yet reads this off the onboarding card, which is
  // the only place it can appear before a join lands.
  const card = harness.node("#join-waiting");
  assert.equal(card.hidden, false, "the waiting card is on screen");
  assert.match(harness.node("#join-waiting-text").textContent, /not the person who sent it/);

  state.joining = null;
});

// --------------------------------------------------------- ratchet destroyed

test("a chain that destroys itself takes the stored chain key with it and says so", async () => {
  // Old enough that the catch-up cap refuses to walk it: the device has been
  // off for longer than the chain will carry.
  const gen = await freshCircle({ e0: epochAt(Date.now()) - (MAX_CATCHUP_EPOCHS + 200) });
  const snap = gen.ratchet.snapshot();
  await dbSet("secret", snap.ck0);
  await dbSet("genMeta", {
    g: 0,
    e0: gen.e0,
    ckEpoch: snap.e0,
    channelId: gen.channelId,
    at: gen.at,
    genRoster: [],
  });
  assert.ok(await dbGet("secret"), "a chain key is on disk to begin with");

  await internals.syncRatchet();

  assert.equal(gen.ratchet.destroyed, true, "the chain destroyed itself");
  assert.equal(await dbGet("secret"), undefined, "the stored chain key was erased");
  assert.equal(await dbGet("genMeta"), undefined, "and the record naming its channel with it");
  assert.equal(state.chainDestroyed, true);
  const item = internals.alertItems().find((i) => i.id === "chain-destroyed");
  assert.ok(item, "the user is told this device has to be re-invited");
  assert.match(item.text, /fresh invite link/);
  assert.equal(state.sharing, false, 'nothing keeps claiming "Live"');
});

// ------------------------------------------------- after the self-destruct

const kvFace = { get: dbGet, set: dbSet, del: dbDel };

// The tracked timer, captured before any test slows the poll loop down.
const trackedTimeout = globalThis.setTimeout;
const pause = (ms) => new Promise((r) => trackedTimeout(r, ms));

// The invite poll waits 15 s between rounds and a check cannot. Long waits are
// clamped for the width of one test; everything else about the loop, including
// the dedup that makes a second delivery impossible, is the real thing.
function hurryTimers(maxMs = 20) {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => real(fn, Math.min(ms ?? 0, maxMs), ...rest);
  return () => {
    globalThis.setTimeout = real;
  };
}

// A circle sitting in the inactive array: real keys, real channel, nothing
// live about it.
async function inactiveCircle(name) {
  const identity = await generateIdentity();
  const gen = await openGeneration({ seed: newSeed(), g: 0, e0: epochAt(Date.now()) });
  const snap = gen.ratchet.snapshot();
  return {
    name,
    secret: snap.ck0,
    identity,
    g: 0,
    e0: gen.e0,
    ckEpoch: snap.e0,
    channelId: gen.channelId,
    at: Date.now(),
    genRoster: [],
    pinned: [],
    profile: null,
    lastTs: 0,
  };
}

// Turn the app lock on around a live circle, the way enableLock leaves the
// disk: the chain key sealed under the vault key, the lock record beside it,
// and no plaintext copy of either.
async function lockUp(gen, passcode) {
  const K = newVaultKey();
  const lockRecord = { enabled: true, autolockMs: 60000, pass: await makePasscodeRecord(passcode, K), bio: null };
  const lock = { enabled: true, vaultKey: K };
  const snap = gen.ratchet.snapshot();
  state.lock = lockRecord;
  state.vaultKey = K;
  await dbSet("lock", lockRecord);
  await dbSet("vaultSecret", await sealUnderVault(K, snap.ck0));
  await dbDel("secret");
  await writeRecordAtRest(kvFace, lock, GEN_SLOT, packGenMeta({ ...gen, ckEpoch: snap.e0, genRoster: [] }));
  return lock;
}

test("a circle that destroys itself hands its slots to the next circle, not to the lock screen", async () => {
  // The self-destruct is a LEAVE now, made at the moment the chain dies rather
  // than pieced back together at the next unlock. Everything below used to
  // happen one launch later, in bespoke code, and each of the last three
  // rounds found that code deleting something it had no business deleting:
  // most recently the app lock, on the first correct passcode after the
  // circle expired.
  const gen = await freshCircle({ e0: epochAt(Date.now()) - (MAX_CATCHUP_EPOCHS + 200) });
  const lock = await lockUp(gen, "824197");
  const other = await inactiveCircle("Second circle");
  state.circles = [other];
  await writeCirclesAtRest(kvFace, lock, [other]);
  const passRecord = state.lock.pass;
  const K = state.vaultKey;
  const deadSealed = await dbGet("vaultSecret");

  await internals.syncRatchet();

  assert.ok(await dbGet("lock"), "the lock record did not go with the circle");
  assert.equal(state.circleName, "Second circle", "the circle that survived is the one on screen");
  assert.equal(await dbGet("secret"), undefined, "no chain key was written in the clear");
  assert.equal(await dbGet("circles"), undefined, "and the remaining circles were not un-sealed");
  const promoted = await dbGet("vaultSecret");
  assert.notDeepEqual(promoted, deadSealed, "the dead circle's sealed chain key is off the disk");
  assert.deepEqual(
    [...(await openUnderVault(K, promoted))],
    [...other.secret],
    "and what took its place is the promoted circle's key, still sealed",
  );
  assert.ok(
    await dbGet(internals.DESTROYED_KEY),
    "the mark is still there: a circle holds the slots, but nobody has read the card yet",
  );

  const item = internals.alertItems().find((i) => i.id === "chain-wiped");
  assert.ok(item, "the person is told a circle went away while they were gone");
  assert.match(item.text, /app lock and your other circles were not touched/);

  // The phone is put away and picked up again. There is nothing left to
  // resume: this is an ordinary locked launch of an ordinary circle. What
  // there IS is a card nobody has read yet, and a sixty second autolock is the
  // ordinary way a card goes unread.
  internals.lockNow();
  assert.equal(state.locked, true);
  assert.equal(state.chainWiped, null, "the lock screen holds nothing about any circle");
  const ok = await internals.unlockWith(() => openPasscodeRecord(passRecord, "824197"));
  await settle();

  assert.equal(ok, true, "the passcode still opens the device");
  assert.ok(await dbGet("lock"), "the app lock survived a circle expiring");
  assert.equal(state.lock?.enabled, true, "and the session still believes it is locked-capable");
  assert.equal(state.circleName, "Second circle");
  assert.ok(state.vaultKey, "the vault key is live, because the lock is still on");

  // The whole point of the mark, and the assertion this test was missing. The
  // device is back in a DIFFERENT circle from the one it went away in, which
  // is the moment the person has to hear about it.
  const back = internals.alertItems().find((i) => i.id === "chain-wiped");
  assert.ok(back, "the notice came back with the unlock instead of dying with the lock");

  // Twice, because a mark spent on the first entry after the destruct looks
  // exactly like a mark that survives until it is read, right up to the second
  // time the phone locks itself.
  internals.lockNow();
  const twice = await internals.unlockWith(() => openPasscodeRecord(passRecord, "824197"));
  await settle();
  assert.equal(twice, true);
  assert.ok(
    internals.alertItems().find((i) => i.id === "chain-wiped"),
    "and again after the second autolock, because nobody has read it yet",
  );

  // And it goes when somebody says they have read it. Not before.
  back.actions.find((a) => a.testid === "alert-chain-wiped-ok").onClick();
  await settle();
  assert.equal(
    internals.alertItems().find((i) => i.id === "chain-wiped"),
    undefined,
    "dismissing it takes the card off the screen",
  );
  assert.equal(await dbGet(internals.DESTROYED_KEY), undefined, "and spends the mark that kept bringing it back");

  internals.lockNow();
  const again = await internals.unlockWith(() => openPasscodeRecord(passRecord, "824197"));
  await settle();
  assert.equal(again, true, "and the passcode still works after all that");
  assert.equal(
    internals.alertItems().find((i) => i.id === "chain-wiped"),
    undefined,
    "a notice somebody has read does not come back",
  );

  state.lock = null;
  state.vaultKey = null;
  await dbDel("lock");
});

// The passcode record and the disk shape a locked device is left in when its
// only circle destroys itself: lock record, self-destruct mark, nothing else.
async function destroyedAlone(passcode) {
  const gen = await freshCircle({ e0: epochAt(Date.now()) - (MAX_CATCHUP_EPOCHS + 200) });
  await lockUp(gen, passcode);
  state.circles = [];
  const passRecord = state.lock.pass;
  await internals.syncRatchet();
  return passRecord;
}

// What boot() sees: a launch starts with nothing in memory.
function coldStart() {
  internals.lockNow();
  state.lock = null;
  state.locked = false;
  state.vaultKey = null;
  state.gen = null;
  state.identity = null;
  state.circles = [];
  state.chainWiped = null;
  state.chainDestroyed = false;
  state.screen = "onboarding";
}

test("a self-destruct with nothing to fall back to still has an app lock two launches later", async () => {
  // The critical one. The mark used to be cleared while the disk was still in
  // the destroyed shape, so the FIRST unlock looked right and the launch after
  // it read a lock record with nothing behind it, called that an abandoned
  // install, and deleted the lock. The notice on screen said in so many words
  // that the app lock was untouched.
  const passRecord = await destroyedAlone("601884");

  assert.equal(state.chainDestroyed, true, "the chain destroyed itself");
  assert.ok(await dbGet("lock"), "the lock record is still there");
  assert.ok(await dbGet(internals.DESTROYED_KEY), "and the mark saying why the device is empty");
  assert.equal(await dbGet("vaultSecret"), undefined, "the sealed chain key is gone");

  // Launch one: the lock screen, the right passcode, the explanation.
  coldStart();
  await internals.boot();
  await settle();
  assert.equal(state.screen, "lock", "the launch after asks for the passcode rather than starting over");
  assert.ok(await dbGet("lock"), "and boot did not read an empty device as an abandoned install");

  const ok = await internals.unlockWith(() => openPasscodeRecord(passRecord, "601884"));
  assert.equal(ok, true, "the passcode opens the device");
  assert.equal(state.screen, "notice", "and it explains itself instead of dropping into onboarding");
  assert.ok(await dbGet("lock"), "the app lock survived the unlock");
  assert.ok(
    await dbGet(internals.DESTROYED_KEY),
    "and the mark was NOT spent on a screen: nothing has taken the slots, so nothing has changed",
  );

  // Launch two, with no circle made in between. This is the one that used to
  // delete the lock.
  coldStart();
  await internals.boot();
  await settle();
  assert.equal(state.screen, "lock", "still a lock screen");
  assert.ok(await dbGet("lock"), "the app lock is still on the disk a launch later");
  const again = await internals.unlockWith(() => openPasscodeRecord(passRecord, "601884"));
  assert.equal(again, true, "and the same passcode still opens it");
  assert.ok(await dbGet("lock"), "which it could not if the record had been deleted");

  state.lock = null;
  state.vaultKey = null;
  await dbDel("lock");
});

test("a self-destruct takes this device's identity in the circle with it", async () => {
  // The card says the circle's keys are gone from memory and from storage. The
  // erase reached the chain key and the four slots and stopped there: the
  // keypair stayed, and it carries the member id this phone posted under,
  // which is what ties a seized phone to a channel the relay has logs of. The
  // circle's name and the send cursor stayed with it.
  const gen = await freshCircle({ e0: epochAt(Date.now()) - (MAX_CATCHUP_EPOCHS + 200) });
  state.circles = [];
  await dbSet("secret", gen.ratchet.snapshot().ck0);
  await dbSet("circleName", "Tuesday march");
  await dbSet("lastSentTs", 1700000000000);
  assert.ok(await dbGet("identity"), "the keypair is on disk to begin with");

  await internals.syncRatchet();

  assert.equal(state.chainDestroyed, true);
  assert.equal(await dbGet("secret"), undefined, "the chain key is gone");
  assert.equal(await dbGet("identity"), undefined, "and this device's keypair for that circle");
  assert.equal(await dbGet("circleName"), undefined, "and the name of the circle it was in");
  assert.equal(await dbGet("lastSentTs"), undefined, "and the send cursor");
  assert.equal(state.identity, null, "memory says what the disk says");
});

test("an unlocked launch after a self-destruct says what happened", async () => {
  // The configuration the app ships with. boot only ever read the mark on the
  // locked path, so on an unlocked device it was written, never read, then
  // cleared: the person came back to a bare onboarding screen, was told
  // nothing, and went on believing a circle could still see them.
  const gen = await freshCircle({ e0: epochAt(Date.now()) - (MAX_CATCHUP_EPOCHS + 200) });
  state.circles = [];
  await dbSet("secret", gen.ratchet.snapshot().ck0);
  await internals.syncRatchet();
  assert.ok(await dbGet(internals.DESTROYED_KEY), "the destruct left its mark");

  coldStart();
  await internals.boot();
  await settle();

  assert.equal(state.screen, "notice", "the launch explains the empty device rather than presenting a fresh one");
  assert.ok(await dbGet(internals.DESTROYED_KEY), "and keeps the mark, because nothing has taken the slots yet");
});

test("a launch that finds a circle and the mark together says a circle went away", async () => {
  // The mark outlives the destruct when the app is killed between the leave
  // and the entry that spends it. The device comes back in a DIFFERENT circle
  // from the one it went away in, which is exactly the moment the person has
  // to hear about it, and nothing on this path read the mark at all.
  const gen = await freshCircle();
  await dbSet("secret", gen.ratchet.snapshot().ck0);
  await dbSet("circleName", "Backup circle");
  const snap = gen.ratchet.snapshot();
  await writeRecordAtRest(kvFace, null, GEN_SLOT, packGenMeta({ ...gen, ckEpoch: snap.e0, genRoster: [] }));
  await dbSet(internals.DESTROYED_KEY, 1);

  coldStart();
  await internals.boot();
  await settle();

  assert.ok(state.gen, "the circle that survived is live");
  assert.equal(state.circleName, "Backup circle");
  const item = internals.alertItems().find((i) => i.id === "chain-wiped");
  assert.ok(item, "and the person is told one of their circles expired while they were away");
  assert.ok(
    await dbGet(internals.DESTROYED_KEY),
    "the mark outlives the entry that raised the card, because raising a card is not anybody reading it",
  );

  item.actions.find((a) => a.testid === "alert-chain-wiped-ok").onClick();
  await settle();
  assert.equal(await dbGet(internals.DESTROYED_KEY), undefined, "the person dismissing it is what spends the mark");
});

test("a circle destroying itself takes the join in flight with it, record and secret", async () => {
  // onChainDestroyed stopped the poll and kept the record. lockNow and
  // cancelJoin both clear it and zero the secret; this one left the screen
  // saying "waiting to be let in" for a rendezvous nothing was listening to,
  // holding a live invite secret nothing would ever spend or clear.
  const gen = await freshCircle({ e0: epochAt(Date.now()) - (MAX_CATCHUP_EPOCHS + 200) });
  state.circles = [];
  await dbSet("secret", gen.ratchet.snapshot().ck0);
  await joinSession();
  const held = state.joining.secret;
  assert.ok(held.some((b) => b !== 0), "the invite secret is live to begin with");

  await internals.syncRatchet();

  assert.equal(state.chainDestroyed, true, "the chain destroyed itself");
  assert.equal(state.joining, null, "and the join in flight went with it");
  assert.deepEqual([...held], new Array(held.length).fill(0), "with its invite secret zeroed, not stranded");
});

test("the recovery a self-destruct advertises is one this device can follow", async () => {
  // The card says to ask for a fresh invite link. It used to be impossible:
  // state.gen stayed live holding an empty ratchet, so completeJoin's first
  // move (write the outgoing circle down) threw inside a promise nobody reads,
  // the welcome was swallowed, and the link had already been burned by the
  // inviter's re-key. Create and switch failed the same way.
  const gen = await freshCircle({ e0: epochAt(Date.now()) - (MAX_CATCHUP_EPOCHS + 200) });
  state.circles = [];
  await dbSet("secret", gen.ratchet.snapshot().ck0);

  // Through the door the app actually comes back in by: resuming a circle is
  // what walks the chain forward, and this is the walk it cannot make.
  await internals.enterCircle();
  assert.equal(state.chainDestroyed, true);
  assert.equal(state.gen, null, "the dead generation was cleared, not left standing");
  assert.equal(state.pinned.size, 0, "and the roster of a circle that is gone with it");

  const card = internals.alertItems().find((i) => i.id === "chain-destroyed");
  assert.ok(card.actions?.some((a) => a.testid === "alert-destroyed-join"), "the card offers the join it advises");

  // So somebody sends a fresh link, and this device uses it.
  const j = await joinSession();
  const feed = await welcomeFeed(j);
  harness.onFetch(async (url) => {
    if (!url.includes(j.chanId)) return null;
    return { ok: true, status: 200, json: async () => ({ members: [feed] }) };
  });

  internals.startJoinWatch();
  await settle(200);
  harness.onFetch(null);

  assert.ok(state.gen, "the circle from the new link landed");
  assert.equal(state.gen.g, 4, "and it is the generation the new inviter sent, not the dead one");
  assert.equal(state.joining, null, "and the device stopped waiting");
  assert.equal(state.chainDestroyed, false, "the alert about the old circle is gone with it");
  assert.ok(state.pinned.has(j.inviter.memberId), "the inviter was pinned from the welcome");
});

test("a self-destruct in one circle moves this device into the next one, not out of all of them", async () => {
  // Same defect, third caller in the round that found it: doSwitchCircle
  // stashed the outgoing circle before promoting anything, and stashing a dead
  // generation threw, so a self-destruct in one circle took away the ones it
  // had nothing to do with. The switch is no longer something the person has
  // to make: the destruct is a leave, and a leave promotes.
  const gen = await freshCircle({ e0: epochAt(Date.now()) - (MAX_CATCHUP_EPOCHS + 200) });
  const other = await inactiveCircle("Backup circle");
  state.circles = [other];
  await dbSet("secret", gen.ratchet.snapshot().ck0);
  await writeCirclesAtRest(kvFace, null, [other]);

  await internals.syncRatchet();

  assert.ok(state.gen, "the device is in a circle, not stranded between them");
  assert.equal(state.circleName, "Backup circle");
  assert.equal(state.gen.channelId, other.channelId, "and it is the circle that was waiting");
  assert.equal(state.circles.length, 0, "which is no longer sitting in the inactive array as well");
  assert.equal(state.chainDestroyed, false, "the alert for the circle that expired went with it");
  assert.deepEqual([...(await dbGet("secret"))], [...other.secret], "the promoted circle's key is in the slots");
  assert.equal(state.identity.memberId, other.identity.memberId, "under the keypair that belongs to it");
  assert.ok(
    internals.alertItems().find((i) => i.id === "chain-wiped"),
    "and the move is explained rather than just happening",
  );
});

test("a welcome whose opening epoch is nowhere near its own is not a join", async () => {
  // membership.js bounds this; here is the plumbing that hands it the number
  // to bound against. A welcome with no epoch at all would be refused too, so
  // the test above is what proves the number arrives and this is what proves
  // it is used: the same feed, the same inviter, one field changed.
  const j = await waitingJoiner();
  const feed = await welcomeFeed({ ...j, e0: 0 });
  harness.onFetch(async (url) => {
    if (!url.includes(j.chanId)) return null;
    return { ok: true, status: 200, json: async () => ({ members: [feed] }) };
  });

  internals.startJoinWatch();
  await settle(200);
  harness.onFetch(null);

  assert.equal(state.chainDestroyed, false, "the welcome did not drive this device into its own self-destruct");
  assert.equal(state.gen, null, "an inviter cannot open the joiner's ratchet at epoch zero");
  assert.ok(state.joining, "the device is still waiting rather than wiped");
  state.joining = null;
});

test("a welcome survives a join that failed, because it is the only copy there is", async () => {
  // The inviter has already re-keyed the circle and burned the invitation by
  // the time this arrives, and the poll loop will not hand over the same
  // message twice, so the buffer holding it is the last copy in existence. It
  // used to be emptied BEFORE the join was attempted, so one persist failure
  // or one busy guard lost the join for good and left the device sitting on
  // "waiting to be let in" for a circle that had already let it in.
  const j = await waitingJoiner();
  const feed = await welcomeFeed(j);
  harness.onFetch(async (url) => {
    if (!url.includes(j.chanId)) return null;
    return { ok: true, status: 200, json: async () => ({ members: [feed] }) };
  });
  // Caught between lock states: the lock record says everything is sealed and
  // the vault key is not in memory, so writing the chain key fails closed
  // rather than putting it on the disk in the clear. Any storage failure has
  // this shape; this one can be turned off again from a test.
  state.lock = { enabled: true, autolockMs: 60000 };
  state.vaultKey = null;

  const unhurry = hurryTimers();
  try {
    internals.startJoinWatch();
    await pause(150);
    assert.equal(state.gen, null, "the join did not land");
    assert.ok(state.joining, "and the device is still waiting to be let in");

    // The transition finishes and the vault key is back. Nothing new arrives:
    // the relay is serving the same two messages and the loop has already seen
    // both, so the join can only be completed from what was kept.
    state.vaultKey = newVaultKey();
    await pause(400);
  } finally {
    unhurry();
    harness.onFetch(null);
  }

  assert.ok(state.gen, "the welcome was still there to be used on the next round");
  assert.equal(state.gen.g, 4, "and it is the generation the inviter actually sent");
  assert.equal(state.joining, null, "the device stopped waiting");
  assert.ok(state.pinned.has(j.inviter.memberId));

  state.lock = null;
  state.vaultKey = null;
});

test("nobody is admitted until the welcome can actually be delivered", async () => {
  // A link holder can fill the rendezvous channel's member slots with junk
  // identities. The inviter has never posted there, so the welcome is their
  // first post and the cap turns it away. Everything the accept does is
  // irreversible except that: the wraps are on the relay, the generation is
  // open, the joiner is pinned into it. Run in that order the circle admits
  // somebody it then has no way to reach, and no way to undo.
  const gen = await freshCircle();
  state.circles = [];
  await internals.enterCircle();
  await settle();
  await api.createInvite();
  const inviteChan = await deriveInviteChannelId(state.invite.secret);

  const joiner = await generateIdentity();
  const req = {
    memberId: joiner.memberId,
    alg: joiner.alg,
    pk: b64uEncode(joiner.pk),
    epk: b64uEncode(joiner.epk),
    name: "Zed",
    safety: "11111 22222",
    at: Date.now(),
  };

  harness.onFetch(async (url, init) => {
    if (init?.method === "POST" && url.includes(inviteChan)) {
      // What the relay answers a channel that is already holding MEMBER_CAP
      // members: no slot for you.
      return { ok: false, status: 403, json: async () => ({ error: "forbidden" }) };
    }
    return null;
  });

  const admitted = await api.acceptJoin(req);
  harness.onFetch(null);

  assert.equal(admitted, false, "the accept failed rather than half succeeded");
  assert.equal(state.gen, gen, "the circle is on the generation it started on");
  assert.equal(state.gen.g, 0, "nothing re-keyed");
  assert.equal(state.gen.channelId, gen.channelId, "and the circle did not move channel");
  assert.equal(state.pinned.has(joiner.memberId), false, "nobody was pinned into a generation they can never be told about");
  assert.equal(state.invite, null, "the jammed link was burned instead of being left to fail again");
  assert.equal(state.joinRequests.length, 0);
});

// --------------------------------------------------------------- join path

// A live circle with an invitation out on it, which is what every check below
// starts from.
async function invitingCircle() {
  const gen = await freshCircle();
  state.circles = [];
  await internals.enterCircle();
  await settle();
  await api.createInvite();
  return gen;
}

// A join request the way onJoinRequest would have left it on the list.
async function joinRequestFrom(identity, name = "Zed") {
  return {
    memberId: identity.memberId,
    alg: identity.alg,
    pk: b64uEncode(identity.pk),
    epk: b64uEncode(identity.epk),
    name,
    safety: "11111 22222",
    at: Date.now(),
  };
}

// Pin n members through the real addPinned, so the roster the cap is measured
// against is the roster the app would actually be holding.
async function fillRoster(n) {
  for (let i = 0; i < n; i++) {
    const id = await generateIdentity();
    const got = await internals.addPinned({
      alg: id.alg,
      pk: b64uEncode(id.pk),
      epk: b64uEncode(id.epk),
      name: `M${i}`,
    });
    assert.ok(got, "the filler member pinned");
  }
}

test("a full circle turns the next joiner away instead of admitting a seventeenth", async () => {
  // There was no cap anywhere on the admit path. The one in net.js bounds what
  // a relay can push into the roster; the one the rendezvous channel enforces
  // is a different channel with a different count. So a full circle admitted
  // one more, the circle channel had no slot left for somebody, and that
  // person silently stopped being able to post with nothing on any screen
  // saying which of them it was.
  //
  // Occupancy is the pinned roster PLUS this device, which is never pinned.
  await invitingCircle();
  await fillRoster(MEMBER_CAP - 2);
  assert.equal(state.pinned.size + 1, MEMBER_CAP - 1, "one seat left");

  // The negative control, first: one below the cap the same request goes in,
  // so what stops the next one is the count and not the request.
  const wanted = await generateIdentity();
  const inReq = await joinRequestFrom(wanted, "Ada");
  state.joinRequests = [inReq];
  assert.equal(await api.acceptJoin(inReq), true, "the last seat is filled normally");
  assert.equal(state.pinned.has(wanted.memberId), true, "and they really are in the circle");
  assert.equal(state.pinned.size + 1, MEMBER_CAP, "the circle is now full");

  await api.createInvite();
  const gen = state.gen;
  const extra = await generateIdentity();
  const outReq = await joinRequestFrom(extra, "Mallory");
  state.joinRequests = [outReq];

  const admitted = await api.acceptJoin(outReq);

  assert.equal(admitted, false, "the seventeenth is turned away");
  assert.equal(state.pinned.has(extra.memberId), false, "nobody was pinned past the cap");
  assert.equal(state.pinned.size + 1, MEMBER_CAP, "and the roster is the size it was");
  assert.equal(state.gen, gen, "the circle was not re-keyed to admit them");
  assert.ok(state.invite, "the invitation was not spent on a refusal");
});

// One post on a rendezvous channel, read back the way the joining device
// reads it: the invite key opens whatever the inviter sealed under it.
async function openInvitePost(key, chanId, memberId, body) {
  const p = JSON.parse(body);
  return openMessage(key, chanId, memberId, p.e, p.ts, b64uDecode(p.n), b64uDecode(p.c));
}

// The relay's copy of a post it accepted, as a feed point.
const keptPoint = (body) => {
  const p = JSON.parse(body);
  return { e: p.e, ts: p.ts, srv: p.ts, n: p.n, c: p.c, sig: p.sig };
};

test("a welcome that did not send takes the admission back out with it", async () => {
  // Round five stopped burning the invitation on a failed welcome so the
  // accept could be tried again, and that part stands: the link is still live
  // below and the request is still on the list. What it could not do was stand
  // alone. Until somebody taps accept a second time the joiner is pinned into
  // a generation nobody handed them, and the retry lives only as long as this
  // device's memory: a lock or a restart empties the request list, and the
  // joiner's half of the handshake is in memory too, so re-opening the link
  // hands the circle a fresh keypair under a fresh member id rather than the
  // one already in the roster. What is left is a member nobody can reach,
  // sitting in the list looking exactly like everybody else, holding a seat
  // and putting every re-key's roster hash out of everyone else's reach.
  await invitingCircle();
  const inviteChan = await deriveInviteChannelId(state.invite.secret);
  const joiner = await generateIdentity();
  const req = await joinRequestFrom(joiner);
  state.joinRequests = [req];

  let posts = 0;
  harness.onFetch(async (url, init) => {
    if (init?.method === "POST" && url.includes(inviteChan)) {
      posts += 1;
      // The slot claim gets through. The delivery behind it does not, which is
      // one bad moment on the network and nothing more.
      if (posts > 1) return { ok: false, status: 503, json: async () => ({ error: "unavailable" }) };
    }
    return null;
  });

  const ok = await api.acceptJoin(req);
  harness.onFetch(null);

  assert.ok(posts > 1, "the welcome was genuinely attempted");
  assert.equal(ok, false, "the accept says nobody was let in");
  assert.equal(state.pinned.has(joiner.memberId), false, "and the circle is not holding somebody it cannot reach");
  assert.equal(state.pinned.size, 0, "nobody else went out with them");
  assert.equal(state.gen.g, 2, "the admission and the undo are both real re-keys");
  assert.ok(state.invite, "the link they have to open again is still live");
  assert.equal(
    state.joinRequests.some((r) => r.memberId === joiner.memberId),
    true,
    "and their request is still on the list to accept a second time",
  );
});

test("a second accept does not put the joiner in the roster hash twice", async () => {
  // doRekey built its recipients by walking state.pinned and then pushing the
  // admitted member on top. On a second accept the first one had already
  // pinned them, so the list held them twice: two wraps to one member, and a
  // roster hash taken over a list with a duplicate in it. rosterHash sorts and
  // joins rather than deduping, so no other device can hash its way to that
  // value, rosterConverged never returns true anywhere, and every other member
  // is left on a membership mismatch nothing can clear.
  //
  // Undoing a failed admission is itself a re-key and it can fail in turn.
  // That is the state this starts from, because it is the only one in which a
  // pinned member can be accepted a second time.
  await invitingCircle();
  const rotator = state.identity.memberId;
  const inviteChan = await deriveInviteChannelId(state.invite.secret);
  const firstChannel = state.gen.channelId;

  const other = await generateIdentity();
  assert.ok(
    await internals.addPinned({ alg: other.alg, pk: b64uEncode(other.pk), epk: b64uEncode(other.epk), name: "Ada" }),
    "there is somebody else in the circle for the hash to be about",
  );

  const joiner = await generateIdentity();
  const req = await joinRequestFrom(joiner, "Zed");
  state.joinRequests = [req];

  let posts = 0;
  harness.onFetch(async (url, init) => {
    if (init?.method !== "POST") return null;
    if (url.includes(inviteChan)) {
      posts += 1;
      if (posts > 1) return { ok: false, status: 503, json: async () => ({ error: "unavailable" }) };
      return null;
    }
    // The admitting re-key lands. The one that would take it back out is on
    // the generation after it, on a channel this refuses.
    if (!url.includes(firstChannel)) return { ok: false, status: 503, json: async () => ({ error: "unavailable" }) };
    return null;
  });
  assert.equal(await api.acceptJoin(req), false, "the first accept could not deliver");
  assert.equal(state.pinned.has(joiner.memberId), true, "and could not undo itself, so they are pinned");

  // The retry, on the same live link and the same request, with nothing in the
  // way. Every re-key wrap it posts is read back off the wire.
  const wraps = [];
  harness.onFetch(async (url, init) => {
    if (init?.method === "POST" && url.includes(state.gen.channelId)) {
      const gen = state.gen;
      const p = JSON.parse(init.body);
      const key = await gen.ratchet.keyFor(p.e, rotator, p.ts);
      const body = key && (await openMessage(key, gen.channelId, rotator, p.e, p.ts, b64uDecode(p.n), b64uDecode(p.c)));
      if (body?.t === "rekey") wraps.push(body);
    }
    return null;
  });
  const ok = await api.acceptJoin(req);
  harness.onFetch(null);

  assert.equal(ok, true, "the second accept went through");
  const to = wraps.map((w) => w.to);
  assert.equal(to.length, 2, "one wrap per member of the circle");
  assert.equal(new Set(to).size, to.length, "and nobody is a recipient twice");

  const rh = wraps[0].rh;
  assert.ok(
    wraps.every((w) => w.rh === rh),
    "every wrap commits to the same roster",
  );
  // What the other member's device computes when it adopts this re-key: its
  // own roster minus the rotator, plus itself.
  assert.equal(
    await rosterConverged({ pinned: [rotator, joiner.memberId], self: other.memberId, by: rotator, rh }),
    true,
    "a member who has met the joiner can reproduce the membership the re-key committed to",
  );
});

test("the welcome is posted last, so a delivery that stops partway leaves nothing to open", async () => {
  // The welcome and the member records are separate posts because one message
  // cannot hold sixteen key pairs, so any of them can be the one the network
  // eats. Posted welcome-first, a failure partway left a welcome standing on
  // the rendezvous channel with its records missing, and that leftover is what
  // poisons every retry and alarms the next person to open the link. Posted
  // last, the welcome is the commit point: nothing on the channel means
  // anything until it lands, and once it lands everything it commits to is
  // already there.
  await invitingCircle();
  const inviteSecret = new Uint8Array(state.invite.secret);
  const inviteChan = await deriveInviteChannelId(inviteSecret);
  const inviteKey = await deriveInviteKey(inviteSecret);
  const me = state.identity.memberId;

  const other = await generateIdentity();
  assert.ok(await internals.addPinned({ alg: other.alg, pk: b64uEncode(other.pk), epk: b64uEncode(other.epk), name: "Ada" }));

  const joiner = await generateIdentity();
  const req = await joinRequestFrom(joiner, "Zed");
  state.joinRequests = [req];

  const kinds = [];
  harness.onFetch(async (url, init) => {
    if (init?.method === "POST" && url.includes(inviteChan)) {
      kinds.push((await openInvitePost(inviteKey, inviteChan, me, init.body))?.t);
    }
    return null;
  });
  const ok = await api.acceptJoin(req);
  harness.onFetch(null);

  assert.equal(ok, true, "the welcome went out");
  assert.equal(kinds.filter((t) => t === "member").length, 2, "there were records to lose");
  assert.equal(kinds.filter((t) => t === "welcome").length, 1, "exactly one welcome");
  assert.equal(kinds.indexOf("welcome"), kinds.length - 1, "and it is the last thing posted, with every record already behind it");
});

test("a joiner assembles a complete welcome out of a channel a failed attempt already wrote to", async () => {
  // The retry the deferred burn exists to enable, end to end: an attempt that
  // dies partway, the undo, the accept that follows, and then the joining
  // device fed exactly what the rendezvous channel is holding by the end of
  // it. Sent welcome-first, the joiner opened the stale welcome from the first
  // attempt on every poll, waited out the grace period for records that were
  // never coming, and refused the join for a short delivery while the complete
  // welcome sat behind it in the same buffer, never looked at.
  await invitingCircle();
  const inviter = state.identity;
  const inviteSecret = new Uint8Array(state.invite.secret);
  const commit = new Uint8Array(state.invite.commit);
  const inviteChan = await deriveInviteChannelId(inviteSecret);
  const inviteKey = await deriveInviteKey(inviteSecret);

  // A second member, so the delivery is more than one record and there is a
  // real partway for it to stop at.
  const other = await generateIdentity();
  assert.ok(await internals.addPinned({ alg: other.alg, pk: b64uEncode(other.pk), epk: b64uEncode(other.epk), name: "Ada" }));

  const joiner = await generateIdentity();
  const req = await joinRequestFrom(joiner, "Zed");
  state.joinRequests = [req];

  // Everything this device puts on the channel, kept the way the relay keeps
  // it: a failed post leaves nothing behind, a successful one is there for
  // good.
  const points = [];
  let posts = 0;
  harness.onFetch(async (url, init) => {
    if (init?.method !== "POST" || !url.includes(inviteChan)) return null;
    posts += 1;
    if (posts > 2) return { ok: false, status: 503, json: async () => ({ error: "unavailable" }) };
    points.push(keptPoint(init.body));
    return null;
  });
  assert.equal(await api.acceptJoin(req), false, "the first attempt did not deliver");
  assert.equal(state.pinned.has(joiner.memberId), false, "and took its admission back out");
  const abandoned = points.length;
  assert.equal(abandoned, 2, "it did leave something on the channel");

  harness.onFetch(async (url, init) => {
    if (init?.method === "POST" && url.includes(inviteChan)) points.push(keptPoint(init.body));
    return null;
  });
  assert.equal(await api.acceptJoin(req), true, "the retry delivered");
  harness.onFetch(null);
  assert.ok(points.length > abandoned + 2, "and put a whole delivery on top of the leftovers");
  assert.equal(
    new Set(points.map((p) => `${p.e}|${p.ts}`)).size,
    points.length,
    "every post is one the relay would have kept, not one that overwrote another",
  );

  const wantG = state.gen.g;
  const wantChannel = state.gen.channelId;

  // Now the other side of the link: the device that made the request, holding
  // nothing but its own keypair, reading that channel.
  await wipeAll();
  state.locked = false;
  state.lock = null;
  state.vaultKey = null;
  state.demo = false;
  state.chainDestroyed = false;
  state.gen = null;
  state.identity = null;
  state.pinned = new Map();
  state.genRoster = new Set();
  state.circles = [];
  state.invite = null;
  state.joinRequests = [];
  state.joinIncomplete = null;
  window.__starlingErrors.length = 0;
  state.joining = {
    status: "waiting",
    since: Date.now(),
    safety: "11111 22222",
    secret: new Uint8Array(inviteSecret),
    commit,
    imposters: 0,
    identity: joiner,
    chanId: inviteChan,
    key: inviteKey,
    circleName: "Test circle",
  };

  const feed = { members: [feedEntry(inviter, points)] };
  harness.onFetch(async (url, init) => {
    if (init?.method === "POST") return { ok: true, status: 200, json: async () => ({}) };
    if (url.includes(inviteChan)) return { ok: true, status: 200, json: async () => feed };
    return null;
  });
  const unhurry = hurryTimers();
  try {
    internals.startJoinWatch();
    await pause(300);
  } finally {
    unhurry();
    harness.onFetch(null);
  }

  assert.equal(state.joinIncomplete, null, "the delivery was not short");
  assert.ok(state.gen, "the joiner got in");
  assert.equal(state.joining, null, "and stopped waiting");
  assert.equal(state.gen.g, wantG, "on the generation the retry opened, not the one the first attempt abandoned");
  assert.equal(state.gen.channelId, wantChannel, "which is the circle everybody else is on");
  assert.equal(state.pinned.has(inviter.memberId), true, "with the inviter pinned");
  assert.equal(state.pinned.has(other.memberId), true, "and the member they have not met yet");
  assert.equal(state.joining, null);
});

test("a welcome addressed to somebody else is a leftover, not somebody impersonating the inviter", async () => {
  // openWelcome returns null both for a welcome the committed inviter did not
  // sign and for one it did sign that this device cannot open, and the two
  // were counted the same. A welcome sealed to a different joiner is what a
  // link that has already been answered once leaves behind, so the second
  // person to open the link was told somebody was impersonating the sender
  // when they were looking at a leftover.
  const { chanId, key, inviter, joiner } = await waitingJoiner();
  const someoneElse = await generateIdentity();
  const attacker = await generateIdentity();

  const lone = async (from, to, ts) => {
    const g = 4;
    const e0 = epochAt(Date.now());
    const context = welcomeContext({ by: from.memberId, g, e0 });
    const eph = await generateEphemeral();
    const w = await sealTo(eph.privateKey, to.epk, chanId, to.memberId, new Uint8Array(32).fill(11), context);
    return invitePost(from, chanId, key, { t: "welcome", g, e0, n: 1, eph: b64uEncode(eph.pub), w: b64uEncode(w) }, ts);
  };

  const now = Date.now();
  const feed = {
    members: [
      // The real inviter's welcome for a joiner who is not us.
      feedEntry(inviter, [await lone(inviter, someoneElse, now)]),
      // And the control: somebody who is not the inviter answering the link.
      feedEntry(attacker, [await lone(attacker, joiner, now)]),
    ],
  };
  harness.onFetch(async (url) => (url.includes(chanId) ? { ok: true, status: 200, json: async () => feed } : null));
  const unhurry = hurryTimers();
  try {
    internals.startJoinWatch();
    await pause(150);
  } finally {
    unhurry();
    harness.onFetch(null);
  }

  assert.ok(state.joining, "still waiting: neither of those was a welcome for this device");
  assert.equal(state.gen, null, "and nothing was joined");
  assert.equal(state.joining.imposters, 1, "the stranger is counted and the leftover is not");
});

test("a welcome record cannot tell this device what algorithm a member's key is", async () => {
  // wire.js says it in capitals: the algorithm is a function of the public key
  // and never a wire field, because the member id commits to the key and to
  // nothing else. addPinned took it off the record. An inviter could put the
  // wrong one on a welcome record, every joiner pinned it, and the moment that
  // member posted anything net.js compared the algorithm their key actually
  // names against the pinned one and raised a keys-changed alarm against
  // somebody who had changed nothing. It never clears: the real member keeps
  // presenting the real key, and the safety number does not cover `alg`, so
  // reading numbers out loud resolves nothing either.
  const gen = await freshCircle();
  const m = await generateIdentity();
  const lie = m.alg === "ed25519" ? "p256" : "ed25519";

  const entry = await internals.addPinned({
    alg: lie,
    pk: b64uEncode(m.pk),
    epk: b64uEncode(m.epk),
    name: "Ada",
  });

  assert.ok(entry, "a real key pins");
  assert.equal(entry.alg, m.alg, "under the algorithm its key names, not the one the record claimed");

  // And the alarm the forged field was worth: the same roster net.js builds,
  // over the same pinned store, fed that member's real post.
  let changed = null;
  const roster = createRoster({
    channelId: gen.channelId,
    ratchet: gen.ratchet,
    selfId: state.identity.memberId,
    pinned: internals.pinnedStore,
    onKeyChange: (id) => {
      changed = id;
    },
  });
  const e = gen.e0;
  const ts = e * EPOCH_MS + 1000;
  const key = await gen.ratchet.keyFor(e, m.memberId, ts);
  const sealed = await sealMessage(key, gen.channelId, m.memberId, e, ts, { v: 2, t: "loc", ts, lat: 1, lon: 2 });
  const post = await buildPost(m, gen.channelId, e, sealed, ts);
  await roster.ingest(
    [
      {
        m: m.memberId,
        alg: m.alg,
        pk: b64uEncode(m.pk),
        epk: b64uEncode(m.epk),
        points: [{ e: post.e, ts: post.ts, srv: post.ts, n: post.n, c: post.c, sig: post.sig }],
      },
    ],
    e * EPOCH_MS + 5000,
  );

  assert.equal(changed, null, "a member who changed nothing raises no alarm");
  assert.equal(state.keyChanges.size, 0);
});

test("a join request cannot tell this device what algorithm its own key is", async () => {
  // The other pinning path, and the one addPinned never sees: acceptJoin hands
  // its record to doRekey, which writes it straight into the roster. It copied
  // `alg` off the request, and the request's copy of it comes from the relay's
  // member row. Pinned wrong, the member's own posts read as a key change here
  // and on every device the welcome hands the record to.
  await invitingCircle();
  const joiner = await generateIdentity();
  const req = await joinRequestFrom(joiner, "Ada");
  req.alg = joiner.alg === "ed25519" ? "p256" : "ed25519";
  state.joinRequests = [req];

  assert.equal(await api.acceptJoin(req), true, "they were let in");

  const pinned = state.pinned.get(joiner.memberId);
  assert.ok(pinned, "and pinned");
  assert.equal(pinned.alg, joiner.alg, "under the algorithm their key names, not the one the request claimed");
});

test("a join that cannot even post does not leave a request nothing is watching", async () => {
  // stopJoinWatch went first and state.joining was replaced last, so a failure
  // in between stopped the poll and left the old join standing: the screen sat
  // on "waiting to be let in" for a channel nothing was listening to, for as
  // long as the app stayed open.
  await waitingJoiner();
  const stale = state.joining;
  assert.ok(stale, "a join is in flight before this one starts");
  internals.startJoinWatch();

  const inviter = await generateIdentity();
  const invite = {
    secret: newInviteSecret(),
    commit: await inviterCommitment(inviter.pk, inviter.epk),
  };
  harness.onFetch(async (_url, init) =>
    init?.method === "POST" ? { ok: false, status: 503, json: async () => ({ error: "unavailable" }) } : null,
  );

  await assert.rejects(() => internals.joinWithInvite(invite, { name: "Zed" }), "the request could not be posted");
  harness.onFetch(null);

  assert.equal(state.joining, null, "nothing is left waiting on a channel nobody is polling");
  assert.equal(harness.node("#join-waiting").hidden, true, "and the card claiming a request is out came down");
  assert.ok(
    stale.secret.every((b) => b === 0),
    "the abandoned join's copy of the invite secret was zeroed, not just dropped",
  );
});

test("a scrubbed vault key cannot seal the chain key", async () => {
  // zero() empties the buffer in place and leaves the reference alive, so a
  // bare `if (!lock.vaultKey)` waves a scrubbed key straight through and the
  // crown jewel gets sealed under 32 zero bytes, which is not encryption. The
  // real window is an autolock landing between writeGenAtRest's earlier writes
  // and this one: the lock context was captured while the key was still live.
  await freshCircle();
  await dbDel("vaultSecret");
  const live = new Uint8Array(32).fill(7);
  const lock = { enabled: true, vaultKey: live };
  const ck = new Uint8Array(32).fill(9);

  await internals.writeChainKey(lock, ck);
  assert.ok(await dbGet("vaultSecret"), "a live key seals normally");
  await dbDel("vaultSecret");

  live.fill(0);
  await assert.rejects(
    () => internals.writeChainKey(lock, ck),
    /refusing to write the chain key/,
    "a scrubbed key is refused, not treated as present",
  );
  assert.equal(await dbGet("vaultSecret"), undefined, "and nothing landed under 32 zero bytes");
});

// ------------------------------------------------------- one spelling of a key

// base64url leaves slack at the end. The last character of a 32 or a 65 byte
// key carries two bits nothing decodes, so several different strings are all
// valid encodings of the same key, and a relay is free to serve any of them.
const B64U = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const respell = (s) => s.slice(0, -1) + B64U[B64U.indexOf(s.at(-1)) ^ 1];

// One signed position from a member, served under whatever spelling of their
// keys the caller asks for. The shape createPoller hands createRoster.
async function feedPoint(gen, who, pk, epk) {
  const e = gen.e0;
  const ts = e * EPOCH_MS + 1000;
  const key = await gen.ratchet.keyFor(e, who.memberId, ts);
  const sealed = await sealMessage(key, gen.channelId, who.memberId, e, ts, {
    v: 2,
    t: "loc",
    ts,
    lat: 51.5,
    lon: -0.1,
  });
  const post = await buildPost(who, gen.channelId, e, sealed, ts);
  return {
    m: who.memberId,
    alg: who.alg,
    pk,
    epk,
    points: [{ e: post.e, ts: post.ts, srv: post.ts, n: post.n, c: post.c, sig: post.sig }],
  };
}

test("a key the relay re-encodes is not a member whose keys changed", async () => {
  // Keys were pinned as the relay's own text and compared as text, so the same
  // key served under another of its spellings read as somebody standing in for
  // that member. What that raises tells a person, in plain language, to check a
  // safety number and think about removing a member who has changed nothing,
  // and it never clears, because the real member keeps presenting the real key.
  const gen = await freshCircle();
  const member = await generateIdentity();
  const pk = b64uEncode(member.pk);
  const epk = b64uEncode(member.epk);
  const pk2 = respell(pk);
  const epk2 = respell(epk);
  assert.notEqual(pk2, pk, "the second spelling is a different string");
  assert.deepEqual([...b64uDecode(pk2)], [...member.pk], "and the same signing key");
  assert.deepEqual([...b64uDecode(epk2)], [...member.epk], "and the same agreement key");

  await internals.addPinned({ alg: member.alg, pk, epk, name: "Ada" });
  assert.equal(state.pinned.size, 1, "the member is pinned");

  const roster = createRoster({
    channelId: gen.channelId,
    ratchet: gen.ratchet,
    selfId: state.identity.memberId,
    pinned: internals.pinnedStore,
    onKeyChange: internals.onKeyChange,
  });
  await roster.ingest([await feedPoint(gen, member, pk2, epk2)], gen.e0 * EPOCH_MS + 5000);
  // net.js does not await the callback, and the callback awaits two safety
  // numbers before it records anything. Reading the moment ingest returns is
  // reading before the alarm has had a chance to be raised, which is a test
  // that passes against every implementation there is.
  await settle();

  assert.equal(state.keyChanges.size, 0, "nothing was recorded against a member who changed nothing");
  assert.equal(
    internals.alertItems().some((i) => i.id.startsWith("key:")),
    false,
    "and nobody is told to go and check a safety number over an encoding",
  );
});

test("the roster keeps one spelling of a key, not whichever one the relay sent", async () => {
  // The pinning path net.js takes. Storing the relay's text is what made the
  // comparison above possible in the first place, and it is durable: it goes
  // to disk and comes back to be compared against tomorrow's spelling.
  const gen = await freshCircle();
  const member = await generateIdentity();
  const roster = createRoster({
    channelId: gen.channelId,
    ratchet: gen.ratchet,
    selfId: state.identity.memberId,
    pinned: internals.pinnedStore,
    onKeyChange: internals.onKeyChange,
  });

  await roster.ingest(
    [await feedPoint(gen, member, respell(b64uEncode(member.pk)), respell(b64uEncode(member.epk)))],
    gen.e0 * EPOCH_MS + 5000,
  );

  const rec = state.pinned.get(member.memberId);
  assert.ok(rec, "the member was pinned off the wire");
  assert.equal(rec.pk, b64uEncode(member.pk), "and stored in one encoding, not the relay's");
  assert.equal(rec.epk, b64uEncode(member.epk), "both keys");
});

test("a pinned roster read back off the disk comes back in one spelling", async () => {
  // An older build wrote whatever the relay spelled at the time. A record that
  // comes back spelled differently from the one the live circle serves is the
  // same false alarm, fired on the first launch after an update.
  const gen = await freshCircle();
  const member = await generateIdentity();
  const snap = gen.ratchet.snapshot();
  await dbSet("secret", snap.ck0);
  await dbSet("circleName", "Field team");
  await writeRecordAtRest(
    kvFace,
    null,
    GEN_SLOT,
    packGenMeta({ ...gen, ckEpoch: snap.e0, genRoster: [member.memberId] }),
  );
  await writeRecordAtRest(kvFace, null, PINNED_SLOT, [
    {
      memberId: member.memberId,
      alg: member.alg,
      pk: respell(b64uEncode(member.pk)),
      epk: respell(b64uEncode(member.epk)),
      verified: false,
      name: "Ada",
    },
  ]);

  coldStart();
  await internals.boot();
  await settle();

  const rec = state.pinned.get(member.memberId);
  assert.ok(rec, "the member came back off the disk");
  assert.equal(rec.pk, b64uEncode(member.pk), "in the one encoding, whatever was written there");
  assert.equal(rec.epk, b64uEncode(member.epk), "both keys");
});
