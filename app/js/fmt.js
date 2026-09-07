// Pure formatting and geometry helpers. Unit-tested; the one word in here
// ("now") goes through the translation layer.

import { t } from "./i18n.js";

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
  if (s < 15) return t("now");
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${String(min % 60).padStart(2, "0")} min`;
  return `${Math.floor(h / 24)} d`;
}

// Initial great-circle bearing from point 1 toward point 2, degrees
// clockwise from north, 0..360. Pure math: finding a person by compass is
// the one direction feature that needs no tile, no network, nothing.
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLon = (lon2 - lon1) * rad;
  const y = Math.sin(dLon) * Math.cos(lat2 * rad);
  const x =
    Math.cos(lat1 * rad) * Math.sin(lat2 * rad) -
    Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// The bearing as a word a person can walk by. Eight ways is what humans
// actually use; degrees are for the decorative arrow.
export function compassWord(deg) {
  const words = [t("north"), t("northeast"), t("east"), t("southeast"), t("south"), t("southwest"), t("west"), t("northwest")];
  return words[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
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
