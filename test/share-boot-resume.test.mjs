// munzzyy/starling#22: a restart or an update ended the share and nothing said so until
// the app was opened again. Android 11 and up give a location service started at boot no
// fixes (Android 14 and up refuse to start it at all), so the wrapper offers a tap instead:
// one notification, and the tap is an ordinary reopen. The native side cannot read the
// page's storage, so the page keeps a copy of the armed record there, and these checks pin
// when that copy is written and when it goes.
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

const { internals } = await loadApp(harness);
const state = internals.state;
const { dbGet, dbSet, dbDel } = await import("../app/js/store.js");
const { openGeneration } = await import("../app/js/rekey.js");
const { epochAt } = await import("../app/js/ratchet.js");
const { generateIdentity, newSeed } = await import("../app/js/crypto.js");

test.after(() => harness.stopTimers());

const SHARE_ARMED = "shareArmed";
const HOUR = 3_600_000;
let calls = [];
let mirror = null;

function nativeStub() {
  calls = [];
  mirror = null;
  globalThis.StarlingNative = {
    startLocation: () => calls.push(["start"]),
    stopLocation: () => calls.push(["stop"]),
    clearStopRecord: () => {},
    windowShown: () => true,
    pulse: () => {},
    cancelShareReminder: () => calls.push(["cancelReminder"]),
    armShareResume: (at, deadline) => {
      calls.push(["arm", at, deadline]);
      mirror = { at, deadline };
    },
    disarmShareResume: () => {
      calls.push(["disarm"]);
      mirror = null;
    },
  };
}

async function world({ armed = null, stopRecord = null } = {}) {
  internals.resetShareResumeGuard();
  nativeStub();
  state.demo = false;
  state.locked = false;
  state.lock = null;
  state.sosActive = false;
  state.stopRecord = stopRecord;
  state.geoDenied = false;
  state.geoFailed = false;
  state.settings = { ...state.settings, shareReminder: 0 };
  state.identity = state.identity || (await generateIdentity());
  if (!state.gen) {
    state.gen = await openGeneration({ seed: new Uint8Array(newSeed()), g: 0, e0: epochAt(Date.now()) });
    state.gen.at = Date.now();
    state.genRoster = new Set();
    state.pinned = new Map();
  }
  if (state.sharing) await internals.setSharing(false);
  internals.setShareWindow(0);
  internals.setupNet();
  if (armed) await dbSet(SHARE_ARMED, armed);
  else await dbDel(SHARE_ARMED);
  calls = [];
  mirror = null;
}

test("starting a share hands the wrapper the same record the page keeps", async () => {
  await world();
  await internals.setSharing(true);
  const kept = await dbGet(SHARE_ARMED);
  assert.ok(mirror, "the wrapper got a copy");
  assert.equal(mirror.at, kept.at);
  assert.equal(mirror.deadline, kept.deadline);
  await internals.setSharing(false);
});

test("a stop the person chose takes the wrapper's copy back", async () => {
  await world();
  await internals.setSharing(true);
  await internals.setSharing(false);
  assert.equal(mirror, null);
  assert.equal(await dbGet(SHARE_ARMED), undefined);
});

test("a stop Android or the app lock made keeps it, since that share still comes back", async () => {
  await world();
  await internals.setSharing(true);
  await internals.setSharing(false, { keepArmed: true });
  assert.ok(mirror, "still armed for the wrapper");
  assert.ok(await dbGet(SHARE_ARMED), "and for the page");
});

test("a window picked after the share started is written down, so a restart cannot outlive it", async () => {
  await world();
  await internals.setSharing(true);
  internals.setShareWindow(HOUR);
  await settle();
  const deadline = internals.shareStatus().deadline;
  assert.ok(deadline > Date.now());
  assert.equal((await dbGet(SHARE_ARMED)).deadline, deadline, "the page's record carries the window");
  assert.equal(mirror.deadline, deadline, "and so does the wrapper's");
  internals.setShareWindow(0);
  await settle();
  assert.equal((await dbGet(SHARE_ARMED)).deadline, 0, "going back to untimed is written down too");
  assert.equal(mirror.deadline, 0);
  await internals.setSharing(false);
});

test("picking a window with sharing off arms nothing", async () => {
  await world();
  internals.setShareWindow(HOUR);
  await settle();
  assert.equal(mirror, null);
  assert.equal(await dbGet(SHARE_ARMED), undefined);
  internals.setShareWindow(0);
});

