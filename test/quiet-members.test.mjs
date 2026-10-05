// A member whose phone has been quiet for a day drops out of the roster, and
// the sheet used to fall back to "Just you here so far", which sent people off
// to mint invites for a circle that already had them in it.
import test from "node:test";
import assert from "node:assert/strict";

import { installDom, loadApp } from "./dom-harness.mjs";

const harness = installDom();

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

const { internals } = await loadApp(harness);
const state = internals.state;
const { openGeneration } = await import("../app/js/rekey.js");
const { epochAt } = await import("../app/js/ratchet.js");
const { generateIdentity, newSeed, sealMessage, buildPost } = await import("../app/js/crypto.js");
const { b64uEncode } = await import("../app/js/wire.js");

test.after(() => harness.stopTimers());

const pinOf = (who, name) => ({
  memberId: who.memberId,
  alg: who.alg,
  pk: b64uEncode(who.pk),
  epk: b64uEncode(who.epk),
  verified: false,
  name,
});

async function circleOf(others) {
  state.demo = false;
  state.locked = false;
  state.lock = null;
  state.identity = await generateIdentity();
  state.gen = await openGeneration({ seed: new Uint8Array(newSeed()), g: 0, e0: epochAt(Date.now()) });
  state.gen.at = Date.now();
  state.genRoster = new Set();
  state.pinned = new Map();
  state.pinned.set(state.identity.memberId, pinOf(state.identity, "Me"));
  for (const [who, name] of others) state.pinned.set(who.memberId, pinOf(who, name));
  await internals.enterCircle();
  assert.equal(state.screen, "map");
  assert.equal(internals.roster().list().length, 0, "nobody has posted anything");
}

const nudge = () => harness.node("#nudge");
const quietList = () => harness.node("#quiet-list");
const cardName = (card) => card.children[1].children[0].textContent;

test("a pinned member with nothing on the map keeps a card, and the nudge stays down", async () => {
  const ana = await generateIdentity();
  await circleOf([[ana, "Ana"]]);
  assert.equal(nudge().hidden, true, "the circle is not empty, so it does not say so");
  const cards = quietList().children;
  assert.equal(cards.length, 1, "one quiet card, and none for this phone");
  assert.equal(cards[0].dataset.member, ana.memberId);
  assert.equal(cardName(cards[0]), "Ana");
  assert.equal(cards[0].children[0].children[0].textContent, "A", "the avatar is the first letter");
  assert.match(cards[0].getAttribute("aria-label"), /^Ana, No recent update$/);
  assert.equal(quietList().hidden, false);
});

test("a circle of one still gets the nudge and no quiet cards", async () => {
  await circleOf([]);
  assert.equal(nudge().hidden, false);
  assert.equal(quietList().children.length, 0);
  assert.equal(quietList().hidden, true);
});

test("the demo draws no quiet cards over a real roster", async () => {
  const ana = await generateIdentity();
  await circleOf([[ana, "Ana"]]);
  internals.startDemo();
  try {
    assert.equal(state.demo, true);
    assert.equal(quietList().children.length, 0, "the real roster stays out of the demo");
    assert.equal(quietList().hidden, true);
  } finally {
    internals.exitDemo();
  }
  assert.equal(quietList().children.length, 1, "and it is back once the demo ends");
});

test("a member who posts leaves the quiet list for the live one", async () => {
  const ana = await generateIdentity();
  const bo = await generateIdentity();
  await circleOf([[ana, "Ana"], [bo, "Bo"]]);
  const before = quietList().children;
  assert.deepEqual(before.map(cardName), ["Ana", "Bo"]);

  const gen = state.gen;
  const ts = Date.now();
  const e = epochAt(ts);
  const key = await gen.ratchet.keyFor(e, ana.memberId, ts);
  const sealed = await sealMessage(key, gen.channelId, ana.memberId, e, ts, { v: 2, ts, t: "loc", name: "Ana", lat: 40, lon: -75, acc: 5 });
  const post = await buildPost(ana, gen.channelId, e, sealed, ts);
  await internals.roster().ingest(
    [{ m: ana.memberId, alg: ana.alg, pk: b64uEncode(ana.pk), epk: b64uEncode(ana.epk), points: [{ e: post.e, ts: post.ts, srv: post.ts, n: post.n, c: post.c, sig: post.sig }] }],
    ts,
  );
  internals.render();
  assert.deepEqual(quietList().children.map(cardName), ["Bo"]);
  assert.equal(quietList().children[0], before[1], "the card left standing is the same node, not a rebuilt one");
  assert.equal(nudge().hidden, true);
});

test("locking takes the quiet cards down with everything else", async () => {
  const ana = await generateIdentity();
  await circleOf([[ana, "Ana"]]);
  assert.equal(quietList().children.length, 1);
  state.lock = { enabled: true, autolockMs: 60_000 };
  internals.lockNow();
  assert.equal(state.screen, "lock");
  assert.equal(quietList().children.length, 0, "no name is left behind the lock screen");
  assert.equal(quietList().hidden, true);
  state.lock = null;
  state.locked = false;
});
