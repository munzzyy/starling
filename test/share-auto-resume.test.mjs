// munzzyy/starling#22, the opt-in half: a share that comes back after a restart
// or an update with no window. The Kotlin half is read as source at the end.
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

const tileCalls = [];
const realTileLayer = globalThis.L.tileLayer;
globalThis.L.tileLayer = (url, opts) => {
  tileCalls.push(String(url));
  return realTileLayer(url, opts);
};

const { internals, api } = await loadApp(harness);
const state = internals.state;
const { dbSet, dbDel } = await import("../app/js/store.js");
const { openGeneration } = await import("../app/js/rekey.js");
const { epochAt } = await import("../app/js/ratchet.js");
const { generateIdentity, newSeed } = await import("../app/js/crypto.js");
const { autoResumeNote, openSettingsSheet, confirmBackgroundLocation } = await import("../app/js/ui.js");

test.after(() => harness.stopTimers());

const SHARE_ARMED = "shareArmed";
const HOUR = 3_600_000;
let reports = [];
let calls = [];
let bridge = {};

// Gates the way ShareResume.setAuto does: on only with a window, Keep sharing,
// the grant and visible notifications; off always.
function nativeStub(over = {}) {
  reports = [];
  calls = [];
  bridge = {
    auto: { boot: false, update: false },
    keep: true,
    notif: true,
    bg: "settings",
    shown: true,
    label: "Allow all the time",
    grant: true,
    grantDelay: 0,
    tor: false,
    record: null,
    ...over,
  };
  globalThis.StarlingNative = {
    startLocation: () => calls.push("start"),
    stopLocation: () => calls.push("stop"),
    clearStopRecord: () => {},
    windowShown: () => bridge.shown,
    pulse: () => {},
    armShareResume: () => {},
    disarmShareResume: () => calls.push("disarm"),
    cancelShareReminder: () => {},
    keepSharing: () => bridge.keep,
    setKeepSharing: (on) => {
      bridge.keep = on;
    },
    headlessResumeState: (word) => reports.push(word),
    autoResume: () => JSON.stringify(bridge.auto),
    setAutoResume: (boot, update) => {
      calls.push(`setAutoResume:${boot},${update}`);
      const ready = bridge.shown && bridge.keep && bridge.notif && (bridge.bg === "granted" || bridge.bg === "notNeeded");
      bridge.auto = { boot: boot && (bridge.auto.boot || ready), update: update && (bridge.auto.update || ready) };
      return JSON.stringify(bridge.auto);
    },
    backgroundLocation: () => bridge.bg,
    backgroundOptionLabel: () => bridge.label,
    requestBackgroundLocation: (token) => {
      calls.push("requestBackground");
      setTimeout(() => {
        if (bridge.grant) bridge.bg = "granted";
        globalThis.__starlingBackground(token, bridge.grant);
      }, bridge.grantDelay);
    },
    notificationsShown: () => bridge.notif,
    torEnabled: () => bridge.tor,
    readAutoResumeRecord: () => bridge.record,
    clearAutoResumeRecord: () => {
      calls.push("clearRecord");
      bridge.record = null;
    },
    panicWipe: () => calls.push("panicWipe"),
  };
}

async function world({ armed = { at: Date.now() - 60_000, windowMs: 0, deadline: 0 }, stopRecord = null, headless = "boot", shown = false, over = {} } = {}) {
  internals.resetShareResumeGuard();
  internals.setHeadless(headless);
  nativeStub({ shown, ...over });
  document.visibilityState = shown ? "visible" : "hidden";
  state.demo = false;
  state.locked = false;
  state.lock = null;
  state.sosActive = false;
  state.stopRecord = stopRecord;
  state.autoResumed = null;
  state.geoDenied = false;
  state.geoFailed = false;
  state.settings = { ...state.settings, basemap: "dark", shareReminder: 0 };
  state.identity = state.identity || (await generateIdentity());
  if (!state.gen) {
    state.gen = await openGeneration({ seed: new Uint8Array(newSeed()), g: 0, e0: epochAt(Date.now()) });
    state.gen.at = Date.now();
    state.genRoster = new Set();
    state.pinned = new Map();
    state.circles = [];
  }
  if (state.sharing) await internals.setSharing(false);
  internals.setShareWindow(0);
  if (armed) await dbSet(SHARE_ARMED, armed);
  else await dbDel(SHARE_ARMED);
  calls = [];
  reports = [];
}

const osm = () => tileCalls.filter((u) => u.includes("tile.openstreetmap.org")).length;
const toasts = () => harness.node("#toasts").children.map((n) => n.textContent);
const card = () => internals.alertItems().find((i) => i.id === "auto-resumed");

