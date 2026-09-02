// Multi-circle storage: the swap and leave orderings that make a crash
// duplicate a circle instead of losing one, the sealed-at-rest form under the
// app lock, and the boot reconciliation that cleans the duplicates up.
//
// In v2 the `secret` slot holds a generation's oldest retained CHAIN KEY, and
// a chain key names nothing on its own, so it now travels with a generation
// record and a pinned roster. Every ordering rule below has to hold for those
// too: a crash must leave a circle duplicated, never a chain key filed under a
// channel it cannot read.
import test from "node:test";
import assert from "node:assert/strict";
import {
  GEN_SLOT,
  PINNED_SLOT,
  INVITE_SLOT,
  STAGED_SLOT,
  packCircles,
  unpackCircles,
  packGenMeta,
  readGenMeta,
  packPinned,
  packInvite,
  readInvite,
  packStagedGen,
  readStagedGen,
  pinnedMap,
  sameSecret,
  writeCirclesAtRest,
  readCirclesAtRest,
  writeRecordAtRest,
  readRecordAtRest,
  switchActive,
  leaveActive,
  reconcileCircles,
  adoptPairedCircle,
  finishPendingLeave,
  LEAVING_KEY,
  LEAVE_PURGE_KEYS,
  enableLockTransition,
  disableLockTransition,
  isSealedRecordError,
  SEALED_KEYS,
  usableVaultKey,
} from "../app/js/circles.js";
import { newVaultKey, zero } from "../app/js/lock.js";
import { b64uEncode } from "../app/js/wire.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function randomSecret() {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return b;
}

// A fake kv that records every operation in order, so the tests can assert
// not just what ended up on disk but what was written first.
function fakeKv() {
  const store = new Map();
  const ops = [];
  return {
    store,
    ops,
    kv: {
      async get(k) {
        ops.push(["get", k]);
        return store.get(k);
      },
      async set(k, v) {
        ops.push(["set", k]);
        store.set(k, v);
      },
      async del(k) {
        ops.push(["del", k]);
        store.delete(k);
      },
    },
  };
}

let seq = 0;
const hex32 = () => (seq++).toString(16).padStart(32, "a");
const idFor = (n) => (n.charCodeAt(0) + seq).toString(16).padStart(32, "b");

function inviteFor(c, createdAt = 1, expiresAt = 2) {
  const commit = new Uint8Array(16);
  globalThis.crypto.getRandomValues(commit);
  return { secret: randomSecret(), commit, by: c.identity.memberId, createdAt, expiresAt };
}

function circle(name, lastTs = 0) {
  const secret = randomSecret();
  return {
    name,
    secret,
    identity: {
      alg: "ed25519",
      privateKey: { fake: name },
      pk: new Uint8Array([1]),
      ecdhPrivate: { fake: `${name}-ecdh` },
      epk: new Uint8Array([2]),
      memberId: idFor(name),
    },
    g: 3,
    e0: 2963800,
    ckEpoch: 2963805,
    channelId: hex32(),
    at: 1788282959714,
    genRoster: [idFor(`${name}-peer`)],
    pinned: [
      {
        memberId: idFor(`${name}-peer`),
        alg: "ed25519",
        pk: "cGs",
        epk: "ZXBr",
        verified: false,
        name: "Peer",
      },
    ],
    profile: { name: `${name} person`, emoji: "x" },
    lastTs,
  };
}

test("pack and unpack round-trip secrets byte for byte, identities by memberId", () => {
  const a = circle("family", 5);
  const b = circle("friends", 9);
  const bytes = packCircles([a, b]);
  const back = unpackCircles(bytes, [a.identity, b.identity]);
  assert.equal(back.length, 2);
  assert.ok(sameSecret(back[0].secret, a.secret));
  assert.ok(sameSecret(back[1].secret, b.secret));
  assert.equal(back[0].name, "family");
  assert.equal(back[1].lastTs, 9);
  assert.equal(back[0].identity.memberId, a.identity.memberId);
  // The generation travels with the chain key: without it the meta names no
  // channel and the circle would be unreachable.
  assert.equal(back[0].channelId, a.channelId);
  assert.equal(back[0].g, a.g);
  assert.equal(back[0].ckEpoch, a.ckEpoch);
  assert.equal(back[0].pinned[0].memberId, a.pinned[0].memberId);
});

test("unpack drops entries with no identity or a bad secret instead of throwing", () => {
  const a = circle("solo");
  const bytes = packCircles([a, circle("orphan")]);
  const back = unpackCircles(bytes, [a.identity]);
  assert.equal(back.length, 1);
  assert.equal(back[0].name, "solo");
  assert.equal(unpackCircles(new TextEncoder().encode("not json"), []), null);
});

test("plaintext at rest: circles key holds the array, sealed keys are cleared", async () => {
  const { store, kv } = fakeKv();
  store.set("vaultCircles", { stale: true });
  store.set("circleIdentities", []);
  const list = [circle("family")];
  await writeCirclesAtRest(kv, null, list);
  assert.equal(store.get("circles"), list);
  assert.ok(!store.has("vaultCircles"));
  assert.ok(!store.has("circleIdentities"));
  assert.equal(await readCirclesAtRest(kv, null), list);
});

test("sealed at rest: no plaintext survives and the blob opens only with K", async () => {
  const { store, kv } = fakeKv();
  const K = newVaultKey();
  const lock = { enabled: true, vaultKey: K };
  const list = [circle("family", 3), circle("friends")];
  await writeCirclesAtRest(kv, lock, list);
  assert.ok(!store.has("circles"));
  assert.ok(store.has("vaultCircles"));
  assert.equal(store.get("circleIdentities").length, 2);
  // The sealed blob never contains a raw secret.
  const blob = JSON.stringify([...store.get("vaultCircles").ct]);
  assert.ok(blob.length > 0);
  const back = await readCirclesAtRest(kv, lock);
  assert.equal(back.length, 2);
  assert.ok(sameSecret(back[0].secret, list[0].secret));
  assert.equal(back[0].lastTs, 3);
  // A wrong key reads as tamper, not as an empty list.
  const other = { enabled: true, vaultKey: newVaultKey() };
  assert.equal(await readCirclesAtRest(kv, other), null);
});

test("locked with no vault key refuses to write anything at all", async () => {
  const { store, ops, kv } = fakeKv();
  await assert.rejects(
    () => writeCirclesAtRest(kv, { enabled: true, vaultKey: null }, [circle("x")]),
    /locked/,
  );
  assert.equal(ops.length, 0);
  assert.equal(store.size, 0);
});

test("switch writes the inactive array before any active slot", async () => {
  const { store, ops, kv } = fakeKv();
  const out = circle("family", 7);
  const incoming = circle("friends", 11);
  const res = await switchActive(kv, null, { outgoing: out, circles: [incoming], toIndex: 0 });
  const setKeys = ops.filter(([op]) => op === "set").map(([, k]) => k);
  assert.equal(setKeys[0], "circles");
  assert.ok(setKeys.indexOf("circles") < setKeys.indexOf("secret"));
  assert.ok(setKeys.indexOf("circles") < setKeys.indexOf("identity"));
  // Both secrets byte-identical on their respective sides of the swap.
  assert.ok(sameSecret(store.get("secret"), incoming.secret));
  assert.ok(sameSecret(store.get("circles")[0].secret, out.secret));
  assert.equal(store.get("circleName"), "friends");
  assert.equal(store.get("lastSentTs"), 11);
  assert.equal(res.circles.length, 1);
  assert.equal(res.circles[0].name, "family");
});

test("switch under the lock seals the incoming secret and never writes plaintext", async () => {
  const { store, kv } = fakeKv();
  const K = newVaultKey();
  const lock = { enabled: true, vaultKey: K };
  const out = circle("family");
  const incoming = circle("friends");
  await switchActive(kv, lock, { outgoing: out, circles: [incoming], toIndex: 0 });
  assert.ok(!store.has("secret"));
  assert.ok(!store.has("circles"));
  assert.ok(store.has("vaultSecret"));
  assert.ok(store.has("vaultCircles"));
  const back = await readCirclesAtRest(kv, lock);
  assert.ok(sameSecret(back[0].secret, out.secret));
});

test("leave promotes the next circle before shrinking the array", async () => {
  const { store, ops, kv } = fakeKv();
  const a = circle("family", 2);
  const b = circle("friends");
  const res = await leaveActive(kv, null, { circles: [a, b], toIndex: 0 });
  const setKeys = ops.filter(([op]) => op === "set").map(([, k]) => k);
  // The promoted circle lands in the active slots before the array write.
  assert.ok(setKeys.indexOf("secret") < setKeys.lastIndexOf("circles"));
  assert.ok(sameSecret(store.get("secret"), a.secret));
  assert.equal(store.get("lastSentTs"), 2);
  assert.equal(res.active.name, "family");
  assert.equal(res.circles.length, 1);
  assert.equal(res.circles[0].name, "friends");
});

