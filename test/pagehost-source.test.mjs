// PageHost and the Tor proxy wiring are Kotlin, which nothing in this suite can
// run, and both broke "keep sharing when the app is closed" on real phones
// while the emulator checks passed (munzzyy/starling#6). These pin the two
// rules by reading the source, because the failure is silent: a share that
// looks on and posts nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const kt = (name) =>
  readFileSync(new URL(`../android/app/src/main/kotlin/app/starlingmap/${name}`, import.meta.url), "utf8");

test("pushes into the page go through the main handler, not View.post", () => {
  const src = kt("PageHost.kt");
  assert.doesNotMatch(src, /\bv\.post\s*\{/, "View.post queues until the view has a window again");
  assert.match(src, /main\.post\s*\{[^}]*evaluateJavascript/);
});

test("reopening the app does not re-apply an unchanged proxy, which reloads the page", () => {
  // The rule moved out of the activity so a page built with no window sits behind it too.
  const src = kt("TorProxy.kt");
  assert.match(src, /PageHost\.proxyApplied == rule\) return/);
  assert.match(src, /PageHost\.proxyApplied == "direct"\) return/);
  assert.match(kt("MainActivity.kt"), /private fun applyTorPref\(\) \{\s*TorProxy\.apply\(this\)\s*\}/);
  assert.doesNotMatch(kt("MainActivity.kt"), /ProxyController/, "one place sets the proxy");
});

test("a dead renderer is handled instead of taking the app and the share down", () => {
  const src = kt("PageHost.kt");
  assert.match(src, /override fun onRenderProcessGone\([\s\S]*?return true\s*\}/);
  assert.match(src, /LocationService\.endShare\(app, "renderer"\)/);
});

test("a still phone still wakes the page: a listener with no distance filter, on the circle's cadence", () => {
  const src = kt("LocationService.kt");
  // Twice: the first request, and the re-arm when the cadence changes. Neither
  // may fall back to the constant, which is the floor and nothing else now.
  assert.equal((src.match(/requestLocationUpdates\(provider, heartbeatMs, 0f, heartbeat, mainLooper\)/g) || []).length, 2);
  assert.doesNotMatch(src, /requestLocationUpdates\(provider, HEARTBEAT_MS/);
  assert.match(src, /removeUpdates\(heartbeat\)/);
  assert.match(src, /private const val HEARTBEAT_MS = 15000L/);
  assert.match(src, /coerceIn\(HEARTBEAT_MS, HEARTBEAT_MAX_MS\)/, "the page's number is held to the floor and the ceiling");
  assert.match(kt("StarlingBridge.kt"), /fun setShareCadence\(seconds: Int\) = LocationService\.setCadence\(seconds\)/);
});
