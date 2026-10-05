// A nickname is applied once, where members() reads the roster, because cards,
// markers, toasts and checkAlerts all read rec.name straight off it. These run
// the real main.js so a path that skipped the nickname would show here.
import test from "node:test";
import assert from "node:assert/strict";

import { installDom, loadApp, settle } from "./dom-harness.mjs";

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

const { internals, api } = await loadApp(harness);
const state = internals.state;
const { openGeneration } = await import("../app/js/rekey.js");
const { epochAt } = await import("../app/js/ratchet.js");
const { generateIdentity, newSeed, sealMessage, buildPost } = await import("../app/js/crypto.js");
const { b64uEncode } = await import("../app/js/wire.js");
const { dbGet, dbSet, wipeAll } = await import("../app/js/store.js");
const { pinnedMap } = await import("../app/js/circles.js");

test.after(() => harness.stopTimers());

const ok = (obj) => ({ ok: true, status: 200, json: async () => obj });
harness.onFetch(async (url, init) => (init?.method === "POST" ? ok({ ok: true, now: Date.now() }) : null));

async function circleWith(peer) {
  await wipeAll();
  state.demo = false;
  state.locked = false;
  state.lock = null;
  state.vaultKey = null;
  state.chainDestroyed = false;
  state.circles = [];
  state.keyChanges.clear();
  state.identity = await generateIdentity();
  await dbSet("identity", state.identity);
  state.gen = await openGeneration({ seed: new Uint8Array(newSeed()), g: 0, e0: epochAt(Date.now()) });
  state.gen.at = Date.now();
  state.pinned = new Map();
  assert.ok(await internals.addPinned({ alg: peer.alg, pk: b64uEncode(peer.pk), epk: b64uEncode(peer.epk), name: "Ana" }));
  state.genRoster = new Set(state.pinned.keys());
  await internals.enterCircle();
  await settle();
}

async function post(who, fields) {
  const gen = state.gen;
  const ts = Date.now();
  const e = epochAt(ts);
  const key = await gen.ratchet.keyFor(e, who.memberId, ts);
  const sealed = await sealMessage(key, gen.channelId, who.memberId, e, ts, { v: 2, ts, lat: 40, lon: -75, acc: 5, ...fields });
  const p = await buildPost(who, gen.channelId, e, sealed, ts);
  await internals.roster().ingest(
    [{ m: who.memberId, alg: who.alg, pk: b64uEncode(who.pk), epk: b64uEncode(who.epk), points: [{ e: p.e, ts: p.ts, srv: p.ts, n: p.n, c: p.c, sig: p.sig }] }],
    ts,
  );
}

const toasts = () => harness.node("#toasts").children.map((n) => n.textContent);

test("a nickname is the name every screen and alert uses, and the posted name rides along", async () => {
  const peer = await generateIdentity();
  await circleWith(peer);
  await post(peer, { t: "loc", name: "Mom" });
  assert.equal(api.members()[0].name, "Mom", "no nickname, the posted name");

  assert.equal(await api.setNickname(peer.memberId, "  Aunt Jo  "), true);
  const [live] = api.members();
  assert.equal(live.name, "Aunt Jo");
  assert.equal(live.posted, "Mom", "what they call themselves is still at hand");
  assert.equal(internals.roster().list()[0].name, "Mom", "the roster's own record is not rewritten");

  const before = toasts().length;
  await post(peer, { t: "sos", name: "Mom" });
  internals.checkAlerts();
  assert.deepEqual(toasts().slice(before), ["SOS from Aunt Jo"], "checkAlerts reads the nickname too");
});

test("a nickname is written down with the roster, and an empty one clears it", async () => {
  const peer = await generateIdentity();
  await circleWith(peer);
  await api.setNickname(peer.memberId, "Gran");
  await settle();
  assert.equal(pinnedMap(await dbGet("pinned")).get(peer.memberId).nick, "Gran");

  await api.setNickname(peer.memberId, "   ");
  await settle();
  assert.ok(!("nick" in state.pinned.get(peer.memberId)));
  assert.ok(!("nick" in pinnedMap(await dbGet("pinned")).get(peer.memberId)));
  assert.equal(await api.setNickname("f".repeat(32), "Nobody"), false, "only for someone pinned");
});

test("the key-change banner and the quiet card use the nickname when nothing is live", async () => {
  const peer = await generateIdentity();
  await circleWith(peer);
  await api.setNickname(peer.memberId, "Gran");
  const quiet = harness.node("#quiet-list").children;
  assert.equal(quiet[0].children[1].children[0].textContent, "Gran");

  state.keyChanges.set(peer.memberId, { presented: {}, at: Date.now() });
  internals.render();
  assert.equal(harness.node("#banner-keys-text").textContent, "Gran's keys changed");
  state.keyChanges.clear();
});

test("a re-key carries the nickname into the new generation and onto disk", async () => {
  const peer = await generateIdentity();
  await circleWith(peer);
  await api.setNickname(peer.memberId, "Gran");
  const g = state.gen.g;
  assert.equal(await api.rekeyCircle(), true, "the re-key went through");
  assert.equal(state.gen.g, g + 1);
  assert.equal(state.pinned.get(peer.memberId).nick, "Gran");
  await settle();
  assert.equal(pinnedMap(await dbGet("pinned")).get(peer.memberId).nick, "Gran", "the roster the new generation wrote");
  assert.equal(await dbGet("genNext"), undefined, "and the staged slot it went through is gone again");
});

test("adopting somebody else's re-key keeps the nickname and says it in the toast", async () => {
  const peer = await generateIdentity();
  await circleWith(peer);
  await api.setNickname(peer.memberId, "Gran");
  const applied = { seed: new Uint8Array(newSeed()), g: state.gen.g + 1, e0: epochAt(Date.now()), rh: null, removed: [], by: peer.memberId };
  const before = toasts().length;
  assert.equal(await internals.adoptRekey(applied, peer.memberId), true);
  assert.equal(state.pinned.get(peer.memberId).nick, "Gran");
  assert.ok(toasts().slice(before).includes("Gran changed the keys."));
  await settle();
  assert.equal(pinnedMap(await dbGet("pinned")).get(peer.memberId).nick, "Gran");
});

test("People and keys shows the nickname, the name they post under, and who sees it", async () => {
  const ui = await import("../app/js/ui.js");
  const peer = await generateIdentity();
  await circleWith(peer);
  await post(peer, { t: "loc", name: "Mom" });
  const find = (n, pred) => (pred(n) ? n : (n.children || []).reduce((hit, c) => hit || find(c, pred), null));
  const sheet = ui.openMembersSheet({ api, onClose() {} });
  const row = () => find(harness.node("#overlays"), (n) => n.dataset?.testid === "member-row" && n.dataset.member === peer.memberId);
  const input = () => find(row(), (n) => n.dataset?.testid === "member-nick");
  const note = () => {
    const field = find(row(), (n) => n.children?.includes(input()));
    return row().children[row().children.indexOf(field) + 1];
  };
  assert.equal(input().value, "");
  assert.equal(input().placeholder, "Mom");
  assert.equal(note().textContent, "Only this phone sees this name.");

  await api.setNickname(peer.memberId, "Gran");
  sheet.refresh();
  assert.equal(find(row(), (n) => n.dataset?.testid === "member-row-name").textContent, "Gran");
  assert.equal(input().value, "Gran");
  assert.equal(note().textContent, "Only this phone sees this name. In the circle they go by Mom.");
  sheet.close();
});