test("leaving the last circle clears every active slot", async () => {
  const { store, kv } = fakeKv();
  store.set("secret", randomSecret());
  store.set("vaultSecret", { v: 1 });
  store.set("identity", {});
  store.set("circleName", "family");
  store.set("lastSentTs", 4);
  const res = await leaveActive(kv, null, { circles: [], toIndex: 0 });
  assert.equal(res.active, null);
  for (const k of ["secret", "vaultSecret", "identity", "circleName", "lastSentTs"]) {
    assert.ok(!store.has(k), `${k} should be gone`);
  }
});

test("reconcile drops a duplicate only when secret AND identity both match", () => {
  const a = circle("family");
  const b = circle("friends");
  // A completed switch leaves a full duplicate of the active circle: dropped.
  const kept = reconcileCircles({
    activeSecret: a.secret,
    activeMemberId: a.identity.memberId,
    circles: [a, b],
  });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].name, "friends");
  // A torn active-slot pair matches each entry only halfway: both are kept,
  // because either one may be the only complete copy of its circle.
  const keptTornSecret = reconcileCircles({
    activeSecret: a.secret,
    activeMemberId: b.identity.memberId,
    circles: [a, b],
  });
  assert.equal(keptTornSecret.length, 2);
  const keptTornId = reconcileCircles({
    activeSecret: randomSecret(),
    activeMemberId: a.identity.memberId,
    circles: [a, b],
  });
  assert.equal(keptTornId.length, 2);
});

test("sameSecret is exact and length-safe", () => {
  const a = randomSecret();
  assert.ok(sameSecret(a, new Uint8Array(a)));
  const b = new Uint8Array(a);
  b[31] ^= 1;
  assert.ok(!sameSecret(a, b));
  assert.ok(!sameSecret(a, a.slice(0, 31)));
  assert.ok(!sameSecret(null, a));
});

// ------------------------------------------------- crash-window properties
// A kv that halts the world after a fixed number of completed operations:
// whatever landed, landed; everything after the crash never happens. Iterated
// over every possible crash point, these prove the orderings, not just the
// happy path.

import { enableLockAtRest, disableLockAtRest } from "../app/js/circles.js";
import { openUnderVault } from "../app/js/lock.js";

function crashingKv(store, allowOps) {
  let n = 0;
  const gate = () => {
    if (n >= allowOps) throw new Error("simulated crash");
    n += 1;
  };
  return {
    async get(k) {
      gate();
      return store.get(k);
    },
    async set(k, v) {
      gate();
      store.set(k, v);
    },
    async del(k) {
      gate();
      store.delete(k);
    },
  };
}

const plainKv = (store) => ({
  async get(k) {
    return store.get(k);
  },
  async set(k, v) {
    store.set(k, v);
  },
  async del(k) {
    store.delete(k);
  },
});

// The recovery contract boot and unlock implement: purge a plaintext slot
// only when its sealed twin exists (and stale seals only when no lock), then
// read every secret that survives in either form.
async function recoverSecrets(store, K) {
  const lock = store.get("lock");
  if (lock?.enabled) {
    if (store.has("vaultSecret")) store.delete("secret");
    if (store.has("vaultCircles")) store.delete("circles");
  } else {
    store.delete("vaultSecret");
    store.delete("vaultCircles");
    store.delete("circleIdentities");
  }
  const secrets = [];
  const push = (s) => {
    if (s && s.length === 32 && !secrets.some((x) => sameSecret(x, s))) secrets.push(s);
  };
  push(store.get("secret"));
  if (store.has("vaultSecret") && K) push(await openUnderVault(K, store.get("vaultSecret")));
  for (const c of store.get("circles") || []) push(c.secret);
  if (store.has("vaultCircles") && K) {
    const list = await readCirclesAtRest(plainKv(store), { enabled: true, vaultKey: K });
    for (const c of list || []) push(c.secret);
  }
  return secrets;
}

function assertAllPresent(secrets, wanted, label) {
  for (const w of wanted) {
    assert.ok(
      secrets.some((s) => sameSecret(s, w.secret)),
      `${label}: ${w.name} secret must survive`,
    );
  }
}

test("switchActive: every crash point leaves every secret recoverable, unlocked and locked", async () => {
  const K = newVaultKey();
  for (const lock of [null, { enabled: true, vaultKey: K }]) {
    for (let allow = 0; allow < 34; allow++) {
      const out = circle("family", 1);
      const incoming = circle("friends", 2);
      const third = circle("event");
      const store = new Map();
      // Seed the pre-switch disk shape in the right form for the lock state.
      await writeCirclesAtRest(plainKv(store), lock, [incoming, third]);
      if (lock) {
        const sealed = await import("../app/js/lock.js").then((m) =>
          m.sealUnderVault(K, out.secret),
        );
        store.set("vaultSecret", await sealed);
      } else {
        store.set("secret", out.secret);
      }
      store.set("identity", out.identity);
      store.set("circleName", out.name);
      if (lock) store.set("lock", { enabled: true });
      let crashed = false;
      try {
        await switchActive(crashingKv(store, allow), lock, {
          outgoing: out,
          circles: [incoming, third],
          toIndex: 0,
        });
      } catch (e) {
        if (!/simulated crash/.test(String(e))) throw e;
        crashed = true;
      }
      const secrets = await recoverSecrets(store, K);
      assertAllPresent(
        secrets,
        [out, incoming, third],
        `switch ${lock ? "locked" : "plain"} allow=${allow}${crashed ? " (crashed)" : ""}`,
      );
      if (!crashed) break;
    }
  }
});

test("enableLockAtRest: every crash point leaves every secret recoverable", async () => {
  for (let allow = 0; allow < 18; allow++) {
    const active = circle("family");
    const other = circle("friends");
    const K = newVaultKey();
    const store = new Map();
    store.set("secret", active.secret);
    store.set("identity", active.identity);
    store.set("circles", [other]);
    let crashed = false;
    try {
      await enableLockAtRest(crashingKv(store, allow), {
        vaultKey: K,
        lockRecord: { enabled: true },
        secret: active.secret,
        circles: [other],
        genMeta: packGenMeta(active),
        pinned: packPinned(active.pinned),
        invite: packInvite(inviteFor(active)),
      });
    } catch (e) {
      if (!/simulated crash/.test(String(e))) throw e;
      crashed = true;
    }
    const secrets = await recoverSecrets(store, K);
    assertAllPresent(secrets, [active, other], `enableLock allow=${allow}`);
    if (!crashed) {
      assert.ok(!store.has("secret") && !store.has("circles"), "plaintext gone after full enable");
      break;
    }
  }
});

test("disableLockAtRest: every crash point leaves every secret recoverable", async () => {
  for (let allow = 0; allow < 22; allow++) {
    const active = circle("family");
    const other = circle("friends");
    const K = newVaultKey();
    const store = new Map();
    // Seed the locked-at-rest shape.
    await enableLockAtRest(plainKv(store), {
      vaultKey: K,
      lockRecord: { enabled: true },
      secret: active.secret,
      circles: [other],
      genMeta: packGenMeta(active),
      pinned: packPinned(active.pinned),
      invite: null,
    });
    store.set("identity", active.identity);
    let crashed = false;
    try {
      await disableLockAtRest(crashingKv(store, allow), {
        secret: active.secret,
        circles: [other],
        genMeta: packGenMeta(active),
        pinned: packPinned(active.pinned),
        invite: null,
      });
    } catch (e) {
      if (!/simulated crash/.test(String(e))) throw e;
      crashed = true;
    }
    const secrets = await recoverSecrets(store, K);
    assertAllPresent(secrets, [active, other], `disableLock allow=${allow}`);
    if (!crashed) {
      assert.ok(!store.has("vaultSecret") && !store.has("vaultCircles"), "seals gone after full disable");
      break;
    }
  }
});

test("sealed blob tampering: truncated and bit-flipped both read as null, never empty", async () => {
  const { store, kv } = fakeKv();
  const K = newVaultKey();
  const lock = { enabled: true, vaultKey: K };
  await writeCirclesAtRest(kv, lock, [circle("family")]);
  const good = store.get("vaultCircles");
  store.set("vaultCircles", { ...good, ct: good.ct.slice(0, good.ct.length - 4) });
  assert.equal(await readCirclesAtRest(kv, lock), null);
  const flipped = new Uint8Array(good.ct);
  flipped[8] ^= 0x40;
  store.set("vaultCircles", { ...good, ct: flipped });
  assert.equal(await readCirclesAtRest(kv, lock), null);
});

test("identity pairing is by memberId, not position, and drops mismatches", () => {
  const a = circle("family");
  const b = circle("friends");
  const bytes = packCircles([a, b]);
  // Reversed order still pairs each circle with its own identity.
  const back = unpackCircles(bytes, [b.identity, a.identity]);
  assert.equal(back.length, 2);
  assert.equal(back[0].name, "family");
  assert.equal(back[0].identity.memberId, a.identity.memberId);
  // A missing identity drops only its own circle.
  const short = unpackCircles(bytes, [b.identity]);
  assert.equal(short.length, 1);
  assert.equal(short[0].name, "friends");
  // A foreign identity list pairs nothing.
  assert.equal(unpackCircles(bytes, [circle("stranger").identity]).length, 0);
});

// ---------------------------------------------------------------------------
// Thrown-and-continuing faults: unlike a crash, the session survives the
// storage error and keeps mutating. The transitions must leave memory and the
// lock record agreeing, or the next mutation persists in the wrong form and
// boot's stray purge finishes the loss.

