// geoPermissionState: a best-effort read that must never throw and must be
// honest about engines (Safari) that do not support the Permissions API for
// geolocation at all.
import test from "node:test";
import assert from "node:assert/strict";
import { geoPermissionState } from "../app/js/geo.js";

function withNavigator(nav, fn) {
  const had = "navigator" in globalThis;
  const prev = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    if (had) Object.defineProperty(globalThis, "navigator", { value: prev, configurable: true, writable: true });
    else delete globalThis.navigator;
  }
}

test("geoPermissionState: unknown when the Permissions API is missing (Safari)", async () => {
  await withNavigator({}, async () => {
    assert.equal(await geoPermissionState(), "unknown");
  });
});

test("geoPermissionState: passes through a real answer", async () => {
  await withNavigator(
    { permissions: { query: async () => ({ state: "granted" }) } },
    async () => {
      assert.equal(await geoPermissionState(), "granted");
    }
  );
});

test("geoPermissionState: a query() rejection still resolves, not throws", async () => {
  await withNavigator(
    {
      permissions: {
        query: async () => {
          throw new Error("nope");
        },
      },
    },
    async () => {
      assert.equal(await geoPermissionState(), "unknown");
    }
  );
});
