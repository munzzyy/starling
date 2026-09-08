// A share can end from the notification's Stop button or a task swipe, and
// neither is guaranteed to leave the page around to see it happen. The
// native side (LocationService, untestable here; see its own comments)
// writes a durable record before it ever touches the notification; these
// check what the page does with that record: surface it honestly on the
// next open, clear it only once acknowledged, name it in real time when the
// page IS still alive to hear about it, and let a panic wipe take it with
// everything else.
import test from "node:test";
import assert from "node:assert/strict";

import { installDom, loadApp, settle } from "./dom-harness.mjs";

const harness = installDom();

// boot() refuses to run at all without IndexedDB (see the oldweb-notice
// guard), and Node has none. store.js falls back to an in-memory map once
// the open fails, so a database that always refuses to open is enough.
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

test.after(() => harness.stopTimers());

function resetForBoot() {
  state.demo = false;
  state.stopRecord = null;
  state.locked = false;
  state.lock = null;
  state.gen = null;
  state.identity = null;
  state.sharing = false;
}

const stopCard = () => internals.alertItems().find((i) => i.id === "stop-record");

test("a stop from the notification route survives to the next open, and dismissing it clears the native side", async () => {
  resetForBoot();
  const calls = [];
  globalThis.StarlingNative = {
    readStopRecord: () => JSON.stringify({ route: "notif", at: 1000 }),
    clearStopRecord: () => calls.push("clear"),
  };
  try {
    await internals.boot();
    await settle();
    assert.deepEqual(state.stopRecord, { route: "notif", at: 1000 });

    const card = stopCard();
    assert.ok(card, "a fresh boot surfaces the record as a dismissible card");
    assert.match(card.text, /notification/i);
    assert.doesNotMatch(card.text, /\bJuno\b/, "the trace names no one, it is a local, single-user event");

    card.actions[0].onClick();
    assert.equal(state.stopRecord, null, "dismissing clears it from the screen");
    assert.deepEqual(calls, ["clear"], "and tells the native side it was acknowledged");
    assert.equal(stopCard(), undefined, "so a second render does not show it again");
  } finally {
    delete globalThis.StarlingNative;
  }
});

test("a stop from a task swipe gets its own honest wording, distinct from the notification route", async () => {
  resetForBoot();
  globalThis.StarlingNative = {
    readStopRecord: () => JSON.stringify({ route: "swipe", at: 2000 }),
    clearStopRecord: () => {},
  };
  try {
    await internals.boot();
    await settle();
    const card = stopCard();
    assert.ok(card);
    assert.match(card.text, /closed/i);
    assert.doesNotMatch(card.text, /notification/i, "a swipe did not happen through the notification");
  } finally {
    delete globalThis.StarlingNative;
  }
});

test("no native record means no card, and a malformed one fails safe", async () => {
  resetForBoot();
  globalThis.StarlingNative = { readStopRecord: () => null };
  try {
    await internals.boot();
    await settle();
    assert.equal(stopCard(), undefined);
  } finally {
    delete globalThis.StarlingNative;
  }

  resetForBoot();
  globalThis.StarlingNative = { readStopRecord: () => "{not json" };
  try {
    await internals.boot();
    await settle();
    assert.equal(stopCard(), undefined, "a boot must not fail over a native record it cannot parse");
  } finally {
    delete globalThis.StarlingNative;
  }
});

test("a panic wipe also tells the native side to drop the stop record", async () => {
  resetForBoot();
  const calls = [];
  globalThis.StarlingNative = {
    panicWipe: () => calls.push("panicWipe"),
    clearStopRecord: () => calls.push("clearStopRecord"),
  };
  try {
    await internals.panic();
    assert.deepEqual(calls, ["panicWipe", "clearStopRecord"]);
  } finally {
    delete globalThis.StarlingNative;
  }
});

test("a live stop from the notification names itself instead of going silent, and clears the trace it just showed", async () => {
  resetForBoot();
  const calls = [];
  globalThis.StarlingNative = {
    startLocation() {},
    stopLocation() {},
    clearStopRecord: () => calls.push("clear"),
  };
  try {
    await internals.setSharing(true);
    assert.equal(state.sharing, true);
    assert.equal(typeof globalThis.__starlingFix, "function", "startWatch armed the native fix sink");

    const toasts = harness.node("#toasts");
    toasts.children.length = 0;

    // What LocationService's ACTION_STOP branch sends the page while it is
    // still alive to receive it.
    globalThis.__starlingFix(JSON.stringify({ stopped: true }));
    await settle();

    assert.equal(state.sharing, false, "the stop is honored, not just logged");
    const last = toasts.children.at(-1);
    assert.ok(last, "the person sees something, not silence");
    assert.match(last.textContent, /notification/i);
    assert.deepEqual(calls, ["clear"], "the in-session toast already said it, so the next-open card should not repeat it");
  } finally {
    delete globalThis.StarlingNative;
    if (state.sharing) await internals.stopSharingInternals();
  }
});
