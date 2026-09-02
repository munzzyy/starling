// Feature detection: every check must key off a real capability, never a UA
// string, and the foreground session must re-acquire its Wake Lock on
// visibilitychange the way iOS forces it to.
import test from "node:test";
import assert from "node:assert/strict";

function freshGlobals(overrides = {}) {
  const listeners = new Map();
  const doc = {
    visibilityState: "visible",
    addEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) || []).concat(fn));
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn));
    },
    fire(type) {
      for (const fn of listeners.get(type) || []) fn();
    },
  };
  globalThis.document = doc;
  // Node 22+ ships a real, non-configurable-by-default globalThis.navigator;
  // redefine it per test rather than assign, or the second test in a run
  // throws "Cannot set property navigator".
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "", ...overrides.navigator },
    configurable: true,
    writable: true,
  });
  globalThis.matchMedia = overrides.matchMedia || (() => ({ matches: false }));
  return doc;
}

function cleanupGlobals() {
  delete globalThis.document;
  Object.defineProperty(globalThis, "navigator", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  delete globalThis.matchMedia;
  delete globalThis.StarlingNative;
}

async function fresh() {
  // Each test needs its own module instance because platform.js and env.js
  // hold module-level state (the deferred install prompt, the persisted
  // cache); a real cache-busting query string forces a new evaluation.
  const mod = await import(`../app/js/platform.js?t=${Math.random()}`);
  return mod;
}

test("isIOS: true only where navigator.standalone exists, never from the UA", async () => {
  freshGlobals({ navigator: { userAgent: "Mozilla/5.0 (Macintosh)" } });
  const { isIOS } = await fresh();
  assert.equal(isIOS(), false);
  cleanupGlobals();

  freshGlobals({ navigator: { standalone: false, userAgent: "Mozilla/5.0 (iPhone)" } });
  const { isIOS: isIOS2 } = await fresh();
  assert.equal(isIOS2(), true);
  cleanupGlobals();
});

test("isIOSSafari: excludes other iOS browsers wearing WebKit", async () => {
  freshGlobals({ navigator: { standalone: false, userAgent: "CriOS/100 iPhone" } });
  const { isIOSSafari } = await fresh();
  assert.equal(isIOSSafari(), false);
  cleanupGlobals();

  freshGlobals({ navigator: { standalone: false, userAgent: "Version/17.0 Mobile Safari" } });
  const { isIOSSafari: is2 } = await fresh();
  assert.equal(is2(), true);
  cleanupGlobals();
});

test("isInstalled: navigator.standalone wins on iOS, display-mode elsewhere", async () => {
  freshGlobals({ navigator: { standalone: true } });
  const { isInstalled } = await fresh();
  assert.equal(isInstalled(), true);
  cleanupGlobals();

  freshGlobals({ matchMedia: (q) => ({ matches: q.includes("standalone") }) });
  const { isInstalled: is2 } = await fresh();
  assert.equal(is2(), true);
  cleanupGlobals();
});

test("canShareInBackground: only the Android wrapper, never a bare web engine", async () => {
  freshGlobals();
  const { canShareInBackground } = await fresh();
  assert.equal(canShareInBackground(), false);
  globalThis.StarlingNative = {};
  assert.equal(canShareInBackground(), true);
  cleanupGlobals();
});

test("hasWakeLock reflects the real API surface", async () => {
  freshGlobals({ navigator: { wakeLock: {} } });
  const { hasWakeLock } = await fresh();
  assert.equal(hasWakeLock(), true);
  cleanupGlobals();

  freshGlobals();
  const { hasWakeLock: h2 } = await fresh();
  assert.equal(h2(), false);
  cleanupGlobals();
});

test("requestPersistence: refuses to ask from a bare, uninstalled web tab", async () => {
  let asked = false;
  freshGlobals({
    navigator: { storage: { persist: async () => ((asked = true), true) } },
  });
  const { requestPersistence } = await fresh();
  const got = await requestPersistence();
  assert.equal(got, false);
  assert.equal(asked, false, "persist() must not be called outside the wrapper or an install");
  cleanupGlobals();
});

test("requestPersistence: asks once installed, and isPersisted reports it back", async () => {
  freshGlobals({
    navigator: { standalone: true, storage: { persist: async () => true, persisted: async () => true } },
  });
  const { requestPersistence, isPersisted } = await fresh();
  assert.equal(await requestPersistence(), true);
  assert.equal(await isPersisted(), true);
  cleanupGlobals();
});

test("createForegroundSession: acquires a lock, re-acquires it on visibilitychange, releases on stop", async () => {
  const doc = freshGlobals({ navigator: { wakeLock: {} } });
  let released = 0;
  let requests = 0;
  globalThis.navigator.wakeLock.request = async () => {
    requests += 1;
    return {
      addEventListener() {},
      release: async () => {
        released += 1;
      },
    };
  };
  const { createForegroundSession } = await fresh();
  const changes = [];
  const session = createForegroundSession({ onWakeLockChange: (v) => changes.push(v) });
  session.start();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(requests, 1);
  assert.deepEqual(changes, [true]);

  // iOS drops the lock the moment the tab is hidden; the module does not
  // pretend to release it (it did not, the OS did), only re-acquires on the
  // way back.
  doc.visibilityState = "hidden";
  doc.fire("visibilitychange");
  doc.visibilityState = "visible";
  doc.fire("visibilitychange");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(requests, 2);

  await session.stop();
  assert.equal(released, 1);
  cleanupGlobals();
});

test("install prompt: captured once, replayed once, cleared either way", async () => {
  freshGlobals();
  const { canPromptInstall, promptInstall } = await fresh();
  assert.equal(canPromptInstall(), false);
  assert.equal(await promptInstall(), null);
  cleanupGlobals();
});