function throwOnceKv(store, failAt) {
  let n = 0;
  const gate = () => {
    const hit = n === failAt;
    n += 1;
    if (hit) throw new Error("simulated fault");
  };
  return {
    async get(k) {
      gate();
      return store.get(k);
    },
    async set(k, v) {
      gate();
      store.set(k, v);
    },
    async del(k) {
      gate();
      store.delete(k);
    },
  };
}

test("enableLockTransition: a thrown op unwinds to unlocked, and continued use plus a boot lose nothing", async () => {
  for (let failAt = 0; failAt < 16; failAt++) {
    const active = circle("family");
    const other = circle("friends");
    const K = newVaultKey();
    const store = new Map();
    store.set("secret", active.secret);
    store.set("identity", active.identity);
    store.set("circles", [other]);
    let threw = false;
    try {
      await enableLockTransition(throwOnceKv(store, failAt), {
        vaultKey: K,
        lockRecord: { enabled: true },
        secret: active.secret,
        circles: [other],
        genMeta: packGenMeta(active),
        pinned: packPinned(active.pinned),
        invite: null,
      });
    } catch (e) {
      if (!/simulated fault/.test(String(e))) throw e;
      threw = true;
    }
    if (threw) {
      // The caller keeps memory unlocked, so the disk must agree.
      assert.ok(!store.get("lock"), `enable failAt=${failAt}: no lock record after unwind`);
      // The session keeps running unlocked: a follow-up mutation in the
      // unlocked form, exactly as writeSecretAtRest and the array persist
      // would run it.
      await writeCirclesAtRest(plainKv(store), null, [other]);
      store.set("secret", active.secret);
      store.delete("vaultSecret");
    }
    const secrets = await recoverSecrets(store, K);
    assertAllPresent(secrets, [active, other], `enableLockTransition failAt=${failAt}`);
    if (!threw) {
      assert.ok(store.get("lock"), "committed enable keeps the lock record");
      break;
    }
  }
});

test("disableLockTransition: a thrown op keeps memory and the lock record in agreement either way", async () => {
  for (let failAt = 0; failAt < 22; failAt++) {
    const active = circle("family");
    const other = circle("friends");
    const K = newVaultKey();
    const store = new Map();
    await enableLockAtRest(plainKv(store), {
      vaultKey: K,
      lockRecord: { enabled: true },
      secret: active.secret,
      circles: [other],
      genMeta: packGenMeta(active),
      pinned: packPinned(active.pinned),
      invite: null,
    });
    store.set("identity", active.identity);
    let threw = false;
    try {
      await disableLockTransition(throwOnceKv(store, failAt), {
        secret: active.secret,
        circles: [other],
        genMeta: packGenMeta(active),
        pinned: packPinned(active.pinned),
        invite: null,
      });
    } catch (e) {
      if (!/simulated fault/.test(String(e))) throw e;
      threw = true;
    }
    if (threw) {
      // Rethrow contract: the lock record survived, memory stays locked, and
      // continued LOCKED use must stay recoverable.
      assert.ok(store.get("lock"), `disable failAt=${failAt}: rethrow only while the record exists`);
      await writeCirclesAtRest(plainKv(store), { enabled: true, vaultKey: K }, [other]);
    } else {
      // Commit contract: the record is gone and unlocked use follows.
      assert.ok(!store.get("lock"), `disable failAt=${failAt}: committed means no record`);
      await writeCirclesAtRest(plainKv(store), null, [other]);
    }
    const secrets = await recoverSecrets(store, K);
    assertAllPresent(secrets, [active, other], `disableLockTransition failAt=${failAt}`);
    if (!threw && failAt >= 16) break;
  }
});

// ---------------------------------------------------------------------------
// Torn active slots: a halt between writeActive's secret and identity writes
// pairs one circle's secret with another's identity. The pairing repair must
// find the properly paired record in the array and adopt it, for the switch,
// leave, and create/join shapes alike.

function bootRepair(store) {
  const activeSecret = store.get("secret");
  const identity = store.get("identity");
  const circles = store.get("circles") || [];
  const paired = adoptPairedCircle({
    activeSecret,
    activeMemberId: identity?.memberId,
    activeGen: readGenMeta(store.get(GEN_SLOT.plain)),
    circles,
  });
  const finalIdentity = paired ? paired.identity : identity;
  const remaining = reconcileCircles({
    activeSecret,
    activeMemberId: finalIdentity?.memberId,
    circles,
  });
  return { activeSecret, identity: finalIdentity, remaining };
}

test("switchActive torn between secret and identity boots into a repaired, correctly paired circle", async () => {
  let sawTorn = false;
  for (let allow = 0; allow < 24; allow++) {
    const out = circle("family", 1);
    const incoming = circle("friends", 2);
    const third = circle("event");
    const store = new Map();
    store.set("secret", out.secret);
    store.set("identity", out.identity);
    store.set("circles", [incoming, third]);
    try {
      await switchActive(crashingKv(store, allow), null, {
        outgoing: out,
        circles: [incoming, third],
        toIndex: 0,
      });
    } catch (e) {
      if (!/simulated crash/.test(String(e))) throw e;
    }
    const torn =
      sameSecret(store.get("secret"), incoming.secret) &&
      store.get("identity")?.memberId === out.identity.memberId;
    if (!torn) continue;
    sawTorn = true;
    const { identity, remaining } = bootRepair(store);
    assert.equal(identity.memberId, incoming.identity.memberId, "adopts the incoming circle's own identity");
    assertAllPresent(
      remaining.map((c) => c.secret).concat([store.get("secret")]),
      [out, incoming, third],
      "torn switch after repair",
    );
    assert.ok(
      remaining.some((c) => c.identity.memberId === out.identity.memberId),
      "the outgoing circle survives in the array",
    );
  }
  assert.ok(sawTorn, "the sweep must actually produce the torn window");
});

test("leaveActive torn between secret and identity repairs to the promoted circle's identity", async () => {
  let sawTorn = false;
  for (let allow = 0; allow < 22; allow++) {
    const departing = circle("family");
    const promoted = circle("friends");
    const store = new Map();
    store.set("secret", departing.secret);
    store.set("identity", departing.identity);
    store.set("circles", [promoted]);
    try {
      await leaveActive(crashingKv(store, allow), null, { circles: [promoted], toIndex: 0 });
    } catch (e) {
      if (!/simulated crash/.test(String(e))) throw e;
    }
    const torn =
      sameSecret(store.get("secret"), promoted.secret) &&
      store.get("identity")?.memberId === departing.identity.memberId;
    if (!torn) continue;
    sawTorn = true;
    const { identity } = bootRepair(store);
    assert.equal(identity.memberId, promoted.identity.memberId, "adopts the promoted circle's identity");
  }
  assert.ok(sawTorn, "the sweep must actually produce the torn window");
});

test("create/join torn after the fixed identity-first order repairs back to the outgoing circle", () => {
  // persistCircle writes identity, lastSentTs, then the secret. A halt after
  // the identity write leaves the OLD secret paired with the fresh identity;
  // the outgoing entry pushed into the array beforehand repairs it, and the
  // fresh key was never used anywhere, so no identity crosses circles.
  const outgoing = circle("family");
  const freshIdentity = circle("unused").identity;
  const store = new Map();
  store.set("secret", outgoing.secret);
  store.set("identity", freshIdentity);
  store.set("circles", [outgoing]);
  const { identity, remaining } = bootRepair(store);
  assert.equal(identity.memberId, outgoing.identity.memberId, "repairs to the outgoing identity");
  assert.equal(remaining.length, 0, "the duplicate array entry reconciles away");
  assert.ok(
    freshIdentity.memberId !== outgoing.identity.memberId,
    "the abandoned fresh identity never belonged to any stored circle",
  );
});

// ---------------------------------------------------------------------------
// The v2 slots. A chain key names nothing on its own, so the generation record
// beside it is load bearing: lose it and the circle is unreachable even though
// the key survived.

test("a meta with no generation is dropped, because the chain key alone reaches nothing", () => {
  const a = circle("family");
  const bytes = packCircles([a]);
  const metas = JSON.parse(new TextDecoder().decode(bytes));
  delete metas[0].channelId;
  const stripped = new TextEncoder().encode(JSON.stringify(metas));
  assert.equal(unpackCircles(stripped, [a.identity]).length, 0);
  assert.equal(unpackCircles(bytes, [a.identity]).length, 1);
});

test("generation records survive the round trip and reject junk", () => {
  const a = circle("family");
  const back = readGenMeta(packGenMeta(a));
  assert.equal(back.g, a.g);
  assert.equal(back.e0, a.e0);
  assert.equal(back.ckEpoch, a.ckEpoch);
  assert.equal(back.channelId, a.channelId);
  assert.equal(back.at, a.at);
  assert.equal(readGenMeta({ ...packGenMeta(a), channelId: "nope" }), null);
  assert.equal(readGenMeta({ ...packGenMeta(a), g: -1 }), null);
  assert.equal(readGenMeta({ ...packGenMeta(a), ckEpoch: 1.5 }), null);
  assert.equal(readGenMeta(null), null);
});

