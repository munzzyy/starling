// The self-destruct on a device that has no room left to write.
//
// The catch-up destruct exists for a phone that has been away for weeks, and a
// phone in that state is exactly the one whose storage may be full. Two rules
// have to hold there, and each was a real defect in its own review round:
//
//   Round six: bookkeeping must not veto the erase. The destroy mark used to
//   be written BEFORE the delete, so a rejected mark write cancelled the whole
//   thing while the card said the keys were gone.
//
//   This round: the CARD must not outrun the disk. leaveActive writes its
//   journal before it deletes anything and rethrows if even that will not
//   land, so a thrown erase leaves the circle whole on disk. The claim was
//   raised first and the throw was swallowed into an array nothing renders,
//   so the person was told their keys were gone from storage while the chain
//   key, the channel id, the roster and a live invite were all still there.
//
// A card naming a protection the person does not have is the same defect as a
// card claiming an erase that did not happen.
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, loadApp, settle } from "./dom-harness.mjs";

// Fake IndexedDB whose put() of one chosen key fails the request, the way a
// full volume reports QuotaExceededError.
const data = new Map();
let failKey = null;
function req(fn) {
  const r = { onsuccess: null, onerror: null, result: undefined, error: null };
  queueMicrotask(() => {
    try { r.result = fn(); r.onsuccess?.(); } catch (e) { r.error = e; r.onerror?.(); }
  });
  return r;
}
const store = {
  get: (k) => req(() => data.get(k)),
  put: (v, k) => req(() => {
    if (k === failKey) throw new Error("QuotaExceededError");
    data.set(k, v);
  }),
  delete: (k) => req(() => { data.delete(k); }),
};
const db = { transaction: () => ({ objectStore: () => store }), close() {} };
globalThis.indexedDB = {
  open: () => { const r = { onsuccess: null, onerror: null, onupgradeneeded: null, result: db }; queueMicrotask(() => r.onsuccess?.()); return r; },
};

const harness = installDom();
const { internals } = await loadApp(harness);
const state = internals.state;

const { openGeneration } = await import("../app/js/rekey.js");
const { generateIdentity, newSeed } = await import("../app/js/crypto.js");
const { epochAt, MAX_CATCHUP_EPOCHS } = await import("../app/js/ratchet.js");
const { GEN_SLOT, PINNED_SLOT, INVITE_SLOT, packGenMeta, packPinned, writeRecordAtRest } = await import("../app/js/circles.js");
const { dbGet, dbSet, dbDel } = await import("../app/js/store.js");
const kvFace = { get: dbGet, set: dbSet, del: dbDel };

const STALE = epochAt(Date.now()) - (MAX_CATCHUP_EPOCHS + 200);

state.locked = false; state.lock = null; state.vaultKey = null;
state.demo = false; state.chainDestroyed = false; state.sharing = false;
state.identity = await generateIdentity();
const gen = await openGeneration({ seed: newSeed(), g: 0, e0: STALE });
gen.at = Date.now();
state.gen = gen;
const snap = gen.ratchet.snapshot();
// lay the circle down on disk exactly as an unlocked device holds it
await dbSet("secret", snap.ck0);
await dbSet("identity", state.identity);
await dbSet("circleName", "March march");
await writeRecordAtRest(kvFace, null, GEN_SLOT, packGenMeta({ ...gen, ckEpoch: snap.e0, genRoster: [] }));
await writeRecordAtRest(kvFace, null, PINNED_SLOT, packPinned(new Map()));
await writeRecordAtRest(kvFace, null, INVITE_SLOT, { s: "live-invite-secret" });


// One circle, laid down the way an unlocked device holds it, whose chain is
// already past the catch-up cliff.
async function staleCircle() {
  state.locked = false; state.lock = null; state.vaultKey = null;
  state.demo = false; state.chainDestroyed = false; state.chainWipeFailed = null;
  state.sharing = false;
  state.identity = await generateIdentity();
  const gen = await openGeneration({ seed: newSeed(), g: 0, e0: STALE });
  gen.at = Date.now();
  state.gen = gen;
  const snap = gen.ratchet.snapshot();
  await dbSet("secret", snap.ck0);
  await dbSet("identity", state.identity);
  await dbSet("circleName", "March march");
  await writeRecordAtRest(kvFace, null, GEN_SLOT, packGenMeta({ ...gen, ckEpoch: snap.e0, genRoster: [] }));
  await writeRecordAtRest(kvFace, null, PINNED_SLOT, packPinned(new Map()));
  await writeRecordAtRest(kvFace, null, INVITE_SLOT, { s: "live-invite-secret" });
}

test.after(() => harness.stopTimers());

const cards = () => internals.alertItems().map((i) => i.id);

test("a destruct that cannot erase does not tell anyone the keys are gone", async () => {
  await staleCircle();
  failKey = "leaving"; // the journal leaveActive writes before it deletes anything
  window.__starlingErrors.length = 0;

  await internals.syncRatchet();
  await settle(30);

  // Nothing was deleted, and that is the point: leaveActive refuses to start
  // an erase it cannot journal.
  assert.ok(await dbGet("secret"), "the chain key is still on disk");
  assert.ok(await dbGet(GEN_SLOT.plain), "and the record naming its channel");
  assert.ok(await dbGet(INVITE_SLOT.plain), "and the live invitation");

  assert.ok(
    !cards().includes("chain-destroyed"),
    "so the card claiming the keys are gone from storage must not be on screen",
  );
  assert.ok(cards().includes("chain-wipe-failed"), "the one that says what really happened is");
  assert.equal(state.chainDestroyed, false, "and nothing claims the destruct completed");
  assert.ok(state.chainWipeFailed, "the failure is recorded so the next launch can retry");
});

test("a destruct that can erase says so, and erases", async () => {
  // The control. Without it the test above passes against an app that simply
  // never shows either card.
  await staleCircle();
  failKey = null;
  window.__starlingErrors.length = 0;

  await internals.syncRatchet();
  await settle(30);

  assert.equal(await dbGet("secret"), undefined, "the chain key went");
  assert.equal(await dbGet(GEN_SLOT.plain), undefined, "and the generation record");
  assert.equal(await dbGet(INVITE_SLOT.plain), undefined, "and the invitation");
  assert.ok(cards().includes("chain-destroyed"), "and the card may say so now");
  assert.ok(!cards().includes("chain-wipe-failed"), "with no failure card beside it");
});
