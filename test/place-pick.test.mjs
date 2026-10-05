// Picking a place on the map, held to the real main.js and map.js: a banner
// says what the map is waiting for, Escape and Cancel back out to Places
// without saving anything, Use the map center saves the crosshair's spot,
// and any other way the pick ends takes the banner with it.
import test from "node:test";
import assert from "node:assert/strict";

import { installDom, loadApp } from "./dom-harness.mjs";

const harness = installDom({ listen: true });

const fakeMap = globalThis.L.map();
const mapClicks = [];
fakeMap.on = function (type, fn) {
  if (type === "click") mapClicks.push(fn);
  return this;
};
let center = { lat: 40.7812, lng: -73.9665 };
fakeMap.getCenter = () => center;
const tapMap = (lat, lng) => {
  for (const fn of mapClicks) fn({ latlng: { lat, lng } });
};

const { internals } = await loadApp(harness);
const ui = await import("../app/js/ui.js");
const state = internals.state;
const banner = harness.node("#banner-pick");
const bannerText = harness.node("#banner-pick-text");
const mapEl = harness.node("#map");
const settle = () => new Promise((r) => setTimeout(r, 10));

const placesSheetOpen = () => harness.node("#overlays").children.some((wrap) => wrap.children?.[1]?.dataset?.testid === "places-sheet");
const reset = () => {
  ui.closeAllOverlays();
  harness.node("#overlays").children = [];
};

test.after(() => harness.stopTimers());

test("a circle's map screen to pick on", () => {
  state.gen = { fake: true };
  internals.startDemo();
  internals.exitDemo();
  assert.equal(state.screen, "map");
  assert.equal(state.demo, false);
  state.places = [];
});

test("picking shows a banner naming the place, and the crosshair", () => {
  let focused = null;
  harness.node("#banner-pick-center").focus = () => (focused = "center");
  internals.startPlacePick("Grandma's");
  assert.equal(focused, "center", "a keyboard cannot tap the map, so focus lands on the button that can pick");
  assert.equal(banner.hidden, false);
  assert.equal(bannerText.textContent, "Tap the map where Grandma's is.");
  assert.ok(mapEl.classList.contains("picking"));
});

test("Escape backs out to Places, and a later tap saves nothing", async () => {
  reset();
  harness.fire(document, "keydown", { key: "Escape" });
  assert.equal(banner.hidden, true);
  assert.ok(!mapEl.classList.contains("picking"));
  assert.ok(placesSheetOpen(), "Places is where the pick started");
  tapMap(40.1, -73.1);
  await settle();
  assert.deepEqual(state.places, []);
});

test("Escape closes a sheet opened over a pick before it backs out of the pick", async () => {
  reset();
  internals.startPlacePick("Gym");
  harness.fire(harness.node('[data-testid="settings-open"]'), "click");
  await settle();
  assert.ok(ui.overlaysOpen(), "Settings is open over the armed pick");
  harness.fire(document, "keydown", { key: "Escape" });
  assert.equal(ui.overlaysOpen(), false, "Escape closed Settings");
  assert.ok(!placesSheetOpen(), "and did not stack Places on top of it");
  assert.equal(banner.hidden, false, "the pick is still armed");
  assert.ok(mapEl.classList.contains("picking"));
  harness.fire(document, "keydown", { key: "Escape" });
  assert.equal(banner.hidden, true);
  assert.ok(placesSheetOpen());
});

test("Use the map center saves the spot under the crosshair", async () => {
  reset();
  internals.startPlacePick("Home");
  harness.fire(harness.node("#banner-pick-center"), "click");
  await settle();
  assert.equal(state.places.length, 1);
  assert.deepEqual(
    { name: state.places[0].name, lat: state.places[0].lat, lon: state.places[0].lon },
    { name: "Home", lat: 40.7812, lon: -73.9665 },
  );
  assert.equal(banner.hidden, true);
  assert.ok(placesSheetOpen(), "a finished pick reopens Places");
});

test("a center past the antimeridian is wrapped before it is saved", async () => {
  reset();
  center = { lat: 10, lng: 370, wrap: () => ({ lat: 10, lng: 10 }) };
  try {
    internals.startPlacePick("Far");
    harness.fire(harness.node("#banner-pick-center"), "click");
    await settle();
    assert.equal(state.places.at(-1).lon, 10);
  } finally {
    center = { lat: 40.7812, lng: -73.9665 };
  }
});

test("Cancel backs out to Places and saves nothing", async () => {
  reset();
  const before = state.places.length;
  internals.startPlacePick("School");
  harness.fire(harness.node("#banner-pick-cancel"), "click");
  assert.equal(banner.hidden, true);
  assert.ok(placesSheetOpen());
  tapMap(40.2, -73.2);
  await settle();
  assert.equal(state.places.length, before);
});

test("a tap on the map still saves and clears the banner", async () => {
  reset();
  internals.startPlacePick("Park");
  tapMap(40.3, -73.3);
  await settle();
  assert.deepEqual([state.places.at(-1).name, state.places.at(-1).lat, state.places.at(-1).lon], ["Park", 40.3, -73.3]);
  assert.equal(banner.hidden, true);
});

test("starting the demo ends a pick and its banner", async () => {
  reset();
  const before = state.places.length;
  internals.startPlacePick("Work");
  internals.startDemo();
  assert.equal(banner.hidden, true);
  assert.ok(!placesSheetOpen(), "a pick ended by something else does not reopen Places");
  internals.exitDemo();
  tapMap(40.4, -73.4);
  await settle();
  assert.equal(state.places.length, before);
});

test("the demo never arms a pick", () => {
  internals.startDemo();
  internals.startPlacePick("Nope");
  assert.equal(banner.hidden, true);
  assert.ok(!mapEl.classList.contains("picking"));
  internals.exitDemo();
  state.gen = null;
});
