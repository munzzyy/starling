// Save battery when still (issue #25), held against the real main.js through
// the wrapper's own push path (__starlingFix), plus the Kotlin half as source.
// The detector itself is JVM-tested in android/app/src/test StillTest.kt.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
const defaults = { ...state.settings };
const ui = await import("../app/js/ui.js");
const { openGeneration } = await import("../app/js/rekey.js");
const { epochAt } = await import("../app/js/ratchet.js");
const { generateIdentity, newSeed, openMessage } = await import("../app/js/crypto.js");
const { b64uDecode } = await import("../app/js/wire.js");
const { staleAfter, statusOf } = await import("../app/js/net.js");
const { shareReport } = await import("../app/js/sharehealth.js");

test.after(() => {
  delete globalThis.StarlingNative;
  harness.stopTimers();
});

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const kt = (name) => src(`android/app/src/main/kotlin/app/starlingmap/${name}`);

function fn(text, name) {
  const at = text.search(new RegExp(`fun ${name}\\([^)]*\\)(: [\\w?<>, ]+)? \\{`));
  assert.ok(at >= 0, `fun ${name} exists`);
  const open = text.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(at, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

const calls = [];
const periods = [];
const live = new Map();
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (f, ms, ...rest) => {
  periods.push(ms);
  const id = realSetInterval(f, ms, ...rest);
  live.set(id, ms);
  return id;
};
globalThis.clearInterval = (id) => {
  live.delete(id);
  return realClearInterval(id);
};

const HERE = { lat: 40.785, lon: -73.968, acc: 6 };
const push = (o) => globalThis.__starlingFix(JSON.stringify(o));

async function sharing({ stillSave = true, steady = false, cadence = 15 } = {}) {
  if (state.sharing) await internals.setSharing(false);
  calls.length = 0;
  periods.length = 0;
  globalThis.StarlingNative = {
    startLocation: () => calls.push("startLocation"),
    stopLocation: () => calls.push("stopLocation"),
    setShareCadence: (s) => calls.push(`cadence:${s}`),
    setStillMode: (on) => calls.push(`still:${on}`),
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
  state.settings = { ...state.settings, stillSave, steady };
  state.circleShare = { precision: null, cadence };
  state.identity = state.identity || (await generateIdentity());
  if (!state.gen) {
    state.gen = await openGeneration({ seed: new Uint8Array(newSeed()), g: 0, e0: epochAt(Date.now()) });
    state.gen.at = Date.now();
    state.genRoster = new Set();
    state.pinned = new Map();
  }
  internals.setupNet();
  await internals.setSharing(true);
  assert.equal(state.sharing, true);
  push({ ...HERE, ts: Date.now() });
  await settle();
}

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

test("the switch starts off: slowing down while still is timing the relay can read", () => {
  assert.equal(defaults.stillSave, false);
});

test("a phone gone still posts at once on the 5 minute pace, and its circle keeps it fresh for 10 minutes", async () => {
  await sharing();
  assert.ok(calls.includes("still:true"), `the wrapper is told it may, got ${calls.join(",")}`);
  assert.ok(calls.indexOf("still:true") < calls.indexOf("startLocation"), "before the start, like the cadence");
  assert.equal(internals.shareCadence(), 15);

  const before = posts.length;
  periods.length = 0;
  push({ still: true });
  await settle();
  assert.equal(posts.length, before + 1, "one post right away");
  const post = await openOwnPost(posts.at(-1));
  assert.equal(post.cadence, 300, "receivers are told to expect the next one in 5 minutes");
  assert.equal(internals.shareCadence(), 300);
  assert.deepEqual(periods, [300_000], "the page's own timer slows down too");

  const now = Date.now();
  const rec = { type: "loc", ts: now, cadence: post.cadence };
  assert.equal(staleAfter(rec), 600_000);
  assert.equal(statusOf(rec, now + 9 * 60_000), "live", "still live 9 minutes later");
  assert.equal(statusOf(rec, now + 11 * 60_000), "stale");
  assert.equal(statusOf({ ...rec, cadence: 15 }, now + 4 * 60_000), "stale", "negative control: on the old pace it would read quiet by 4 minutes");

  const quiet = posts.length;
  push({ ...HERE, ts: Date.now() });
  await settle();
  assert.equal(posts.length, quiet, "a still fix inside 5 minutes sends nothing");

  periods.length = 0;
  push({ still: false });
  await settle();
  assert.equal(internals.shareCadence(), 15);
  assert.deepEqual(periods, [15_000]);
  const realNow = Date.now;
  Date.now = () => realNow() + 20_000;
  try {
    push({ lat: HERE.lat + 0.001, lon: HERE.lon, acc: 6, ts: Date.now() });
    await settle();
  } finally {
    Date.now = realNow;
  }
  assert.equal(posts.length, quiet + 1, "the first fix after moving goes out");
  assert.equal((await openOwnPost(posts.at(-1))).cadence, 15);
});

test("a still word that lands while a share is starting leaves one send timer, and stopping clears it", async () => {
  if (state.sharing) await internals.setSharing(false);
  const before = new Set(live.keys());
  const mine = () => [...live].filter(([id]) => !before.has(id)).map(([, ms]) => ms);
  globalThis.StarlingNative = {
    startLocation: () => {},
    stopLocation: () => {},
    setShareCadence: () => {},
    setStillMode: () => {},
    // The service is already still and says so again as the page starts its share.
    armShareResume: () => push({ still: true }),
    clearStopRecord: () => {},
    keepSharing: () => false,
    setKeepSharing: () => {},
    windowShown: () => false,
    pulse: () => {},
  };
  internals.resetShareResumeGuard();
  state.settings = { ...state.settings, stillSave: true, steady: false };
  state.circleShare = { precision: null, cadence: 15 };
  await internals.setSharing(true);
  await settle();
  assert.equal(internals.shareCadence(), 300, "negative control: the still word did land mid-start");
  assert.deepEqual(mine(), [300_000]);
  await internals.setSharing(false);
  assert.deepEqual(mine(), [], "no send timer outlives the share");
});

test("with steady sending on, still mode stays off in the wrapper and in the page", async () => {
  await sharing({ steady: true });
  assert.ok(calls.includes("still:false"));
  assert.ok(!calls.includes("still:true"));
  const before = posts.length;
  push({ still: true });
  await settle();
  assert.equal(internals.shareCadence(), 15, "a stray still from the wrapper changes nothing");
  assert.equal(posts.length, before);
});

test("turning steady sending on while still puts the circle's pace back at once", async () => {
  await sharing();
  push({ still: true });
  await settle();
  assert.equal(internals.shareCadence(), 300);
  calls.length = 0;
  await api.setSetting("steady", true);
  assert.ok(calls.includes("still:false"), `got ${calls.join(",")}`);
  assert.equal(internals.shareCadence(), 15);
  await api.setSetting("steady", false);
  assert.ok(calls.includes("still:true"));
});

test("an SOS never slows down, still or not", async () => {
  await sharing({ cadence: 60 });
  push({ still: true });
  await settle();
  assert.equal(internals.shareCadence(), 300);
  calls.length = 0;
  await internals.fireSos();
  await settle();
  assert.ok(calls.includes("still:false"), `the wrapper hears it at once, got ${calls.join(",")}`);
  assert.equal(internals.shareCadence(), 15);
  const sos = await openOwnPost(posts.at(-1));
  assert.equal(sos.t, "sos");
  assert.equal(sos.cadence, 15);
  push({ still: true });
  await settle();
  assert.equal(internals.shareCadence(), 15, "a still from the wrapper during an SOS changes nothing");
  await internals.doCheckin();
  await settle();
  assert.ok(calls.includes("still:true"), "a check-in hands still mode back");
});

test("turning the switch off while still goes back to the circle's pace", async () => {
  await sharing();
  push({ still: true });
  await settle();
  calls.length = 0;
  await api.setSetting("stillSave", false);
  assert.deepEqual(calls.filter((c) => c.startsWith("still:")), ["still:false"]);
  assert.equal(internals.shareCadence(), 15);
  await internals.setSharing(false);
});

test("the sharing report says the setting and how long the phone sat still, with no position", () => {
  const h = { service: true, sharingMs: 3_600_000, fixes: 40, gpsFixes: 30, networkFixes: 10, lastFixMs: 1000, ticks: 3, rewatches: 0, freezes: 0, nudges: 0, lastPulseMs: 1000 };
  const report = (extra, still) => shareReport({ h: { ...h, ...extra }, page: { version: "0.18.0", sharing: true, startedAt: 1, still }, now: 3_600_001 });
  const on = report({ stillSupported: true, still: true, stillSpells: 3, stillMs: 2_700_000 }, "on");
  assert.match(on, /^Save battery when still: on$/m);
  assert.match(on, /^Still: now, 3 times this share, 45 min in all$/m);
  assert.match(report({ stillSupported: true, still: false, stillSpells: 0, stillMs: 0 }, "steady"), /^Save battery when still: off, Steady sending is on$/m);
  assert.match(report({ stillSupported: true, still: false, stillSpells: 1, stillMs: 60_000 }, "sos"), /^Save battery when still: off during the SOS$/m);
  assert.match(report({ stillSupported: false, still: false, stillSpells: 0, stillMs: 0 }, "on"), /^Save battery when still: no motion sensor on this phone$/m);
  assert.match(report({ stillSupported: true, still: false, stillSpells: 0, stillMs: 0 }, "<script>"), /^Save battery when still: unknown$/m);
  assert.doesNotMatch(report({}, "on"), /still/i, "an older wrapper says nothing about it");
});

function settingsWith(still, settings) {
  const host = document.getElementById("overlays");
  const before = host.children.length;
  state.settings = { ...state.settings, ...settings };
  const ov = ui.openSettingsSheet({
    api,
    values: { circleName: "Home", profile: { name: "", emoji: "x" }, settings: state.settings, share: { precision: "precise", cadence: 15 }, relay: null },
    demo: false,
    tor: null,
    keepSharing: null,
    shareClock: null,
    still,
    background: null,
    forward: null,
    lock: { enabled: false, hasBio: false, hasDuress: false, bioAvailable: false, autolockMs: 60000 },
    lockActions: {},
    onChange() {},
    onClose() {},
  });
  const found = {};
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.dataset?.testid === "settings-still") found.row = n;
    if (n.dataset?.testid === "settings-still-why") found.why = n;
    for (const c of n.children || []) walk(c);
  };
  host.children.slice(before).forEach(walk);
  ov.close?.();
  return found;
}

const switchOf = (row) => row.children.find((c) => c.getAttribute?.("role") === "switch");

test("Settings shows the switch only with the wrapper, off by default, and says why when it cannot be on", () => {
  assert.equal(settingsWith(null, {}).row, undefined, "no switch on the web or an older wrapper");

  const off = settingsWith({ supported: true }, { stillSave: false, steady: false });
  assert.equal(switchOf(off.row).getAttribute("aria-checked"), "false");
  assert.equal(switchOf(off.row).disabled, false);
  assert.equal(off.why.hidden, true);
  assert.match(off.row.children[0].children[1].textContent, /relay cannot read where you are, but it can tell from the slower timing/);

  const on = settingsWith({ supported: true }, { stillSave: true, steady: false });
  assert.equal(switchOf(on.row).getAttribute("aria-checked"), "true");

  const steady = settingsWith({ supported: true }, { stillSave: true, steady: true });
  assert.equal(switchOf(steady.row).getAttribute("aria-checked"), "false", "forced off under steady sending");
  assert.equal(switchOf(steady.row).disabled, true);
  assert.equal(steady.why.hidden, false);
  assert.equal(steady.why.textContent, "Steady sending is on, which keeps the timing even, so this stays off.");

  const bare = settingsWith({ supported: false }, { stillSave: true, steady: false });
  assert.equal(switchOf(bare.row).getAttribute("aria-checked"), "false");
  assert.equal(switchOf(bare.row).disabled, true);
  assert.equal(bare.why.textContent, "This phone has no motion sensor that can wake it, so this stays off.");
  state.settings = { ...state.settings, stillSave: false, steady: false };
});

test("the service drops to one slow heartbeat while still and is woken by the motion sensor", () => {
  const svc = kt("LocationService.kt");
  const plan = kt("LocationPlan.kt");
  assert.match(plan, /const val STILL_MS = 5 \* 60000L/);
  assert.match(plan, /return maxOf\(REWATCH_MIN_MS, 2 \* every\)/);
  const request = fn(svc, "request");
  assert.match(request, /val cadence = if \(still\.on\) LocationPlan\.STILL_MS else heartbeatMs/);
  assert.match(request, /LocationPlan\.plan\(cadence, still\.on, platformProviders, fusedOn\)/);
  assert.match(fn(svc, "rearmHeartbeat"), /if \(!watching \|\| still\.on\) return/, "a cadence change waits until the phone moves");

  const onFix = fn(svc, "onLocationChanged");
  const check = onFix.indexOf("if (still.fix(location.latitude, location.longitude, acc, lastFixAt, stillWanted && motionArmed)) stillChanged()");
  assert.ok(check >= 0 && check < onFix.indexOf("sink?.invoke(fix.toString())"), "the page hears the state before the fix");

  const changed = fn(svc, "stillChanged");
  assert.ok(changed.indexOf('put("still", still.on)') < changed.indexOf("removeUpdates(this)"));
  assert.match(changed, /if \(request\(lm\)\.isEmpty\(\)\) noProvider\(\)/);

  assert.match(svc, /getDefaultSensor\(Sensor\.TYPE_SIGNIFICANT_MOTION\)/);
  assert.match(fn(svc, "onStartCommand"), /startWatching\(\)\s*\/\/[^\n]*\n\s*if \(still\.on\) sink\?\.invoke\(JSONObject\(\)\.put\("still", true\)\.toString\(\)\)/);
  assert.match(fn(svc, "armMotion"), /if \(motionArmed \|\| !stillWanted \|\| !watching\) return/, "the sensor is only asked for while the switch allows it");
  assert.match(fn(svc, "armMotion"), /requestTriggerSensor\(motion, sensor\)/);
  assert.match(fn(svc, "onMotion"), /still\.motion\(SystemClock\.elapsedRealtime\(\)\)\s*armMotion\(\)/);
  assert.match(fn(svc, "stillWantedChanged"), /disarmMotion\(\)\s*if \(still\.leave\(\)\) stillChanged\(\)/, "an SOS or steady sending ends still mode at once");
  assert.match(fn(svc, "onDestroy"), /disarmMotion\(\)/);
  assert.match(kt("StarlingBridge.kt"), /fun setStillMode\(on: Boolean\) = LocationService\.setStillMode\(on\)/);
  assert.match(kt("StarlingBridge.kt"), /fun stillSupported\(\): Boolean = LocationService\.stillSupported\(app\)/);
});

test("no new permission: the motion sensor needs none, and nothing asks for activity recognition", () => {
  const manifest = src("android/app/src/main/AndroidManifest.xml");
  assert.doesNotMatch(manifest, /ACTIVITY_RECOGNITION|HIGH_SAMPLING_RATE_SENSORS|BODY_SENSORS/);
  for (const name of ["LocationService.kt", "StillClock.kt", "StarlingBridge.kt", "Health.kt"]) {
    assert.doesNotMatch(kt(name), /ActivityRecognition|TYPE_STEP|TYPE_ACCELEROMETER|gms/, name);
  }
});

test("the page reads the still signal from the wrapper and nothing else", () => {
  const geo = src("app/js/geo.js");
  assert.match(geo, /if \(p && typeof p\.still === "boolean"\) \{\s*onSignal\?\.\(\{ still: p\.still \}\);\s*return;\s*\}/);
  const main = src("app/js/main.js");
  assert.match(main, /const stillAllowed = \(\) => state\.settings\.stillSave === true && !state\.settings\.steady && !state\.sosActive;/);
  assert.match(main, /native\(\)\?\.setShareCadence\?\.\(circleCadenceS\(\)\)/, "the wrapper's heartbeat never takes the still pace");
});
