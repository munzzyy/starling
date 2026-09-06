// Demo flight: a fully offline simulation of a living circle. No network, no
// persistence; everything lives in this module until stop() is called.
//
// The demo is the product tour, and on the hosted site it is the only tour:
// the web never opens circles, so this is where a visitor learns what the
// app feels like. It shows the whole 0.7 surface: live dots with trails,
// status captions, a place arrival, a low battery, and an SOS that clears.
// The story beats repeat on a cycle so a patient viewer sees them again.

import { TRAIL_CAP } from "./wire.js";
import { t } from "./i18n.js";

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
    stKey: "coffee run",
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
    stKey: "",
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
    stKey: "phone's dying",
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
    stKey: "omw to the fountain",
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

// The story runs on a cycle so its beats come back around for anyone who
// keeps watching. Juno raises an SOS, checks in, clears; Mabel's caption
// flips when she reaches the fountain.
const CYCLE_S = 120;
const SOS_AT = 20;
const CHECKIN_AT = 28;
const CLEAR_AT = 34;
const MABEL_ARRIVES_S = 130;

// The fountain, in meter space: the point Mabel reaches MABEL_ARRIVES_S
// seconds in. Shared by demoPlaces (as a place) and by her caption (which
// flips on the same geometry the tracker judges, so the card can never read
// "omw" and "At The fountain" in the same breath).
const MABEL_GEOM = segLengths(WALKERS[3].path);
const FOUNTAIN_M = posAlong(
  WALKERS[3].path,
  MABEL_GEOM,
  WALKERS[3].phase * MABEL_GEOM.total + WALKERS[3].speed * MABEL_ARRIVES_S,
);
const FOUNTAIN_R = 100;

// Demo-only places, derived from the same geometry the walkers use so the
// arrival beat is guaranteed by construction: "the fountain" sits where
// Mabel will be MABEL_ARRIVES_S seconds into the demo, far enough ahead
// that she starts outside its circle and walks in. "Home" sits under your
// own feet, so the you-line reads "At Home" from the first frame. These
// never touch the real place list; the demo swaps them in and back out.
export function demoPlaces() {
  const fountain = toLatLon(FOUNTAIN_M);
  const home = toLatLon([0, 0]);
  return [
    { id: "de30703e", name: t("Home"), lat: home.lat, lon: home.lon, radius: 100 },
    { id: "de30f0f0", name: t("The fountain"), lat: fountain.lat, lon: fountain.lon, radius: FOUNTAIN_R },
  ];
}

// One frame of the story, as a pure function of demo time. Exported so a
// test can play the whole tape without timers and hold the beats to it.
export function demoFrame(tSec, now, profile) {
  const members = WALKERS.map((w) => {
    const geom = segLengths(w.path);
    const mPos = posAlong(w.path, geom, w.phase * geom.total + w.speed * tSec);
    const pos = toLatLon(mPos);
    const cycle = ((tSec % CYCLE_S) + CYCLE_S) % CYCLE_S;
    let type = "loc";
    let st = w.stKey ? t(w.stKey) : "";
    if (w.name === "Juno") {
      if (cycle >= SOS_AT && cycle < CHECKIN_AT) type = "sos";
      else if (cycle >= CHECKIN_AT && cycle < CLEAR_AT) type = "checkin";
    }
    if (w.name === "Mabel") {
      const there = Math.hypot(mPos[0] - FOUNTAIN_M[0], mPos[1] - FOUNTAIN_M[1]) <= FOUNTAIN_R;
      st = there ? t("made it") : t("omw to the fountain");
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
      st,
    };
  });
  const youGeom = segLengths(YOU_PATH);
  const youPos = toLatLon(posAlong(YOU_PATH, youGeom, YOU_SPEED * tSec));
  const you = {
    name: profile?.name || "You",
    emoji: profile?.emoji || "\u{1F9ED}",
    lat: youPos.lat,
    lon: youPos.lon,
    ts: now,
  };
  return { members, you };
}

export function createDemo({ profile, onTick, onEvent }) {
  const trails = new Map(WALKERS.map((w) => [w.id, []]));
  let t = 0;
  let timer = 0;

  function pushTrail(m) {
    const trail = trails.get(m.id);
    trail.push({ lat: m.lat, lon: m.lon, ts: m.ts });
    if (trail.length > TRAIL_CAP) trail.splice(0, trail.length - TRAIL_CAP);
  }

  function frameAt(tSec, now) {
    const { members, you } = demoFrame(tSec, now, profile);
    for (const m of members) {
      pushTrail(m);
      m.trail = trails.get(m.id);
    }
    return { members, you };
  }

  function tick() {
    const now = Date.now();
    const { members, you } = frameAt(t, now);
    const cycle = t % CYCLE_S;
    if (cycle === SOS_AT) onEvent?.({ kind: "sos", name: "Juno" });
    if (cycle === CHECKIN_AT) onEvent?.({ kind: "checkin", name: "Juno" });
    onTick(members, you);
    t += 1;
  }

  return {
    start() {
      // Seed six minutes of history so trails have something to show
      // immediately.
      const now = Date.now();
      for (let back = 360; back > 0; back -= 4) {
        const { members } = demoFrame(-back, now - back * 1000, profile);
        for (const m of members) pushTrail(m);
      }
      tick();
      timer = setInterval(tick, 1000);
    },
    stop() {
      clearInterval(timer);
    },
  };
}
