// Places: named spots like Home or School that live ONLY on this device.
// Nothing here ever touches the wire. Positions already arrive encrypted from
// circle members; this module just compares them against locally stored
// circles of interest and reports enter/leave transitions. The relay never
// learns that places exist, let alone where they are.
//
// Detection is deliberately conservative, because GPS jitter at a boundary
// would otherwise flap "arrived" / "left" all afternoon:
//   - enter when a point lands inside the place radius
//   - leave only past radius * EXIT_FACTOR + EXIT_PAD meters (hysteresis)
//   - after any flip, the opposite flip is suppressed for MIN_FLIP_MS
//   - coarse-mode points are ignored: a deliberately degraded position has
//     nothing honest to say about a 250 m circle
//   - stale points are ignored: silence is not the same thing as leaving

import { haversineMeters } from "./fmt.js";

export const PLACE_RADII = [100, 250, 500];
export const DEFAULT_RADIUS = 250;
export const MAX_PLACES = 10;
export const MAX_NAME_LEN = 24;
export const EXIT_FACTOR = 1.4;
export const EXIT_PAD_M = 60;
export const MIN_FLIP_MS = 120_000;
export const POINT_MAX_AGE_MS = 10 * 60 * 1000;

export function newPlaceId() {
  const b = new Uint8Array(4);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// Shape-check one stored place. Storage is local, but it is still parsed
// input: a migrated or hand-edited record must not crash the tracker.
export function validPlace(p) {
  return (
    typeof p === "object" &&
    p !== null &&
    typeof p.id === "string" &&
    /^[0-9a-f]{8}$/.test(p.id) &&
    typeof p.name === "string" &&
    p.name.length > 0 &&
    p.name.length <= MAX_NAME_LEN &&
    Number.isFinite(p.lat) &&
    Math.abs(p.lat) <= 90 &&
    Number.isFinite(p.lon) &&
    Math.abs(p.lon) <= 180 &&
    PLACE_RADII.includes(p.radius)
  );
}

export const sanitizePlaces = (list) =>
  (Array.isArray(list) ? list : []).filter(validPlace).slice(0, MAX_PLACES);

// The place a point is inside of, by the ENTER radius: nearest center wins
// when circles overlap, so a member is only ever "at" one place.
export function placeContaining(places, lat, lon) {
  let best = null;
  let bestD = Infinity;
  for (const p of places) {
    const d = haversineMeters(lat, lon, p.lat, p.lon);
    if (d <= p.radius && d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

// Per-member arrive/leave tracking against the current set of places.
export function createPlaceTracker(initialPlaces = []) {
  let places = sanitizePlaces(initialPlaces);
  // memberId -> { placeId, since, flippedAt }; placeId null means "nowhere".
  const state = new Map();

  function setPlaces(next) {
    places = sanitizePlaces(next);
    const live = new Set(places.map((p) => p.id));
    // A deleted place must not fire a "left" event later; forget it quietly.
    for (const rec of state.values()) {
      if (rec.placeId && !live.has(rec.placeId)) {
        rec.placeId = null;
        rec.flippedAt = 0;
      }
    }
  }

  // Feed one member point. Returns a list of events, each
  // { type: "arrive" | "leave", memberId, placeId, placeName }.
  function update(memberId, lat, lon, { mode, ts, now = Date.now() } = {}) {
    if (!places.length) return [];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    if (mode === "coarse") return [];
    if (Number.isFinite(ts) && now - ts > POINT_MAX_AGE_MS) return [];

    let rec = state.get(memberId);
    if (!rec) {
      // First sight of a member: adopt where they already are without an
      // event. "Juno arrived at Home" is false if Juno was home all along.
      const here = placeContaining(places, lat, lon);
      rec = { placeId: here?.id ?? null, since: now, flippedAt: 0 };
      state.set(memberId, rec);
      return [];
    }

    const events = [];
    const current = rec.placeId ? places.find((p) => p.id === rec.placeId) : null;

    if (current) {
      const d = haversineMeters(lat, lon, current.lat, current.lon);
      const exitAt = current.radius * EXIT_FACTOR + EXIT_PAD_M;
      if (d >= exitAt && now - rec.flippedAt >= MIN_FLIP_MS) {
        rec.placeId = null;
        rec.since = now;
        rec.flippedAt = now;
        events.push({ type: "leave", memberId, placeId: current.id, placeName: current.name });
      }
    }

    if (!rec.placeId) {
      const entered = placeContaining(places, lat, lon);
      // Entering somewhere new is allowed in the same tick as leaving: walking
      // straight from one place into an adjacent one is real. Re-entering the
      // place just left is what the flip cooldown exists to absorb.
      const bouncing =
        entered && current && entered.id === current.id && now - rec.flippedAt < MIN_FLIP_MS && events.length === 0;
      if (entered && !bouncing) {
        rec.placeId = entered.id;
        rec.since = now;
        rec.flippedAt = now;
        events.push({ type: "arrive", memberId, placeId: entered.id, placeName: entered.name });
      }
    }

    return events;
  }

  function placeFor(memberId) {
    const rec = state.get(memberId);
    if (!rec?.placeId) return null;
    return places.find((p) => p.id === rec.placeId) || null;
  }

  function sinceFor(memberId) {
    const rec = state.get(memberId);
    return rec?.placeId ? rec.since : null;
  }

  function forget(memberId) {
    state.delete(memberId);
  }

  return {
    setPlaces,
    update,
    placeFor,
    sinceFor,
    forget,
    clear: () => state.clear(),
    places: () => places,
  };
}
