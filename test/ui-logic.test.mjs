// Unit tests for the pure UI logic in app/js/fmt.js and app/js/ui.js.
import test from "node:test";
import assert from "node:assert/strict";

import {
  haversineMeters,
  fmtDistance,
  fmtRelTime,
  coarsePos,
  hueFromMemberId,
  resolveUnits,
  setUnits,
  fmtClock,
} from "../app/js/fmt.js";
import { fmtCountdown, memberSubLine } from "../app/js/ui.js";
import { loadLocale, setLocale } from "../app/js/i18n.js";

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

test("fmtDistance: miles, with feet for the last tenth of a mile", () => {
  setUnits("imperial");
  try {
    assert.equal(fmtDistance(0), "0 ft");
    assert.equal(fmtDistance(30), "100 ft");
    assert.equal(fmtDistance(160), "520 ft");
    assert.equal(fmtDistance(161), "0.1 mi");
    assert.equal(fmtDistance(1609), "1.0 mi");
    assert.equal(fmtDistance(16000), "9.9 mi");
    assert.equal(fmtDistance(16093), "10 mi");
    assert.equal(fmtDistance(-1), "");
  } finally {
    setUnits("metric");
  }
  assert.equal(fmtDistance(1234), "1.2 km", "back to metric once set back");
});

test("fmtDistance: decimals follow the language", async () => {
  await loadLocale("de");
  setLocale("de");
  try {
    assert.equal(fmtDistance(1234), "1,2 km");
    assert.equal(fmtDistance(38.4), "38 m");
    setUnits("imperial");
    assert.equal(fmtDistance(1609), "1,0 mi");
  } finally {
    setUnits("metric");
    setLocale("en");
  }
  assert.equal(fmtDistance(1234), "1.2 km");
});

test("resolveUnits: a choice stands, Auto reads the region and defaults to metric", () => {
  assert.equal(resolveUnits("metric", "en-US"), "metric");
  assert.equal(resolveUnits("imperial", "de-DE"), "imperial");
  assert.equal(resolveUnits("auto", "en-US"), "imperial");
  assert.equal(resolveUnits("auto", "es-US"), "imperial");
  assert.equal(resolveUnits("auto", "en-LR"), "imperial");
  assert.equal(resolveUnits("auto", "my-MM"), "imperial");
  assert.equal(resolveUnits("auto", "en-GB"), "metric");
  assert.equal(resolveUnits("auto", "pt-BR"), "metric");
  assert.equal(resolveUnits("auto", "en"), "metric", "no region is no evidence of miles");
  assert.equal(resolveUnits("auto", ""), "metric");
  assert.equal(resolveUnits("auto", "not a tag"), "metric");
  assert.equal(resolveUnits(undefined, "en-US"), "imperial", "a settings record from before the choice existed is Auto");
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

test("fmtCountdown: exact strings", () => {
  assert.equal(fmtCountdown(59_999), "under a minute");
  assert.equal(fmtCountdown(60_000), "1 min");
  assert.equal(fmtCountdown(42 * 60_000), "42 min");
  assert.equal(fmtCountdown(59 * 60_000 + 59_000), "59 min");
  assert.equal(fmtCountdown(60 * 60_000), "1 h 00 min");
  assert.equal(fmtCountdown(6 * 60 * 60_000 - 1000), "5 h 59 min");
  assert.equal(fmtCountdown(24 * 60 * 60_000), "24 h 00 min");
});

test("fmtCountdown: an expired thing says so instead of counting up", () => {
  assert.equal(fmtCountdown(0), "expired");
  assert.equal(fmtCountdown(-1), "expired");
  assert.equal(fmtCountdown(-60 * 60_000), "expired");
  assert.equal(fmtCountdown(NaN), "expired");
  assert.equal(fmtCountdown(Infinity), "expired");
  assert.equal(fmtCountdown(undefined), "expired");
});

test("memberSubLine: a place carries 'since' only for a seen arrival under a day old", () => {
  const now = Date.UTC(2026, 9, 5, 15, 0);
  const rec = { ts: now };
  const at = now - 47 * 60_000;
  assert.equal(memberSubLine(rec, now, null, "Home", "live", at), `At Home since ${fmtClock(at)} · now`);
  assert.equal(memberSubLine(rec, now, null, "Home", "live", null), "At Home · now", "first sight: no since");
  assert.equal(memberSubLine(rec, now, null, "Home", "live"), "At Home · now");
  assert.equal(memberSubLine(rec, now, null, "Home", "live", now - 24 * 60 * 60_000), "At Home · now", "a bare clock time past a day is ambiguous");
  assert.equal(
    memberSubLine(rec, now, null, "Home", "live", now - 24 * 60 * 60_000 + 1),
    `At Home since ${fmtClock(now - 24 * 60 * 60_000 + 1)} · now`,
  );
  assert.equal(memberSubLine(rec, now, null, "Home", "live", now + 60_000), "At Home · now", "never a time still to come");
  assert.equal(memberSubLine(rec, now, null, null, "live", at), "now", "no place, nothing to be at since");
});
