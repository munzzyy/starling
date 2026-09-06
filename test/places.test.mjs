import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPlaceTracker,
  placeContaining,
  sanitizePlaces,
  validPlace,
  newPlaceId,
  EXIT_FACTOR,
  EXIT_PAD_M,
  MIN_FLIP_MS,
  POINT_MAX_AGE_MS,
  MAX_PLACES,
} from "../app/js/places.js";

// About 1 degree of latitude = 111,320 m; walk north by meters from a base.
const BASE = { lat: 40.0, lon: -75.0 };
const north = (m) => ({ lat: BASE.lat + m / 111320, lon: BASE.lon });

const HOME = { id: "aaaaaaaa", name: "Home", lat: BASE.lat, lon: BASE.lon, radius: 250 };
const SCHOOL = { id: "bbbbbbbb", name: "School", lat: north(2000).lat, lon: BASE.lon, radius: 250 };
const exitAt = (p) => p.radius * EXIT_FACTOR + EXIT_PAD_M;

test("validPlace accepts a good record and rejects junk", () => {
  assert.ok(validPlace(HOME));
  assert.ok(!validPlace(null));
  assert.ok(!validPlace({ ...HOME, radius: 123 }));
  assert.ok(!validPlace({ ...HOME, name: "" }));
  assert.ok(!validPlace({ ...HOME, name: "x".repeat(25) }));
  assert.ok(!validPlace({ ...HOME, lat: 91 }));
  assert.ok(!validPlace({ ...HOME, id: "nothex!!" }));
});

test("sanitizePlaces filters and caps", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    ...HOME,
    id: i.toString(16).padStart(8, "0"),
  }));
  assert.equal(sanitizePlaces(many).length, MAX_PLACES);
  assert.deepEqual(sanitizePlaces("nope"), []);
  assert.deepEqual(sanitizePlaces([HOME, { bad: true }]), [HOME]);
});

test("newPlaceId is 8 hex chars", () => {
  assert.match(newPlaceId(), /^[0-9a-f]{8}$/);
});

test("placeContaining picks the nearest overlapping place", () => {
  const a = { ...HOME, id: "aaaaaaaa", radius: 500 };
  const b = { ...HOME, id: "bbbbbbbb", radius: 500, lat: north(300).lat };
  const hit = placeContaining([a, b], north(280).lat, BASE.lon);
  assert.equal(hit.id, "bbbbbbbb");
});

test("first sight inside a place adopts it silently", () => {
  const t = createPlaceTracker([HOME]);
  const ev = t.update("m1", BASE.lat, BASE.lon, { now: 1000 });
  assert.deepEqual(ev, []);
  assert.equal(t.placeFor("m1").name, "Home");
});

test("walking in fires arrive, walking out fires leave past hysteresis", () => {
  const t = createPlaceTracker([HOME]);
  let now = 1000;
  assert.deepEqual(t.update("m1", north(5000).lat, BASE.lon, { now }), []);

  now += MIN_FLIP_MS + 1000;
  const inEv = t.update("m1", north(100).lat, BASE.lon, { now });
  assert.equal(inEv.length, 1);
  assert.equal(inEv[0].type, "arrive");
  assert.equal(inEv[0].placeName, "Home");

  // Just past the enter radius but inside the exit boundary: still home.
  now += MIN_FLIP_MS + 1000;
  assert.deepEqual(t.update("m1", north(300).lat, BASE.lon, { now }), []);
  assert.equal(t.placeFor("m1").name, "Home");

  // Past radius * EXIT_FACTOR + EXIT_PAD: left.
  now += MIN_FLIP_MS + 1000;
  const outEv = t.update("m1", north(exitAt(HOME) + 20).lat, BASE.lon, { now });
  assert.equal(outEv.length, 1);
  assert.equal(outEv[0].type, "leave");
  assert.equal(t.placeFor("m1"), null);
});

test("boundary jitter inside the cooldown cannot flap", () => {
  const t = createPlaceTracker([HOME]);
  let now = 1000;
  t.update("m1", north(5000).lat, BASE.lon, { now });
  now += MIN_FLIP_MS + 1000;
  assert.equal(t.update("m1", north(200).lat, BASE.lon, { now }).length, 1);

  // Seconds later GPS spits a point well outside: suppressed by cooldown.
  now += 5000;
  assert.deepEqual(t.update("m1", north(exitAt(HOME) + 50).lat, BASE.lon, { now }), []);
  assert.equal(t.placeFor("m1").name, "Home");

  // After the cooldown the same point counts.
  now += MIN_FLIP_MS;
  assert.equal(t.update("m1", north(exitAt(HOME) + 50).lat, BASE.lon, { now }).length, 1);
});

test("leaving one place straight into another fires both events", () => {
  const near = { ...SCHOOL, lat: north(HOME.radius * EXIT_FACTOR + EXIT_PAD_M + 120).lat };
  const t = createPlaceTracker([HOME, near]);
  let now = 1000;
  t.update("m1", BASE.lat, BASE.lon, { now });
  now += MIN_FLIP_MS + 1000;
  const evs = t.update("m1", near.lat, near.lon, { now });
  assert.deepEqual(
    evs.map((e) => e.type),
    ["leave", "arrive"],
  );
  assert.equal(t.placeFor("m1").name, "School");
});

test("coarse and stale points say nothing", () => {
  const t = createPlaceTracker([HOME]);
  let now = 1000;
  t.update("m1", north(5000).lat, BASE.lon, { now });
  now += MIN_FLIP_MS + 1000;
  assert.deepEqual(t.update("m1", BASE.lat, BASE.lon, { mode: "coarse", now }), []);
  assert.deepEqual(t.update("m1", BASE.lat, BASE.lon, { ts: now - POINT_MAX_AGE_MS - 1, now }), []);
  assert.equal(t.placeFor("m1"), null);
});

test("deleting a place forgets it without firing leave", () => {
  const t = createPlaceTracker([HOME]);
  let now = 1000;
  t.update("m1", BASE.lat, BASE.lon, { now });
  assert.equal(t.placeFor("m1").name, "Home");
  t.setPlaces([]);
  assert.equal(t.placeFor("m1"), null);
  now += MIN_FLIP_MS + 1000;
  assert.deepEqual(t.update("m1", north(5000).lat, BASE.lon, { now }), []);
});

test("no places means no work and no events", () => {
  const t = createPlaceTracker([]);
  assert.deepEqual(t.update("m1", BASE.lat, BASE.lon, { now: 1000 }), []);
  assert.equal(t.placeFor("m1"), null);
});

test("sinceFor reports when the member arrived", () => {
  const t = createPlaceTracker([HOME]);
  let now = 5000;
  t.update("m1", north(5000).lat, BASE.lon, { now });
  now += MIN_FLIP_MS + 1000;
  t.update("m1", BASE.lat, BASE.lon, { now });
  assert.equal(t.sinceFor("m1"), now);
  assert.equal(t.sinceFor("nobody"), null);
});

test("forget drops a member's state", () => {
  const t = createPlaceTracker([HOME]);
  t.update("m1", BASE.lat, BASE.lon, { now: 1000 });
  t.forget("m1");
  // Re-seen inside: adopted silently again, not announced.
  assert.deepEqual(t.update("m1", BASE.lat, BASE.lon, { now: 2000 }), []);
});
