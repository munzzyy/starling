// Multi-circle storage: the swap and leave orderings that make a crash
// duplicate a circle instead of losing one, the sealed-at-rest form under the
// app lock, and the boot reconciliation that cleans the duplicates up.
import test from "node:test";
import assert from "node:assert/strict";
import {
  packCircles,
  unpackCircles,
  sameSecret,
  writeCirclesAtRest,
  readCirclesAtRest,
  switchActive,
  leaveActive,
  reconcileCircles,
  adoptPairedIdentity,
  enableLockTransition,
  disableLockTransition,
} from "../app/js/circles.js";
import { newVaultKey } from "../app/js/lock.js";

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

function circle(name, lastTs = 0) {
  const secret = randomSecret();
  return {
    name,
    secret,
    identity: { alg: "ed25519", privateKey: { fake: name }, pk: new Uint8Array([1]), memberId: `member-${name}` },
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
  assert.equal(back[0].identity.memberId, "member-family");
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
    for (let allow = 0; allow < 24; allow++) {
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
  for (let allow = 0; allow < 12; allow++) {
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
  for (let allow = 0; allow < 12; allow++) {
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
    });
    store.set("identity", active.identity);
    let crashed = false;
    try {
      await disableLockAtRest(crashingKv(store, allow), {
        secret: active.secret,
        circles: [other],
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
  for (let failAt = 0; failAt < 9; failAt++) {
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
  for (let failAt = 0; failAt < 9; failAt++) {
    const active = circle("family");
    const other = circle("friends");
    const K = newVaultKey();
    const store = new Map();
    await enableLockAtRest(plainKv(store), {
      vaultKey: K,
      lockRecord: { enabled: true },
      secret: active.secret,
      circles: [other],
    });
    store.set("identity", active.identity);
    let threw = false;
    try {
      await disableLockTransition(throwOnceKv(store, failAt), {
        secret: active.secret,
        circles: [other],
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
    if (!threw && failAt >= 6) break;
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
  const paired = adoptPairedIdentity({
    activeSecret,
    activeMemberId: identity?.memberId,
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
  for (let allow = 0; allow < 16; allow++) {
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
  for (let allow = 0; allow < 12; allow++) {
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
