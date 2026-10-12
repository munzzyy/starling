// The quiet-circle hint, run through main.js: a pinned member who has said nothing for over a day.
import test from "node:test";
import assert from "node:assert/strict";

import { installDom, loadApp, settle } from "./dom-harness.mjs";

const harness = installDom({ listeners: true });
const { internals } = await loadApp(harness);
const state = internals.state;

globalThis.indexedDB ??= {
  open() {
    throw new Error("no indexeddb in the harness");
  },
  deleteDatabase() {
    const req = {};
    setTimeout(() => req.onsuccess?.(), 0);
    return req;
  },
};

const { openGeneration } = await import("../app/js/rekey.js");
const { epochAt } = await import("../app/js/ratchet.js");
const { generateIdentity, newSeed, sealMessage, buildPost } = await import("../app/js/crypto.js");
const { b64uEncode } = await import("../app/js/wire.js");
const { dbGet, dbSet, wipeAll } = await import("../app/js/store.js");
const { QUIET_HINT_MS } = await import("../app/js/roster.js");

test.after(() => harness.stopTimers());

const ok = (obj) => ({ ok: true, status: 200, json: async () => obj });
const quiet = () => internals.alertItems().find((a) => a.id === "quiet-circle");

async function waitFor(cond, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await settle(50);
  }
  return cond();
}

test("a pinned member silent for over a day raises the hint, and a post from them clears it", { timeout: 30_000 }, async () => {
  const self = await generateIdentity();
  const peer = await generateIdentity();
  internals.teardownNet();
  await wipeAll();
  Object.assign(state, {
    circles: [],
    locked: false,
    lock: null,
    vaultKey: null,
    demo: false,
    chainDestroyed: false,
    sharing: false,
    pinned: new Map(),
    me: null,
    identity: self,
  });
  await dbSet("identity", self);
  const seed = newSeed();
  const e0 = epochAt(Date.now());
  state.gen = await openGeneration({ seed: new Uint8Array(seed), g: 0, e0 });
  state.gen.at = Date.now();
  state.gen.joined = Date.now() - QUIET_HINT_MS - 3_600_000;
  const peerGen = await openGeneration({ seed: new Uint8Array(seed), g: 0, e0 });
  assert.ok(await internals.addPinned({ alg: peer.alg, pk: b64uEncode(peer.pk), epk: b64uEncode(peer.epk), name: "Peer" }));
  state.genRoster = new Set(state.pinned.keys());

  let served = [];
  harness.onFetch(async (url) => (/\/api\/v2\/f\/[0-9a-f]{32}/.test(url) ? ok({ now: Date.now(), members: served }) : null));
  window.__starlingErrors.length = 0;

  internals.setupNet();
  assert.ok(await waitFor(() => quiet(), 5000), "silence plus a working feed raises the hint");
  const item = quiet();
  assert.equal(item.kind, "info");
  assert.equal(item.title, "Nothing from anyone here for over a day");
  assert.equal(item.actions, undefined, "it is a hint, not a prompt");

  const ts = Date.now();
  const e = epochAt(ts);
  const key = await peerGen.ratchet.keyFor(e, peer.memberId, ts);
  const sealed = await sealMessage(key, peerGen.channelId, peer.memberId, e, ts, { v: 2, ts, t: "loc", lat: 44.9, lon: -93.2 });
  const post = await buildPost(peer, peerGen.channelId, e, sealed, ts);
  served = [
    {
      m: peer.memberId,
      alg: peer.alg,
      pk: b64uEncode(peer.pk),
      epk: b64uEncode(peer.epk),
      points: [{ e: post.e, ts: post.ts, srv: post.ts, n: post.n, c: post.c, sig: post.sig }],
    },
  ];
  for (const fn of harness.listeners("document", "visibilitychange")) fn();
  assert.ok(await waitFor(() => !quiet(), 5000), "hearing from them clears it");
  assert.ok(state.gen.heard >= ts);

  // Written with the generation, so a reload keeps it, and a re-key carries it over.
  state.gen.heardSaved = -Infinity;
  await internals.persistRatchet();
  const stored = await dbGet("genMeta");
  assert.equal(stored.heard, state.gen.heard);
  assert.equal(stored.joined, state.gen.joined);
  harness.onFetch(null);
  internals.teardownNet();
  assert.deepEqual(window.__starlingErrors, []);
});