// First in the file: the map is built once per page, on the first circle entered.
test("a page that came back with nobody looking fetches no map tiles until a person looks", async () => {
  await world();
  const before = osm();
  await internals.enterCircle();
  await settle();
  assert.equal(state.screen, "map");
  assert.equal(internals.basemapHeld(), true);
  assert.equal(osm(), before, "the map was built with no tile layer");

  internals.releaseHeldBasemap();
  assert.equal(osm(), before, "a hidden page is still nobody looking");
  document.visibilityState = "visible";
  internals.releaseHeldBasemap();
  assert.equal(osm(), before, "a nudge makes the page visible for a second with no window behind it");

  bridge.shown = true;
  internals.releaseHeldBasemap();
  assert.equal(osm(), before + 1, "the saved basemap the first time a window shows the page");
  assert.equal(internals.basemapHeld(), false);
  internals.releaseHeldBasemap();
  assert.equal(osm(), before + 1, "once");
  await internals.setSharing(false);
});

test("the boot reports started once the share is back, and delivered once after the first post", async () => {
  await world();
  await internals.enterCircle();
  await internals.reportHeadlessBoot();
  assert.equal(state.sharing, true);
  assert.deepEqual(reports, ["started"]);
  assert.deepEqual(state.autoResumed?.why, "boot", "the card is waiting for whoever opens the app");

  globalThis.__starlingFix(JSON.stringify({ lat: 45.06, lon: 13.23, ts: Date.now(), acc: 8 }));
  await settle(60);
  assert.deepEqual(reports, ["started", "delivered"], "the post went out, so a Tor wait can end");
  globalThis.__starlingFix(JSON.stringify({ lat: 45.07, lon: 13.24, ts: Date.now() + 20_000, acc: 8 }));
  await settle(60);
  assert.deepEqual(reports, ["started", "delivered"], "said once");
  await internals.setSharing(false);
});

test("a failed post is not delivered", async () => {
  await world();
  harness.onFetch(async (url, init) => (init?.method === "POST" ? { ok: false, status: 503, json: async () => ({}) } : null));
  try {
    await internals.enterCircle();
    await internals.reportHeadlessBoot();
    globalThis.__starlingFix(JSON.stringify({ lat: 45.06, lon: 13.23, ts: Date.now(), acc: 8 }));
    await settle(60);
    assert.deepEqual(reports, ["started"]);
  } finally {
    harness.onFetch(null);
    await internals.setSharing(false);
  }
});

test("the page reports locked behind the app lock, and declined whenever a reopen would not resume", async () => {
  await world();
  state.locked = true;
  await internals.reportHeadlessBoot();
  assert.deepEqual(reports, ["locked"], "a locked page has no keys and never got as far as resuming");
  assert.equal(state.sharing, false);

  const declines = [
    ["a Stop on the notification", { stopRecord: { route: "notif", at: Date.now() - 1000 } }],
    ["a timed share that ran out", { armed: { at: Date.now() - 2 * HOUR, windowMs: HOUR, deadline: Date.now() - HOUR } }],
    ["nothing armed, as after a panic wipe", { armed: null }],
  ];
  for (const [why, opts] of declines) {
    await world(opts);
    await internals.enterCircle();
    await internals.reportHeadlessBoot();
    assert.deepEqual(reports, ["declined"], why);
    assert.equal(state.sharing, false, why);
    assert.equal(state.autoResumed, null, `${why}: no card for a share that did not come back`);
  }
});

test("a boot with no circle reports declined and turns the switches off", async () => {
  state.gen = null;
  state.identity = null;
  state.sharing = false;
  state.locked = false;
  state.lock = null;
  internals.setHeadless("");
  nativeStub({ auto: { boot: true, update: true }, keep: true, bg: "granted" });
  globalThis.StarlingNative.headlessResume = () => "update";
  globalThis.StarlingNative.readStopRecord = () => null;
  await internals.boot();
  await settle(60);
  assert.ok(calls.includes("setAutoResume:false,false"), "nothing on this phone for a restart to bring back");
  assert.deepEqual(bridge.auto, { boot: false, update: false });
  assert.deepEqual(reports, ["declined"]);
  internals.setHeadless("");
});

test("a boot reads the record the wrapper left, and the card says what happened", async () => {
  state.gen = null;
  state.identity = null;
  internals.setHeadless("");
  nativeStub({ record: JSON.stringify({ why: "update", at: 1234 }) });
  globalThis.StarlingNative.readStopRecord = () => null;
  await internals.boot();
  await settle();
  assert.deepEqual(state.autoResumed, { why: "update", at: 1234 });
  const c = card();
  assert.ok(c, "the card is up");
  assert.equal(c.kind, "warn");
  assert.equal(c.title, "Sharing came back on by itself");
  assert.match(c.text, /Starling updated while you were sharing/);
  assert.match(c.text, /check who has access to this phone/);
  assert.deepEqual(c.actions.map((a) => a.testid), ["alert-auto-resumed-settings", "alert-auto-resumed-ok"]);

  state.autoResumed = { why: "boot", at: 1 };
  assert.match(card().text, /Your phone restarted while you were sharing/);
  card().actions.find((a) => a.testid === "alert-auto-resumed-ok").onClick();
  assert.equal(state.autoResumed, null);
  assert.ok(calls.includes("clearRecord"), "Got it clears the wrapper's record too");
  assert.equal(card(), undefined);

  for (const bad of ["{not json", JSON.stringify({ why: "elsewhere", at: 1 }), JSON.stringify([1])]) {
    state.autoResumed = null;
    nativeStub({ record: bad });
    globalThis.StarlingNative.readStopRecord = () => null;
    await internals.boot();
    await settle();
    assert.equal(state.autoResumed, null, `refused: ${bad}`);
  }
});

