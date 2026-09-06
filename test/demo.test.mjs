// The demo is the product tour, so its beats are pinned here: the invented
// places are valid, you start at Home, Mabel's fountain arrival actually
// fires (not silently adopted at frame zero), captions flip, and the SOS arc
// comes back around for a viewer who keeps watching.
import test from "node:test";
import assert from "node:assert/strict";

import { demoFrame, demoPlaces, DEMO_CENTER } from "../app/js/demo.js";
import { createPlaceTracker, validPlace } from "../app/js/places.js";
import { haversineMeters } from "../app/js/fmt.js";

const T0 = 1_000_000_000_000;

test("demo places are valid place records and never collide with real ids", () => {
  const places = demoPlaces();
  assert.equal(places.length, 2);
  for (const p of places) assert.ok(validPlace(p), p.name);
  assert.ok(places.every((p) => p.id.startsWith("de3")), "recognizable demo ids");
});

test("you start inside Home; the you-line can say so from the first frame", () => {
  const home = demoPlaces().find((p) => p.name === "Home");
  const { you } = demoFrame(0, T0, null);
  assert.ok(haversineMeters(you.lat, you.lon, home.lat, home.lon) < home.radius);
  assert.ok(haversineMeters(DEMO_CENTER.lat, DEMO_CENTER.lon, home.lat, home.lon) < 5);
});

test("Mabel starts outside the fountain and arrives within the first 90 seconds", () => {
  const places = demoPlaces();
  const fountain = places.find((p) => p.name === "The fountain");
  const first = demoFrame(0, T0, null).members.find((m) => m.name === "Mabel");
  assert.ok(
    haversineMeters(first.lat, first.lon, fountain.lat, fountain.lon) > fountain.radius,
    "an arrival adopted silently at frame zero is no arrival at all",
  );

  const tracker = createPlaceTracker(places);
  let arrivedAt = null;
  for (let t = 0; t <= 90 && arrivedAt === null; t++) {
    const now = T0 + t * 1000;
    for (const m of demoFrame(t, now, null).members) {
      const evs = tracker.update(m.id, m.lat, m.lon, { mode: m.mode, ts: m.ts, now });
      for (const ev of evs) {
        if (ev.type === "arrive" && ev.placeName === "The fountain") arrivedAt = t;
      }
    }
  }
  assert.ok(arrivedAt !== null, "Mabel never arrived at the fountain");
  assert.ok(arrivedAt > 0, "the arrival must be an event, not frame-zero adoption");
});

test("captions ride the members and Mabel's flips on arrival", () => {
  const before = demoFrame(10, T0, null).members;
  assert.ok(before.every((m) => typeof m.st === "string"));
  assert.equal(before.find((m) => m.name === "Mabel").st, "omw to the fountain");
  assert.equal(before.find((m) => m.name === "Ash").st, "phone's dying");
  // She enters the fountain's circle around t=45; the caption flips on the
  // same geometry the place tracker judges, so the two can never disagree.
  const after = demoFrame(60, T0, null).members;
  assert.equal(after.find((m) => m.name === "Mabel").st, "made it");
});

test("the SOS arc runs, clears, and comes back around next cycle", () => {
  const juno = (t) => demoFrame(t, T0, null).members.find((m) => m.name === "Juno");
  assert.equal(juno(10).type, "loc");
  assert.equal(juno(22).type, "sos");
  assert.equal(juno(30).type, "checkin");
  assert.equal(juno(40).type, "loc");
  assert.equal(juno(142).type, "sos", "a viewer still watching gets the story again");
});

test("Ash's battery is under the low-battery line from the start", () => {
  const ash = demoFrame(0, T0, null).members.find((m) => m.name === "Ash");
  assert.ok(ash.bat < 0.15);
});
