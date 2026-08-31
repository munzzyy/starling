// Demo flight: a fully offline simulation of a living circle. No network, no
// persistence; everything lives in this module until stop() is called.

import { TRAIL_CAP } from "./wire.js";

export const DEMO_CENTER = { lat: 40.7794, lon: -73.9632 };

const M_LAT = 1 / 111320;
const M_LON = 1 / (111320 * Math.cos((DEMO_CENTER.lat * Math.PI) / 180));

// Waypoint loops in meters east/north of the center: plausible walking paths.
const WALKERS = [
  {
    id: "a1b2c3d4e5f60011",
    name: "Wren",
    emoji: "\u{1F426}",
    hue: 168,
    speed: 1.35,
    bat: 0.82,
    phase: 0.5,
    path: [[30, -20], [95, 15], [150, -10], [185, -75], [130, -135], [55, -145], [5, -90]],
  },
  {
    id: "b2c3d4e5f6a70022",
    name: "Juno",
    emoji: "\u{1F98A}",
    hue: 262,
    speed: 1.5,
    bat: 0.57,
    phase: 0.35,
    path: [[-60, 40], [-160, 85], [-260, 45], [-325, -40], [-260, -125], [-150, -135], [-70, -60]],
  },
  {
    id: "c3d4e5f6a7b80033",
    name: "Ash",
    emoji: "\u{1F989}",
    hue: 36,
    speed: 1.25,
    bat: 0.08,
    phase: 0.6,
    path: [[20, -180], [110, -235], [155, -320], [80, -400], [-40, -380], [-95, -280], [-30, -200]],
  },
  {
    id: "d4e5f6a7b8c90044",
    name: "Mabel",
    emoji: "\u{1F41D}",
    hue: 330,
    speed: 1.4,
    bat: 0.66,
    phase: 0.15,
    path: [[120, 80], [225, 145], [300, 220], [260, 320], [150, 335], [60, 240], [70, 140]],
  },
];

// You wander a few meters around the terrace.
const YOU_PATH = [[0, 0], [9, 6], [15, -1], [8, -8]];
const YOU_SPEED = 0.25;

function toLatLon([e, n]) {
  return { lat: DEMO_CENTER.lat + n * M_LAT, lon: DEMO_CENTER.lon + e * M_LON };
}

function segLengths(path) {
  const out = [];
  let total = 0;
  for (let i = 0; i < path.length; i++) {
    const [x1, y1] = path[i];
    const [x2, y2] = path[(i + 1) % path.length];
    const len = Math.hypot(x2 - x1, y2 - y1);
    out.push(len);
    total += len;
  }
  return { lengths: out, total };
}

function posAlong(path, geom, dist) {
  let d = ((dist % geom.total) + geom.total) % geom.total;
  for (let i = 0; i < path.length; i++) {
    const len = geom.lengths[i];
    if (d <= len) {
      const [x1, y1] = path[i];
      const [x2, y2] = path[(i + 1) % path.length];
      const k = len === 0 ? 0 : d / len;
      return [x1 + (x2 - x1) * k, y1 + (y2 - y1) * k];
    }
    d -= len;
  }
  return path[0];
}

// SOS storyline: Juno raises an SOS 20 s in, checks in 8 s later, clears.
const SOS_AT = 20;
const CHECKIN_AT = 28;
const CLEAR_AT = 34;

export function createDemo({ profile, onTick, onEvent }) {
  const walkers = WALKERS.map((w) => ({ ...w, geom: segLengths(w.path), trail: [] }));
  const youGeom = segLengths(YOU_PATH);
  let t = 0;
  let timer = 0;

  function memberState(w, tSec, now) {
    const pos = toLatLon(posAlong(w.path, w.geom, w.phase * w.geom.total + w.speed * tSec));
    let type = "loc";
    if (w.name === "Juno") {
      if (tSec >= SOS_AT && tSec < CHECKIN_AT) type = "sos";
      else if (tSec >= CHECKIN_AT && tSec < CLEAR_AT) type = "checkin";
    }
    return {
      id: w.id,
      name: w.name,
      emoji: w.emoji,
      hue: w.hue,
      lat: pos.lat,
      lon: pos.lon,
      bat: Math.max(0.02, w.bat - tSec * 0.00002),
      mode: "precise",
      ts: now,
      type,
      trail: w.trail,
    };
  }

  function youState(tSec, now) {
    const pos = toLatLon(posAlong(YOU_PATH, youGeom, YOU_SPEED * tSec));
    return {
      name: profile?.name || "You",
      emoji: profile?.emoji || "\u{1F9ED}",
      lat: pos.lat,
      lon: pos.lon,
      ts: now,
    };
  }

  function pushTrail(w, m) {
    w.trail.push({ lat: m.lat, lon: m.lon, ts: m.ts });
    if (w.trail.length > TRAIL_CAP) w.trail.splice(0, w.trail.length - TRAIL_CAP);
  }

  function tick() {
    const now = Date.now();
    const members = walkers.map((w) => {
      const m = memberState(w, t, now);
      pushTrail(w, m);
      return m;
    });
    if (t === SOS_AT) onEvent?.({ kind: "sos", name: "Juno" });
    if (t === CHECKIN_AT) onEvent?.({ kind: "checkin", name: "Juno" });
    onTick(members, youState(t, now));
    t += 1;
  }

  return {
    start() {
      // Seed six minutes of history so trails have something to show
      // immediately.
      const now = Date.now();
      for (const w of walkers) {
        for (let back = 360; back > 0; back -= 4) {
          const m = memberState(w, -back, now - back * 1000);
          pushTrail(w, m);
        }
      }
      tick();
      timer = setInterval(tick, 1000);
    },
    stop() {
      clearInterval(timer);
    },
  };
}