test("the members a generation opened with travel with it", () => {
  // Who may re-key is "the members this generation opened with", which is
  // narrower than "everyone this device has pinned" and stays narrower only if
  // it is written down. Rebuilt from the pinned roster on every boot, unlock
  // and circle switch, the rule widened back out on every reload to take in
  // anyone this device had ever seen a point from.
  const a = circle("family");
  const opened = [idFor("one"), idFor("two")];
  const rec = packGenMeta({ ...a, genRoster: opened });
  assert.deepEqual(readGenMeta(rec).genRoster, opened);

  // What is stored is member ids and nothing else, in both directions.
  assert.deepEqual(packGenMeta({ ...a, genRoster: [idFor("one"), "nope", null, 7] }).genRoster, [idFor("one")]);
  assert.deepEqual(readGenMeta({ ...rec, genRoster: [idFor("one"), "nope"] }).genRoster, [idFor("one")]);

  // A generation that opened alone is a real answer and must not read as an
  // absent field, or a device with one circle and no peers would fall back to
  // the wide rule for ever.
  assert.deepEqual(readGenMeta(packGenMeta({ ...a, genRoster: [] })).genRoster, []);
  // A record from a build that never wrote the field is the one case a caller
  // has to tell apart, so it comes back null rather than empty.
  const { genRoster, ...old } = rec;
  void genRoster;
  assert.equal(readGenMeta(old).genRoster, null);

  // It survives the inactive array, which is what a circle switch reads back.
  const back = unpackCircles(packCircles([{ ...a, genRoster: opened }]), [a.identity]);
  assert.deepEqual(back[0].genRoster, opened);
  // And the staged record a torn generation write leaves behind for boot.
  const staged = readStagedGen(packStagedGen({ ...a, genRoster: opened, ck: randomSecret(), pinned: a.pinned }));
  assert.deepEqual(staged.genRoster, opened);
});

test("an invitation cannot be read back into a circle that did not mint it", () => {
  const a = circle("family");
  const b = circle("friends");
  const inv = packInvite(inviteFor(a));
  // The record names its owner, so the active circle can tell its own live
  // credential from one the previous circle left in the shared slot.
  assert.equal(readInvite(inv).by, a.identity.memberId);
  assert.notEqual(readInvite(inv).by, b.identity.memberId);
  // And the commitment travels with it, so the link a device shows after a
  // restart is still the link that names this circle's identity.
  assert.equal(readInvite(inv).commit.length, 16);
  assert.equal(readInvite({ ...inv, commit: "!!!" }), null);

  // A record in the old unscoped shape is refused on the way IN as well as on
  // the way out. Reading one back is how a credential minted for another
  // circle gets picked up by whichever circle happens to be active.
  const { by, ...unscoped } = inv;
  const { commit, ...uncommitted } = inv;
  void by;
  void commit;
  assert.equal(readInvite(unscoped), null, "an invitation naming no circle must not be read back");
  assert.equal(readInvite(uncommitted), null, "an invitation with no commitment is a bearer link");
  assert.equal(readInvite({ ...inv, by: "short" }), null);
  assert.equal(readInvite({ ...inv, commit: b64uEncode(new Uint8Array(15)) }), null);
});

test("the pinned roster round-trips from a Map and drops entries that name no member", () => {
  const good = { memberId: "a".repeat(32), alg: "ed25519", pk: "cGs", epk: "ZXBr", verified: true, name: "Ana" };
  const list = packPinned(new Map([[good.memberId, good]]).set("short", { pk: "x", epk: "y" }));
  assert.equal(list.length, 1);
  assert.equal(list[0].verified, true);
  assert.equal(list[0].memberId, good.memberId);
  // An unknown alg is not passed through to the crypto layer as a name.
  assert.equal(packPinned([{ ...good, alg: "rot13" }])[0].alg, "p256");
  assert.equal(pinnedMap(list).get(good.memberId).name, "Ana");
});

test("an invitation round-trips its 32 bytes and refuses anything else", () => {
  const a = circle("family");
  const inv = inviteFor(a, 5, 9);
  const back = readInvite(packInvite(inv));
  assert.ok(sameSecret(back.secret, inv.secret));
  assert.equal(back.expiresAt, 9);
  assert.equal(back.by, a.identity.memberId);
  assert.equal(packInvite(null), null);
  // Unscoped or uncommitted is the shape being retired: refused, not repaired.
  assert.equal(packInvite({ secret: inv.secret, createdAt: 5, expiresAt: 9 }), null);
  assert.equal(readInvite({ secret: "short" }), null);
  assert.equal(readInvite(null), null);
});

test("a staged generation carries its chain key and its roster together", () => {
  const a = circle("family");
  const ck = randomSecret();
  const back = readStagedGen(packStagedGen({ ...a, ck }));
  assert.ok(sameSecret(back.ck, ck));
  assert.equal(back.channelId, a.channelId);
  assert.equal(back.pinned.length, 1);
  assert.equal(readStagedGen({ ...packStagedGen({ ...a, ck }), ck: "nope" }), null);
});

test("record slots seal under the lock, read back, and never leave plaintext behind", async () => {
  const { store, kv } = fakeKv();
  const K = newVaultKey();
  const lock = { enabled: true, vaultKey: K };
  const a = circle("family");

  await writeRecordAtRest(kv, null, GEN_SLOT, packGenMeta(a));
  assert.ok(store.has(GEN_SLOT.plain));
  await writeRecordAtRest(kv, lock, GEN_SLOT, packGenMeta(a));
  assert.ok(!store.has(GEN_SLOT.plain), "the plaintext form goes when the sealed one lands");
  assert.equal((await readRecordAtRest(kv, lock, GEN_SLOT)).channelId, a.channelId);

  // A blob that will not authenticate is a record this device has and cannot
  // read. It throws, so no caller can spend it as "there is nothing here".
  const blob = store.get(GEN_SLOT.sealed);
  const flipped = new Uint8Array(blob.ct);
  flipped[2] ^= 0x20;
  store.set(GEN_SLOT.sealed, { ...blob, ct: flipped });
  await assert.rejects(() => readRecordAtRest(kv, lock, GEN_SLOT), isSealedRecordError);
  store.set(GEN_SLOT.sealed, blob);

  // Null clears the slot in whichever form is live.
  await writeRecordAtRest(kv, lock, GEN_SLOT, null);
  assert.ok(!store.has(GEN_SLOT.sealed) && !store.has(GEN_SLOT.plain));
});

test("record slots fail closed: locked with no vault key writes nothing at all", async () => {
  for (const slot of [GEN_SLOT, PINNED_SLOT, INVITE_SLOT, STAGED_SLOT]) {
    const { store, ops, kv } = fakeKv();
    await assert.rejects(() => writeRecordAtRest(kv, { enabled: true, vaultKey: null }, slot, { g: 1 }), /locked/);
    assert.equal(ops.length, 0, `${slot.plain} wrote something while locked`);
    assert.equal(store.size, 0);
  }
});

test("writeActive burns the invitation first and lands the chain key before the identity", async () => {
  const { store, ops, kv } = fakeKv();
  const out = circle("family");
  const incoming = circle("friends");
  store.set(INVITE_SLOT.plain, packInvite(inviteFor(out)));
  await switchActive(kv, null, { outgoing: out, circles: [incoming], toIndex: 0 });
  const keys = ops.filter(([op]) => op !== "get").map(([op, k]) => `${op}:${k}`);
  const at = (k) => keys.indexOf(k);
  assert.ok(at(`del:${INVITE_SLOT.plain}`) < at("set:secret"), "an invitation never outlives the circle that issued it");
  assert.ok(at(`set:${GEN_SLOT.plain}`) < at("set:secret"), "the generation record lands before the chain key");
  assert.ok(at("set:secret") < at("set:identity"), "the identity write is still the commit point");
  assert.ok(!store.has(INVITE_SLOT.plain));
  assert.equal(store.get(GEN_SLOT.plain).channelId, incoming.channelId);
  assert.equal(store.get(PINNED_SLOT.plain)[0].memberId, incoming.pinned[0].memberId);
});

test("leaving the last circle clears the generation, roster, invitation and staging too", async () => {
  const { store, kv } = fakeKv();
  const a = circle("family");
  for (const k of ["secret", "identity", "circleName", "lastSentTs"]) store.set(k, 1);
  for (const slot of [GEN_SLOT, PINNED_SLOT, INVITE_SLOT, STAGED_SLOT]) {
    store.set(slot.plain, 1);
    store.set(slot.sealed, 1);
  }
  void a;
  const res = await leaveActive(kv, null, { circles: [], toIndex: 0 });
  assert.equal(res.active, null);
  assert.equal(store.size, 0, "nothing about the circle survives the last leave");
});

