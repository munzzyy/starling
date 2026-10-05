// Distance units held to the real main.js: Auto resolves at boot from the
// phone's language tag, and a choice in settings changes every distance the
// app prints from then on.
import test from "node:test";
import assert from "node:assert/strict";

import { installDom, loadApp, settle } from "./dom-harness.mjs";

const setLang = (tag) => Object.defineProperty(globalThis.navigator, "language", { value: tag, configurable: true });
setLang("en-US");

const harness = installDom({ listen: true });
globalThis.indexedDB ??= {
  open() {
    throw new Error("no indexeddb in the harness");
  },
  deleteDatabase() {
    const req = {};
    setTimeout(() => req.onsuccess?.(), 0);
    return req;
  },
};
const { internals, api } = await loadApp(harness);
const { memberSubLine } = await import("../app/js/ui.js");

test.after(() => harness.stopTimers());

const now = Date.now();
const here = { lat: 40.7794, lon: -73.9632 };
// About 1.2 km north of here.
const rec = { ts: now, lat: 40.7902, lon: -73.9632 };
const line = () => memberSubLine(rec, now, here, null, "live");

test("Auto at boot follows the region in the phone's language", () => {
  assert.equal(internals.state.settings.units, "auto");
  assert.match(line(), / 0\.7 mi$/);
});

test("Kilometers and Miles apply the moment they are chosen", async () => {
  await api.setSetting("units", "metric");
  assert.equal(internals.state.settings.units, "metric");
  assert.match(line(), / 1\.2 km$/);
  await api.setSetting("units", "imperial");
  assert.match(line(), / 0\.7 mi$/);
});

test("choosing Auto again reads the language tag again", async () => {
  setLang("de-DE");
  try {
    await api.setSetting("units", "auto");
    await settle();
    assert.match(line(), / 1\.2 km$/);
  } finally {
    setLang("en-US");
  }
  await api.setSetting("units", "auto");
  assert.match(line(), / 0\.7 mi$/);
});

test("the place radius chips speak the chosen units", async () => {
  const { openPlacesSheet } = await import("../app/js/ui.js");
  const chips = async (units) => {
    await api.setSetting("units", units);
    const sheet = openPlacesSheet({
      api: { places: () => [{ id: "p1", name: "Home", lat: 1, lon: 2, radius: 250 }] },
      onClose() {},
    });
    const out = [];
    const walk = (n) => {
      if (n?.dataset?.radius) out.push(n.textContent);
      for (const kid of n?.children || []) walk(kid);
    };
    walk(harness.node("#overlays").children.at(-1));
    sheet.close();
    return out;
  };
  assert.deepEqual(await chips("metric"), ["100 m", "250 m", "500 m"]);
  assert.deepEqual(await chips("imperial"), ["330 ft", "0.2 mi", "0.3 mi"]);
  await api.setSetting("units", "auto");
});

test("the Neighborhood note in Settings follows the units while the sheet is open", async () => {
  const ui = await import("../app/js/ui.js");
  internals.state.gen = { fake: true };
  internals.startDemo();
  internals.exitDemo();
  const note = () => {
    let out = null;
    const walk = (n) => {
      if (n?.dataset?.testid === "precision-note") out = n.textContent;
      for (const kid of n?.children || []) walk(kid);
    };
    walk(harness.node("#overlays").children.at(-1));
    return out;
  };
  try {
    await api.setSetting("units", "metric");
    harness.fire(harness.node('[data-testid="settings-open"]'), "click");
    await settle();
    assert.equal(note(), "Neighborhood rounds your position to about 1 km on your device before it is encrypted");
    await api.setSetting("units", "imperial");
    assert.equal(note(), "Neighborhood rounds your position to about half a mile on your device before it is encrypted");
  } finally {
    ui.closeAllOverlays();
    internals.state.gen = null;
    await api.setSetting("units", "auto");
  }
});
