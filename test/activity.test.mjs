// Show what I'm doing: an opt-in word (still, walking, cycling, driving) on
// your own posts, worked out on the phone from fix speeds and the still
// detector. No permission, no Play services, and it never leaves the
// ciphertext; the padding budget for it lives in crypto.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { installDom, loadApp, settle } from "./dom-harness.mjs";
import { activityFor, medianSpeed, ACTIVITIES } from "../app/js/geo.js";
import { actFrom } from "../app/js/net.js";

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
const defaults = { ...state.settings };
const ui = await import("../app/js/ui.js");
const i18n = await import("../app/js/i18n.js");
const { openGeneration } = await import("../app/js/rekey.js");
const { epochAt } = await import("../app/js/ratchet.js");
const { generateIdentity, newSeed, openMessage, sealMessage, buildPost } = await import("../app/js/crypto.js");
const { b64uDecode, b64uEncode } = await import("../app/js/wire.js");

test.after(() => {
  delete globalThis.StarlingNative;
  i18n.setLocale("en");
  harness.stopTimers();
});

test("speeds name the four words, with room past each edge before the word changes", () => {
  assert.deepEqual(ACTIVITIES, ["s", "w", "c", "d"]);
  assert.equal(activityFor(null, 0.2), "s");
  assert.equal(activityFor(null, 1.4), "w");
  assert.equal(activityFor(null, 5), "c");
  assert.equal(activityFor(null, 15), "d");
  assert.equal(activityFor("w", 2.6), "w", "just past the walking edge is still walking");
  assert.equal(activityFor("w", 2.9), "c");
  assert.equal(activityFor("c", 2.2), "c", "and just under it is still cycling");
  assert.equal(activityFor("c", 2.0), "w");
  assert.equal(activityFor("d", 7.2), "d");
  assert.equal(activityFor("d", 6.5), "c");
  assert.equal(activityFor("s", 0.65), "s");
  assert.equal(activityFor("s", 3), "c", "a big jump goes straight to where the speed is");
  for (const bad of [null, undefined, NaN, -1, "3"]) assert.equal(activityFor("w", bad), null);
});

test("one speed reading names nothing; two or more give their median", () => {
  assert.equal(medianSpeed([]), null);
  assert.equal(medianSpeed([12]), null);
  assert.equal(medianSpeed([1, 3]), 2);
  assert.equal(medianSpeed([0.2, 14, 1.1]), 1.1, "one wild reading does not move it");
  assert.equal(medianSpeed([NaN, -2, 4]), null);
});

test("a receiver keeps only the four letters", () => {
  for (const a of ["s", "w", "c", "d"]) assert.equal(actFrom({ act: a }), a);
  for (const bad of ["S", "x", "walking", "", 1, null, ["w"], { w: 1 }]) assert.equal(actFrom({ act: bad }), null, String(bad));
  assert.equal(actFrom({}), null);
  assert.equal(actFrom(null), null);
});

test("the switch starts off", () => {
  assert.equal(defaults.showActivity, false);
});

const HERE = { lat: 40.785, lon: -73.968 };
const push = (o) => globalThis.__starlingFix(JSON.stringify(o));
const posts = [];
harness.onFetch(async (url, init) => {
  if (state.gen && url.includes(`/f/${state.gen.channelId}/loc`)) posts.push(init.body);
  return undefined;
});

async function openOwnPost(body) {
  const p = JSON.parse(body);
  const key = await state.gen.ratchet.keyFor(p.e, state.identity.memberId, p.ts);
  return openMessage(key, state.gen.channelId, state.identity.memberId, p.e, p.ts, b64uDecode(p.n), b64uDecode(p.c));
}