test("a timed share that came back keeps its deadline for the next restart", async () => {
  const deadline = Date.now() + HOUR;
  await world({ armed: { at: Date.now() - 60_000, windowMs: 2 * HOUR, deadline } });
  assert.equal(await internals.resumeShareIfArmed(), true);
  await settle();
  const kept = await dbGet(SHARE_ARMED);
  assert.ok(Math.abs(kept.deadline - deadline) < 5_000, `page record deadline ${kept.deadline} vs ${deadline}`);
  assert.ok(Math.abs(mirror.deadline - deadline) < 5_000, "the wrapper's copy too");
  await internals.setSharing(false);
});

test("a Stop on the notification found at reopen takes the wrapper's copy back too", async () => {
  await world({
    armed: { at: Date.now() - 60_000, windowMs: 0, deadline: 0 },
    stopRecord: { route: "notif", at: Date.now() - 30_000 },
  });
  mirror = { at: 1, deadline: 0 };
  assert.equal(await internals.resumeShareIfArmed(), false);
  assert.equal(mirror, null);
});

test("the panic wipe takes the wrapper's copy back before it wipes", async () => {
  await world();
  await internals.setSharing(true);
  calls = [];
  globalThis.StarlingNative.panicWipe = () => calls.push(["wipe"]);
  await internals.panic();
  const at = (name) => calls.findIndex((c) => c[0] === name);
  assert.ok(at("disarm") >= 0, "panic disarms");
  assert.ok(at("disarm") < at("wipe"), "before the wipe kills the process");
});

test("an older wrapper without the methods still shares", async () => {
  await world();
  delete globalThis.StarlingNative.armShareResume;
  delete globalThis.StarlingNative.disarmShareResume;
  await internals.setSharing(true);
  assert.equal(state.sharing, true);
  internals.setShareWindow(HOUR);
  await settle();
  await internals.setSharing(false);
  assert.equal(state.sharing, false);
});

test("the Kotlin side: a private receiver, and a start only through the switches' gate", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  const kt = (name) => read(`android/app/src/main/kotlin/app/starlingmap/${name}`);
  const manifest = read("android/app/src/main/AndroidManifest.xml");
  assert.equal((manifest.match(/ACCESS_BACKGROUND_LOCATION/g) || []).length, 1, "declared once, asked for elsewhere");
  assert.doesNotMatch(manifest, /LOCKED_BOOT_COMPLETED/);
  assert.doesNotMatch(manifest, /directBootAware/, "nothing runs before the first unlock");
  assert.match(manifest, /<uses-permission android:name="android\.permission\.RECEIVE_BOOT_COMPLETED" \/>/);
  const receiver = manifest.match(/<receiver\s+android:name="\.ShareResumeReceiver"[\s\S]*?<\/receiver>/);
  assert.ok(receiver, "the receiver is declared");
  assert.match(receiver[0], /android:exported="false"/);
  assert.match(receiver[0], /android\.intent\.action\.BOOT_COMPLETED/);
  assert.match(receiver[0], /android\.intent\.action\.MY_PACKAGE_REPLACED/);
  const resume = kt("ShareResume.kt");
  // The window's start, the activity's page and a plain load never happen from here.
  assert.doesNotMatch(resume, /LocationService\.start\(|startForegroundService|PageHost\.attach|PageHost\.load/);
  assert.equal((resume.match(/LocationService\.startResumed\(/g) || []).length, 1, "one start, behind decide()");
  assert.match(resume, /if \(LocationService\.running \|\| starting\) return/);
  assert.match(kt("Wipe.kt"), /runCatching \{ ShareResume\.disarm\(ctx\) \}/);
  const wipe = kt("Wipe.kt");
  assert.ok(wipe.indexOf("ShareResume.disarm") < wipe.indexOf("clearApplicationUserData"));
  // A Stop on the notification is a decision, recorded natively even with no page to hear it.
  assert.match(kt("LocationService.kt"), /if \(intent\?\.action == ACTION_STOP\) \{[\s\S]{0,400}ShareResume\.disarm\(this\)/);
  const bridge = kt("StarlingBridge.kt");
  assert.match(bridge, /fun armShareResume\(at: Long, deadline: Long\) = ShareResume\.arm\(app, at, deadline\)/);
  assert.match(bridge, /fun disarmShareResume\(\) = ShareResume\.disarm\(app\)/);
});
