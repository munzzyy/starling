// The page's half of munzzyy/starling#6, a share with nobody looking, held
// against the real main.js.
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
const { openGeneration } = await import("../app/js/rekey.js");
const { epochAt } = await import("../app/js/ratchet.js");
const { generateIdentity, newSeed } = await import("../app/js/crypto.js");

test.after(() => harness.stopTimers());

const bridge = { calls: [], pulses: [], shown: false };

async function sharing() {
  bridge.calls.length = 0;
  bridge.pulses.length = 0;
  globalThis.StarlingNative = {
    startLocation: () => bridge.calls.push("startLocation"),
    stopLocation: () => bridge.calls.push("stopLocation"),
    clearStopRecord: () => {},
    keepSharing: () => false,
    setKeepSharing: () => {},
    windowShown: () => bridge.shown,
    pulse: (busy) => bridge.pulses.push(busy),
    notify: (...a) => bridge.calls.push(["notify", ...a]),
  };
  internals.resetShareResumeGuard();
  state.demo = false;
  state.locked = false;
  state.stopRecord = null;
  state.sosActive = false;
  state.identity = state.identity || (await generateIdentity());
  if (!state.gen) {
    state.gen = await openGeneration({ seed: new Uint8Array(newSeed()), g: 0, e0: epochAt(Date.now()) });
    state.gen.at = Date.now();
    state.genRoster = new Set();
    state.pinned = new Map();
  }
  if (state.sharing) await internals.setSharing(false);
  internals.setupNet();
  await internals.setSharing(true);
  assert.equal(state.sharing, true);
  assert.equal(typeof globalThis.__starlingFix, "function");
}

// Location POSTs, each held open until the check lets it answer.
function holdPosts() {
  const posts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    if (opts?.method === "POST" && String(url).endsWith("/loc")) {
      return new Promise((resolve) => posts.push(() => resolve(new Response("{}", { status: 200 }))));
    }
    return realFetch(url, opts);
  };
  let answered = 0;
  return {
    posts,
    // Answering can set off another post, so drain until nothing is held.
    async restore() {
      while (answered < posts.length) {
        while (answered < posts.length) posts[answered++]();
        await settle();
      }
      globalThis.fetch = realFetch;
    },
  };
}

let north = 0;
function fix() {
  // Each one 44 m further on, so every fix is worth a post.
  north += 1;
  return JSON.stringify({ lat: 40.78 + 0.0004 * north, lon: -73.97, ts: Date.now(), acc: 5 });
}

test("a burst of fixes behind a slow post sends one more post, not the whole backlog", async () => {
  await sharing();
  const held = holdPosts();
  const realNow = Date.now;
  const t0 = realNow();
  try {
    globalThis.__starlingFix(fix());
    await settle();
    assert.equal(held.posts.length, 1, "the first fix posts");
    // Five seconds apart, as a frozen page is handed them.
    for (let i = 1; i <= 5; i++) {
      Date.now = () => t0 + i * 5000;
      globalThis.__starlingFix(fix());
      await settle(5);
    }
    assert.equal(held.posts.length, 1, "nothing queues up behind a post in flight");
    held.posts[0]();
    await settle();
    assert.equal(held.posts.length, 2, "the newest position goes next, once");
    held.posts[1]();
    await settle();
    assert.equal(held.posts.length, 2, "and that is the end of it");
    assert.equal(internals.sendStatus().busy, 0);
  } finally {
    Date.now = realNow;
    await held.restore();
  }
});

test("every push is answered, with the posts still in flight, so the phone can sleep after", async () => {
  await sharing();
  const held = holdPosts();
  try {
    bridge.pulses.length = 0;
    globalThis.__starlingFix(fix());
    await settle();
    assert.ok(bridge.pulses.includes(1), `the push is answered while its post is out: ${bridge.pulses}`);
    held.posts[0]();
    await settle();
    assert.equal(bridge.pulses.at(-1), 0, "and again when it settles, with nothing left in flight");

    bridge.pulses.length = 0;
    globalThis.__starlingFix(JSON.stringify({ tick: true }));
    await settle();
    assert.ok(bridge.pulses.length >= 1, "a tick is answered too");
    held.posts.at(-1)?.();
    await settle();
  } finally {
    await held.restore();
  }
});

