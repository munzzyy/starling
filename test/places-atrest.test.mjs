// Places at rest: sealed under the vault key while the lock is on, plaintext
// otherwise, exactly one form on disk, and every interrupted-transition
// residue swept toward the safe side. Driven through the real main.js
// functions, because the at-rest rule only counts where the app enforces it.
import test from "node:test";
import assert from "node:assert/strict";

import { installDom, loadApp } from "./dom-harness.mjs";

// The same fake IndexedDB shape destruct-wipe.test.mjs uses: a Map behind
// request objects, so store.js runs its real code paths.
const data = new Map();
const req = (run) => {
  const r = { onsuccess: null, onerror: null };
  queueMicrotask(() => {
    r.result = run();
    r.onsuccess?.();
  });
  return r;
};
const store = {
  get: (k) => req(() => data.get(k)),
  put: (v, k) => req(() => {
    data.set(k, v);
  }),
  delete: (k) => req(() => {
    data.delete(k);
  }),
};
const db = { transaction: () => ({ objectStore: () => store }), close() {} };
globalThis.indexedDB = {
  open: () => {
    const r = { onsuccess: null, onerror: null, onupgradeneeded: null, result: db };
    queueMicrotask(() => r.onsuccess?.());
    return r;
  },
};

const harness = installDom();
const { internals } = await loadApp(harness);
const state = internals.state;

const { dbGet, dbSet } = await import("../app/js/store.js");
const { newVaultKey, makePasscodeRecord, zero } = await import("../app/js/lock.js");

const PLACE = { id: "aaaaaaaa", name: "Home", lat: 40, lon: -75, radius: 250 };

test.after(() => harness.stopTimers());

function unlockCleared() {
  state.lock = null;
  state.vaultKey = null;
  state.locked = false;
}

test("with the lock off, places persist as plaintext only", async () => {
  unlockCleared();
  state.places = [PLACE];
  await internals.writePlacesAtRest();
  assert.deepEqual(await dbGet("places"), [PLACE]);
  assert.equal(await dbGet("vaultPlaces"), undefined);
});

test("with the lock on, places persist sealed only, and round-trip", async () => {
  state.lock = { enabled: true };
  state.vaultKey = newVaultKey();
  state.places = [PLACE];
  await internals.writePlacesAtRest();
  assert.equal(await dbGet("places"), undefined, "no plaintext copy may remain");
  const sealed = await dbGet("vaultPlaces");
  assert.ok(sealed?.ct, "sealed blob is on disk");
  const hay = JSON.stringify([...sealed.ct]);
  assert.ok(!JSON.stringify(sealed).includes("Home"), "the name is not readable in the record");
  void hay;

  state.places = [];
  await internals.loadPlaces();
  assert.deepEqual(state.places, [PLACE], "sealed places open back up");
});

test("a zeroed vault key refuses to write rather than falling back to plaintext", async () => {
  state.lock = { enabled: true };
  state.vaultKey = newVaultKey();
  zero(state.vaultKey);
  state.places = [PLACE];
  await assert.rejects(() => internals.writePlacesAtRest(), /locked/);
  assert.equal(await dbGet("places"), undefined);
});

test("a plaintext stray found while locked is adopted, resealed, and deleted", async () => {
  state.lock = { enabled: true };
  state.vaultKey = newVaultKey();
  const stray = [{ ...PLACE, id: "bbbbbbbb", name: "School" }];
  await dbSet("places", stray);
  await dbSet("vaultPlaces", null);
  state.places = [];
  await internals.loadPlaces();
  assert.deepEqual(
    state.places.map((p) => p.name),
    ["School"],
    "the stray's content survives",
  );
  assert.equal(await dbGet("places"), undefined, "but not in the plaintext form");
  assert.ok((await dbGet("vaultPlaces"))?.ct, "it moved into the sealed form");
});

test("a sealed blob found with the lock off is deleted as unreadable", async () => {
  unlockCleared();
  await dbSet("vaultPlaces", { v: 1, nonce: new Uint8Array(12), ct: new Uint8Array(48) });
  await dbSet("places", [PLACE]);
  await internals.loadPlaces();
  assert.deepEqual(state.places, [PLACE]);
  assert.equal(await dbGet("vaultPlaces"), undefined);
});

test("junk in storage never crashes the loader and never survives it", async () => {
  unlockCleared();
  await dbSet("places", [{ nonsense: true }, PLACE, { ...PLACE, id: "zz" }]);
  await internals.loadPlaces();
  assert.deepEqual(state.places, [PLACE], "only the valid record is kept");
});

test("setDuress refuses the unlock passcode and stores a verifier otherwise", async () => {
  const K = newVaultKey();
  state.lock = { enabled: true, pass: await makePasscodeRecord("1234", K) };
  state.vaultKey = K;
  assert.equal(await internals.setDuress("1234"), false, "the unlock passcode is refused");
  assert.ok(!state.lock.duress);
  assert.equal(await internals.setDuress("9999"), true);
  assert.ok(state.lock.duress, "a verifier is stored");
  const onDisk = await dbGet("lock");
  assert.ok(onDisk.duress, "and persisted");
  await internals.clearDuress();
  assert.equal(state.lock.duress, null);
  assert.equal((await dbGet("lock")).duress, null);
});
