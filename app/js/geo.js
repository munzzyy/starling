// Geolocation and battery. watchPosition is only ever started on explicit
// user intent (sharing turned on, or the demo); never at boot.
//
// Inside the Android wrapper the fix stream comes from the native foreground
// service instead: page-level watchPosition stops the moment the app leaves
// the foreground, while the service keeps delivering with the screen off.

import { native } from "./env.js";

function startNativeWatch(n, onFix, onError, { onSignal, afterEach } = {}) {
  // afterEach runs even when handling throws: a missed answer reads as a frozen page.
  globalThis.__starlingFix = (json) => {
    try {
      handle(json);
    } finally {
      afterEach?.();
    }
  };
  const handle = (json) => {
    let p;
    try {
      p = JSON.parse(json);
    } catch {
      return;
    }
    // Everything from the service is terminal: it does not retry, so the page
    // must actually stop sharing rather than keep publishing the last fix.
    if (p && p.stopped) {
      const route = typeof p.route === "string" ? p.route : "notif";
      onError({ code: 2, message: "stopped", native: true, stopped: true, route });
      return;
    }
    if (p && p.error) {
      onError({ code: Number(p.code) || 2, message: String(p.error), native: true });
      return;
    }
    // A tick is a minute with no fix; paused is the location switch, "" for back on.
    if (p && (p.tick === true || typeof p.paused === "string")) {
      onSignal?.(p.tick === true ? { tick: true } : { paused: p.paused || null });
      return;
    }
    if (p && typeof p.still === "boolean") {
      onSignal?.({ still: p.still });
      return;
    }
    if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lon)) return;
    onFix({
      lat: p.lat,
      lon: p.lon,
      acc: Number.isFinite(p.acc) ? Math.round(p.acc) : null,
      spd: Number.isFinite(p.spd) ? p.spd : null,
      hdg: Number.isFinite(p.hdg) ? p.hdg : null,
      ts: Number.isFinite(p.ts) ? p.ts : Date.now(),
    });
  };
  try {
    n.startLocation();
  } catch {
    delete globalThis.__starlingFix;
    // Native: nothing retries, so the share stops instead of sitting on "Still trying".
    onError({ code: 2, message: "native location failed", native: true });
    return () => {};
  }
  return () => {
    delete globalThis.__starlingFix;
    try {
      n.stopLocation();
    } catch {
      // service already gone
    }
  };
}

// `hooks` ({ onSignal, afterEach }) only matter inside the Android wrapper.
export function startWatch(onFix, onError, hooks) {
  const n = native();
  if (n?.startLocation) return startNativeWatch(n, onFix, onError, hooks);
  if (!("geolocation" in navigator)) {
    onError({ code: 2, message: "geolocation unsupported" });
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (pos) => {
      const c = pos.coords;
      onFix({
        lat: c.latitude,
        lon: c.longitude,
        acc: Number.isFinite(c.accuracy) ? Math.round(c.accuracy) : null,
        spd: Number.isFinite(c.speed) ? c.speed : null,
        hdg: Number.isFinite(c.heading) ? c.heading : null,
        ts: pos.timestamp || Date.now(),
      });
    },
    (err) => onError(err),
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 25000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

// Best-effort read of geolocation permission state, for a UI that wants to
// show why it is about to ask before spending the prompt. Safari does not
// implement the Permissions API for geolocation (query() rejects there), so
// the honest answer on iOS is always "unknown" and the caller falls back to
// asking outright; every other engine gets a real answer for free.
export async function geoPermissionState() {
  try {
    if (!navigator.permissions?.query) return "unknown";
    const status = await navigator.permissions.query({ name: "geolocation" });
    return status.state; // "granted" | "denied" | "prompt"
  } catch {
    return "unknown";
  }
}

let batteryPromise;

export async function batteryLevel() {
  try {
    if (typeof navigator.getBattery !== "function") return null;
    if (!batteryPromise) batteryPromise = navigator.getBattery();
    const b = await batteryPromise;
    return typeof b.level === "number" ? Math.round(b.level * 100) / 100 : null;
  } catch {
    return null;
  }
}

// Still, walking, cycling, driving: the one-letter act a post may carry.
export const ACTIVITIES = ["s", "w", "c", "d"];
// m/s between each pair of neighbours above.
const ACT_EDGES = [0.6, 2.5, 8];
const ACT_MARGIN = 0.15;

export function activityFor(prev, speed) {
  if (!Number.isFinite(speed) || speed < 0) return null;
  let i = ACT_EDGES.findIndex((e) => speed < e);
  if (i < 0) i = ACT_EDGES.length;
  const p = ACTIVITIES.indexOf(prev);
  if (p >= 0 && p !== i) {
    const lo = p > 0 ? ACT_EDGES[p - 1] * (1 - ACT_MARGIN) : -Infinity;
    const hi = p < ACT_EDGES.length ? ACT_EDGES[p] * (1 + ACT_MARGIN) : Infinity;
    if (speed >= lo && speed < hi) return prev;
  }
  return ACTIVITIES[i];
}

// Null with fewer than two readings: one GPS speed is too noisy to name anything.
export function medianSpeed(speeds) {
  const v = speeds.filter((s) => Number.isFinite(s) && s >= 0).sort((a, b) => a - b);
  if (v.length < 2) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