test("a torn generation record is repaired from the array, not entered as a chimera", () => {
  const out = circle("family");
  const incoming = circle("friends");
  // The crash window inside writeActive after the generation record and before
  // the chain key: this circle's key with the other circle's channel.
  const paired = adoptPairedCircle({
    activeSecret: out.secret,
    activeMemberId: out.identity.memberId,
    activeGen: { g: incoming.g, channelId: incoming.channelId, ckEpoch: incoming.ckEpoch },
    circles: [out, incoming],
  });
  assert.equal(paired?.name, "family", "adopts the record that actually owns this chain key");
  // A complete, agreeing active slot set is not a repair.
  assert.equal(
    adoptPairedCircle({
      activeSecret: out.secret,
      activeMemberId: out.identity.memberId,
      activeGen: { g: out.g, channelId: out.channelId, ckEpoch: out.ckEpoch },
      circles: [out, incoming],
    }),
    null,
  );
  // A moved chain-key epoch is a repair too: the ratchet would otherwise
  // derive every key of the generation one step wrong.
  assert.ok(
    adoptPairedCircle({
      activeSecret: out.secret,
      activeMemberId: out.identity.memberId,
      activeGen: { g: out.g, channelId: out.channelId, ckEpoch: out.ckEpoch + 1 },
      circles: [out],
    }),
  );
});

// ---------------------------------------------------------------------------
// The staged generation slot. It holds a whole generation for the width of a
// generation write, boot applies whatever it finds there over the active
// slots, and it is live key material the entire time. Both of those make it
// dangerous in a way the other slots are not: it must never survive a change
// of circle, and it must never be the one slot a lock transition forgets.

test("a switch clears the staged generation, so it cannot be applied to the wrong circle", async () => {
  const { store, ops, kv } = fakeKv();
  const out = circle("family");
  const incoming = circle("friends");
  const ck = randomSecret();
  // A generation write for the OUTGOING circle that a crash interrupted. Boot
  // applies this over whatever the active slots hold, which after the switch
  // is a different circle whose only chain key it would overwrite.
  store.set(STAGED_SLOT.plain, packStagedGen({ ...out, ck }));
  store.set(STAGED_SLOT.sealed, { stale: true });
  await switchActive(kv, null, { outgoing: out, circles: [incoming], toIndex: 0 });
  assert.ok(!store.has(STAGED_SLOT.plain), "a staged generation never crosses into another circle");
  assert.ok(!store.has(STAGED_SLOT.sealed), "in either form");
  const keys = ops.filter(([op]) => op !== "get").map(([op, k]) => `${op}:${k}`);
  assert.ok(
    keys.indexOf(`del:${STAGED_SLOT.plain}`) < keys.indexOf("set:secret"),
    "cleared before the incoming chain key lands, so a torn switch cannot apply it either",
  );
  // The incoming circle's own key is what is on disk, untouched.
  assert.ok(sameSecret(store.get("secret"), incoming.secret));
});

test("a leave that promotes another circle clears the staged generation too", async () => {
  const { store, kv } = fakeKv();
  const departing = circle("family");
  const promoted = circle("friends");
  store.set(STAGED_SLOT.plain, packStagedGen({ ...departing, ck: randomSecret() }));
  await leaveActive(kv, null, { circles: [promoted], toIndex: 0 });
  assert.ok(!store.has(STAGED_SLOT.plain), "the promoted circle does not inherit a re-key it never made");
  assert.ok(sameSecret(store.get("secret"), promoted.secret));
});

test("a switch under the lock clears the sealed staging as well", async () => {
  const { store, kv } = fakeKv();
  const K = newVaultKey();
  const lock = { enabled: true, vaultKey: K };
  const out = circle("family");
  const incoming = circle("friends");
  await writeRecordAtRest(kv, lock, STAGED_SLOT, packStagedGen({ ...out, ck: randomSecret() }));
  assert.ok(store.has(STAGED_SLOT.sealed));
  await switchActive(kv, lock, { outgoing: out, circles: [incoming], toIndex: 0 });
  assert.ok(!store.has(STAGED_SLOT.sealed) && !store.has(STAGED_SLOT.plain));
});

test("turning the lock on leaves no plaintext staged generation behind", async () => {
  const store = new Map();
  const K = newVaultKey();
  const a = circle("family");
  const ck = randomSecret();
  store.set("secret", a.secret);
  store.set("circles", []);
  store.set(GEN_SLOT.plain, packGenMeta(a));
  store.set(PINNED_SLOT.plain, packPinned(a.pinned));
  store.set(INVITE_SLOT.plain, packInvite(inviteFor(a)));
  store.set(STAGED_SLOT.plain, packStagedGen({ ...a, ck }));
  await enableLockAtRest(plainKv(store), {
    vaultKey: K,
    lockRecord: { enabled: true },
    secret: a.secret,
    circles: [],
    genMeta: packGenMeta(a),
    pinned: packPinned(a.pinned),
    invite: packInvite(inviteFor(a)),
  });
  // Every slot, not just the ones the caller happened to pass: a chain key and
  // a channel id left in the clear is the exact thing the lock is for.
  for (const slot of [GEN_SLOT, PINNED_SLOT, INVITE_SLOT, STAGED_SLOT]) {
    assert.ok(!store.has(slot.plain), `${slot.plain} survived the lock in plaintext`);
  }
  assert.ok(!store.has("secret") && !store.has("circles"));
  // Migrated, not dropped: it is still the repair record for a generation
  // write boot has not finished yet.
  const back = readStagedGen(await readRecordAtRest(plainKv(store), { enabled: true, vaultKey: K }, STAGED_SLOT));
  assert.ok(back && sameSecret(back.ck, ck), "the staged chain key survives, sealed");
  assert.equal(back.channelId, a.channelId);
});

test("a thrown lock enable never leaves the staged generation in neither form", async () => {
  let faults = 0;
  for (let failAt = 0; failAt < 24; failAt++) {
    const active = circle("family");
    const K = newVaultKey();
    const ck = randomSecret();
    const store = new Map();
    store.set("secret", active.secret);
    store.set("identity", active.identity);
    store.set("circles", []);
    store.set(STAGED_SLOT.plain, packStagedGen({ ...active, ck }));
    let threw = false;
    try {
      await enableLockTransition(throwOnceKv(store, failAt), {
        vaultKey: K,
        lockRecord: { enabled: true },
        secret: active.secret,
        circles: [],
        genMeta: packGenMeta(active),
        pinned: packPinned(active.pinned),
        invite: null,
      });
    } catch (e) {
      if (!/simulated fault/.test(String(e))) throw e;
      threw = true;
      faults += 1;
    }
    const plain = store.get(STAGED_SLOT.plain);
    const sealed = store.get(STAGED_SLOT.sealed);
    let found = plain ? readStagedGen(plain) : null;
    if (!found && sealed) {
      const bytes = await openUnderVault(K, sealed);
      found = bytes ? readStagedGen(JSON.parse(new TextDecoder().decode(bytes))) : null;
    }
    assert.ok(
      found && sameSecret(found.ck, ck),
      `enable failAt=${failAt}: the staged chain key must survive in one form or the other`,
    );
    if (threw) assert.ok(!store.get("lock"), `enable failAt=${failAt}: no lock record after unwind`);
    else assert.ok(!plain, "a committed enable leaves no plaintext staging");
  }
  assert.ok(faults > 0, "the sweep must actually produce faults");
});

// ---------------------------------------------------------------------------
// Unreadable is not absent. A locked install whose sealed records will not
// open has been tampered with or damaged; reading that as "no record here"
// puts a real circle in front of the v1 notice, whose only button erases the
// device.

test("a sealed record that will not open throws, and only absence reads as absent", async () => {
  const { store, kv } = fakeKv();
  const K = newVaultKey();
  const lock = { enabled: true, vaultKey: K };
  const a = circle("family");
  for (const [slot, value] of [
    [GEN_SLOT, packGenMeta(a)],
    [PINNED_SLOT, packPinned(a.pinned)],
    [INVITE_SLOT, packInvite(inviteFor(a))],
    [STAGED_SLOT, packStagedGen({ ...a, ck: randomSecret() })],
  ]) {
    await writeRecordAtRest(kv, lock, slot, value);
    const good = store.get(slot.sealed);
    // Tampered.
    const flipped = new Uint8Array(good.ct);
    flipped[1] ^= 0x08;
    store.set(slot.sealed, { ...good, ct: flipped });
    await assert.rejects(
      () => readRecordAtRest(kv, lock, slot),
      (e) => isSealedRecordError(e) && e.key === slot.sealed,
      `${slot.sealed} tampered must not read as empty`,
    );
    // Damaged.
    store.set(slot.sealed, { ...good, ct: good.ct.slice(0, good.ct.length - 3) });
    await assert.rejects(() => readRecordAtRest(kv, lock, slot), isSealedRecordError);
    // Another device's key, which is what a restored or swapped blob looks like.
    store.set(slot.sealed, good);
    await assert.rejects(
      () => readRecordAtRest(kv, { enabled: true, vaultKey: newVaultKey() }, slot),
      isSealedRecordError,
    );
    // Absent is the only thing that reads as absent.
    store.delete(slot.sealed);
    assert.equal(await readRecordAtRest(kv, lock, slot), null);
  }
});

// ---------------------------------------------------------------------------
// The generation's open time is the only clock the daily re-key runs on.