test("no resume toast while nobody is looking, and the toast as before for a person who is", async () => {
  await world();
  harness.node("#toasts").children.length = 0;
  await internals.enterCircle();
  await settle();
  assert.equal(state.sharing, true);
  assert.equal(toasts().filter((t) => /back on/.test(t)).length, 0, "nobody to read it");
  await internals.setSharing(false);

  await world({ headless: "", shown: true });
  harness.node("#toasts").children.length = 0;
  await internals.enterCircle();
  await settle();
  assert.equal(state.sharing, true);
  assert.ok(toasts().some((t) => /Sharing was on when the app closed/.test(t)), toasts().join(" | "));
  await internals.setSharing(false);
});

test("the card waits for the first look, then is built and spoken once, even with the sheet at peek", async () => {
  await world();
  await internals.enterCircle();
  await internals.enterCircle();
  await settle();
  assert.ok(harness.node("#sheet").classList.contains("sheet-peek"), "at peek a card only speaks through the toast");
  const alerts = harness.node("#alerts");
  const built = () => alerts.children.filter((n) => n.dataset.alert === "auto-resumed").length;
  const spoken = () => toasts().filter((t) => t === "Sharing came back on by itself").length;
  alerts.children.length = 0;
  harness.node("#toasts").children.length = 0;
  await internals.reportHeadlessBoot();
  await settle();
  assert.equal(card()?.title, "Sharing came back on by itself");
  assert.equal(built(), 0, "nothing built for nobody");
  assert.equal(spoken(), 0, "and nothing said to nobody");

  bridge.shown = true;
  document.visibilityState = "visible";
  internals.releaseHeldBasemap();
  await settle();
  assert.ok(built() > 0, "built the first time a window shows the page");
  assert.equal(spoken(), 1, "and spoken then");
  await internals.enterCircle();
  await settle();
  assert.equal(spoken(), 1, "once");
  await internals.setSharing(false);
});

test("a reload in front of a person is no page nobody has seen, and puts back no card", async () => {
  for (const shown of [true, false]) {
    state.gen = null;
    state.identity = null;
    internals.setHeadless("");
    nativeStub({ shown });
    globalThis.StarlingNative.headlessResume = () => "boot";
    globalThis.StarlingNative.readStopRecord = () => null;
    document.visibilityState = shown ? "visible" : "hidden";
    await internals.boot();
    await settle();
    assert.equal(internals.basemapHeld(), !shown, shown ? "a person is looking at this boot" : "nobody is");
  }
  internals.setHeadless("");

  await world({ shown: true });
  internals.setHeadless("boot", true);
  await internals.enterCircle();
  await internals.reportHeadlessBoot();
  assert.equal(state.sharing, true);
  assert.deepEqual(reports, ["started"], "the wrapper still hears that the share is up");
  assert.equal(state.autoResumed, null, "a card the person already dismissed stays dismissed");
  await internals.setSharing(false);
});

test("the status note under the switches, for every state the wrapper can report", () => {
  const base = { boot: false, update: false, lock: false, keepSharing: true, notifications: true, background: "settings", tor: false };
  const note = (over) => autoResumeNote({ ...base, ...over });

  assert.equal(note({}).disabled, false);
  assert.match(note({}).lines[0], /only while you use the app. Turning one of these on asks Android/);
  assert.match(note({}).lines.at(-1), /It never brings back a share you stopped/);

  const lock = note({ lock: true, keepSharing: false, notifications: false });
  assert.equal(lock.disabled, true);
  assert.match(lock.lines[0], /^Off while the app lock is on/, "the lock is the reason given first");

  const keep = note({ keepSharing: false });
  assert.equal(keep.disabled, true);
  assert.match(keep.lines[0], /need Keep sharing when the app is closed/);

  const quiet = note({ notifications: false });
  assert.equal(quiet.disabled, true);
  assert.equal(quiet.button, "notifications");

  const never = note({ background: "noLocation" });
  assert.equal(never.disabled, true);
  assert.match(never.lines[0], /Share once first/);

  const granted = note({ background: "granted" });
  assert.equal(granted.disabled, false);
  assert.equal(granted.button, "app", "a grant used for nothing says how to take it back");
  assert.match(granted.lines[0], /uses that for nothing while both of these are off/);
  const used = note({ background: "granted", boot: true });
  assert.equal(used.button, null);
  assert.doesNotMatch(used.lines.join(" "), /uses that for nothing/);

  assert.match(note({ background: "notNeeded" }).lines[0], /On Android 9/);
  assert.match(note({ tor: true }).lines.at(-1), /^Route through Orbot is on, so a share that comes back sends nothing until Orbot connects/);
});

