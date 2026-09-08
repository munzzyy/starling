// A collapsed, generic notification is only safe if it is still noticeable.
// notifyEvent is the one chokepoint every circle event posts a system
// notification through; this holds it to forwarding urgency honestly, since
// that boolean is what routes an SOS to its own channel, sound and
// vibration on the native side (untestable here; see Events.kt).
import test from "node:test";
import assert from "node:assert/strict";

import { installDom, loadApp } from "./dom-harness.mjs";

const harness = installDom();
const { internals } = await loadApp(harness);
const state = internals.state;

test.after(() => harness.stopTimers());

function withHiddenPage(fn) {
  const prev = document.visibilityState;
  document.visibilityState = "hidden";
  try {
    return fn();
  } finally {
    document.visibilityState = prev;
  }
}

test("an SOS notification asks the bridge to be urgent; routine ones do not", () => {
  state.demo = false;
  const calls = [];
  globalThis.StarlingNative = { notify: (...args) => calls.push(args) };
  try {
    withHiddenPage(() => {
      internals.notifyEvent("SOS from Juno", "Open Starling to see their live position.", "sos-1", true);
      internals.notifyEvent("Someone wants to join", "Open Starling to check their number and let them in.", "join-req");
    });
  } finally {
    delete globalThis.StarlingNative;
  }
  assert.equal(calls.length, 2);
  assert.equal(calls[0][3], true, "the SOS call must mark itself urgent");
  assert.equal(calls[1][3], false, "a routine call must not borrow the SOS channel");
});

test("notifyEvent never reaches the bridge while the page is visible or the demo is running", () => {
  const calls = [];
  globalThis.StarlingNative = { notify: (...args) => calls.push(args) };
  try {
    document.visibilityState = "visible";
    state.demo = false;
    internals.notifyEvent("SOS from Juno", "body", "sos-1", true);
    assert.equal(calls.length, 0, "a visible page already toasted this, it must not also hit the tray");

    document.visibilityState = "hidden";
    state.demo = true;
    internals.notifyEvent("SOS from Juno", "body", "sos-1", true);
    assert.equal(calls.length, 0, "the demo's fake SOS must never reach the real notification tray");
  } finally {
    state.demo = false;
    document.visibilityState = "visible";
    delete globalThis.StarlingNative;
  }
});
