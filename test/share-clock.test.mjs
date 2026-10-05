// The clock on Android's sharing notification is opt-in: a locked phone shows it too.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { installDom, loadApp } from "./dom-harness.mjs";

const harness = installDom();

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
const ui = await import("../app/js/ui.js");

test.after(() => harness.stopTimers());

function settingsWith(shareClock) {
  const host = document.getElementById("overlays");
  const before = host.children.length;
  const ov = ui.openSettingsSheet({
    api,
    values: {
      circleName: "Home",
      profile: { name: "", emoji: "x" },
      settings: internals.state.settings,
      share: { precision: "precise", cadence: 15 },
      relay: null,
    },
    demo: false,
    tor: null,
    keepSharing: null,
    shareClock,
    background: null,
    forward: null,
    lock: { enabled: false, hasBio: false, hasDuress: false, bioAvailable: false, autolockMs: 60000 },
    lockActions: {},
    onChange() {},
    onClose() {},
  });
  let row = null;
  const walk = (n) => {
    if (!n || typeof n !== "object" || row) return;
    if (n.dataset?.testid === "settings-share-clock") row = n;
    for (const c of n.children || []) walk(c);
  };
  host.children.slice(before).forEach(walk);
  ov.close?.();
  return { row };
}

const switchOf = (row) => row.children.find((c) => c.getAttribute?.("role") === "switch");

test("no switch on a wrapper that cannot show the clock", () => {
  assert.equal(settingsWith(null).row, null);
});

test("the switch shows what the wrapper holds, and says the lock screen shows it too", () => {
  const off = settingsWith({ enabled: false }).row;
  assert.ok(off, "shown with the bridge");
  assert.equal(switchOf(off).getAttribute("aria-checked"), "false");
  const note = off.children[0].children[1].textContent;
  assert.match(note, /lock screen shows it too/);
  assert.equal(switchOf(settingsWith({ enabled: true }).row).getAttribute("aria-checked"), "true");
});

test("turning it on goes to the wrapper only, and nothing lands in the page's settings", async () => {
  const calls = [];
  globalThis.StarlingNative = { setShareClock: (on) => calls.push(on), shareClock: () => false };
  const before = JSON.stringify(internals.state.settings);
  await api.setSetting("shareClock", true);
  await api.setSetting("shareClock", false);
  assert.deepEqual(calls, [true, false]);
  assert.equal(JSON.stringify(internals.state.settings), before);
  delete globalThis.StarlingNative;
});

test("the page offers it only with the bridge and never in the demo", () => {
  const src = readFileSync(new URL("../app/js/main.js", import.meta.url), "utf8");
  assert.match(src, /if \(typeof n\?\.setShareClock === "function" && !state\.demo\) \{\s*try \{\s*shareClock = \{ enabled: !!n\.shareClock\(\) \};/);
  const ui = readFileSync(new URL("../app/js/ui.js", import.meta.url), "utf8");
  assert.match(ui, /onChange: \(v\) => onChange\("shareClock", v\)/);
});
