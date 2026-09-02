// The emergency beacon and the page behind a help link.
//
// A beacon link is a shared secret. It names the channel and it derives the
// content key, so every person it was forwarded to can produce ciphertext that
// opens cleanly on the viewer page: a false position, or a "bye" that tells
// every helper the session ended while somebody is still in trouble. GCM says
// only that someone holding the link wrote this. The signature is what says
// who, and the id the link commits to is what says which signature to believe.
//
// So these tests are about one question: can anybody other than the beacon put
// something on a helper's screen. They run the real beacon, take the real
// link, and attack the channel with the same crypto the beacon uses.
import test from "node:test";
import assert from "node:assert/strict";

import { startBeacon } from "../app/js/helpsession.js";
import { onlyFrom } from "../app/js/helpview.js";
import { createRoster, statusOf } from "../app/js/net.js";
import {
  generateIdentity,
  parseBeaconFragment,
  deriveHelpChannelId,
  deriveHelpEncKey,
  sealMessage,
  buildPost,
} from "../app/js/crypto.js";
import { epochAt } from "../app/js/ratchet.js";
import { memberIdFromKeys, b64uDecode } from "../app/js/wire.js";

const ORIGIN = "http://127.0.0.1:8899";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The beacon posts through the real sender, so it needs a location to build
// its link against and a fetch to write to. Every POST body is kept: those are
// the exact bytes a viewer would be served back.
function stubGlobals() {
  const posts = [];
  const prevLoc = Object.getOwnPropertyDescriptor(globalThis, "location");
  const prevFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "location", {
    value: { origin: ORIGIN, hostname: "127.0.0.1", pathname: "/" },
    configurable: true,
    writable: true,
  });
  globalThis.fetch = async (url, init) => {
    posts.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  return {
    posts,
    restore() {
      if (prevLoc) Object.defineProperty(globalThis, "location", prevLoc);
      else delete globalThis.location;
      globalThis.fetch = prevFetch;
    },
  };
}

// One feed entry as the relay would serve it, from a post body.
const entryOf = (post) => ({
  m: post.m,
  alg: post.alg,
  pk: post.pk,
  epk: post.epk,
  points: [{ e: post.e, ts: post.ts, srv: post.ts, n: post.n, c: post.c, sig: post.sig }],
});

// Everything a viewer holding the link can do, done by someone who is not the
// beacon: their own signing identity, the link's channel, the link's key.
async function forge(secret, msg, ts = Date.now()) {
  const identity = await generateIdentity();
  const channelId = await deriveHelpChannelId(secret);
  const key = await deriveHelpEncKey(secret, ["encrypt", "decrypt"]);
  const e = epochAt(ts);
  const sealed = await sealMessage(key, channelId, identity.memberId, e, ts, { v: 2, ts, ...msg });
  return buildPost(identity, channelId, e, sealed, ts);
}

// The viewer page's own wiring: the link's channel and key, the one sender the
// link commits to, nothing else.
async function viewerFor(parsed) {
  const channelId = await deriveHelpChannelId(parsed.secret);
  const key = await deriveHelpEncKey(parsed.secret, ["decrypt"]);
  const roster = createRoster({
    channelId,
    ratchet: { keyFor: async () => key, currentEpoch: async (n) => epochAt(n), retainedEpochs: () => [] },
    selfId: null,
    pinned: new Map(),
  });
  return { roster, bound: onlyFrom(roster, parsed.ownerId) };
}

test("a help link commits to the signing identity the beacon actually posts with", async () => {
  const g = stubGlobals();
  try {
    const beacon = await startBeacon();
    const v = await beacon.addViewer({ label: "Sam", ttlMs: 60_000 });
    await beacon.send({ t: "sos", lat: 44.98, lon: -93.27 });

    const parsed = parseBeaconFragment(`#${v.link.split("#")[1]}`);
    assert.ok(parsed, "the minted link must parse");
    assert.match(parsed.ownerId, /^[0-9a-f]{32}$/);

    const post = g.posts.at(-1).body;
    assert.equal(post.m, parsed.ownerId, "the link names the member id that signs the points");
    // And that id is not a label the relay could reassign: it is a hash of the
    // two public keys, so pinning it pins the signing key.
    assert.equal(await memberIdFromKeys(b64uDecode(post.pk), b64uDecode(post.epk)), parsed.ownerId);

    // Two viewers of one emergency get unlinkable links AND different
    // identities, so one viewer's link says nothing about another's channel.
    const v2 = await beacon.addViewer({ ttlMs: 60_000 });
    const p2 = parseBeaconFragment(`#${v2.link.split("#")[1]}`);
    assert.notEqual(p2.ownerId, parsed.ownerId);
    assert.notDeepEqual(p2.secret, parsed.secret);
  } finally {
    g.restore();
  }
});

