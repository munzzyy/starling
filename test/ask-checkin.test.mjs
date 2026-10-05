// Asking a member to check in, run through main.js on both ends of the wire.
import test from "node:test";
import assert from "node:assert/strict";

import { installDom, loadApp, settle } from "./dom-harness.mjs";

const harness = installDom();
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
// A battery the share would report, so a post that leaves it out is seen to.
globalThis.navigator.getBattery = async () => ({ level: 0.5 });

const { openGeneration } = await import("../app/js/rekey.js");
const { epochAt } = await import("../app/js/ratchet.js");
const { generateIdentity, newSeed, sealMessage, openMessage, buildPost } = await import("../app/js/crypto.js");
const { b64uEncode, b64uDecode } = await import("../app/js/wire.js");
const { dbSet, wipeAll } = await import("../app/js/store.js");
const { ASK_GAP_MS } = await import("../app/js/checkin.js");

test.after(() => harness.stopTimers());

const ok = (obj) => ({ ok: true, status: 200, json: async () => obj });

// This device and one peer in a fresh generation; every post this device makes is kept.
async function circleWith(self, peer) {
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
    sosActive: false,
    pinned: new Map(),
    me: null,
    identity: self,
  });
  await dbSet("identity", self);
  const seed = newSeed();
  const e0 = epochAt(Date.now());
  state.gen = await openGeneration({ seed: new Uint8Array(seed), g: 0, e0 });
  state.gen.at = Date.now();
  const peerGen = await openGeneration({ seed: new Uint8Array(seed), g: 0, e0 });
  assert.ok(
    await internals.addPinned({ alg: peer.alg, pk: b64uEncode(peer.pk), epk: b64uEncode(peer.epk), name: "Peer" }),
  );
  state.genRoster = new Set(state.pinned.keys());
  const posted = [];
  harness.onFetch(async (url, init) => {
    if (!/\/api\/v2\/f\/[0-9a-f]{32}/.test(url)) return null;
    if (init?.method === "POST") {
      posted.push(JSON.parse(init.body));
      return ok({ ok: true, now: Date.now() });
    }
    return ok({ now: Date.now(), members: [] });
  });
  internals.setupNet();
  await settle(50);
  window.__starlingErrors.length = 0;
  return { peerGen, posted };
}

// What the peer reads out of one of this device's posts.
async function opened(peerGen, post) {
  const key = await peerGen.ratchet.keyFor(post.e, post.m, post.ts);
  return openMessage(key, peerGen.channelId, post.m, post.e, post.ts, b64uDecode(post.n), b64uDecode(post.c));
}

let lastTs = Date.now();
async function peerPost(peer, peerGen, fields) {
  const ts = (lastTs = Math.max(Date.now(), lastTs + 1));
  const e = epochAt(ts);
  const key = await peerGen.ratchet.keyFor(e, peer.memberId, ts);
  const sealed = await sealMessage(key, peerGen.channelId, peer.memberId, e, ts, { v: 2, ts, name: "Juno", ...fields });
  const post = await buildPost(peer, peerGen.channelId, e, sealed, ts);
  await internals.roster().ingest([
    {
      m: peer.memberId,
      alg: peer.alg,
      pk: b64uEncode(peer.pk),
      epk: b64uEncode(peer.epk),
      points: [{ e: post.e, ts: post.ts, srv: post.ts, n: post.n, c: post.c, sig: post.sig }],
    },
  ]);
  internals.checkAlerts();
  return ts;
}

const toastTexts = () => harness.node("#toasts").children.map((n) => n.textContent);
const askAlerts = () => internals.alertItems().filter((a) => a.id.startsWith("ask:"));

