// The rendezvous compass is pure math; these pin the math. i18n falls back
// to English source strings in the harness, so the words are literal.
import test from "node:test";
import assert from "node:assert/strict";

import { bearingDeg, compassWord } from "../app/js/fmt.js";

test("bearing to the four cardinal neighbors", () => {
  const lat = 40.0;
  const lon = -75.0;
  assert.ok(Math.abs(bearingDeg(lat, lon, lat + 0.01, lon) - 0) < 0.5, "north");
  assert.ok(Math.abs(bearingDeg(lat, lon, lat, lon + 0.01) - 90) < 0.5, "east");
  assert.ok(Math.abs(bearingDeg(lat, lon, lat - 0.01, lon) - 180) < 0.5, "south");
  assert.ok(Math.abs(bearingDeg(lat, lon, lat, lon - 0.01) - 270) < 0.5, "west");
});

test("bearing is always 0..360 even across the antimeridian", () => {
  const b = bearingDeg(0, 179.99, 0, -179.99);
  assert.ok(b >= 0 && b < 360);
  assert.ok(Math.abs(b - 90) < 0.5, "eastward across the line");
});

test("compass words cover the eight ways and wrap at the seams", () => {
  assert.equal(compassWord(0), "north");
  assert.equal(compassWord(44), "northeast");
  assert.equal(compassWord(46), "northeast");
  assert.equal(compassWord(90), "east");
  assert.equal(compassWord(135), "southeast");
  assert.equal(compassWord(180), "south");
  assert.equal(compassWord(225), "southwest");
  assert.equal(compassWord(270), "west");
  assert.equal(compassWord(315), "northwest");
  assert.equal(compassWord(359), "north");
  assert.equal(compassWord(-45), "northwest");
});