async function sharing({ showActivity = true, places = [], precision = null } = {}) {
  if (state.sharing) await internals.setSharing(false);
  globalThis.StarlingNative = {
    startLocation: () => {},
    stopLocation: () => {},
    setShareCadence: () => {},
    setStillMode: () => {},
    clearStopRecord: () => {},
    keepSharing: () => false,
    setKeepSharing: () => {},
    windowShown: () => false,
    pulse: () => {},
  };
  internals.resetShareResumeGuard();
  state.demo = false;
  state.locked = false;
  state.stopRecord = null;
  state.sosActive = false;
  state.settings = { ...state.settings, showActivity, stillSave: true, steady: false };
  state.circleShare = { precision, cadence: 15 };
  state.places = places;
  state.identity = state.identity || (await generateIdentity());
  if (!state.gen) {
    state.gen = await openGeneration({ seed: new Uint8Array(newSeed()), g: 0, e0: epochAt(Date.now()) });
    state.gen.at = Date.now();
    state.genRoster = new Set();
    state.pinned = new Map();
  }
  internals.setupNet();
  await internals.setSharing(true);
}

// A fixed pause lost the race on a slow Windows runner, so wait for the sender to go quiet.
const idle = () => internals.sendStatus().busy === 0;
async function until(ok, what, ms = 10000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await settle(10);
  }
}

async function postWith(speeds) {
  for (const spd of speeds) push({ ...HERE, acc: 5, spd, ts: Date.now() });
  await settle();
  await until(idle, "the sender to go idle");
  const before = posts.length;
  await internals.sendLoc(true);
  await until(() => idle() && posts.length > before, "a new post");
  return openOwnPost(posts.at(-1));
}

test("your posts carry the word only with the switch on, and only when the speeds say enough", async () => {
  await sharing({ showActivity: false });
  assert.equal((await postWith([1.3, 1.5, 1.4])).act, undefined, "off sends nothing");

  await sharing();
  assert.equal((await postWith([1.3, 1.5, 1.4])).act, "w");
  await sharing();
  assert.equal((await postWith([16, 17, 15])).act, "d");
  await sharing();
  assert.equal((await postWith([16])).act, undefined, "one reading is not enough to name it");
  await sharing();
  assert.equal((await postWith([null, null])).act, undefined, "a fix with no speed says nothing either");
  await internals.setSharing(false);
});

test("still mode says still, and a privacy fence leaves the word off", async () => {
  await sharing();
  await until(idle, "the sender to go idle");
  const before = posts.length;
  push({ ...HERE, acc: 5, spd: 16, ts: Date.now() });
  push({ ...HERE, acc: 5, spd: 16, ts: Date.now() });
  push({ still: true });
  await settle();
  await until(() => idle() && posts.length > before, "the post the still word sends");
  assert.equal((await openOwnPost(posts.at(-1))).act, "s", "the post that starts the slow pace already says still");

  const home = { id: "aaaaaaaa", name: "Home", lat: HERE.lat, lon: HERE.lon, radius: 250, fence: true };
  await sharing({ places: [home] });
  const fenced = await postWith([1.3, 1.5]);
  assert.equal(fenced.act, undefined);
  assert.equal(fenced.lat, home.lat, "negative control: the fence did snap this post");
  await internals.setSharing(false);
  state.places = [];
});

test("a circle set to Neighborhood never gets the word, which would say how you move inside the square", async () => {
  await sharing({ precision: "coarse" });
  const coarse = await postWith([1.3, 1.5, 1.4]);
  assert.equal(coarse.act, undefined);
  assert.equal(coarse.acc, undefined, "it goes the way acc already goes");
  await sharing({ precision: "precise" });
  assert.equal((await postWith([1.3, 1.5, 1.4])).act, "w", "negative control: the same speeds on Precise name it");
  await internals.setSharing(false);
});

