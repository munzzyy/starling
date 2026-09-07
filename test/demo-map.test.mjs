// The demo's real-map switch, held to the real main.js: off-grid from the
// first frame, a consent banner before any street basemap, tiles only after
// "Load map", one press back to off-grid, and nothing on exit unless there
// is a circle whose saved basemap has a map screen to return to.
//
// The observable is L.tileLayer. Every street basemap goes through it with
// the OSM URL and off-grid never calls it, so counting those calls IS the
// demo's network claim, measured where the app makes it.
import test from "node:test";
import assert from "node:assert/strict";

import { installDom, loadApp } from "./dom-harness.mjs";

const harness = installDom();

const tileCalls = [];
const fakeL = globalThis.L;
const realTileLayer = fakeL.tileLayer;
fakeL.tileLayer = (url, opts) => {
  tileCalls.push(String(url));
  return realTileLayer(url, opts);
};

const { internals } = await loadApp(harness);
const state = internals.state;

const osmCalls = () => tileCalls.filter((u) => u.includes("tile.openstreetmap.org")).length;
const consent = harness.node("#banner-demo-consent");
const toggle = harness.node("#banner-demo-map");

test("demo starts off-grid and stays there without consent", () => {
  const before = osmCalls();
  internals.startDemo();
  assert.equal(state.demo, true);
  assert.equal(osmCalls(), before, "entering the demo must not create a tile layer");
  assert.equal(consent.hidden, true, "no consent banner until the button asks for it");
  assert.equal(toggle.textContent, "Real map");
});

test("the toggle asks first: consent banner, still no tiles", () => {
  const before = osmCalls();
  internals.toggleDemoMap();
  assert.equal(consent.hidden, false, "first press opens the consent banner");
  assert.equal(osmCalls(), before, "asking is not loading");
});

test("cancel keeps the demo off-grid, and exit after cancel fetches nothing", () => {
  const before = osmCalls();
  internals.cancelDemoMap();
  assert.equal(consent.hidden, true, "cancel closes the consent banner");
  assert.equal(toggle.textContent, "Real map", "still off, still offering");
  assert.equal(osmCalls(), before, "cancel loads nothing");
  // The visitor who said no and left: the whole visit must stay at zero.
  // Exit lands on onboarding (no circle in this harness), where restoring
  // the default street basemap would have been a fetch nobody agreed to.
  internals.exitDemo();
  assert.equal(state.demo, false);
  assert.equal(osmCalls(), before, "exit after cancel must not touch the tile host");
  internals.startDemo();
});

test("Load map is the one path to tiles, and one press turns them back off", () => {
  internals.toggleDemoMap();
  const before = osmCalls();
  internals.loadDemoMap();
  assert.equal(osmCalls(), before + 1, "consent loads exactly one tile layer");
  assert.equal(consent.hidden, true, "consent banner closes once answered");
  assert.equal(toggle.textContent, "Off-grid");

  internals.toggleDemoMap();
  assert.equal(osmCalls(), before + 1, "turning tiles off never loads more");
  assert.equal(toggle.textContent, "Real map");
});

test("with no circle, exit goes off-grid even after consent, and the demo forgets the choice", () => {
  internals.loadDemoMap();
  const before = osmCalls();
  internals.exitDemo();
  assert.equal(state.demo, false);
  // No circle: exit lands on onboarding, and the demo's consent must not
  // leak into a tile layer for a screen with no map on it.
  assert.equal(osmCalls(), before, "exit without a circle creates no tile layer");
  internals.startDemo();
  assert.equal(consent.hidden, true);
  assert.equal(toggle.textContent, "Real map", "a fresh demo starts off-grid again");
  assert.equal(osmCalls(), before, "re-entering the demo adds no tile layer of its own");
  internals.exitDemo();
});

test("with a circle, exit restores the saved street basemap", () => {
  // A circle in state is what makes exit land on the map screen; only then
  // does the user's own saved basemap come back.
  state.gen = { fake: true };
  const before = osmCalls();
  internals.startDemo();
  assert.equal(osmCalls(), before, "demo entry stays off-grid regardless of circle");
  internals.exitDemo();
  assert.equal(osmCalls(), before + 1, "exit with a circle restores the saved street basemap");
  state.gen = null;
});

test("teardown", () => {
  harness.stopTimers();
});
