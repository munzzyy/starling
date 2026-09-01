import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "app");

function diskPath(urlPath) {
  const p = urlPath === "/" ? "/index.html" : urlPath;
  return path.join(APP, p.replace(/^\//, ""));
}

function sizeOf(file) {
  return statSync(file).size;
}

const manifestPath = path.join(APP, "manifest.webmanifest");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

test("manifest has the required fields", () => {
  assert.equal(manifest.name, "Starling");
  assert.equal(manifest.short_name, "Starling");
  assert.equal(
    manifest.description,
    "Starling's landing page and live demo. Location sharing itself lives in the Starling Android app."
  );
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "browser");
  assert.equal(manifest.orientation, "portrait");
  assert.equal(manifest.background_color, "#0a0d14");
  assert.equal(manifest.theme_color, "#0a0d14");
});

test("manifest icon set covers 192, 512, maskable 512 and the svg", () => {
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 4);
  const bySrc = new Map(manifest.icons.map((i) => [i.src, i]));
  const png192 = bySrc.get("/icons/icon-192.png");
  assert.ok(png192, "192 icon listed");
  assert.equal(png192.sizes, "192x192");
  assert.equal(png192.type, "image/png");
  const png512 = bySrc.get("/icons/icon-512.png");
  assert.ok(png512, "512 icon listed");
  assert.equal(png512.sizes, "512x512");
  assert.equal(png512.type, "image/png");
  const maskable = bySrc.get("/icons/icon-maskable-512.png");
  assert.ok(maskable, "maskable icon listed");
  assert.equal(maskable.sizes, "512x512");
  assert.equal(maskable.type, "image/png");
  assert.equal(maskable.purpose, "maskable");
  const svg = bySrc.get("/icons/starling.svg");
  assert.ok(svg, "svg icon listed");
  assert.equal(svg.sizes, "any");
  assert.equal(svg.type, "image/svg+xml");
  assert.equal(svg.purpose, "any");
});

test("every icon file the manifest references exists with nonzero size", () => {
  for (const icon of manifest.icons) {
    const file = diskPath(icon.src);
    assert.ok(existsSync(file), `${icon.src} missing on disk`);
    assert.ok(sizeOf(file) > 0, `${icon.src} is empty`);
  }
});

const swText = readFileSync(path.join(APP, "sw.js"), "utf8");

// The frozen app shell contract shared with the UI build.
const PRECACHE = [
  "/",
  "/index.html",
  "/css/tokens.css",
  "/css/app.css",
  "/js/main.js",
  "/js/ui.js",
  "/js/map.js",
  "/js/net.js",
  "/js/store.js",
  "/js/geo.js",
  "/js/fmt.js",
  "/js/demo.js",
  "/js/wire.js",
  "/js/crypto.js",
  "/js/qr.js",
  "/vendor/leaflet/leaflet.js",
  "/vendor/leaflet/leaflet.css",
  "/icons/starling.svg",
  "/icons/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/manifest.webmanifest"
];

// Files that must already exist: this agent's own output plus the frozen
// vendor, js, css and icon files. The rest belongs to the UI agent and may
// land later; those get a skip, not a failure, while absent.
const MUST_EXIST = new Set([
  "/css/tokens.css",
  "/js/wire.js",
  "/js/crypto.js",
  "/js/qr.js",
  "/vendor/leaflet/leaflet.js",
  "/vendor/leaflet/leaflet.css",
  "/icons/starling.svg",
  "/icons/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/manifest.webmanifest"
]);

test("sw.js precaches the exact app shell list", () => {
  for (const p of PRECACHE) {
    assert.ok(swText.includes(`"${p}"`), `precache list missing "${p}"`);
  }
});

test("sw.js never caches /api/ and passes non-GET through", () => {
  assert.match(swText, /startsWith\("\/api\/"\)/);
  assert.match(swText, /req\.method !== "GET"/);
});

for (const p of PRECACHE) {
  const file = diskPath(p);
  const label = `precache path ${p} exists on disk`;
  if (MUST_EXIST.has(p)) {
    test(label, () => {
      assert.ok(existsSync(file), `${p} missing at ${file}`);
      assert.ok(sizeOf(file) > 0, `${p} is empty`);
    });
  } else {
    test(label, (t) => {
      if (!existsSync(file)) {
        t.skip(`${p} not present yet (UI build in flight)`);
        return;
      }
      assert.ok(sizeOf(file) > 0, `${p} is empty`);
    });
  }
}