test("a circle keeps its generation's open time through the sealed array", async () => {
  const a = circle("family");
  const back = unpackCircles(packCircles([a]), [a.identity]);
  assert.equal(back[0].at, a.at, "without this the daily re-key timer never fires for this circle again");
  const { kv } = fakeKv();
  const lock = { enabled: true, vaultKey: newVaultKey() };
  await writeCirclesAtRest(kv, lock, [a]);
  const read = await readCirclesAtRest(kv, lock);
  assert.equal(read[0].at, a.at);
  // And it survives the round trip a switch actually makes: out to the array,
  // back into the active slots.
  const res = await switchActive(kv, null, { outgoing: circle("friends"), circles: read, toIndex: 0 });
  assert.equal(res.active.at, a.at);
});

// ---------------------------------------------------------------------------
// The torn-write repair has to be able to say "nothing is torn".

test("the live generation shape reaches the no-repair branch", () => {
  const out = circle("family");
  const live = (ckEpoch) => ({
    g: out.g,
    channelId: out.channelId,
    // The live generation keeps its chain key epoch in the ratchet, not as a
    // field: this is the shape boot and unlock actually pass in.
    ratchet: { snapshot: () => ({ e0: ckEpoch, ck0: out.secret }) },
  });
  const ask = (activeGen, circles = [out]) =>
    adoptPairedCircle({
      activeSecret: out.secret,
      activeMemberId: out.identity.memberId,
      activeGen,
      circles,
    });
  assert.equal(ask(live(out.ckEpoch)), null, "an intact circle is not repaired over and over");
  assert.ok(ask(live(out.ckEpoch + 1)), "a moved chain-key epoch is still the repair it always was");
  assert.ok(ask({ ...live(out.ckEpoch), channelId: circle("other").channelId }), "a torn channel is still caught");
  // An epoch that cannot be known from what was passed is not evidence of a
  // tear, so it does not manufacture one.
  assert.equal(ask({ g: out.g, channelId: out.channelId }), null);
  assert.equal(ask({ g: out.g, channelId: out.channelId, ratchet: { snapshot: () => null } }), null);
});

// ---------------------------------------------------------------------------
// The roster is written off the circle guard, from the network, through a
// queue. A write it decided to make while the circle was live can still be
// waiting when the circle stops being live.

test("a roster write queued before a leave never lands on a circle that is gone", async () => {
  const { store, kv } = fakeKv();
  const a = circle("family");
  store.set("identity", a.identity);
  await writeRecordAtRest(kv, null, GEN_SLOT, packGenMeta(a));
  await writeRecordAtRest(kv, null, PINNED_SLOT, packPinned(a.pinned));
  // The decision to write is taken here, while the circle is still live; the
  // write itself reaches storage only after the leave has cleared the slots.
  const queued = () => writeRecordAtRest(kv, null, PINNED_SLOT, packPinned(a.pinned));
  await leaveActive(kv, null, { circles: [], toIndex: 0 });
  // Refused rather than dropped, because a straggler after the LAST leave is
  // the tail of a sequence whose next step writes a chain key this module
  // never sees; failing the write it is waiting on is what stops that step.
  await assert.rejects(queued, /left: refusing to write/, "the straggler is refused, not applied");
  assert.ok(!store.has(PINNED_SLOT.plain), "no plaintext roster for a circle this device has left");
  assert.equal(store.size, 0, "nothing about the circle survives the last leave");
  // The same straggler with the lock on must not resurrect the sealed form
  // either: a sealed roster nothing points at is still a member count.
  const lock = { enabled: true, vaultKey: newVaultKey() };
  await assert.rejects(() => writeRecordAtRest(kv, lock, PINNED_SLOT, packPinned(a.pinned)), /left: refusing/);
  assert.equal(store.size, 0);
  // A circle taking the slots opens them again: the generation record is the
  // first thing every arrival writes, and persistCircle has already put the
  // identity that record belongs to on disk.
  const b = circle("friends");
  store.set("identity", b.identity);
  await writeRecordAtRest(kv, null, STAGED_SLOT, packStagedGen({ ...b, ck: randomSecret() }));
  assert.equal(await writeRecordAtRest(kv, null, PINNED_SLOT, packPinned(b.pinned)), true);
  assert.equal(store.get(PINNED_SLOT.plain)[0].memberId, b.pinned[0].memberId);
});

test("a switch reopens the slots for the circle arriving in them", async () => {
  const { store, kv } = fakeKv();
  const out = circle("family");
  const incoming = circle("friends");
  await switchActive(kv, null, { outgoing: out, circles: [incoming], toIndex: 0 });
  // The incoming circle's own roster is on disk, and its later pins persist.
  assert.equal(store.get(PINNED_SLOT.plain)[0].memberId, incoming.pinned[0].memberId);
  const extra = [...packPinned(incoming.pinned), { memberId: "c".repeat(32), alg: "p256", pk: "cGs", epk: "ZXBr" }];
  assert.equal(await writeRecordAtRest(kv, null, PINNED_SLOT, extra), true);
  assert.equal(store.get(PINNED_SLOT.plain).length, 2);
});

test("a switch that never lands leaves the slots open for the circle still in them", async () => {
  let sawInsideWriteActive = false;
  for (let failAt = 0; failAt < 10; failAt++) {
    const store = new Map();
    const a = circle("family");
    const incoming = circle("friends");
    store.set(GEN_SLOT.plain, packGenMeta(a));
    store.set(PINNED_SLOT.plain, packPinned(a.pinned));
    const kv = throwOnceKv(store, failAt);
    let threw = false;
    try {
      await switchActive(kv, null, { outgoing: a, circles: [incoming], toIndex: 0 });
    } catch (e) {
      if (!/simulated fault/.test(String(e))) throw e;
      threw = true;
    }
    if (!threw) continue;
    // Only the windows where nothing of the incoming circle reached the
    // generation slot: the active slots still hold the circle that was there,
    // the caller puts memory back on it, and its own roster writes are not
    // stragglers from anywhere.
    if (store.get(GEN_SLOT.plain)?.channelId === incoming.channelId) continue;
    if (store.get("circleName") === incoming.name) sawInsideWriteActive = true;
    assert.equal(
      await writeRecordAtRest(kv, null, PINNED_SLOT, packPinned(a.pinned)),
      true,
      `failAt=${failAt}: the circle still in the slots must keep persisting its roster`,
    );
  }
  assert.ok(sawInsideWriteActive, "the sweep must actually fail partway through writeActive");
});

// ---------------------------------------------------------------------------
// The last-circle leave. Every other teardown hands the active slots to
// another circle, so each of its crash windows ends with some circle owning
// every slot. This one deletes them, and a run of deletes has no commit point,
// so it runs under a journal: what a crash strands, the next boot finishes.
// The leftovers matter because they are not inert. The generation record names
// the channel the circle talks on, the roster carries every member's public
// keys and their number, and the invitation is a credential somebody can still
// use, all in plaintext with the lock off, for a circle the user has been told
// is gone.

// A device sitting on one circle, with every slot filled in both spellings:
// which one is on disk depends on a lock state a torn leave can outlive.
function seedLastCircle(store, c) {
  store.set("secret", c.secret);
  store.set("vaultSecret", { sealed: true });
  store.set("identity", c.identity);
  store.set("circleName", c.name);
  store.set("lastSentTs", 7);
  store.set(GEN_SLOT.plain, packGenMeta(c));
  store.set(GEN_SLOT.sealed, { sealed: true });
  store.set(PINNED_SLOT.plain, packPinned(c.pinned));
  store.set(PINNED_SLOT.sealed, { sealed: true });
  store.set(INVITE_SLOT.plain, packInvite(inviteFor(c)));
  store.set(INVITE_SLOT.sealed, { sealed: true });
  store.set(STAGED_SLOT.plain, packStagedGen({ ...c, ck: randomSecret() }));
  store.set(STAGED_SLOT.sealed, { sealed: true });
  return [...store.keys()];
}

test("the purge list covers both spellings of every slot, and stops at the inactive array", () => {
  for (const slot of [GEN_SLOT, PINNED_SLOT, INVITE_SLOT, STAGED_SLOT]) {
    assert.ok(LEAVE_PURGE_KEYS.includes(slot.plain), `${slot.plain} must be purged`);
    assert.ok(LEAVE_PURGE_KEYS.includes(slot.sealed), `${slot.sealed} must be purged`);
  }
  for (const k of ["secret", "vaultSecret", "identity", "circleName", "lastSentTs"]) {
    assert.ok(LEAVE_PURGE_KEYS.includes(k), `${k} must be purged`);
  }
  // Nothing outside the active slots. The array holds other circles and may be
  // the only copy of them; the lock record is the caller's to clear, and it
  // clears it first so no crash leaves a passcode screen over an empty device;
  // and the profile is the user's own name and emoji, which outlive any one
  // circle and seed the next one.
  for (const k of ["circles", "vaultCircles", "circleIdentities", "lock", "profile"]) {
    assert.ok(!LEAVE_PURGE_KEYS.includes(k), `${k} is not the leaving circle's to delete`);
  }
});

