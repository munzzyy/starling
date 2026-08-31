// Unit tests for the pure UI logic in app/js/fmt.js.
import test from "node:test";
import assert from "node:assert/strict";

import {
  haversineMeters,
  fmtDistance,
  fmtRelTime,
  coarsePos,
  hueFromMemberId,
} from "../app/js/fmt.js";

test("haversineMeters: zero distance is exactly 0", () => {
  assert.equal(haversineMeters(40.7794, -73.9632, 40.7794, -73.9632), 0);
  assert.equal(haversineMeters(0, 0, 0, 0), 0);
});

test("haversineMeters: 0.01 deg of latitude at the equator is ~1112 m", () => {
  const d = haversineMeters(0, 0, 0.01, 0);
  assert.ok(Math.abs(d - 1111.95) < 0.05, `got ${d}`);
});

test("haversineMeters: negative coords, pure latitude step", () => {
  const d = haversineMeters(-10, -10, -10.01, -10);
  assert.ok(Math.abs(d - 1111.95) < 0.05, `got ${d}`);
});

test("haversineMeters: antimeridian-adjacent points are near, not half a world apart", () => {
  const d = haversineMeters(0, 179.995, 0, -179.995);
  assert.ok(Math.abs(d - 1111.95) < 0.5, `got ${d}`);
});

test("haversineMeters: symmetric in argument order", () => {
  const a = haversineMeters(40.7794, -73.9632, 40.7757, -73.9719);
  const b = haversineMeters(40.7757, -73.9719, 40.7794, -73.9632);
  assert.equal(a, b);
});

test("fmtDistance: exact strings", () => {
  assert.equal(fmtDistance(0), "0 m");
  assert.equal(fmtDistance(38.4), "38 m");
  assert.equal(fmtDistance(999.4), "999 m");
  assert.equal(fmtDistance(1000), "1.0 km");
  assert.equal(fmtDistance(1234), "1.2 km");
  assert.equal(fmtDistance(9949), "9.9 km");
  assert.equal(fmtDistance(10000), "10 km");
  assert.equal(fmtDistance(12345), "12 km");
});

test("fmtDistance: garbage in, empty string out", () => {
  assert.equal(fmtDistance(-1), "");
  assert.equal(fmtDistance(NaN), "");
  assert.equal(fmtDistance(Infinity), "");
});

test("fmtRelTime: exact strings", () => {
  assert.equal(fmtRelTime(0), "now");
  assert.equal(fmtRelTime(14999), "now");
  assert.equal(fmtRelTime(15000), "15 s");
  assert.equal(fmtRelTime(42000), "42 s");
  assert.equal(fmtRelTime(59999), "59 s");
  assert.equal(fmtRelTime(60000), "1 min");
  assert.equal(fmtRelTime(5 * 60000), "5 min");
  assert.equal(fmtRelTime(3599999), "59 min");
  assert.equal(fmtRelTime(3600000), "1 h 00 min");
  assert.equal(fmtRelTime(3900000), "1 h 05 min");
  assert.equal(fmtRelTime(9240000), "2 h 34 min");
  assert.equal(fmtRelTime(86399999), "23 h 59 min");
  assert.equal(fmtRelTime(86400000), "1 d");
  assert.equal(fmtRelTime(216000000), "2 d");
});

test("fmtRelTime: negative and non-finite clamp to now", () => {
  assert.equal(fmtRelTime(-5000), "now");
  assert.equal(fmtRelTime(NaN), "now");
});

test("coarsePos: rounds to 0.01 degrees", () => {
  assert.deepEqual(coarsePos(44.9812, -93.2765), { lat: 44.98, lon: -93.28 });
  assert.deepEqual(coarsePos(51.5074, -0.1278), { lat: 51.51, lon: -0.13 });
  assert.deepEqual(coarsePos(40.7794, -73.9632), { lat: 40.78, lon: -73.96 });
  assert.deepEqual(coarsePos(-33.8688, 151.2093), { lat: -33.87, lon: 151.21 });
});

test("coarsePos: already-coarse positions are unchanged", () => {
  assert.deepEqual(coarsePos(40.78, -73.96), { lat: 40.78, lon: -73.96 });
});

test("hueFromMemberId: exact known values", () => {
  assert.equal(hueFromMemberId("0000000000000000"), 0);
  assert.equal(hueFromMemberId("ffffffffffffffff"), 135);
  assert.equal(hueFromMemberId("a3b1c2d3e4f5a6b7"), 234);
  assert.equal(hueFromMemberId("0123456789abcdef"), 45);
});

test("hueFromMemberId: stable, integral, in range", () => {
  const ids = ["a3b1c2d3e4f5a6b7", "deadbeefdeadbeef", "0011223344556677", "cafef00dcafef00d"];
  for (const id of ids) {
    const h = hueFromMemberId(id);
    assert.equal(h, hueFromMemberId(id));
    assert.ok(Number.isInteger(h) && h >= 0 && h < 360, `hue ${h} out of range for ${id}`);
  }
});

test("hueFromMemberId: nearby ids spread apart", () => {
  const a = hueFromMemberId("a3b1c2d3e4f5a6b7");
  const b = hueFromMemberId("a3b1c3d3e4f5a6b7");
  assert.notEqual(a, b);
});
