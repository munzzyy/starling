// The Android icons read as source: the themed launcher layer is the real mark, and the status bar stays generic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const res = (p) => read(`android/app/src/main/res/${p}`);
const tokens = (d) => d.match(/[A-Za-z]|-?\d*\.?\d+/g);
const attr = (xml, name) => {
  const m = xml.match(new RegExp(`android:${name}="([^"]*)"`));
  assert.ok(m, name);
  return m[1];
};

const svg = read("app/icons/starling.svg");
const mark = tokens(svg.match(/<path[^>]*\sd="([^"]+)"/)[1]);

test("Android 13 and up get a themed icon layer", () => {
  assert.match(res("mipmap-anydpi-v26/ic_launcher.xml"), /<monochrome android:drawable="@drawable\/ic_launcher_mono" \/>/);
});

test("the themed layer is the mark in starling.svg, one solid color with the bird cut out", () => {
  const mono = res("drawable/ic_launcher_mono.xml");
  assert.deepEqual(tokens(attr(mono, "pathData")), mark, "same path, number for number");
  assert.match(svg, /fill-rule="evenodd"/);
  assert.equal(attr(mono, "fillType"), "evenOdd");
  assert.equal(attr(mono, "fillColor"), "#FFFFFFFF");
  assert.equal((mono.match(/<path/g) || []).length, 1);
});

test("the themed mark sits inside the 66dp safe zone of the 108dp canvas", () => {
  const mono = res("drawable/ic_launcher_mono.xml");
  assert.equal(attr(mono, "width"), "108dp");
  assert.equal(attr(mono, "height"), "108dp");
  const view = Number(attr(mono, "viewportWidth"));
  assert.equal(Number(attr(mono, "viewportHeight")), view);
  const s = 108 / view;
  const tx = Number(attr(mono, "translateX"));
  const ty = Number(attr(mono, "translateY"));

  // The pin is a circle over a point: M tip ... A r r 0 1 1 end, drawn from the curve's last point.
  const n = mark.map(Number);
  const tip = [n[1], n[2]];
  const a = mark.indexOf("A");
  const r = n[a + 1];
  const from = [n[a - 2], n[a - 1]];
  const to = [n[a + 6], n[a + 7]];
  const center = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  assert.equal(to[0] - from[0], 2 * r, "the arc spans a full diameter");
  const extremes = [tip, from, to, [center[0], center[1] - r]];
  for (const [x, y] of extremes) {
    const dx = (x + tx) * s - 54;
    const dy = (y + ty) * s - 54;
    assert.ok(Math.hypot(dx, dy) <= 33 + 1e-9, `${x},${y} lands ${Math.hypot(dx, dy).toFixed(2)}dp from the middle`);
  }
  const top = (center[1] - r + ty) * s;
  const bottom = (tip[1] + ty) * s;
  assert.ok(Math.abs((top + bottom) / 2 - 54) < 0.01, "centered top to bottom");
  assert.ok(Math.abs((center[0] + tx) * s - 54) < 0.01, "centered side to side");
});

test("the status bar keeps the generic pin, so a glance at the screen does not name the app", () => {
  const stat = res("drawable/ic_stat_starling.xml");
  assert.match(attr(stat, "pathData"), /^M12,2C8\.13,2 5,5\.13 5,9c0,5\.25 7,13 7,13s7,-7\.75 7,-13C19,5\.13 15\.87,2 12,2z/);
  assert.notDeepEqual(tokens(attr(stat, "pathData")), mark);
});