test("a viewer shows the beacon's own points", async () => {
  const g = stubGlobals();
  try {
    const beacon = await startBeacon();
    const v = await beacon.addViewer({ ttlMs: 60_000 });
    await beacon.send({ t: "sos", lat: 44.98, lon: -93.27, name: "Ana" });

    const parsed = parseBeaconFragment(`#${v.link.split("#")[1]}`);
    const { roster, bound } = await viewerFor(parsed);
    await bound.ingest([entryOf(g.posts.at(-1).body)]);

    const recs = roster.list();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].id, parsed.ownerId);
    assert.equal(recs[0].name, "Ana");
    assert.equal(recs[0].lat, 44.98);
    assert.equal(statusOf(recs[0], Date.now()), "sos");
  } finally {
    g.restore();
  }
});

test("someone else holding the link cannot put a position on a helper's map", async () => {
  const g = stubGlobals();
  try {
    const beacon = await startBeacon();
    const v = await beacon.addViewer({ ttlMs: 60_000 });
    await beacon.send({ t: "sos", lat: 44.98, lon: -93.27, name: "Ana" });

    const parsed = parseBeaconFragment(`#${v.link.split("#")[1]}`);
    const { roster, bound } = await viewerFor(parsed);

    // The attacker is FIRST, which is the whole reason trust on first use is
    // no defence here: they were forwarded the link and the person in trouble
    // has not posted yet.
    const lie = await forge(parsed.secret, { t: "sos", lat: 0, lon: 0, name: "Ana" });
    await bound.ingest([entryOf(lie)]);
    assert.deepEqual(roster.list(), [], "a point from an unpinned sender must not land");

    // The real beacon's point still lands afterwards, so the filter is not
    // just breaking the channel.
    await bound.ingest([entryOf(g.posts.at(-1).body)]);
    const recs = roster.list();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].id, parsed.ownerId);
    assert.equal(recs[0].lat, 44.98);

    // And it cannot overwrite the real position afterwards either.
    const later = await forge(parsed.secret, { t: "loc", lat: 0, lon: 0 }, Date.now() + 1000);
    await bound.ingest([entryOf(later)]);
    assert.equal(roster.list().length, 1);
    assert.equal(roster.list()[0].lat, 44.98);
  } finally {
    g.restore();
  }
});

test("someone else holding the link cannot forge the end of an emergency", async () => {
  const g = stubGlobals();
  try {
    const beacon = await startBeacon();
    const v = await beacon.addViewer({ ttlMs: 60_000 });
    await beacon.send({ t: "sos", lat: 44.98, lon: -93.27 });

    const parsed = parseBeaconFragment(`#${v.link.split("#")[1]}`);
    const { roster, bound } = await viewerFor(parsed);
    await bound.ingest([entryOf(g.posts.at(-1).body)]);

    // "Session ended" while the person is still in trouble is the worst thing
    // this page can be made to say. The forged bye is newer than the real
    // position, and the page draws the freshest record it holds, so a bye that
    // merely lands in some other slot is still a bye on the screen: the test
    // has to ask the question the way render() asks it.
    const bye = await forge(parsed.secret, { t: "bye" }, Date.now() + 1000);
    await bound.ingest([entryOf(bye)]);
    const recs = roster.list();
    assert.equal(recs.length, 1, "the roster holds only the sender the link named");
    const shown = recs.reduce((a, b) => (b.ts > a.ts ? b : a));
    assert.equal(shown.id, parsed.ownerId);
    assert.equal(shown.type, "sos");
    assert.notEqual(statusOf(shown, Date.now()), "stopped");
  } finally {
    g.restore();
  }
});

test("the viewer page's key cannot encrypt, so no bug in it can post", async () => {
  const g = stubGlobals();
  try {
    const beacon = await startBeacon();
    const v = await beacon.addViewer({ ttlMs: 60_000 });
    const parsed = parseBeaconFragment(`#${v.link.split("#")[1]}`);
    const key = await deriveHelpEncKey(parsed.secret, ["decrypt"]);
    const channelId = await deriveHelpChannelId(parsed.secret);
    await assert.rejects(() => sealMessage(key, channelId, parsed.ownerId, epochAt(Date.now()), Date.now(), { t: "loc" }));
  } finally {
    g.restore();
  }
});

