// Pure formatting and geometry helpers. No DOM, no globals, unit-tested.

const EARTH_R = 6371008.8; // mean Earth radius, meters

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function fmtDistance(m) {
  if (!Number.isFinite(m) || m < 0) return "";
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 10000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

export function fmtRelTime(msAgo) {
  if (!Number.isFinite(msAgo) || msAgo < 0) msAgo = 0;
  const s = Math.floor(msAgo / 1000);
  if (s < 15) return "now";
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${String(min % 60).padStart(2, "0")} min`;
  return `${Math.floor(h / 24)} d`;
}

// Rounds a position onto a ~1 km grid (0.01 degrees).
export function coarsePos(lat, lon) {
  return {
    lat: Math.round(lat * 100) / 100,
    lon: Math.round(lon * 100) / 100,
  };
}

// Stable hue for a member id: first 6 hex chars spread over the wheel.
export function hueFromMemberId(hex) {
  const n = parseInt(String(hex).slice(0, 6), 16);
  if (!Number.isFinite(n)) return 0;
  return n % 360;
}
