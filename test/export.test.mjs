// The export's one promise: everything about you, nothing that opens
// anything. The denylist walk is the load-bearing check, run against a state
// deliberately stuffed with key material in every pocket.
import test from "node:test";
import assert from "node:assert/strict";

import { buildDataExport, EXPORT_KEY_DENYLIST } from "../app/js/export.js";

const HOSTILE_STATE = {
  now: 1725600000000,
  profile: { name: "Avery", emoji: "🐦", st: "omw" },
  settings: { precision: "precise", history: "default", basemap: "dark" },
  places: [
    { id: "aabbccdd", name: "Home", lat: 40, lon: -75, radius: 250, fence: true },
    { id: "aabbccde", name: "Gym", lat: 40.1, lon: -75, radius: 100, alerts: "arrive" },
  ],
  circles: [
    {
      name: "Family",
      active: true,
      precision: "precise",
      cadence: 15,
      secret: new Uint8Array([1, 2, 3]),
      identity: { sk: "SECRETKEYMATERIAL" },
      pinned: new Map([
        ["a".repeat(32), { memberId: "a".repeat(32), name: "Blair", nick: "Gran", muted: true, verified: true, pk: "PUBKEYB64THATMUSTNOTLEAK", epk: "EPHKEYB64THATMUSTNOTLEAK" }],
      ]),
    },
    {
      name: "Climbing",
      precision: "coarse",
      cadence: 300,
      secret: new Uint8Array([4, 5, 6]),
      ck: "CHAINKEYTHATMUSTNOTLEAK",
      channelId: "CHANNELTHATSTAYSHOME",
      identity: { sk: "OTHERSECRETKEYMATERIAL" },
      pinned: [
        { memberId: "c".repeat(32), alg: "ed25519", name: "Casey", nick: "Cas", muted: true, verified: false, pk: "CASEYPKTHATMUSTNOTLEAK", epk: "CASEYEPKTHATMUSTNOTLEAK" },
      ],
    },
  ],
  pinned: [
    {
      memberId: "a".repeat(32),
      name: "Blair",
      nick: "Gran",
      muted: true,
      verified: true,
      alg: "ed25519",
      pk: "PUBKEYB64THATMUSTNOTLEAK",
      epk: "EPHKEYB64THATMUSTNOTLEAK",
    },
  ],
  vaultKey: new Uint8Array([9, 9, 9]),
  lock: { passcode: "hunter2", duress: "wipeword" },
};

function walkKeys(obj, path = []) {
  const hits = [];
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (EXPORT_KEY_DENYLIST.includes(k)) hits.push([...path, k].join("."));
      hits.push(...walkKeys(v, [...path, k]));
    }
  }
  return hits;
}

test("the export carries the user's data", () => {
  const out = buildDataExport(HOSTILE_STATE);
  assert.equal(out.profile.name, "Avery");
  assert.equal(out.places[0].name, "Home");
  assert.equal(out.places[0].fence, true);
  assert.equal(out.circles[0].name, "Family");
  assert.equal(out.people[0].name, "Blair");
  assert.equal(out.people[0].verified, true);
  assert.equal(out.people[0].nick, "Gran", "a nickname is data this device keeps, so it is in the export");
  assert.equal(buildDataExport({ pinned: [{ memberId: "b".repeat(32), name: "Cy" }] }).people[0].nick, null);
  assert.equal(out.people[0].muted, true, "so is a muted switch");
  assert.equal(buildDataExport({ pinned: [{ memberId: "b".repeat(32), name: "Cy" }] }).people[0].muted, false);
  assert.equal(out.exported, new Date(1725600000000).toISOString());
});

test("no denylisted key survives at any depth, and no key bytes leak as values", () => {
  const out = buildDataExport(HOSTILE_STATE);
  assert.deepEqual(walkKeys(out), [], "denylisted key names absent everywhere");
  const flat = JSON.stringify(out);
  for (const needle of ["SECRETKEYMATERIAL", "OTHERSECRETKEYMATERIAL", "PUBKEYB64THATMUSTNOTLEAK", "EPHKEYB64THATMUSTNOTLEAK", "CASEYPKTHATMUSTNOTLEAK", "CASEYEPKTHATMUSTNOTLEAK", "CHAINKEYTHATMUSTNOTLEAK", "CHANNELTHATSTAYSHOME", "hunter2", "wipeword"]) {
    assert.ok(!flat.includes(needle), `${needle} must not appear in the export`);
  }
});

test("every circle is in the export with its own people and sharing choices, the active one flagged", () => {
  const out = buildDataExport(HOSTILE_STATE);
  assert.equal(out.circles.length, 2);
  const [family, climbing] = out.circles;
  assert.deepEqual(family, {
    name: "Family",
    active: true,
    precision: "precise",
    cadence: 15,
    people: [{ name: "Blair", nick: "Gran", muted: true, memberId: "a".repeat(32), verified: true }],
  });
  assert.deepEqual(climbing, {
    name: "Climbing",
    active: false,
    precision: "coarse",
    cadence: 300,
    people: [{ name: "Casey", nick: "Cas", muted: true, memberId: "c".repeat(32), verified: false }],
  });
  assert.deepEqual(out.people, family.people, "the top-level list stays the active circle's for one more release");
});

test("each place says which way it alerts, with no choice stored meaning both", () => {
  const out = buildDataExport(HOSTILE_STATE);
  assert.deepEqual(out.places.map((p) => p.alerts), ["both", "arrive"]);
});

test("negative control: a leaked secret would be caught", () => {
  // Prove the walker actually bites: hand it an export-shaped object with a
  // smuggled key and watch the check fail.
  const smuggled = { ...buildDataExport(HOSTILE_STATE), circles: [{ name: "Family", secret: "oops" }] };
  assert.ok(walkKeys(smuggled).length > 0, "the denylist walk detects a smuggled key");
});

test("the caption is not in the export either: it clears with the share and belongs to nobody's archive", () => {
  const out = buildDataExport(HOSTILE_STATE);
  assert.ok(!JSON.stringify(out).includes("omw"), "the transient caption stays transient");
});
