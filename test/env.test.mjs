// Host-environment routing: relay normalization, API base selection, and the
// wrapper's canonical invite origin. The wrapper is simulated by planting a
// fake StarlingNative bridge on globalThis.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRelay, setApiBase, apiUrl, getApiBase, shareUrlBase, isWrapped, shareCapable } from "../app/js/env.js";
const envExports = { shareCapable };

function withBridge(bridge, fn) {
  globalThis.StarlingNative = bridge;
  try {
    return fn();
  } finally {
    delete globalThis.StarlingNative;
  }
}

test("normalizeRelay accepts https origins and strips trailing slashes", () => {
  assert.equal(normalizeRelay("https://relay.example.org"), "https://relay.example.org");
  assert.equal(normalizeRelay("https://relay.example.org/"), "https://relay.example.org");
  assert.equal(normalizeRelay("  https://relay.example.org//  "), "https://relay.example.org");
  assert.equal(normalizeRelay("https://relay.example.org:8443"), "https://relay.example.org:8443");
});

test("normalizeRelay keeps a path but trims its trailing slash", () => {
  assert.equal(normalizeRelay("https://x.example/starling/"), "https://x.example/starling");
});

test("normalizeRelay rejects junk", () => {
  assert.equal(normalizeRelay("http://relay.example.org"), null);
  assert.equal(normalizeRelay("https://user:pw@relay.example.org"), null);
  assert.equal(normalizeRelay("https://relay.example.org/?q=1"), null);
  assert.equal(normalizeRelay("https://relay.example.org/#frag"), null);
  assert.equal(normalizeRelay("relay.example.org"), null);
  assert.equal(normalizeRelay(""), null);
  assert.equal(normalizeRelay("   "), null);
  assert.equal(normalizeRelay(null), null);
  assert.equal(normalizeRelay(42), null);
});

test("api base is same-origin on the web and canonical in the wrapper", () => {
  setApiBase(null);
  assert.equal(getApiBase(), "");
  assert.equal(apiUrl("/api/v1/health"), "/api/v1/health");
  withBridge({}, () => {
    setApiBase(null);
    assert.equal(getApiBase(), "https://starlingmap.app");
    assert.equal(apiUrl("/api/v1/health"), "https://starlingmap.app/api/v1/health");
  });
  setApiBase(null);
  assert.equal(getApiBase(), "");
});

test("a custom relay overrides the default on both hosts", () => {
  setApiBase("https://relay.example.org/");
  assert.equal(apiUrl("/api/v1/x"), "https://relay.example.org/api/v1/x");
  withBridge({}, () => {
    setApiBase("https://relay.example.org");
    assert.equal(apiUrl("/api/v1/x"), "https://relay.example.org/api/v1/x");
  });
  // Junk falls back to the host default instead of poisoning the base.
  setApiBase("http://nope");
  assert.equal(getApiBase(), "");
  setApiBase(null);
});

test("shareUrlBase names the canonical origin only in the wrapper", () => {
  withBridge({}, () => {
    assert.equal(shareUrlBase(), "https://starlingmap.app/");
    assert.equal(isWrapped(), true);
  });
  assert.equal(isWrapped(), false);
  const hadLocation = "location" in globalThis;
  globalThis.location = { origin: "https://example.test", pathname: "/app/" };
  try {
    assert.equal(shareUrlBase(), "https://example.test/app/");
  } finally {
    if (!hadLocation) delete globalThis.location;
  }
});

test("shareCapable: wrapper always, dev hosts on the web, hosted origin never", () => {
  const { shareCapable } = envExports;
  const hadLocation = "location" in globalThis;
  const prev = globalThis.location;
  try {
    globalThis.location = { hostname: "starlingmap.app" };
    assert.equal(shareCapable(), false);
    assert.equal(withBridge({}, () => shareCapable()), true);
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      globalThis.location = { hostname: host };
      assert.equal(shareCapable(), true);
    }
    globalThis.location = { hostname: "evil.example" };
    assert.equal(shareCapable(), false);
    delete globalThis.location;
    assert.equal(shareCapable(), false);
  } finally {
    if (hadLocation) globalThis.location = prev;
    else delete globalThis.location;
  }
});