test("the member asked is told once per ask, however many posts carry it", async () => {
  const self = await generateIdentity();
  const peer = await generateIdentity();
  const { peerGen, posted } = await circleWith(self, peer);
  harness.node("#toasts").children.length = 0;

  const ak = Date.now();
  const mine = { t: "loc", lat: 1, lon: 2, ask: self.memberId.slice(0, 8), ak };
  await peerPost(peer, peerGen, mine);
  await peerPost(peer, peerGen, mine);
  await peerPost(peer, peerGen, mine);
  assert.deepEqual(toastTexts(), ["Juno asked you to check in"], "one toast across three posts");
  assert.equal(askAlerts().length, 1, "and one card");

  const card = askAlerts()[0];
  card.actions.find((a) => a.testid === "alert-ask-checkin").onClick();
  await settle(100);
  assert.equal(askAlerts().length, 0, "the card goes once it is answered");
  const reply = await opened(peerGen, posted.at(-1));
  assert.equal(reply.t, "checkin", "and the answer is an ordinary check-in");

  await peerPost(peer, peerGen, { ...mine, ak: ak + 1000 });
  assert.equal(toastTexts().length, 2, "a second ask inside ten minutes is not announced again");
  assert.equal(askAlerts().length, 0);
});

test("an ask aimed at someone else does nothing here", async () => {
  const self = await generateIdentity();
  const peer = await generateIdentity();
  const { peerGen } = await circleWith(self, peer);
  harness.node("#toasts").children.length = 0;
  const other = self.memberId[0] === "0" ? "1" : "0";
  await peerPost(peer, peerGen, { t: "loc", lat: 1, lon: 2, ask: other + self.memberId.slice(1, 8), ak: Date.now() });
  assert.deepEqual(toastTexts(), []);
  assert.deepEqual(askAlerts(), []);
});

test("asking from a phone that is not sharing posts one bye with no position and no battery", async () => {
  const self = await generateIdentity();
  const peer = await generateIdentity();
  const { peerGen, posted } = await circleWith(self, peer);
  await peerPost(peer, peerGen, { t: "loc", lat: 1, lon: 2 });
  state.me = { lat: 45.5, lon: -122.6, acc: 8, ts: Date.now() - 3_600_000 };

  assert.equal(internals.askState(peer.memberId), "ready");
  assert.equal(await internals.askToCheckIn(peer.memberId), true);
  assert.equal(posted.length, 1);
  const sent = await opened(peerGen, posted[0]);
  assert.equal(sent.t, "bye");
  assert.equal(sent.ask, peer.memberId.slice(0, 8));
  assert.ok(Math.abs(sent.ak - Date.now()) < 5000);
  for (const field of ["lat", "lon", "acc", "bat"]) assert.equal(field in sent, false, `${field} stays home`);

  assert.equal(internals.askState(peer.memberId), "asked");
  assert.equal(await internals.askToCheckIn(peer.memberId), false, "one ask per member per ten minutes");
  assert.equal(posted.length, 1);
  assert.ok(ASK_GAP_MS >= 10 * 60 * 1000);
});

test("a sharing phone carries the ask on its own posts", async () => {
  const self = await generateIdentity();
  const peer = await generateIdentity();
  const { peerGen, posted } = await circleWith(self, peer);
  await peerPost(peer, peerGen, { t: "loc", lat: 1, lon: 2 });
  state.me = { lat: 45.5, lon: -122.6, acc: 8, ts: Date.now() };
  state.sharing = true;
  try {
    assert.equal(await internals.askToCheckIn(peer.memberId), true);
    await settle(200);
    const sent = await opened(peerGen, posted.at(-1));
    assert.equal(sent.t, "loc");
    assert.equal(sent.ask, peer.memberId.slice(0, 8));
    assert.equal(sent.lat, 45.5, "a share keeps sending its position as before");
  } finally {
    state.sharing = false;
  }
});

test("there is no ask button in the demo, while locked, or for yourself", async () => {
  const self = await generateIdentity();
  const peer = await generateIdentity();
  const { peerGen } = await circleWith(self, peer);
  await peerPost(peer, peerGen, { t: "loc", lat: 1, lon: 2 });
  assert.equal(internals.askState(self.memberId), null);
  state.demo = true;
  assert.equal(internals.askState(peer.memberId), null);
  state.demo = false;
  state.locked = true;
  assert.equal(internals.askState(peer.memberId), null);
  state.locked = false;
  assert.equal(internals.askState(peer.memberId), "ready");
});