const findTestid = (n, id) => {
  if (n?.dataset?.testid === id) return n;
  for (const k of n?.children || []) {
    const f = findTestid(k, id);
    if (f) return f;
  }
  return null;
};
const textOf = (n) => [n?.textContent || "", ...(n?.children || []).map(textOf)].join(" ");

test("in Settings the switches sit under Keep sharing, repaint from the wrapper, and an on switch can always go off", () => {
  let st = { boot: false, update: true, lock: true, keepSharing: true, notifications: true, background: "granted", tor: false };
  const host = harness.node("#overlays");
  host.children.length = 0;
  const sheet = openSettingsSheet({
    api,
    values: { circleName: "C", profile: { name: "", emoji: "x" }, settings: state.settings, share: { precision: "precise", cadence: 15 }, relay: null },
    demo: false,
    tor: null,
    keepSharing: { enabled: true },
    autoResume: { read: () => st, onToggle: async () => false, onOpenNotifications() {}, onOpenApp() {} },
    background: null,
    forward: null,
    lock: null,
    lockActions: {},
    onChange() {},
    onMembers() {},
    onInvite() {},
    onPlaces() {},
    onPanic() {},
    onLeave() {},
    onExport: null,
    onClose() {},
  });
  const sw = (id) => findTestid(host, id).children[1];
  const box = () => findTestid(host, "settings-auto-resume");
  assert.equal(sw("settings-auto-boot").disabled, true, "nothing turns on under the app lock");
  assert.equal(sw("settings-auto-update").disabled, false, "but one already on can be turned off");
  assert.equal(sw("settings-auto-update").getAttribute("aria-checked"), "true");
  assert.match(textOf(box()), /Off while the app lock is on/);

  st = { ...st, lock: false, update: false };
  sheet.refresh();
  assert.equal(sw("settings-auto-boot").disabled, false);
  assert.equal(sw("settings-auto-update").getAttribute("aria-checked"), "false");
  assert.ok(findTestid(host, "settings-auto-app"), "a grant used for nothing comes with the way back to Android's settings");

  st = { ...st, notifications: false };
  sheet.refresh();
  assert.equal(sw("settings-auto-boot").disabled, true);
  assert.ok(findTestid(host, "settings-auto-notifications"));
  sheet.close();
});

