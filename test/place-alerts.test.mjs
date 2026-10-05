// Per-place alert choices through the real roster and checkAlerts.
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

const { internals, api } = await loadApp(harness);
const state = internals.state;
const { openGeneration } = await import("../app/js/rekey.js");
const { epochAt } = await import("../app/js/ratchet.js");
const { generateIdentity, newSeed, sealMessage, buildPost } = await import("../app/js/crypto.js");
const { b64uEncode } = await import("../app/js/wire.js");

test.after(() => {
  delete globalThis.StarlingNative;
  harness.stopTimers();
});

const BASE = { lat: 40.0, lon: -75.0 };
const north = (m) => ({ lat: BASE.lat + m / 111320, lon: BASE.lon });

async function circleWith(places) {
  state.demo = false;
  state.locked = false;
  state.lock = null;
  state.settings = { ...state.settings, placeAlerts: true };
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

// Far away, into the place, and back out; returns the place notifications.
async function walk(who) {
  const calls = [];
  globalThis.StarlingNative = {
    windowShown: () => false,
    notify: (title, body, tag) => {
      if (tag === `place-${who.memberId}`) calls.push(title);
    },
    cancelNotify: () => {},
  };
  const t0 = Date.now();
  const realNow = Date.now;
  const step = async (pos, ts) => {
    const gen = state.gen;
    const e = epochAt(ts);
    const key = await gen.ratchet.keyFor(e, who.memberId, ts);
    const sealed = await sealMessage(key, gen.channelId, who.memberId, e, ts, {
      v: 2,
      ts,
      t: "loc",
      name: "Juno",
      lat: pos.lat,
      lon: pos.lon,
      acc: 5,
      mode: "precise",
    });
    const post = await buildPost(who, gen.channelId, e, sealed, ts);
    await internals.roster().ingest(
      [
        {
          m: who.memberId,
          alg: who.alg,
          pk: b64uEncode(who.pk),
          epk: b64uEncode(who.epk),
          points: [{ e: post.e, ts: post.ts, srv: post.ts, n: post.n, c: post.c, sig: post.sig }],
        },
      ],
      ts,
    );
    Date.now = () => ts + 500;
    try {
      internals.checkAlerts();
    } finally {
      Date.now = realNow;
    }
  };
  await step(north(2000), t0);
  await step(BASE, t0 + 60_000);
  const atPlace = internals.placeTracker.placeFor(who.memberId)?.name ?? null;
  await step(north(2000), t0 + 210_000);
  return { calls, atPlace };
}

const HOME = { id: "aaaaaaaa", name: "Home", lat: BASE.lat, lon: BASE.lon, radius: 250 };

test("an arrive-only place announces arrival and not departure", async () => {
  await circleWith([{ ...HOME, alerts: "arrive" }]);
  const { calls } = await walk(await generateIdentity());
  assert.deepEqual(calls, ["Juno arrived at Home"]);

  await circleWith([HOME]);
  const both = await walk(await generateIdentity());
  assert.deepEqual(both.calls, ["Juno arrived at Home", "Juno left Home"], "a place with no choice still says both");
});

test("an off place announces nothing but the member still shows at it", async () => {
  await circleWith([{ ...HOME, alerts: "off" }]);
  const { calls, atPlace } = await walk(await generateIdentity());
  assert.deepEqual(calls, []);
  assert.equal(atPlace, "Home", "the At Home line stays true with the alerts off");
});

// Muting a member is for routine noise. These pin that it never reaches the
// alerts that exist for an emergency.
async function pinned(who) {
  assert.ok(await internals.addPinned({ alg: who.alg, pk: b64uEncode(who.pk), epk: b64uEncode(who.epk), name: "Juno" }));
}

function captureNotes() {
  const notes = [];
  globalThis.StarlingNative = {
    windowShown: () => false,
    notify: (title, body, tag, urgent) => notes.push({ title, tag, urgent }),
    cancelNotify: () => {},
  };
  return notes;
}

const toastsNow = () => harness.node("#toasts").children.map((n) => n.textContent);

async function postAs(who, fields, ts = Date.now()) {
  const gen = state.gen;
  const e = epochAt(ts);
  const key = await gen.ratchet.keyFor(e, who.memberId, ts);
  const sealed = await sealMessage(key, gen.channelId, who.memberId, e, ts, { v: 2, ts, name: "Juno", lat: BASE.lat, lon: BASE.lon, acc: 5, ...fields });
  const post = await buildPost(who, gen.channelId, e, sealed, ts);
  await internals.roster().ingest(
    [{ m: who.memberId, alg: who.alg, pk: b64uEncode(who.pk), epk: b64uEncode(who.epk), points: [{ e: post.e, ts: post.ts, srv: post.ts, n: post.n, c: post.c, sig: post.sig }] }],
    ts,
  );
}

test("a muted member's comings and goings say nothing, and the At line stays true", async () => {
  await circleWith([HOME]);
  const who = await generateIdentity();
  await pinned(who);
  assert.equal(await api.setMuted(who.memberId, true), true);
  const before = toastsNow().length;
  const { calls, atPlace } = await walk(who);
  assert.deepEqual(calls, [], "no notification");
  assert.ok(!toastsNow().slice(before).some((m) => /Home/.test(m)), "no toast");
  assert.equal(atPlace, "Home", "the tracker still followed them in");

  await circleWith([HOME]);
  const loud = await generateIdentity();
  await pinned(loud);
  assert.deepEqual((await walk(loud)).calls, ["Juno arrived at Home", "Juno left Home"], "negative control: unmuted still speaks");
});

test("a muted member's low battery says nothing, an unmuted one still warns", async () => {
  await circleWith([]);
  const who = await generateIdentity();
  await pinned(who);
  await api.setMuted(who.memberId, true);
  const notes = captureNotes();
  await postAs(who, { t: "loc", bat: 0.08 });
  internals.checkAlerts();
  assert.deepEqual(notes.filter((n) => n.tag.startsWith("bat-")), []);

  await api.setMuted(who.memberId, false);
  const other = await generateIdentity();
  await pinned(other);
  await postAs(other, { t: "loc", bat: 0.08 });
  internals.checkAlerts();
  assert.deepEqual(notes.filter((n) => n.tag.startsWith("bat-")).map((n) => n.tag), [`bat-${other.memberId}`]);
});

test("an SOS, a missed check-in and a key change from a muted member all still come through", async () => {
  await circleWith([]);
  const who = await generateIdentity();
  await pinned(who);
  await api.setMuted(who.memberId, true);
  const notes = captureNotes();
  const before = toastsNow().length;

  const t0 = Date.now();
  await postAs(who, { t: "sos" }, t0);
  internals.checkAlerts();
  assert.deepEqual(notes.filter((n) => n.tag === `sos-${who.memberId}`).map((n) => [n.title, n.urgent]), [["SOS from Juno", true]]);

  await postAs(who, { t: "loc", due: t0 - 5 * 60_000 }, t0 + 1000);
  internals.checkAlerts();
  assert.ok(notes.some((n) => n.tag === `due-${who.memberId}` && n.urgent), "the missed check-in notifies");

  const stranger = await generateIdentity();
  await internals.onKeyChange(who.memberId, { alg: stranger.alg, pk: b64uEncode(stranger.pk), epk: b64uEncode(stranger.epk) });
  assert.ok(state.keyChanges.has(who.memberId), "the key change is held for a person to decide");
  const said = toastsNow().slice(before);
  assert.ok(said.includes("SOS from Juno"));
  assert.ok(said.includes("Juno missed their check-in"));
  assert.ok(said.some((m) => m.startsWith("Juno's keys changed")));
  state.keyChanges.clear();
});

test("People and keys shows each member's mute switch as it stands", async () => {
  const ui = await import("../app/js/ui.js");
  await circleWith([]);
  const who = await generateIdentity();
  await pinned(who);
  const find = (n, pred) => (pred(n) ? n : (n.children || []).reduce((hit, c) => hit || find(c, pred), null));
  const sheet = ui.openMembersSheet({ api, onClose() {} });
  const sw = () => {
    const row = find(harness.node("#overlays"), (n) => n.dataset?.testid === "member-row" && n.dataset.member === who.memberId);
    return find(find(row, (n) => n.dataset?.testid === "member-mute"), (n) => n.getAttribute?.("role") === "switch");
  };
  assert.equal(sw().getAttribute("aria-checked"), "false");
  await api.setMuted(who.memberId, true);
  sheet.refresh();
  assert.equal(sw().getAttribute("aria-checked"), "true");
  sheet.close();
});
