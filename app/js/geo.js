// Geolocation and battery. watchPosition is only ever started on explicit
// user intent (sharing turned on, or the demo); never at boot.
//
// Inside the Android wrapper the fix stream comes from the native foreground
// service instead: page-level watchPosition stops the moment the app leaves
// the foreground, while the service keeps delivering with the screen off.

import { native } from "./env.js";

function startNativeWatch(n, onFix, onError) {
  globalThis.__starlingFix = (json) => {
    let p;
    try {
      p = JSON.parse(json);
    } catch {
      return;
    }
    // Everything from the service is terminal: it does not retry, so the page
    // must actually stop sharing rather than keep publishing the last fix.
    if (p && p.stopped) {
      onError({ code: 2, message: "stopped", native: true, stopped: true });
      return;
    }
    if (p && p.error) {
      onError({ code: Number(p.code) || 2, message: String(p.error), native: true });
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
    onError({ code: 2, message: "native location failed" });
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

export function startWatch(onFix, onError) {
  const n = native();
  if (n?.startLocation) return startNativeWatch(n, onFix, onError);
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
