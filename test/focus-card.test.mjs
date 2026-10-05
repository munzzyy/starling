// The member card on the map, as a screen reader and a keyboard meet it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installDom, loadApp, settle } from "./dom-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const harness = installDom({ interactive: true });

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

async function memberEntry(gen, who, fields, ts) {
  const e = epochAt(ts);
  const key = await gen.ratchet.keyFor(e, who.memberId, ts);
  const sealed = await sealMessage(key, gen.channelId, who.memberId, e, ts, { v: 2, ts, ...fields });
  const post = await buildPost(who, gen.channelId, e, sealed, ts);
  return {
    m: who.memberId,
    alg: who.alg,
    pk: b64uEncode(who.pk),
    epk: b64uEncode(who.epk),
    points: [{ e: post.e, ts: post.ts, srv: post.ts, n: post.n, c: post.c, sig: post.sig }],
  };
}

// Counts every write, so "unchanged" means nobody touched it, not that the same words went in again.
function watch(node) {
  let value = node.textContent;
  const writes = [];
  Object.defineProperty(node, "textContent", {
    configurable: true,
    get: () => value,
    set: (v) => {
      value = v;
      writes.push(v);
    },
  });
  return writes;
}

const said = harness.node("#focus-said");
const writes = watch(said);
const focusCard = harness.node("#focus-card");
let who;
let t0;
const realNow = Date.now;

test("the card is a region with a name and no live region of its own", () => {
  const html = readFileSync(path.join(ROOT, "app/index.html"), "utf8");
  const card = html.match(/<div[^>]*\bid="focus-card"[^>]*>/)[0];
  assert.doesNotMatch(card, /aria-live/, "render() rewrites the card every five seconds");
  assert.match(card, /role="region"/);
  assert.match(card, /aria-label="Member details"/);
  assert.match(card, /tabindex="-1"/, "focusable from script, not a tab stop");
  const status = html.match(/<div[^>]*\bid="focus-said"[^>]*>/)?.[0] || "";
  assert.match(status, /role="status"/);
  assert.match(status, /class="vh"/, "heard, not seen");
});

test("Enter on a member card opens the focus card with focus on it, and says who and how once", async () => {
  state.demo = false;
  state.locked = false;
  state.identity = await generateIdentity();
  state.gen = await openGeneration({ seed: new Uint8Array(newSeed()), g: 0, e0: epochAt(Date.now()) });
  state.gen.at = Date.now();
  state.genRoster = new Set();
  state.pinned = new Map();
  internals.setupNet();
  await internals.enterCircle();
  await settle();
  assert.equal(state.screen, "map");

  who = await generateIdentity();
  t0 = Date.now();
  await internals.roster().ingest([await memberEntry(state.gen, who, { t: "loc", name: "Juno", lat: 40.78, lon: -73.97 }, t0)], t0);
  internals.render();
  const card = harness.node("#member-list").children.find((n) => n.dataset.member === who.memberId);
  assert.ok(card, "the member card is on the list");

  writes.length = 0;
  card.dispatchEvent({ type: "keydown", key: "Enter", preventDefault() {} });
  assert.equal(focusCard.hidden, false);
  assert.equal(document.activeElement, focusCard, "a keyboard user lands on what they opened");
  assert.deepEqual(writes, ["Juno, Live"]);
});

test("a repaint ten seconds later says nothing new", () => {
  try {
    Date.now = () => t0 + 10_000;
    internals.render();
    Date.now = () => t0 + 20_000;
    internals.render();
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(writes, ["Juno, Live"], "the age and distance on the card moved, the status line did not");
});

test("an SOS from the focused member is said once, however many repaints follow", async () => {
  const ts = t0 + 30_000;
  await internals.roster().ingest([await memberEntry(state.gen, who, { t: "sos", name: "Juno", lat: 40.78, lon: -73.97 }, ts)], ts);
  try {
    Date.now = () => ts + 1000;
    internals.render();
    Date.now = () => ts + 6000;
    internals.render();
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(writes, ["Juno, Live", "Juno, SOS"]);
});

test("closing the card puts focus back on that member's card in the list", () => {
  const card = harness.node("#member-list").children.find((n) => n.dataset.member === who.memberId);
  const close = focusCard.children[0].children[2];
  assert.equal(close.className, "icon-btn fc-close");
  close.dispatchEvent({ type: "click" });
  assert.equal(focusCard.hidden, true);
  assert.equal(document.activeElement, card);
  assert.equal(said.textContent, "", "nothing focused, nothing left to find in the status line");
});

test("a tap that opens the card leaves focus where it was", () => {
  const card = harness.node("#member-list").children.find((n) => n.dataset.member === who.memberId);
  document.activeElement = document.body;
  card.dispatchEvent({ type: "click" });
  assert.equal(focusCard.hidden, false);
  assert.equal(document.activeElement, document.body, "only the keyboard path moves focus");
  focusCard.children[0].children[2].dispatchEvent({ type: "click" });
  assert.equal(document.activeElement, document.body, "and closing a card focus never entered does not pull it into the list");
});