test("the word shows under a live member's name, translated, and goes with the presence", async () => {
  const now = Date.now();
  const rec = { id: "m1", name: "Juno", ts: now - 10_000, act: "c" };
  assert.match(ui.memberSubLine(rec, now, null, null, "live"), /^Cycling · /);
  assert.match(ui.memberSubLine(rec, now, null, null, "sos"), /Cycling/);
  assert.doesNotMatch(ui.memberSubLine(rec, now, null, null, "stale"), /Cycling/, "a word from an hour ago is not what they are doing");
  assert.doesNotMatch(ui.memberSubLine(rec, now, null, null, "stopped"), /Cycling/);
  assert.doesNotMatch(ui.memberSubLine({ ...rec, act: "x" }, now, null, null, "live"), /x ·/);
  assert.doesNotMatch(ui.memberSubLine({ ...rec, act: undefined }, now, null, null, "live"), /Still|Walking|Cycling|Driving/);
  const uiSrc = readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8");
  assert.match(uiSrc, /\$\("\.fc-sub", root\)\.textContent = `\$\{t\(CHIP_TEXT\[status\]\)\} · \$\{memberSubLine\(/, "the focus card reads the same line");
  await i18n.loadLocale("es");
  i18n.setLocale("es");
  try {
    assert.match(ui.memberSubLine({ ...rec, act: "w" }, now, null, null, "live"), /^Caminando · /);
  } finally {
    i18n.setLocale("en");
  }
});

test("a member's word comes off the wire, and a post without one clears it", async () => {
  state.demo = false;
  state.identity = await generateIdentity();
  state.gen = await openGeneration({ seed: new Uint8Array(newSeed()), g: 0, e0: epochAt(Date.now()) });
  state.gen.at = Date.now();
  state.genRoster = new Set();
  state.pinned = new Map();
  internals.setupNet();
  const who = await generateIdentity();
  const postAs = async (fields, ts) => {
    const e = epochAt(ts);
    const key = await state.gen.ratchet.keyFor(e, who.memberId, ts);
    const sealed = await sealMessage(key, state.gen.channelId, who.memberId, e, ts, { v: 2, ts, t: "loc", name: "Juno", ...HERE, ...fields });
    const post = await buildPost(who, state.gen.channelId, e, sealed, ts);
    await internals.roster().ingest(
      [{ m: who.memberId, alg: who.alg, pk: b64uEncode(who.pk), epk: b64uEncode(who.epk), points: [{ e: post.e, ts: post.ts, srv: post.ts, n: post.n, c: post.c, sig: post.sig }] }],
      ts,
    );
    return internals.roster().get(who.memberId);
  };
  const t0 = Date.now();
  assert.equal((await postAs({ act: "d" }, t0)).act, "d");
  assert.equal((await postAs({ act: "teleporting" }, t0 + 1000)).act, null);
  assert.equal((await postAs({ act: "w" }, t0 + 2000)).act, "w");
  assert.equal((await postAs({}, t0 + 3000)).act, null, "cleared by omission");
});

function settingsRow({ demo = false } = {}) {
  const host = document.getElementById("overlays");
  const before = host.children.length;
  const ov = ui.openSettingsSheet({
    api,
    values: { circleName: "Home", profile: { name: "", emoji: "x" }, settings: state.settings, share: { precision: "precise", cadence: 15 }, relay: null },
    demo,
    tor: null,
    keepSharing: null,
    shareClock: null,
    still: null,
    background: null,
    forward: null,
    lock: { enabled: false, hasBio: false, hasDuress: false, bioAvailable: false, autolockMs: 60000 },
    lockActions: {},
    onChange() {},
    onClose() {},
  });
  let row = null;
  const walk = (n) => {
    if (!n || typeof n !== "object" || row) return;
    if (n.dataset?.testid === "settings-activity") row = n;
    for (const c of n.children || []) walk(c);
  };
  host.children.slice(before).forEach(walk);
  ov.close?.();
  return row;
}

test("Settings has the switch, off unless turned on, and its note says who sees it", () => {
  state.settings = { ...state.settings, showActivity: false };
  const row = settingsRow();
  assert.ok(row, "shown on every platform: speeds come from the browser too");
  const sw = row.children.find((c) => c.getAttribute?.("role") === "switch");
  assert.equal(sw.getAttribute("aria-checked"), "false");
  const note = row.children[0].children[1].textContent;
  assert.match(note, /only your circle can read it/);
  assert.match(note, /works it out from its own speed/);
  state.settings = { ...state.settings, showActivity: true };
  assert.equal(settingsRow().children.find((c) => c.getAttribute?.("role") === "switch").getAttribute("aria-checked"), "true");
  state.settings = { ...state.settings, showActivity: false };
});

test("the demo has no such switch: it would be saved for real and go out on the next real share", () => {
  state.settings = { ...state.settings, showActivity: false };
  assert.equal(settingsRow({ demo: true }), null);
  assert.ok(settingsRow({ demo: false }), "negative control: the same sheet outside the demo has it");
});
