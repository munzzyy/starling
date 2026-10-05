// Who is at each place, through the real roster, tracker, cards and Places
// sheet: a seen arrival dates the card line, first sight does not, and Here
// now names only the people whose dots are still live.
import test from "node:test";
import assert from "node:assert/strict";

import { installDom, loadApp } from "./dom-harness.mjs";

const harness = installDom();
globalThis.indexedDB ??= {
  open() {
    throw new Error("no indexeddb in the harness");
  },
  deleteDatabase() {
    const req = {};
    setTimeout(() => req.onsuccess?.(), 0);
    return req;
  },
};

const { internals, api } = await loadApp(harness);
const state = internals.state;
const { openGeneration } = await import("../app/js/rekey.js");
const { epochAt } = await import("../app/js/ratchet.js");
const { generateIdentity, newSeed, sealMessage, buildPost } = await import("../app/js/crypto.js");
const { b64uEncode } = await import("../app/js/wire.js");
const { fmtClock } = await import("../app/js/fmt.js");

test.after(() => harness.stopTimers());

const BASE = { lat: 40.0, lon: -75.0 };
const north = (m) => ({ lat: BASE.lat + m / 111320, lon: BASE.lon });
const HOME = { id: "aaaaaaaa", name: "Home", lat: BASE.lat, lon: BASE.lon, radius: 250 };
const SCHOOL = { id: "bbbbbbbb", name: "School", lat: north(2000).lat, lon: BASE.lon, radius: 250 };

async function post(who, name, pos, ts, mode = "precise") {
  const gen = state.gen;
  const e = epochAt(ts);
  const key = await gen.ratchet.keyFor(e, who.memberId, ts);
  const sealed = await sealMessage(key, gen.channelId, who.memberId, e, ts, {
    v: 2,
    ts,
    t: "loc",
    name,
    lat: pos.lat,
    lon: pos.lon,
    ...(mode === "precise" ? { acc: 5 } : {}),
    mode,
  });
  const p = await buildPost(who, gen.channelId, e, sealed, ts);
  await internals.roster().ingest(
    [
      {
        m: who.memberId,
        alg: who.alg,
        pk: b64uEncode(who.pk),
        epk: b64uEncode(who.epk),
        points: [{ e: p.e, ts: p.ts, srv: p.ts, n: p.n, c: p.c, sig: p.sig }],
      },
    ],
    ts,
  );
  const realNow = Date.now;
  Date.now = () => ts + 500;
  try {
    internals.checkAlerts();
  } finally {
    Date.now = realNow;
  }
}

const now = Date.now();
const juno = await generateIdentity();
const wren = await generateIdentity();
const mabel = await generateIdentity();
const junoArrived = now - 60_000;

test("a circle where people come and go", async () => {
  state.demo = false;
  state.locked = false;
  state.lock = null;
  state.identity = await generateIdentity();
  state.gen = await openGeneration({ seed: new Uint8Array(newSeed()), g: 0, e0: epochAt(now - 15 * 60_000) });
  state.gen.at = now;
  state.genRoster = new Set();
  state.pinned = new Map();
  internals.setupNet();
  internals.resetMemberAlerts();
  state.places = [HOME, SCHOOL];
  await internals.savePlaces();
  internals.startDemo();
  internals.exitDemo();
  assert.equal(state.screen, "map");

  // Juno walks into Home while this phone watches.
  await post(juno, "Juno", north(2000), now - 120_000);
  await post(juno, "Juno", BASE, junoArrived);
  // Wren is already at School the first time this phone hears from her.
  await post(wren, "Wren", SCHOOL, now - 30_000);
  // Mabel was at Home too, but her dot went quiet minutes ago.
  await post(mabel, "Mabel", north(50), now - 9 * 60_000);

  assert.equal(internals.placeTracker.placeFor(juno.memberId)?.name, "Home");
  assert.equal(internals.placeTracker.placeFor(wren.memberId)?.name, "School");
  assert.equal(internals.placeTracker.placeFor(mabel.memberId)?.name, "Home");
});

test("the card dates a seen arrival and only a seen one", async () => {
  await api.setSetting("trail", true);
  const label = (id) =>
    harness.node("#member-list").children.find((c) => c.dataset.member === id)?.getAttribute("aria-label") || "";
  assert.ok(label(juno.memberId).includes(`At Home since ${fmtClock(junoArrived)}`), label(juno.memberId));
  assert.ok(label(wren.memberId).includes("At School"), label(wren.memberId));
  assert.ok(!label(wren.memberId).includes("since"), "first sight is not an arrival anyone saw");
});

// Opens the real Places sheet and reads each row's Here now line, by place id.
function hereLines() {
  internals.openPlaces();
  const out = {};
  const walk = (n, place) => {
    const at = n?.dataset?.place || place;
    if (n?.dataset?.testid === "place-here") out[at] = n.hidden ? "" : n.textContent;
    for (const kid of n?.children || []) walk(kid, at);
  };
  walk(harness.node("#overlays").children.at(-1), null);
  return out;
}

test("the Places sheet names who is at each place right now", () => {
  const here = hereLines();
  assert.equal(here[HOME.id], "Here now: Juno", "Mabel's quiet dot is not here now");
  assert.equal(here[SCHOOL.id], "Here now: Wren");
});

test("you count too, and an empty place says nothing", () => {
  state.me = { lat: SCHOOL.lat, lon: SCHOOL.lon, ts: Date.now() };
  try {
    internals.checkAlerts();
    const gym = { id: "cccccccc", name: "Gym", lat: north(9000).lat, lon: BASE.lon, radius: 100 };
    state.places = [HOME, SCHOOL, gym];
    internals.placeTracker.setPlaces(state.places);
    assert.deepEqual(hereLines(), {
      [HOME.id]: "Here now: Juno",
      [SCHOOL.id]: "Here now: You and Wren",
      [gym.id]: "",
    });
  } finally {
    state.me = null;
  }
});

test("a member who switches to Neighborhood is not named at a place until she is precise again", async () => {
  const label = (id) =>
    harness.node("#member-list").children.find((c) => c.dataset.member === id)?.getAttribute("aria-label") || "";
  const ts = Date.now();
  await post(juno, "Juno", BASE, ts - 30_000, "coarse");
  assert.equal(internals.placeTracker.placeFor(juno.memberId), null);
  assert.equal(hereLines()[HOME.id], "", "a grid point a kilometer wide cannot put her at Home");
  await api.setSetting("trail", false);
  assert.ok(label(juno.memberId).includes("Neighborhood"), label(juno.memberId));
  assert.ok(!label(juno.memberId).includes("At Home"), label(juno.memberId));

  await post(juno, "Juno", BASE, ts);
  assert.equal(hereLines()[HOME.id], "Here now: Juno");
  await api.setSetting("trail", true);
  assert.ok(label(juno.memberId).includes("At Home"), label(juno.memberId));
  assert.ok(!label(juno.memberId).includes("since"), "nobody saw when she got back");
});