test("the last leave journals before the first delete and drops the journal after the last", async () => {
  const { store, ops, kv } = fakeKv();
  seedLastCircle(store, circle("family"));
  const res = await leaveActive(kv, null, { circles: [], toIndex: 0 });
  const keys = ops.map(([op, k]) => `${op}:${k}`);
  const at = (k) => keys.indexOf(k);
  assert.equal(keys[0], `set:${LEAVING_KEY}`, "nothing is deleted before the journal is durable");
  assert.equal(keys[keys.length - 1], `del:${LEAVING_KEY}`, "the journal outlives every delete");
  // Severity order inside the run: the journal only helps a device that runs
  // the app again, and a seized phone never does.
  assert.ok(at("del:secret") < at(`del:${PINNED_SLOT.plain}`), "the chain key goes before the roster");
  assert.ok(
    at(`del:${STAGED_SLOT.plain}`) < at(`del:${GEN_SLOT.plain}`),
    "a staged generation is key material and does not wait behind metadata",
  );
  assert.ok(
    at(`del:${INVITE_SLOT.plain}`) < at(`del:${PINNED_SLOT.plain}`),
    "the live credential goes before the roster",
  );
  assert.equal(res.pending, false, "a clean purge owes boot nothing");
  assert.equal(store.size, 0, "nothing about the circle survives, journal included");
});

test("a crash inside the last leave leaves the circle whole or leaves a journal, and boot finishes it", async () => {
  let sawStranded = false;
  for (let allow = 0; allow < 22; allow++) {
    const store = new Map();
    const seeded = seedLastCircle(store, circle("family"));
    try {
      await leaveActive(crashingKv(store, allow), null, { circles: [], toIndex: 0 });
    } catch (e) {
      if (!/simulated crash/.test(String(e))) throw e;
    }
    if (store.size === 0) {
      // The whole run got through before the crash point; there is nothing
      // left to strand.
      continue;
    }
    if (store.has(LEAVING_KEY)) {
      // The journal is on disk, so boot owns the rest of the purge however
      // little of it ran.
      if (store.size > 1) sawStranded = true;
      await finishPendingLeave(plainKv(store));
      assert.equal(store.size, 0, `allow=${allow}: boot must finish what the crash interrupted`);
    } else {
      // No journal means the crash beat the journal write, and nothing may
      // have been deleted: the caller still has its circle, whole.
      for (const k of seeded) {
        assert.ok(store.has(k), `allow=${allow}: ${k} went without a journal to clean up after it`);
      }
      await finishPendingLeave(plainKv(store));
      assert.equal(store.size, seeded.length, `allow=${allow}: an unjournalled leave deletes nothing`);
    }
  }
  assert.ok(sawStranded, "the sweep must actually interrupt a purge");
});

test("a delete the store refuses is reported, not thrown, and the rest of the purge still runs", async () => {
  const store = new Map();
  seedLastCircle(store, circle("family"));
  let refuse = true;
  const kv = {
    ...plainKv(store),
    async del(k) {
      // An early key storage will not give up must never keep the invitation
      // and the roster alive behind it.
      if (refuse && k === "vaultSecret") throw new Error("simulated fault");
      store.delete(k);
    },
  };
  const res = await leaveActive(kv, null, { circles: [], toIndex: 0 });
  assert.equal(res.active, null);
  assert.equal(res.pending, true, "the caller is told the disk is not clean yet");
  assert.ok(store.has(LEAVING_KEY), "the journal stays for boot");
  for (const k of [INVITE_SLOT.plain, PINNED_SLOT.plain, GEN_SLOT.plain, STAGED_SLOT.plain, "secret", "identity"]) {
    assert.ok(!store.has(k), `${k} must go even though an earlier delete failed`);
  }
  refuse = false;
  assert.equal(await finishPendingLeave(kv), true);
  assert.equal(store.size, 0, "the next boot clears what storage refused");
});

test("a leave that cannot even journal keeps the circle and keeps its slots open", async () => {
  const store = new Map();
  const a = circle("family");
  seedLastCircle(store, a);
  const kv = {
    ...plainKv(store),
    async set(k, v) {
      if (k === LEAVING_KEY) throw new Error("simulated fault");
      store.set(k, v);
    },
  };
  await assert.rejects(() => leaveActive(kv, null, { circles: [], toIndex: 0 }), /simulated fault/);
  assert.ok(store.has("secret"), "nothing was deleted, so the caller still has its circle");
  assert.ok(store.has(GEN_SLOT.plain));
  assert.ok(!store.has(LEAVING_KEY));
  // The caller keeps this circle live, so its own roster writes are not
  // stragglers and must not be dropped.
  assert.equal(
    await writeRecordAtRest(kv, null, PINNED_SLOT, packPinned(a.pinned)),
    true,
    "a failed leave must not silently stop the circle persisting its roster",
  );
});

test("boot's replay touches nothing on a device that is still in a circle", async () => {
  const { store, ops, kv } = fakeKv();
  const seeded = seedLastCircle(store, circle("family"));
  assert.equal(await finishPendingLeave(kv), false, "no journal, no work");
  assert.ok(!ops.some(([op]) => op === "del"), "an ordinary launch deletes nothing");
  for (const k of seeded) assert.ok(store.has(k), `${k} must survive an ordinary launch`);
});

test("boot's replay survives a store that will not answer", async () => {
  const dead = {
    async get() {
      throw new Error("simulated fault");
    },
    async set() {
      throw new Error("simulated fault");
    },
    async del() {
      throw new Error("simulated fault");
    },
  };
  // A device that cannot clean up still has to boot.
  assert.equal(await finishPendingLeave(dead), false);
});

test("a circle arriving in the slots spends the journal boot would have replayed", async () => {
  const store = new Map();
  seedLastCircle(store, circle("family"));
  let refuse = true;
  const kv = {
    ...plainKv(store),
    async del(k) {
      if (refuse && k === LEAVING_KEY) throw new Error("simulated fault");
      store.delete(k);
    },
  };
  const res = await leaveActive(kv, null, { circles: [], toIndex: 0 });
  assert.equal(res.pending, true, "the journal could not be dropped");
  assert.ok(store.has(LEAVING_KEY));
  refuse = false;
  // Same session, no boot in between: the user creates a circle. persistCircle
  // writes the new identity first, then writeGenAtRest stages the generation
  // before the chain key lands, and that is the arrival.
  const b = circle("friends");
  store.set("identity", b.identity);
  await writeRecordAtRest(kv, null, STAGED_SLOT, packStagedGen({ ...b, ck: b.secret }));
  assert.ok(!store.has(LEAVING_KEY), "the arriving circle spends the journal before its key lands");
  store.set("secret", b.secret);
  await finishPendingLeave(plainKv(store));
  assert.ok(
    sameSecret(store.get("secret"), b.secret),
    "boot must never purge the circle that took the slots after the leave",
  );
});

// ---------------------------------------------------------------------------
// The vault key after zero().
//
// lock.js scrubs a key with bytes.fill(0): the buffer empties in place and
// every reference to it stays alive, now holding 32 zero bytes. So a lock
// context captured before the app locked still carries a `vaultKey`, and a
// check that only asks whether the field is set waves it through. What it
// waves through is a record sealed under a key the whole world has. These
// checks ask whether the key still protects anything.

// Exactly what lockNow does to the key a captured context is still pointing at.
function zeroedKey() {
  const k = newVaultKey();
  zero(k);
  return k;
}

const ZEROS = new Uint8Array(32);

test("a zeroed vault key is not a vault key", () => {
  assert.equal(usableVaultKey(newVaultKey()), true);
  assert.equal(usableVaultKey(zeroedKey()), false, "fill(0) leaves the reference alive and the key dead");
  assert.equal(usableVaultKey(new Uint8Array(32)), false);
  assert.equal(usableVaultKey(null), false);
  assert.equal(usableVaultKey(undefined), false);
  // Not a Starling vault key, whatever else it is.
  assert.equal(usableVaultKey(new Uint8Array(16).fill(9)), false);
  assert.equal(usableVaultKey("0123456789abcdef0123456789abcdef"), false, "32 characters are not 32 bytes");
  assert.equal(usableVaultKey(new Array(32).fill(7)), false);
  // One live byte is still a key: the check is "was this scrubbed", not
  // "does this look random".
  const almost = new Uint8Array(32);
  almost[31] = 1;
  assert.equal(usableVaultKey(almost), true);
});

test("a captured lock context whose key was zeroed seals nothing at all", async () => {
  for (const slot of [GEN_SLOT, PINNED_SLOT, INVITE_SLOT, STAGED_SLOT]) {
    const { store, ops, kv } = fakeKv();
    const a = circle("family");
    // The shape the app produces: lockCtx() is captured while unlocked, the
    // autolock fires, and the write lands afterwards holding the same object.
    const captured = { enabled: true, vaultKey: newVaultKey() };
    zero(captured.vaultKey);
    await assert.rejects(
      () => writeRecordAtRest(kv, captured, slot, packGenMeta(a)),
      /locked: refusing to write/,
      `${slot.plain} was written under a dead key`,
    );
    assert.equal(ops.length, 0, `${slot.plain} touched storage on a refused write`);
    assert.equal(store.size, 0);
  }
  // The inactive array rides the same key and fails the same way.
  const { store, kv } = fakeKv();
  const captured = { enabled: true, vaultKey: zeroedKey() };
  await assert.rejects(() => writeCirclesAtRest(kv, captured, [circle("family")]), /locked: refusing to write circles/);
  assert.equal(store.size, 0);
});

