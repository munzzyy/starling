// Geolocation and battery. watchPosition is only ever started on explicit
// user intent (sharing turned on, or the demo); never at boot.

export function startWatch(onFix, onError) {
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
