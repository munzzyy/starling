// A re-key sealed while this device was away has to be read before the window trims its key.
import test, { mock } from "node:test";
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

const { openGeneration, buildRekey } = await import("../app/js/rekey.js");
const { EPOCH_MS, TRIM_HOLD_MS, epochAt } = await import("../app/js/ratchet.js");
const { generateIdentity, newSeed, sealMessage, buildPost } = await import("../app/js/crypto.js");
const { b64uEncode } = await import("../app/js/wire.js");
const { dbSet, wipeAll } = await import("../app/js/store.js");

test.after(() => harness.stopTimers());

const ok = (obj) => ({ ok: true, status: 200, json: async () => obj });
const rec = (id) => ({ memberId: id.memberId, epk: id.epk });
const channelOf = async (built) =>
  (await openGeneration({ seed: new Uint8Array(built.seed), g: built.g, e0: built.e0 })).channelId;

async function waitFor(cond, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await settle(50);
  }
  return cond();
}

// The chain as a reload leaves it: nothing walked past the stored snapshot at `e0`.
async function awayCircle(self, peer, e0) {
  internals.teardownNet();
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
  state.keyChanges.clear();
  state.rosterPending = null;
  state.invite = null;
  state.joining = null;
  state.joinRequests = [];
  state.missedRekey = false;
  state.identity = self;
  await dbSet("identity", self);
  const seed = newSeed();
  state.gen = await openGeneration({ seed: new Uint8Array(seed), g: 0, e0 });
  state.gen.at = e0 * EPOCH_MS;
  const peerGen = await openGeneration({ seed: new Uint8Array(seed), g: 0, e0 });
  assert.ok(
    await internals.addPinned({ alg: peer.alg, pk: b64uEncode(peer.pk), epk: b64uEncode(peer.epk), name: "Peer" }),
  );
  state.genRoster = new Set(state.pinned.keys());
  window.__starlingErrors.length = 0;
  return peerGen;
}

// The peer's re-key as the relay holds it: sealed and posted at `ts`, on the old channel.
async function rekeyServed(peer, peerGen, recipient, ts) {
  const built = await buildRekey({ identity: peer, gen: peerGen, recipients: [rec(recipient)], now: ts });
  const e = epochAt(ts);
  const key = await peerGen.ratchet.keyFor(e, peer.memberId, ts);
  const sealed = await sealMessage(key, peerGen.channelId, peer.memberId, e, ts + 1, { v: 2, ts: ts + 1, ...built.posts[0] });
  const post = await buildPost(peer, peerGen.channelId, e, sealed, ts + 1);
  const entry = {
    m: peer.memberId,
    alg: peer.alg,
    pk: b64uEncode(peer.pk),
    epk: b64uEncode(peer.epk),
    points: [{ e: post.e, ts: post.ts, srv: post.ts, n: post.n, c: post.c, sig: post.sig }],
  };
  return { built, entry };
}

// A relay that honours the cursor the way the real one does (srv >= since).
function relay(feed) {
  const reads = [];
  harness.onFetch(async (url, init) => {
    const m = /\/api\/v2\/f\/([0-9a-f]{32})(\/loc)?/.exec(url);
    if (!m) return null;
    const [, chan, loc] = m;
    if (loc || init?.method === "POST") return ok({ ok: true, now: Date.now() });
    const since = Number(new URL(url, "http://x").searchParams.get("since") || 0);
    reads.push({ chan, since });
    const served = feed(chan);
    if (!served) return { ok: false, status: 503, json: async () => ({}) };
    const members = served.map((en) => ({ ...en, points: en.points.filter((p) => p.srv >= since) }));
    return ok({ now: Date.now(), members });
  });
  return reads;
}