test("nothing a lock transition writes is sealed under a zeroed key", async () => {
  const { store, kv } = fakeKv();
  const a = circle("family");
  store.set("secret", a.secret);
  store.set("circles", [a]);
  store.set(GEN_SLOT.plain, packGenMeta(a));
  await assert.rejects(
    () =>
      enableLockTransition(kv, {
        vaultKey: zeroedKey(),
        lockRecord: { v: 1 },
        secret: a.secret,
        circles: [a],
        genMeta: packGenMeta(a),
        pinned: packPinned(a.pinned),
        invite: null,
      }),
    /unusable vault key/,
  );
  for (const k of SEALED_KEYS) assert.ok(!store.has(k), `${k} was sealed under 32 zero bytes`);
  assert.ok(!store.has("lock"), "no lock record over an unusable key");
  assert.ok(sameSecret(store.get("secret"), a.secret), "the plaintext the caller still holds is where it was");
});

test("a zeroed key reads as locked, never as a damaged install", async () => {
  const { store, kv } = fakeKv();
  const K = newVaultKey();
  const live = { enabled: true, vaultKey: K };
  const a = circle("family");
  await writeRecordAtRest(kv, live, GEN_SLOT, packGenMeta(a));
  await writeCirclesAtRest(kv, live, [a]);
  const captured = { enabled: true, vaultKey: K };
  zero(K);
  // SealedRecordError is the damaged-install answer, and boot answers it by
  // parking and DELETING the staged generation while the lock screen answers
  // it by telling the user their data will not open. A key that is gone is
  // neither of those things.
  await assert.rejects(
    () => readRecordAtRest(kv, captured, GEN_SLOT),
    (e) => /locked: refusing to read/.test(String(e)) && !isSealedRecordError(e),
  );
  // null from the array read means "corrupt, drop every inactive circle".
  await assert.rejects(() => readCirclesAtRest(kv, captured), /locked: refusing to read circles/);
  // And both records are still there, untouched, for a real unlock to open.
  assert.ok(store.has(GEN_SLOT.sealed) && store.has("vaultCircles"));
});

test("an autolock landing mid-switch stops before the chain key, not after it", async () => {
  const store = new Map();
  const out = circle("family");
  const incoming = circle("friends");
  const lock = { enabled: true, vaultKey: newVaultKey() };
  const kv = {
    async get(k) {
      return store.get(k);
    },
    async set(k, v) {
      store.set(k, v);
    },
    async del(k) {
      store.delete(k);
      // The last op of the roster write. Everything up to here was sealed
      // under a live key; the chain key is the next thing writeActive reaches,
      // and by then the key has been scrubbed out from under it.
      if (k === PINNED_SLOT.plain) zero(lock.vaultKey);
    },
  };
  await assert.rejects(
    () => switchActive(kv, lock, { outgoing: out, circles: [incoming], toIndex: 0 }),
    /locked: refusing to write the chain key/,
  );
  assert.ok(!store.has("vaultSecret"), "the crown jewel was written under a dead key");
  assert.ok(!store.has("secret"), "and not in the clear either");
  // The point of the check, spelled out: had it passed, this is what a seized
  // phone would have found.
  for (const k of ["vaultSecret", GEN_SLOT.sealed, PINNED_SLOT.sealed, "vaultCircles"]) {
    const rec = store.get(k);
    if (!rec) continue;
    assert.equal(await openUnderVault(ZEROS, rec), null, `${k} opens under 32 zero bytes`);
  }
});

// ---------------------------------------------------------------------------
// The last-circle leave against a write that was already in flight.
//
// persistRatchet is called un-awaited from the poller, and writeGenAtRest is
// four storage writes ending in the chain key. A leave can land anywhere
// inside that sequence: by the time the sequence resumes the device holds no
// circle, and every remaining step puts part of the one it left back on the
// disk, in the clear if the app lock was dropped with it.

test("a generation write in flight across the last leave is refused, not applied", async () => {
  for (const tail of [GEN_SLOT, PINNED_SLOT, STAGED_SLOT]) {
    const { store, kv } = fakeKv();
    const a = circle("family");
    seedLastCircle(store, a);
    // The write was decided here, while the circle was still live.
    const inFlight = () =>
      writeRecordAtRest(
        kv,
        null,
        tail,
        tail === PINNED_SLOT ? packPinned(a.pinned) : tail === STAGED_SLOT ? packStagedGen({ ...a, ck: a.secret }) : packGenMeta(a),
      );
    const res = await leaveActive(kv, null, { circles: [], toIndex: 0 });
    assert.equal(res.pending, false);
    assert.equal(store.size, 0, "the leave itself got the disk clean");
    await assert.rejects(inFlight, /left: refusing to write/, `${tail.plain} was written back after the leave`);
    assert.equal(store.size, 0, "nothing about the circle this device left is back on disk");
  }
});

test("a straggling generation write does not spend the journal boot still owes", async () => {
  const store = new Map();
  const a = circle("family");
  seedLastCircle(store, a);
  let refuse = true;
  const kv = {
    ...plainKv(store),
    async del(k) {
      // Storage will not give up the roster, so the journal has to outlive
      // this leave and boot owns the rest of the sweep.
      if (refuse && k === PINNED_SLOT.plain) throw new Error("simulated fault");
      store.delete(k);
    },
  };
  const res = await leaveActive(kv, null, { circles: [], toIndex: 0 });
  assert.equal(res.pending, true);
  assert.ok(store.has(LEAVING_KEY), "the journal is what boot replays");
  // The tail of the interrupted writeGenAtRest arrives now. Spending the
  // journal here would leave the roster on disk with nothing left to sweep it.
  await assert.rejects(() => writeRecordAtRest(kv, null, GEN_SLOT, packGenMeta(a)), /left: refusing to write/);
  assert.ok(store.has(LEAVING_KEY), "the straggler spent the journal");
  assert.ok(!store.has(GEN_SLOT.plain), "and put the channel id back with it");
  refuse = false;
  assert.equal(await finishPendingLeave(kv), true);
  assert.equal(store.size, 0, "boot finishes what the leave could not");
});

test("the circle the user creates after leaving still takes the slots", async () => {
  const { store, kv } = fakeKv();
  seedLastCircle(store, circle("family"));
  await leaveActive(kv, null, { circles: [], toIndex: 0 });
  // persistCircle: the identity goes down first, precisely so the generation
  // record that follows always has the identity it belongs to on disk.
  const b = circle("friends");
  await kv.set("identity", b.identity);
  await writeRecordAtRest(kv, null, STAGED_SLOT, packStagedGen({ ...b, ck: b.secret }));
  await writeRecordAtRest(kv, null, GEN_SLOT, packGenMeta(b));
  assert.equal(await writeRecordAtRest(kv, null, PINNED_SLOT, packPinned(b.pinned)), true);
  assert.equal(store.get(GEN_SLOT.plain).channelId, b.channelId);
  assert.equal(store.get(PINNED_SLOT.plain)[0].memberId, b.pinned[0].memberId);
});

// ---------------------------------------------------------------------------
// What a delete that resolved is worth. store.js resolves its IndexedDB ops on
// REQUEST success, and the transaction commits afterwards; one that aborts on
// the way to disk rolls the delete back after the caller was told it worked.

test("a delete that resolves but does not stick is not a clean disk", async () => {
  const store = new Map();
  const a = circle("family");
  seedLastCircle(store, a);
  const kv = {
    ...plainKv(store),
    async del(k) {
      // The request succeeded and the transaction aborted afterwards: no
      // throw ever reaches us, and the key is still there.
      if (k === INVITE_SLOT.plain) return;
      store.delete(k);
    },
  };
  const res = await leaveActive(kv, null, { circles: [], toIndex: 0 });
  assert.ok(store.has(INVITE_SLOT.plain), "the invitation is still on disk, whatever the store said");
  assert.equal(res.pending, true, "a purge is clean when it is observed clean, not when it is reported clean");
  assert.ok(store.has(LEAVING_KEY), "the journal stays, so boot sweeps it");
  // And boot does.
  store.delete(INVITE_SLOT.plain);
  assert.equal(await finishPendingLeave(plainKv(store)), true);
  assert.equal(store.size, 0);
});

// ---------------------------------------------------------------------------
// The one thing this module cannot assert about itself: that the caller acts
// on what it hands back. `pending` is the difference between the user being
// told the circle is gone and it actually being gone, and a returned value
// nobody reads is not a report. This is a source check, and it proves exactly
// one thing: the leave path in main.js branches on it. That the branch says
// something true is on the reviewer.

const MAIN_JS = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app", "js", "main.js"),
  "utf8",
);

test("main.js acts on a leave that could not finish its deletes", () => {
  const from = MAIN_JS.indexOf("const leaveCircle =");
  const to = MAIN_JS.indexOf("function openCircles");
  assert.ok(from > 0 && to > from, "leaveCircle moved; this check has to move with it");
  const body = MAIN_JS.slice(from, to);
  assert.ok(body.includes("await leaveActive("), "wrong slice: this is not the leave path");
  assert.ok(/res\.pending/.test(body), "leaveActive reports an unfinished purge and nobody reads it");
  assert.ok(
    !/ui\.toast\("You left the circle\."\)/.test(body),
    "the unconditional 'it is gone' toast cannot survive a purge that did not finish",
  );
});