test("a link with the commitment stripped off is not a link", async () => {
  const g = stubGlobals();
  try {
    const beacon = await startBeacon();
    const v = await beacon.addViewer({ ttlMs: 60_000 });
    const frag = `#${v.link.split("#")[1]}`;
    // Downgrading to the old two-field form must not parse into a viewer that
    // believes whoever writes first.
    const stripped = frag.slice(0, frag.lastIndexOf("."));
    assert.equal(parseBeaconFragment(stripped), null);
    assert.ok(parseBeaconFragment(frag));
  } finally {
    g.restore();
  }
});

test("the beacon stops posting to a viewer whose link has expired", async () => {
  const g = stubGlobals();
  try {
    const beacon = await startBeacon();
    const live = await beacon.addViewer({ label: "live", ttlMs: 60_000 });
    const dying = await beacon.addViewer({ label: "dying", ttlMs: 1 });
    await sleep(5);

    await beacon.send({ t: "sos", lat: 44.98, lon: -93.27 });
    const dyingChan = await deriveHelpChannelId(parseBeaconFragment(`#${dying.link.split("#")[1]}`).secret);
    const liveChan = await deriveHelpChannelId(parseBeaconFragment(`#${live.link.split("#")[1]}`).secret);
    assert.equal(g.posts.filter((p) => p.url.includes(dyingChan)).length, 0, "nothing lands after the deadline");
    assert.equal(g.posts.filter((p) => p.url.includes(liveChan)).length, 1, "the other viewer is unaffected");

    const listed = beacon.list();
    assert.equal(listed.find((x) => x.label === "dying").expired, true);
    assert.equal(listed.find((x) => x.label === "live").expired, false);

    // Still nothing on the next position either.
    await beacon.send({ t: "loc", lat: 45, lon: -93 });
    assert.equal(g.posts.filter((p) => p.url.includes(dyingChan)).length, 0);
  } finally {
    g.restore();
  }
});

test("a revoked viewer gets a goodbye and then nothing", async () => {
  const g = stubGlobals();
  try {
    const beacon = await startBeacon();
    const v = await beacon.addViewer({ ttlMs: 60_000 });
    const chan = await deriveHelpChannelId(parseBeaconFragment(`#${v.link.split("#")[1]}`).secret);
    await beacon.send({ t: "sos", lat: 44.98, lon: -93.27 });
    await beacon.revokeViewer(v.id);
    const afterBye = g.posts.filter((p) => p.url.includes(chan)).length;
    assert.equal(afterBye, 2, "one position and one goodbye");

    await beacon.send({ t: "loc", lat: 45, lon: -93 });
    assert.equal(g.posts.filter((p) => p.url.includes(chan)).length, afterBye, "revoked means no more writes");
  } finally {
    g.restore();
  }
});


test("ending an emergency tells every live viewer, not just cancels them", async () => {
  // The bug this pins: end() marked a viewer revoked and THEN asked live(),
  // which itself checks !revoked, so the answer was always no and every
  // viewer was cancelled silently. A helper watching a real SOS was left with
  // a position that just went stale, which reads as "still in trouble" rather
  // than "safe". The end-to-end run with a third browser as the helper is what
  // surfaced it, so this asks the same question: does a bye actually land.
  const g = stubGlobals();
  try {
    const beacon = await startBeacon();
    const one = await beacon.addViewer({ label: "one" });
    const two = await beacon.addViewer({ label: "two" });
    await beacon.send({ lat: 1, lon: 2 });
    g.posts.length = 0;

    await beacon.end();

    const channelOf = async (v) => deriveHelpChannelId(parseBeaconFragment(new URL(v.link).hash).secret);
    const wanted = new Set(await Promise.all([one, two].map(channelOf)));
    const hit = new Set(g.posts.map((p) => p.url.split("/f/")[1].split("/")[0]));
    for (const c of wanted) assert.ok(hit.has(c), `a goodbye reached the viewer on ${c.slice(0, 8)}`);
    assert.equal(hit.size, 2, "both live viewers were told, not zero and not one");
  } finally {
    g.restore();
  }
});