test("a re-key from two hours ago is read on entry, before the window trims its key", { timeout: 30_000 }, async () => {
  const self = await generateIdentity();
  const peer = await generateIdentity();
  const E = epochAt(Date.now()) - 12;
  const peerGen = await awayCircle(self, peer, E - 2);
  const oldChannel = state.gen.channelId;
  const { built, entry } = await rekeyServed(peer, peerGen, self, E * EPOCH_MS + 1000);
  assert.equal(built.epoch, E);
  const newChannel = await channelOf(built);
  const reads = relay((chan) => (chan === oldChannel ? [entry] : []));

  await internals.enterCircle();

  const moved = await waitFor(() => state.gen?.g === 1, 5000);
  const followed = await waitFor(() => reads.some((r) => r.chan === newChannel), 3000);
  harness.onFetch(null);
  assert.ok(moved, "the re-key sealed while this device was away moved it to the next generation");
  assert.ok(followed, "and the poller moved to the new channel");
  assert.equal(reads.find((r) => r.chan === oldChannel).since, 0, "the first read asked for the whole backlog");
  assert.deepEqual(window.__starlingErrors, []);
});

test("coming back to the app reads the backlog before the window trims", { timeout: 30_000 }, async () => {
  const self = await generateIdentity();
  const peer = await generateIdentity();
  const E = epochAt(Date.now()) - 12;
  const peerGen = await awayCircle(self, peer, E - 2);
  const oldChannel = state.gen.channelId;
  const { entry } = await rekeyServed(peer, peerGen, self, E * EPOCH_MS + 1000);
  let online = false;
  relay((chan) => (chan === oldChannel ? (online ? [entry] : null) : []));
  // The page's own resume handlers, not the poller's: the poller registers its listener in setupNet.
  const onShow = harness.listeners("document", "visibilitychange");
  assert.ok(onShow.length > 0);

  // A poller whose last read failed, as on a phone that lost signal, with nothing walked yet.
  internals.setupNet();
  await settle(100);
  assert.equal(state.gen.ratchet.head, E - 2);

  online = true;
  for (const fn of onShow) fn();

  // Well inside the poller's ten second backoff, so only the resume itself can have read it.
  const moved = await waitFor(() => state.gen?.g === 1, 5000);
  harness.onFetch(null);
  assert.ok(moved, "returning to the app read the re-key before anything trimmed its key");
});

test("coming back with no network still walks to the current epoch at once", { timeout: 30_000 }, async () => {
  const self = await generateIdentity();
  const peer = await generateIdentity();
  const E = epochAt(Date.now()) - 12;
  await awayCircle(self, peer, E - 2);
  relay(() => null);
  internals.setupNet();
  await settle(100);
  assert.equal(state.gen.ratchet.head, E - 2);

  for (const fn of harness.listeners("document", "visibilitychange")) fn();
  assert.ok(await waitFor(() => state.gen.ratchet.head >= E + 12, 3000), "the walk does not wait for the network");
  assert.equal(state.gen.ratchet.trimHeld, true);
  assert.equal(state.gen.ratchet.retainedEpochs()[0], E - 2, "only the trim waits");
  harness.onFetch(null);
});

test("a phone that comes back with no network still trims once the hold runs out", { timeout: 30_000 }, async () => {
  const self = await generateIdentity();
  const peer = await generateIdentity();
  const E = epochAt(Date.now()) - 12;
  await awayCircle(self, peer, E - 2);
  relay(() => null);

  await internals.enterCircle();
  await settle(100);
  assert.equal(state.gen.ratchet.trimHeld, true, "a failed read leaves the hold in place");
  assert.equal(state.gen.ratchet.retainedEpochs()[0], E - 2);

  const until = state.gen.ratchet.trimHeldUntil;
  assert.ok(until > Date.now() && until <= Date.now() + TRIM_HOLD_MS);
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    internals.holdTrimForBacklog();
    mock.timers.tick(until - Date.now() - 1);
    assert.equal(state.gen.ratchet.retainedEpochs()[0], E - 2);
    // Opening the app again just before the end must not buy the old keys more time.
    internals.holdTrimForBacklog();
    assert.equal(state.gen.ratchet.trimHeldUntil, until);
    mock.timers.tick(1);
  } finally {
    mock.timers.reset();
  }
  assert.ok(await waitFor(() => state.gen.ratchet.retainedEpochs()[0] >= E + 7, 3000));
  assert.equal(state.gen.ratchet.trimHeld, false);
  harness.onFetch(null);
});
