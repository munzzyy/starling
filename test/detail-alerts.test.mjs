// Issue #28: opt-in, one notification per place event, with the words kept off the lock screen unless chosen.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

test.after(() => {
  delete globalThis.StarlingNative;
  harness.stopTimers();
});

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const kt = (name) => src(`android/app/src/main/kotlin/app/starlingmap/${name}`);

const BASE = { lat: 40.0, lon: -75.0 };
const north = (m) => ({ lat: BASE.lat + m / 111320, lon: BASE.lon });
const HOME = { id: "aaaaaaaa", name: "Home", lat: BASE.lat, lon: BASE.lon, radius: 250 };

async function circleWith(places) {
  state.demo = false;
  state.locked = false;
  state.lock = null;
  state.settings = { ...state.settings, placeAlerts: true, batAlerts: true };
  state.identity = await generateIdentity();
  state.gen = await openGeneration({ seed: new Uint8Array(newSeed()), g: 0, e0: epochAt(Date.now()) });
  state.gen.at = Date.now();
  state.genRoster = new Set();
  state.pinned = new Map();
  internals.setupNet();
  internals.resetMemberAlerts();
  state.places = places;
  await internals.savePlaces();
}

async function postAs(who, fields, ts = Date.now()) {
  const gen = state.gen;
  const e = epochAt(ts);
  const key = await gen.ratchet.keyFor(e, who.memberId, ts);
  const sealed = await sealMessage(key, gen.channelId, who.memberId, e, ts, { v: 2, ts, name: "Juno", acc: 5, mode: "precise", ...fields });
  const post = await buildPost(who, gen.channelId, e, sealed, ts);
  await internals.roster().ingest(
    [{ m: who.memberId, alg: who.alg, pk: b64uEncode(who.pk), epk: b64uEncode(who.epk), points: [{ e: post.e, ts: post.ts, srv: post.ts, n: post.n, c: post.c, sig: post.sig }] }],
    ts,
  );
}

async function at(ts, fn) {
  const realNow = Date.now;
  Date.now = () => ts + 500;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}


function bridge({ detail = true } = {}) {
  const calls = [];
  globalThis.StarlingNative = {
    windowShown: () => false,
    notify: () => {},
    cancelNotify: () => {},
    notifyKind: (title, body, tag, kind) => calls.push({ via: "kind", title, body, tag, kind }),
    takeOpenMember: () => calls.opened ?? "",
  };
  if (detail) {
    globalThis.StarlingNative.notifyDetail = (title, body, tag, kind, member, onLock) =>
      calls.push({ via: "detail", title, body, tag, kind, member, onLock });
  }
  return calls;
}

async function walkInAndOut({ bridge: wrapper, ...settings }) {
  await circleWith([HOME]);
  state.settings = { ...state.settings, ...settings };
  const calls = bridge(wrapper);
  const who = await generateIdentity();
  const t0 = Date.now();
  await postAs(who, { t: "loc", ...north(2000) }, t0);
  await at(t0, () => internals.checkAlerts());
  await postAs(who, { t: "loc", ...BASE }, t0 + 60_000);
  await at(t0 + 60_000, () => internals.checkAlerts());
  await postAs(who, { t: "loc", ...north(2000) }, t0 + 210_000);
  await at(t0 + 210_000, () => internals.checkAlerts());
  return { calls, who };
}

test("the setting starts off, so place alerts stay generic and collapsed", async () => {
  assert.equal(state.settings.detailAlerts, false);
  assert.equal(state.settings.detailOnLock, false);
  const { calls } = await walkInAndOut({ detailAlerts: false });
  assert.deepEqual(calls.map((c) => [c.via, c.tag.startsWith("place-")]), [["kind", true], ["kind", true]]);
  assert.equal(calls[0].tag, calls[1].tag, "one id per member, as before");
});

test("with the setting on, every event is its own notification with name, place and time", async () => {
  const { calls, who } = await walkInAndOut({ detailAlerts: true, detailOnLock: false });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.via === "detail"));
  assert.deepEqual(calls.map((c) => [c.title, c.kind]), [["Juno arrived at Home", "arrive"], ["Juno left Home", "leave"]]);
  assert.notEqual(calls[0].tag, calls[1].tag, "no upsert");
  for (const c of calls) {
    assert.ok(c.tag.length <= 64);
    assert.match(c.body, /\d/, "carries a time");
    assert.equal(c.member, who.memberId);
    assert.equal(c.onLock, false);
  }
});

test("two events in the same millisecond still get different ids", async () => {
  const { calls } = await walkInAndOut({ detailAlerts: true });
  const again = await walkInAndOut({ detailAlerts: true });
  assert.equal(new Set([...calls, ...again.calls].map((c) => c.tag)).size, 4);
});

test("the lock screen choice rides along, and an older wrapper falls back to the generic path", async () => {
  const lock = await walkInAndOut({ detailAlerts: true, detailOnLock: true });
  assert.ok(lock.calls.every((c) => c.onLock === true));
  const old = await walkInAndOut({ detailAlerts: true, bridge: { detail: false } });
  assert.deepEqual(old.calls.map((c) => c.via), ["kind", "kind"]);
});

test("Android: no detail keeps the generic words, detail keeps the lock screen generic unless chosen", () => {
  const events = kt("Events.kt");
  const show = events.slice(events.indexOf("private fun show"), events.indexOf("private fun buildChannel"));
  assert.match(show, /val publicText = if \(detail == null\) text else if \(detail\.onLock\) detail\.body else ctx\.getString\(R\.string\.notif_place_text\)/);
  assert.match(show, /val publicHeading = if \(detail\?\.onLock == true\) heading else ctx\.getString\(titleRes\)/);
  assert.match(show, /\.setVisibility\(NotificationCompat\.VISIBILITY_PRIVATE\)\s*\.setPublicVersion\(publicVersion\)/);
  const post = events.slice(events.indexOf("fun post("), events.indexOf("fun postDetail"));
  assert.doesNotMatch(post, /Detail\(/, "the old path never carries caller text");
  assert.match(events, /if \(detail == null\) 0 else tag\.hashCode\(\)/, "a request code per notification");
  assert.match(events, /putExtra\(MainActivity\.EXTRA_MEMBER, detail\.member\)/);
  for (const dir of ["values", "values-de", "values-fr", "values-es", "values-pt"]) {
    assert.match(src(`android/app/src/main/res/${dir}/strings.xml`), /name="notif_place_text"/, dir);
  }
  assert.match(src("android/app/src/main/res/values/strings.xml"), /name="notif_place_text">A place update</);
});

test("a tapped notification selects that member, but never around the lock", async () => {
  await circleWith([HOME]);
  const calls = bridge();
  const who = await generateIdentity();
  const t0 = Date.now();
  await postAs(who, { t: "loc", ...BASE }, t0);
  calls.opened = who.memberId;
  state.locked = true;
  await at(t0, () => globalThis.__starlingOpenMember());
  assert.equal(internals.focusedMember(), null, "locked: nothing opens");
  state.locked = false;
  calls.opened = "not-a-member";
  await at(t0, () => globalThis.__starlingOpenMember());
  assert.equal(internals.focusedMember(), null, "an unknown id opens nothing");
  calls.opened = who.memberId;
  await at(t0, () => globalThis.__starlingOpenMember());
  assert.equal(internals.focusedMember(), who.memberId, "the member is selected");
});