test("a clock refusal whose check never answers does not hold up the posts after it", async () => {
  await sharing();
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  const t0 = realNow();
  let posts = 0;
  let checks = 0;
  globalThis.fetch = (url, opts) => {
    if (opts?.method === "POST" && String(url).endsWith("/loc")) {
      posts += 1;
      const body = posts === 1 ? JSON.stringify({ error: "clock" }) : "{}";
      return Promise.resolve(new Response(body, { status: posts === 1 ? 400 : 200 }));
    }
    // The clock check is the only GET with a deadline of its own; this one never answers.
    if (opts?.signal && String(url).includes("?since=")) {
      checks += 1;
      return new Promise(() => {});
    }
    return realFetch(url, opts);
  };
  try {
    globalThis.__starlingFix(fix());
    await settle();
    assert.equal(posts, 1);
    assert.equal(checks, 1, "the refusal set off a clock check, with a deadline of its own");
    Date.now = () => t0 + 5000;
    globalThis.__starlingFix(fix());
    await settle();
    assert.equal(posts, 2, "the next fix posts while the check still hangs");
    assert.equal(internals.sendStatus().busy, 0);
  } finally {
    Date.now = realNow;
    globalThis.fetch = realFetch;
  }
});

test("a minute with no fix resends the last position", async () => {
  await sharing();
  const held = holdPosts();
  try {
    globalThis.__starlingFix(fix());
    await settle();
    held.posts[0]();
    await settle();
    const before = held.posts.length;
    // Past the 3 s floor between posts, as a real minute would be.
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try {
      globalThis.__starlingFix(JSON.stringify({ tick: true }));
      await settle();
    } finally {
      Date.now = realNow;
    }
    assert.equal(held.posts.length, before + 1, "the tick posts");
    held.posts.at(-1)();
    await settle();
  } finally {
    await held.restore();
  }
});

test("a position that arrives between generations waits for the next sender", async () => {
  await sharing();
  const held = holdPosts();
  try {
    internals.teardownNet();
    assert.equal(internals.hasSender(), false);
    globalThis.__starlingFix(fix());
    await settle();
    assert.equal(held.posts.length, 0, "nothing to seal with yet");
    assert.equal(internals.sendStatus().whenReady, true, "but it is remembered");
    internals.setupNet();
    await settle();
    assert.equal(held.posts.length, 1, "and sent on the next sender");
    held.posts[0]();
    await settle();
  } finally {
    await held.restore();
  }
});

test("with location switched off the last position is not resent as live, but an SOS still goes", async () => {
  await sharing();
  const held = holdPosts();
  try {
    globalThis.__starlingFix(fix());
    await settle();
    held.posts[0]();
    await settle();
    const before = held.posts.length;
    globalThis.__starlingFix(JSON.stringify({ paused: "location-off" }));
    await settle();
    assert.equal(internals.sendStatus().locationPaused, "location-off");
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try {
      internals.sendLoc(true);
      await settle();
      assert.equal(held.posts.length, before, "no routine post while location is off");
      state.sosActive = true;
      internals.sendLoc(true);
      await settle();
      assert.equal(held.posts.length, before + 1, "an SOS is not held back");
    } finally {
      Date.now = realNow;
      state.sosActive = false;
    }
    held.posts.at(-1)();
    await settle();
    globalThis.__starlingFix(JSON.stringify({ paused: "" }));
    assert.equal(internals.sendStatus().locationPaused, null, "and back on clears it");
  } finally {
    await held.restore();
  }
});

test("a share Android ended comes back when the app is opened; one a person ended does not", async () => {
  await sharing();
  globalThis.__starlingFix(JSON.stringify({ stopped: true, route: "system" }));
  await settle();
  assert.equal(state.sharing, false, "the share stops claiming to be live");
  assert.equal(state.stopRecord?.route, "system", "and says why");
  assert.equal(await internals.resumeShareIfArmed(), true, "opening the app puts it back");
  assert.equal(state.sharing, true);

  await sharing();
  globalThis.__starlingFix(JSON.stringify({ stopped: true, route: "stalled" }));
  await settle();
  assert.equal(state.sharing, false);
  assert.equal(await internals.resumeShareIfArmed(), true, "a stall is not a decision either");

  await sharing();
  globalThis.__starlingFix(JSON.stringify({ stopped: true }));
  await settle();
  assert.equal(state.sharing, false);
  internals.resetShareResumeGuard();
  assert.equal(await internals.resumeShareIfArmed(), false, "a Stop from the notification stays stopped");
});