test("the disclosure says what, why and for nothing else, and names Android's own choice", () => {
  const host = harness.node("#overlays");
  host.children.length = 0;
  confirmBackgroundLocation({ mode: "settings", label: "Allow all the time" });
  const sheet = findTestid(host, "background-sheet");
  assert.ok(sheet);
  const text = textOf(sheet);
  assert.match(text, /Starling uses your location to keep sharing it with your circle after a restart or an update, even when the app is closed or not in use/);
  assert.match(text, /Starling uses it for nothing else/);
  assert.match(text, /Android opens Starling's location settings next\. Choose Allow all the time, then come back\./);
  assert.ok(findTestid(host, "background-go") && findTestid(host, "background-later"));
  host.children.length = 0;
  confirmBackgroundLocation({ mode: "dialog", label: "Allow all the time" });
  assert.match(textOf(host), /Android asks next\. Choose Allow all the time\./);
  host.children.length = 0;
});

test("turning one on explains first, then asks Android, and only then switches it on", async () => {
  await world({ headless: "", shown: true });
  const order = [];
  internals.setConfirmBackground(async (opts) => {
    order.push(["disclosure", opts.mode, opts.label]);
    return true;
  });
  const realRequest = globalThis.StarlingNative.requestBackgroundLocation;
  globalThis.StarlingNative.requestBackgroundLocation = (token) => {
    order.push(["request"]);
    realRequest(token);
  };
  harness.node("#toasts").children.length = 0;
  assert.equal(await internals.toggleAutoResume("boot", true), true);
  assert.deepEqual(order, [["disclosure", "settings", "Allow all the time"], ["request"]]);
  assert.deepEqual(bridge.auto, { boot: true, update: false });
  assert.ok(toasts().includes("Sharing will come back by itself after a restart."));

  order.length = 0;
  assert.equal(await internals.toggleAutoResume("update", true), true);
  assert.deepEqual(order, [], "already allowed: nothing to explain or ask");
  assert.deepEqual(bridge.auto, { boot: true, update: true });

  harness.node("#toasts").children.length = 0;
  assert.equal(await internals.toggleAutoResume("boot", false), false);
  assert.deepEqual(bridge.auto, { boot: false, update: true });
  assert.ok(toasts().includes("After a restart you get a tap to share again instead."));
});

test("Not now, a denial, or Android having stopped asking all leave it off", async () => {
  await world({ headless: "", shown: true });
  internals.setConfirmBackground(async () => false);
  assert.equal(await internals.toggleAutoResume("boot", true), false);
  assert.ok(!calls.includes("requestBackground"), "Not now asks Android nothing");
  assert.deepEqual(bridge.auto, { boot: false, update: false });

  internals.setConfirmBackground(async () => true);
  harness.node("#toasts").children.length = 0;
  bridge.grant = false;
  assert.equal(await internals.toggleAutoResume("boot", true), false);
  assert.deepEqual(bridge.auto, { boot: false, update: false });
  assert.ok(
    toasts().includes("Android will not ask again. In Starling's app settings, open Permissions, then Location, and choose Allow all the time."),
    toasts().join(" | "),
  );

  harness.node("#toasts").children.length = 0;
  bridge.grantDelay = 1100;
  assert.equal(await internals.toggleAutoResume("update", true), false);
  assert.ok(toasts().includes("Android still allows your location only while you use Starling, so this stays off."));

  harness.node("#toasts").children.length = 0;
  bridge.grantDelay = 0;
  bridge.bg = "dialog";
  bridge.label = "";
  let label = null;
  internals.setConfirmBackground(async (opts) => {
    label = opts.label;
    return true;
  });
  assert.equal(await internals.toggleAutoResume("update", true), false);
  assert.equal(label, "Allow all the time", "Android 10 gives no label, so the page names it");
  assert.ok(toasts().includes("Android still allows your location only while you use Starling, so this stays off."), "a quick no from the Android 10 dialog is just a no");
});

test("the lock, Keep sharing off, hidden notifications or no location at all refuse before asking anything", async () => {
  for (const [why, over, extra] of [
    ["app lock", {}, () => (state.lock = { enabled: true })],
    ["keep sharing off", { keep: false }],
    ["notifications hidden", { notif: false }],
    ["no location permission yet", { bg: "noLocation" }],
  ]) {
    await world({ headless: "", shown: true, over });
    extra?.();
    let asked = false;
    internals.setConfirmBackground(async () => {
      asked = true;
      return true;
    });
    assert.equal(await internals.toggleAutoResume("boot", true), false, why);
    assert.equal(asked, false, `${why}: no disclosure`);
    assert.ok(!calls.includes("requestBackground"), `${why}: no ask`);
    assert.ok(!calls.some((c) => c.startsWith("setAutoResume:true")), `${why}: never written on`);
  }
  state.lock = null;
});

test("the switches go off before the panic wipe, and on the last circle's leave", async () => {
  await world({ headless: "", shown: true, over: { auto: { boot: true, update: true }, bg: "granted" } });
  await internals.panic();
  const off = calls.indexOf("setAutoResume:false,false");
  assert.ok(off >= 0, "panic turns them off");
  assert.ok(off < calls.indexOf("panicWipe"), "before the wipe kills the process");
  state.gen = null;

  await world({ headless: "", shown: true, over: { auto: { boot: true, update: false }, bg: "granted" } });
  state.circles = [];
  assert.equal(await internals.leaveCircle(), true);
  assert.ok(calls.includes("setAutoResume:false,false"), "no circle left to bring back");
  assert.deepEqual(bridge.auto, { boot: false, update: false });
  assert.equal(state.gen, null);
});

test("an older wrapper without the methods still shares, and nothing here throws", async () => {
  await world({ headless: "", shown: true });
  const n = globalThis.StarlingNative;
  for (const m of [
    "headlessResumeState",
    "autoResume",
    "setAutoResume",
    "backgroundLocation",
    "backgroundOptionLabel",
    "requestBackgroundLocation",
    "notificationsShown",
    "readAutoResumeRecord",
    "clearAutoResumeRecord",
  ]) {
    delete n[m];
  }
  await internals.enterCircle();
  await settle();
  assert.equal(state.sharing, true);
  await internals.reportHeadlessBoot();
  assert.equal(await internals.toggleAutoResume("boot", true), false);
  assert.deepEqual(internals.autoResumeStatus(), {
    boot: false,
    update: false,
    lock: false,
    keepSharing: true,
    notifications: false,
    background: "noLocation",
    tor: false,
  });
  await internals.setSharing(false);
});

test("turning the app lock on turns the switches off before anything is sealed", async () => {
  await world({ headless: "", shown: true, over: { auto: { boot: true, update: true }, bg: "granted" } });
  const { dbGet } = await import("../app/js/store.js");
  await dbDel("lock");
  let sealedAtOff = null;
  const off = globalThis.StarlingNative.setAutoResume;
  globalThis.StarlingNative.setAutoResume = (boot, update) => {
    if (!boot && !update) sealedAtOff = dbGet("lock");
    return off(boot, update);
  };
  assert.equal(await internals.enableLock("2468"), true);
  assert.deepEqual(bridge.auto, { boot: false, update: false });
  assert.ok(sealedAtOff, "the lock turned them off");
  assert.equal(await sealedAtOff, undefined, "while the lock record was not written yet");
  assert.equal((await dbGet("lock"))?.enabled, true, "and the lock did go on");
  state.lock = null;
  state.locked = false;
  await dbDel("lock");
});

// ------------------------------------------------------------- Kotlin, as source

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const kt = (name) => read(`android/app/src/main/kotlin/app/starlingmap/${name}`);
const code = (body) => body.replace(/\/\/[^\n]*/g, "");

function fn(src, name) {
  const at = src.search(new RegExp(`fun ${name}\\([^)]*\\)(: [\\w?<>, .]+)? \\{`));
  assert.ok(at >= 0, `fun ${name} exists`);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

function fnExpr(src, name) {
  const at = src.search(new RegExp(`fun ${name}\\(`));
  assert.ok(at >= 0, `fun ${name} exists`);
  return src.slice(at, src.indexOf("\n\n", at));
}

test("a circle that erased itself with no other circle to take its place turns the switches off too", () => {
  const src = read("app/js/main.js");
  const body = src.slice(src.indexOf("async function leaveDestroyedCircle"), src.indexOf("function showDestroyedNotice"));
  const off = body.indexOf("autoResumeOff();");
  assert.ok(off > body.indexOf("if (res.active) {"), "not when another circle took the slots");
  assert.ok(off < body.indexOf("state.identity = null;"), "but as soon as nothing is left");
});

test("Kotlin: the permission is declared once, nothing runs before the first unlock, and nobody else can fire the receiver", () => {
  const m = read("android/app/src/main/AndroidManifest.xml");
  assert.equal((m.match(/<uses-permission android:name="android\.permission\.ACCESS_BACKGROUND_LOCATION" \/>/g) || []).length, 1);
  assert.doesNotMatch(m, /LOCKED_BOOT_COMPLETED|directBootAware/);
  const receiver = m.match(/<receiver\s+android:name="\.ShareResumeReceiver"[\s\S]*?<\/receiver>/)[0];
  assert.match(receiver, /android:exported="false"/);
  assert.match(m, /android:name="\.LocationService"\s*android:exported="false"/);
});

test("Kotlin: one gate decides, and it needs every input", () => {
  const src = kt("ShareResume.kt");
  const decide = code(fn(src, "decide"));
  assert.match(decide, /if \(!due\) return Path\.NONE/);
  assert.match(
    decide,
    /if \(autoOn && keepSharing && background && notifications && webViewOk && \(!torOn \|\| torSupported\)\) return Path\.HEADLESS/,
  );
  assert.match(decide, /return Path\.OFFER\s*\}$/);
  const start = code(fn(src, "onSystemStart"));
  assert.match(start, /if \(LocationService\.running \|\| starting\) return/, "a share already running is left alone");
  assert.match(start, /if \(!\(keep && background && notifications\)\) autoOff\(ctx\)/, "a switch that cannot be honoured goes off");
  assert.match(start, /Path\.HEADLESS -> try \{\s*starting = true\s*LocationService\.startResumed\(ctx, why\)\s*\} catch \(e: Exception\) \{\s*starting = false\s*Events\.postShareResume\(ctx, offer\)/);
  for (const f of ["ShareResume.kt", "LocationService.kt", "PageHost.kt", "MainActivity.kt", "StarlingBridge.kt", "Wipe.kt", "TorProxy.kt"]) {
    const hits = (kt(f).match(/startResumed\(/g) || []).length;
    const want = f === "ShareResume.kt" ? 1 : f === "LocationService.kt" ? 1 : 0;
    assert.equal(hits, want, `startResumed( in ${f}`);
  }
  assert.match(kt("LocationService.kt"), /fun startResumed\(ctx: Context, why: String\) \{/, "LocationService only defines it");
});

test("Kotlin: the service says why before it goes foreground, holds your own server back, and is never sticky", () => {
  const svc = kt("LocationService.kt");
  const start = code(fn(svc, "onStartCommand"));
  const why = start.indexOf("resumedWhy = ");
  assert.ok(why > 0 && why < start.indexOf("ServiceCompat.startForeground("), "the title is right from the first frame");
  assert.ok(start.indexOf("ACTION_STOP") < start.indexOf("ACTION_RESUME"), "Stop is still handled first");
  assert.ok(start.indexOf("ACTION_REPOST") < start.indexOf("ACTION_RESUME"), "and the repost second");
  assert.match(start, /if \(resume\) \{\s*if \(running\) return START_NOT_STICKY/);
  assert.match(start, /catch \(e: Exception\) \{[\s\S]*?if \(resume\) ShareResume\.startFailed\(this\)[\s\S]*?return START_NOT_STICKY/, "a refused start falls back to the tap");
  assert.match(start, /if \(resume\) \{\s*if \(live\) ShareResume\.serviceUp\(this\) else ShareResume\.startFailed\(this\)\s*\}/);
  assert.match(fn(svc, "onLocationChanged"), /if \(!resumePending\) Forward\.maybeSend\(this, location\)/);
  assert.match(fn(svc, "onDestroy"), /ShareResume\.serviceGone\(\)/);
  for (const f of ["LocationService.kt", "ShareResume.kt", "PageHost.kt"]) {
    assert.doesNotMatch(kt(f), /(?<!NOT_)START_STICKY|START_REDELIVER_INTENT/, `${f} never asks Android to restart it`);
  }
  const build = code(fn(svc, "buildNotification"));
  assert.match(build, /"boot" -> getString\(R\.string\.notif_title_resumed_boot\)/);
  assert.match(build, /"update" -> getString\(R\.string\.notif_title_resumed_update\)/);
  assert.equal((build.match(/\.setContentTitle\(title\)/g) || []).length, 2, "the lock screen version says the same");
  const off = build.indexOf("locationOff -> ");
  const tor = build.indexOf("waitingForTor -> getString(R.string.notif_waiting_orbot)");
  const fwd = build.indexOf("forwardHost != null -> ");
  assert.ok(off >= 0 && tor > off && fwd > tor);
});

test("Kotlin: the page with no window loads only behind the proxy, and reuses the kept page's machinery", () => {
  const host = kt("PageHost.kt");
  const boot = code(fn(host, "bootHeadless"));
  assert.match(boot, /if \(!SystemCheck\.webViewOk\(app\)\) return false/, "the WebView floor a window would enforce");
  assert.match(boot, /activity = null/);
  assert.match(boot, /build\(app\)\s*hold\(\)/, "held in the same private display a kept page is");
  assert.match(boot, /val tor = TorProxy\.enabled\(app\)\s*if \(tor && !TorProxy\.supported\(\)\) return false/, "Tor on with no way to set a proxy is the tap, never a direct load");
  assert.ok(boot.indexOf("TorProxy.supported()") < boot.indexOf("build(app)"));
  assert.match(boot, /val pending = TorProxy\.apply\(app, Runnable \{ if \(tor\) load\(null\) \}\)/);
  assert.ok(boot.indexOf("TorProxy.apply(") < boot.indexOf("build(app)"), "the proxy is set before the WebView exists");
  assert.match(
    boot,
    /hold\(\)\s*if \(!tor \|\| !pending\) load\(null\)/,
    "with Tor on the page loads from the listener, or at once when the rule is already in; with Tor off it waits on no listener",
  );
  assert.equal((boot.match(/load\(/g) || []).length, 2, "no other load");
  assert.match(fn(host, "attach"), /return build\(app\)/, "one way to build a page");
  assert.match(fnExpr(host, "backgroundReply"), /eval\("globalThis\.__starlingBackground && __starlingBackground\(\$\{JSONObject\.quote\(token\)\}, \$granted\)"\)/);
  assert.match(fn(host, "setKeepSharing"), /if \(!on\) ShareResume\.autoOff\(ctx\)/);
  const tor = kt("TorProxy.kt");
  assert.match(tor, /setProxyOverride\(config, executor, then\)/);
  assert.match(tor, /clearProxyOverride\(executor, then\)/);
  assert.match(tor, /"socks5:\/\/127\.0\.0\.1:\$\{OrbotStatus\.socksPort\}"/);
});

test("Kotlin: the page's word is checked, and anything but started ends the share", () => {
  const src = kt("ShareResume.kt");
  assert.match(src, /private val PAGE_STATES = setOf\("started", "delivered", "locked", "declined"\)/);
  assert.match(fn(src, "pageSaid"), /if \(state !in PAGE_STATES\) return/);
  const on = code(fn(src, "onPage"));
  assert.match(on, /val why = headlessWhy \?: return/, "only while a share came back by itself");
  assert.match(on, /"started" -> \{[\s\S]*?LocationService\.resumePending = false/, "your own server waits for this");
  assert.match(
    on,
    /if \(alerted\) return\s*alerted = true\s*Events\.postShareResumed\([\s\S]*?\)\s*prefs\(ctx\)\.edit\(\)\.putString\(PREF_LAST_WHY, why\)/,
    "the alert and the record once for each share that came back, so a reload brings back no dismissed card",
  );
  assert.match(code(fn(src, "clear")), /alerted = false/, "and the next one alerts again");
  assert.match(on, /else -> \{[\s\S]*?LocationService\.stop\(ctx\)/, "locked and declined both end it");
  assert.match(
    on,
    /else -> \{\s*val alone = PageHost\.activity == null[\s\S]*?LocationService\.stop\(ctx\)\s*if \(alone\) offerIfDue\(ctx, offerText\(why\)\)\s*\}/,
    "locked and declined both get the tap back when nobody is at the window",
  );
  assert.doesNotMatch(on, /state == "locked"/, "a page that threw says declined, and that must not end in nothing");
  assert.match(code(fn(src, "offerIfDue")), /if \(dueNow\(ctx\)\) Events\.postShareResume\(ctx, text\)/, "a share stopped or run out gets no tap");
  const abandon = code(fn(src, "abandon"));
  assert.match(abandon, /if \(PageHost\.activity != null\) return/, "never behind a person's back");
  assert.ok(abandon.indexOf("PageHost.destroy()") < abandon.indexOf("LocationService.stop(ctx)"), "no page, no posts, then no service");
  const up = code(fn(src, "serviceUp"));
  assert.match(up, /if \(!runCatching \{ PageHost\.bootHeadless\(app\) \}\.getOrDefault\(false\)\) \{\s*abandon\(app, offerText\(why\)\)/, "a page that cannot be built is the tap, not a crash at boot");
  assert.match(code(fn(src, "onSystemStart")), /val torSupported = webViewOk && torOn && runCatching \{ TorProxy\.supported\(\) \}\.getOrDefault\(false\)/, "and neither is a WebView that cannot answer");
  assert.match(up, /CONFIRM_MS/);
  assert.match(up, /ORBOT_WAIT_MS/);
  assert.match(up, /R\.string\.notif_resume_orbot_text/);
  assert.match(src, /private const val ORBOT_ASK_MS = 25_000L/, "inside Orbot's trust window");
  const bridge = kt("StarlingBridge.kt");
  assert.match(bridge, /fun headlessResumeState\(state: String\) = ShareResume\.pageSaid\(app, state\)/);
  assert.match(bridge, /fun headlessResume\(\): String = ShareResume\.headlessWhy \?: ""/);
});

test("Kotlin: a switch goes on only with a person at the window and every gate passed", () => {
  const src = kt("ShareResume.kt");
  const set = code(fn(src, "setAuto"));
  assert.match(set, /val ready = PageHost\.windowShown && PageHost\.keepSharing\(ctx\) && backgroundHeld\(ctx\) && notificationsVisible\(ctx\)/);
  assert.match(set, /val nextBoot = boot && \(autoBoot\(ctx\) \|\| ready\)/);
  assert.match(set, /val nextUpdate = update && \(autoUpdate\(ctx\) \|\| ready\)/);
  assert.match(code(fn(src, "autoState")), /if \(!\(PageHost\.keepSharing\(ctx\) && backgroundHeld\(ctx\) && notificationsVisible\(ctx\)\)\) autoOff\(ctx\)/);
  const visible = code(fn(src, "notificationsVisible"));
  assert.match(visible, /areNotificationsEnabled\(\)\) return false/);
  assert.match(visible, /listOf\(LocationService\.CHANNEL, MainActivity\.EVENTS_CHANNEL\)/);
  assert.match(visible, /IMPORTANCE_NONE\) return false/);
  const held = code(fn(src, "backgroundHeld"));
  assert.match(held, /if \(!locationHeld\(ctx\)\) return false/);
  assert.match(held, /ACCESS_BACKGROUND_LOCATION/);
  const bridge = kt("StarlingBridge.kt");
  const ask = code(fn(bridge, "requestBackgroundLocation"));
  assert.match(ask, /if \(a == null\) \{\s*PageHost\.backgroundReply\(token, false\)/, "no window, no ask");
  assert.match(ask, /if \(PageHost\.windowShown && PageHost\.activity === a\) a\.askBackgroundLocation\(token\)/);
  assert.match(fn(kt("MainActivity.kt"), "onCreate"), /PageHost\.attach\(this\)\s*ShareResume\.windowOpened\(\)/);
});

test("Kotlin: the wipe forgets the switches and gives the grant back before it kills the process", () => {
  const wipe = code(fn(kt("Wipe.kt"), "everything"));
  const forget = wipe.indexOf("ShareResume.forgetAuto(ctx)");
  const revoke = wipe.indexOf("revokeSelfPermissionsOnKill(listOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION))");
  const clear = wipe.indexOf("clearApplicationUserData()");
  assert.ok(forget > 0 && revoke > forget && clear > revoke);
  assert.match(wipe, /SDK_INT >= Build\.VERSION_CODES\.TIRAMISU\) \{\s*runCatching \{ ctx\.revokeSelfPermissionsOnKill/);
});

test("Kotlin: the alert carries string resources only, in every language", () => {
  assert.match(
    kt("Events.kt"),
    /fun postShareResumed\(ctx: Context, @StringRes textRes: Int\) =\s*show\(ctx, R\.string\.notif_resumed_title, textRes, ShareResume\.RESUMED_TAG, false\)/,
  );
  const keys = [
    "notif_title_resumed_boot",
    "notif_title_resumed_update",
    "notif_waiting_orbot",
    "notif_resumed_title",
    "notif_resumed_boot_text",
    "notif_resumed_update_text",
    "notif_resume_orbot_text",
  ];
  const dash = new RegExp("[\\u2013\\u2014]");
  for (const dir of ["values", "values-es", "values-de", "values-fr", "values-pt"]) {
    const xml = read(`android/app/src/main/res/${dir}/strings.xml`);
    for (const key of keys) {
      const v = xml.match(new RegExp(`<string name="${key}">([^<]+)</string>`))?.[1];
      assert.ok(v, `${dir}/${key}`);
      assert.ok(!dash.test(v), `${dir}/${key} has a dash`);
      assert.ok(!v.includes("%"), `${dir}/${key} takes nothing from a caller`);
    }
  }
});

test("Kotlin: the report counts and states, never a position", () => {
  const h = kt("Health.kt");
  for (const field of ["autoBoot", "autoUpdate", "background", "resumedBy", "headlessResumes", "headlessAbandons"]) {
    assert.match(h, new RegExp(`o\\.put\\("${field}", `), field);
  }
  assert.match(h, /o\.put\("resumedBy", ShareResume\.headlessWhy \?: ""\)/);
});
