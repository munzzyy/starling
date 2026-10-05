// The Show everyone button, held to the real main.js and map.js: it frames
// every member with a position plus you, it flies only when motion is
// allowed, it hides when there is nothing to frame, and the demo's opening
// shot stays the fixed, unanimated one it always was.
import test from "node:test";
import assert from "node:assert/strict";

import { installDom, loadApp } from "./dom-harness.mjs";

const harness = installDom({ listen: true });

const motion = { matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
const realMatchMedia = globalThis.matchMedia;
globalThis.matchMedia = (q) => (String(q).includes("reduced-motion") ? motion : realMatchMedia(q));

const fakeL = globalThis.L;
const realBounds = fakeL.latLngBounds;
fakeL.latLngBounds = (pts) => ({ ...realBounds(pts), pts });
const fits = [];
fakeL.map().fitBounds = (bounds, opts) => fits.push({ pts: bounds.pts, opts });

const { internals, api } = await loadApp(harness);
const state = internals.state;
const fab = harness.node("#fab-fit");

test.after(() => harness.stopTimers());

test("the demo opens on its fixed shot and offers the button", () => {
  fits.length = 0;
  internals.startDemo();
  assert.equal(fits.length, 1, "startDemo frames once");
  assert.equal(fits[0].opts.animate, false, "the opening shot does not fly");
  assert.equal(fab.hidden, false, "walkers and you on the map: the button shows");
});

test("one press frames every walker and you, animated", () => {
  fits.length = 0;
  harness.fire(fab, "click");
  assert.equal(fits.length, 1, "one press, one fit");
  const walkers = api.members().filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
  assert.ok(walkers.length >= 2, `the demo has walkers (${walkers.length})`);
  assert.deepEqual(fits[0].pts, [...walkers.map((r) => [r.lat, r.lon]), [state.me.lat, state.me.lon]]);
  assert.equal(fits[0].opts.animate, true);
});

test("under reduced motion the fit jumps instead of flying", () => {
  motion.matches = true;
  try {
    fits.length = 0;
    harness.fire(fab, "click");
    assert.equal(fits.length, 1);
    assert.equal(fits[0].opts.animate, false);
  } finally {
    motion.matches = false;
  }
});

test("a circle with nobody else on the map has no button", async () => {
  state.gen = { fake: true };
  try {
    internals.exitDemo();
    assert.equal(state.screen, "map");
    assert.equal(fab.hidden, true, "no positions at all");
    state.me = { lat: 40.7794, lon: -73.9632, ts: Date.now() };
    await api.setSetting("trail", true);
    assert.equal(fab.hidden, true, "you alone is what Center the map on me is for");
  } finally {
    state.me = null;
    state.gen = null;
  }
});

test("the debug hook frames the same set without flying", () => {
  internals.startDemo();
  fits.length = 0;
  assert.equal(globalThis.window.__starlingFit(), true);
  assert.equal(fits.length, 1);
  assert.equal(fits[0].opts.animate, false);
  assert.equal(fits[0].pts.length, api.members().length + 1);
  internals.exitDemo();
});