test("a moment of visibility with no window up does not suppress a notification", async () => {
  await sharing();
  const prev = document.visibilityState;
  try {
    document.visibilityState = "visible";
    bridge.shown = false;
    bridge.calls.length = 0;
    internals.notifyEvent("SOS from Juno", "body", "sos-1", "sos");
    assert.equal(bridge.calls.filter((c) => c[0] === "notify").length, 1, "nobody is looking, so it goes to the tray");
    bridge.shown = true;
    internals.notifyEvent("SOS from Juno", "body", "sos-1", "sos");
    assert.equal(bridge.calls.filter((c) => c[0] === "notify").length, 1, "with the window up the toast is enough");
  } finally {
    document.visibilityState = prev;
    bridge.shown = false;
  }
});

test("the line under your name stops saying live once the circle stops hearing from this phone", async () => {
  await internals.enterCircle();
  await sharing();
  assert.equal(state.screen, "map", "the line is on the map screen");
  const held = holdPosts();
  const realNow = Date.now;
  try {
    globalThis.__starlingFix(fix());
    await settle();
    held.posts[0]();
    await settle();
    const sub = harness.node("#you-sub");
    Date.now = () => realNow() + 2 * 60_000;
    globalThis.__starlingFix(JSON.stringify({ lat: 40.78 + 0.0004 * north, lon: -73.97, ts: Date.now(), acc: 5 }));
    await settle();
    assert.match(sub.textContent, /^Live · Precise · last sent 2 min ago$/, sub.textContent);
    Date.now = () => realNow() + 5 * 60_000;
    globalThis.__starlingFix(JSON.stringify({ lat: 40.78 + 0.0004 * north, lon: -73.97, ts: Date.now(), acc: 5 }));
    await settle();
    assert.match(sub.textContent, /^Not reaching your circle · last sent 5 min ago$/, sub.textContent);
  } finally {
    Date.now = realNow;
    await held.restore();
  }
});

test("the battery question is asked once, and a no is final", async () => {
  await sharing();
  state.settings = { ...state.settings, batteryAsked: false };
  const card = internals.healthCard("optimized");
  assert.ok(card, "asked while a share runs on an optimized phone");
  const later = card.actions.find((a) => a.testid === "alert-health-later");
  later.onClick();
  assert.equal(state.settings.batteryAsked, true);
  assert.equal(internals.healthCard("optimized"), null, "not asked again");
});

test("the Battery Saver card opens Battery Saver settings, on a wrapper that can", async () => {
  await sharing();
  const prev = globalThis.StarlingNative;
  try {
    const without = internals.healthCard("saver");
    assert.deepEqual(without.actions.map((a) => a.testid), ["alert-health-ok-saver"], "an older wrapper keeps only Got it");
    const opened = [];
    globalThis.StarlingNative = { ...prev, openSaverSettings: () => opened.push("saver") };
    const card = internals.healthCard("saver");
    assert.deepEqual(card.actions.map((a) => a.testid), ["alert-health-saver", "alert-health-ok-saver"]);
    assert.equal(card.actions[0].label, "Open Battery Saver settings");
    card.actions[0].onClick();
    assert.deepEqual(opened, ["saver"]);
  } finally {
    globalThis.StarlingNative = prev;
  }
});

// Last, because it locks the app.
test("autolock is not reset by a thaw, and a frozen timer cannot sleep through an absence", async () => {
  await sharing();
  await internals.setSharing(false);
  const prevVis = document.visibilityState;
  const prevLock = state.lock;
  const realNow = Date.now;
  state.lock = { enabled: true, autolockMs: 60_000 };
  try {
    document.visibilityState = "hidden";
    bridge.shown = false;
    internals.armAutoLock();
    assert.equal(internals.lockArmed(), true, "hidden: the countdown starts");

    // The wrapper thaws the page: visible for a second, no window.
    document.visibilityState = "visible";
    internals.armAutoLock();
    assert.equal(internals.lockArmed(), true, "a thaw is not the person coming back");
    document.visibilityState = "hidden";
    internals.armAutoLock();
    assert.equal(internals.lockArmed(), true);

    // The timer never ran in the frozen page; the person is back five minutes later.
    Date.now = () => realNow() + 5 * 60_000;
    document.visibilityState = "visible";
    bridge.shown = true;
    internals.armAutoLock();
    assert.equal(state.locked, true, "the clock locks it on the way back in");
  } finally {
    Date.now = realNow;
    document.visibilityState = prevVis;
    bridge.shown = false;
    if (!state.locked) state.lock = prevLock;
  }
});
