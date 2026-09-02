// The poll loop and the authenticated sender.
//
// The cursor is the relay's own receive time, never a client's claimed ts, so
// one member's skewed clock cannot filter another member's honest points out of
// the feed. Points the relay re-delivers because the srv filter is inclusive
// must not reach the roster twice.
import test from "node:test";
import assert from "node:assert/strict";

import {
  createPoller,
  createSender,
  createRoster,
  windowStart,
  statusOf,
  sortMembers,
  STALE_MS,
} from "../app/js/net.js";
import { openGeneration } from "../app/js/rekey.js";
import { generateIdentity, newSeed, sealMessage, buildPost } from "../app/js/crypto.js";
import { EPOCH_MS, epochAt } from "../app/js/ratchet.js";
import { MEMBER_CAP, TTL_MS, memberIdFromKeys, b64uEncode } from "../app/js/wire.js";

const A = "a".repeat(32);
const B = "b".repeat(32);
const CHANNEL = "c".repeat(32);
const E0 = 2980471;
const at = (e) => e * EPOCH_MS;

function stubGlobals(responses, calls) {
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, "document");
  const prevFetch = globalThis.fetch;
  globalThis.document = {
    visibilityState: "visible",
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (typeof r === "function") return r(calls.length - 1);
    return { ok: true, status: 200, json: async () => r };
  };
  return () => {
    if (prevDoc) Object.defineProperty(globalThis, "document", prevDoc);
    else delete globalThis.document;
    globalThis.fetch = prevFetch;
  };
}

const sinceOf = (url) => Number(new URL(url, "http://x").searchParams.get("since"));
const entry = (m, points) => ({ m, alg: "ed25519", pk: "pk", epk: "epk", points });

// A poller run over a fixed list of responses, returning what reached the
// roster on each poll and every URL that was fetched.
async function run(responses, opts = {}) {
  const calls = [];
  const restore = stubGlobals(responses, calls);
  const polls = [];
  const roster = {
    async ingest(entries) {
      polls.push(entries.flatMap((e) => e.points.map((p) => `${e.m}|${p.n}`)));
    },
  };
  const events = [];
  const poller = createPoller({
    channelId: CHANNEL,
    roster,
    onChange() {},
    onStatus: (s) => events.push(s),
    onRetired: () => events.push("retired"),
    ...opts,
  });
  try {
    poller.start();
    await new Promise((r) => setTimeout(r, 20));
    for (let i = 1; i < responses.length; i++) {
      await poller.pollNow();
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    poller.stop();
    restore();
  }
  return { calls, urls: calls.map((c) => c.url), polls, events };
}

test("the cursor pages on server receive time, so a late point is still delivered", async () => {
  // A point can reach the relay late with a client ts behind the poll cursor.
  // Paging on srv delivers it anyway; paging on client ts would have dropped it
  // forever.
  const T = 3_000_000_000;
  const { urls, polls } = await run([
    { now: T + 200, members: [entry(A, [{ e: E0, ts: T, srv: T + 100, n: "an1", c: "ac1" }])] },
    // ts is 5 s BEHIND the first point, but srv is later: it arrived late.
    { now: T + 400, members: [entry(A, [{ e: E0, ts: T - 5_000, srv: T + 300, n: "an2", c: "ac2" }])] },
    { now: T + 600, members: [] },
  ]);
  assert.equal(sinceOf(urls[0]), 0);
  assert.equal(sinceOf(urls[1]), T + 100);
  assert.equal(sinceOf(urls[2]), T + 300);
  assert.deepEqual(polls[0], [`${A}|an1`]);
  assert.deepEqual(polls[1], [`${A}|an2`]);
});

test("a member with a fast clock cannot push the cursor or starve anyone", async () => {
  const T = 1_000_000_000;
  const { urls, polls } = await run([
    {
      now: T,
      members: [
        // B claims a ts eight minutes in the future. srv is what the relay saw.
        entry(B, [{ e: E0 + 1, ts: T + 480_000, srv: T, n: "bn1", c: "bc1" }]),
        entry(A, [{ e: E0, ts: T, srv: T, n: "an1", c: "ac1" }]),
      ],
    },
    {
      now: T + 10_000,
      members: [
        entry(B, [{ e: E0 + 1, ts: T + 480_000, srv: T, n: "bn1", c: "bc1" }]),
        entry(A, [{ e: E0, ts: T + 5_000, srv: T + 5_000, n: "an2", c: "ac2" }]),
      ],
    },
    { now: T + 20_000, members: [] },
  ]);
  // The cursor followed srv, not B's claimed ts.
  assert.equal(sinceOf(urls[1]), T);
  assert.equal(sinceOf(urls[2]), T + 5_000);
  assert.deepEqual([...polls[0]].sort(), [`${A}|an1`, `${B}|bn1`]);
  // A is not starved by B's clock, and B's already-seen point is not handed to
  // the roster a second time.
  assert.deepEqual(polls[1], [`${A}|an2`]);
  assert.deepEqual(polls[2], []);
});

test("the boundary millisecond is refetched and deduped, never lost", async () => {
  // The srv filter is inclusive, so the relay re-serves everything that landed
  // in the cursor's own millisecond. The poller drops the repeats by
  // member+epoch+ts+nonce rather than moving the cursor past them.
  const T = 4_000_000_000;
  const dup = { e: E0, ts: T, srv: T, n: "an1", c: "ac1" };
  const { urls, polls } = await run([
    { now: T, members: [entry(A, [dup])] },
    { now: T + 10, members: [entry(A, [dup, { e: E0, ts: T + 1, srv: T, n: "an2", c: "ac2" }])] },
    { now: T + 20, members: [entry(A, [dup])] },
  ]);
  assert.equal(sinceOf(urls[1]), T, "the cursor does not skip past the boundary");
  assert.equal(sinceOf(urls[2]), T);
  assert.deepEqual(polls[0], [`${A}|an1`]);
  assert.deepEqual(polls[1], [`${A}|an2`], "only the new point crosses");
  assert.deepEqual(polls[2], []);
});

test("the cursor never goes backwards, even if the relay serves older rows", async () => {
  const T = 5_000_000_000;
  const { urls } = await run([
    { now: T, members: [entry(A, [{ e: E0, ts: T, srv: T + 500, n: "n1", c: "c1" }])] },
    { now: T, members: [entry(A, [{ e: E0, ts: T, srv: T - 9_000, n: "n2", c: "c2" }])] },
    { now: T, members: [] },
  ]);
  assert.equal(sinceOf(urls[1]), T + 500);
  assert.equal(sinceOf(urls[2]), T + 500);
});

test("a 410 retires the client instead of letting it sync into silence", async () => {
  // v1 and v2 derive different channel ids from the same circle, so an
  // out-of-date client would otherwise poll an empty channel forever with no
  // signal that anything was wrong.
  const calls = [];
  const restore = stubGlobals(
    [() => ({ ok: false, status: 410, json: async () => ({ error: "protocol v1 retired" }) })],
    calls,
  );
  const events = [];
  const poller = createPoller({
    channelId: CHANNEL,
    roster: { async ingest() {} },
    onChange() {},
    onStatus: (s) => events.push(s),
    onRetired: () => events.push("retired"),
  });
  try {
    poller.start();
    await new Promise((r) => setTimeout(r, 30));
    await poller.pollNow();
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    poller.stop();
    restore();
  }
  assert.ok(events.includes("retired"));
  assert.equal(calls.length, 1, "it stops polling rather than hammering a dead endpoint");
});

test("one failure is a blip, two in a row is worth showing", async () => {
  const calls = [];
  const restore = stubGlobals(
    [
      () => { throw new Error("offline"); },
      () => { throw new Error("offline"); },
      () => ({ ok: true, status: 200, json: async () => ({ now: 1, members: [] }) }),
    ],
    calls,
  );
  const events = [];
  const poller = createPoller({
    channelId: CHANNEL,
    roster: { async ingest() {} },
    onChange() {},
    onStatus: (s) => events.push(s),
  });
  try {
    poller.start();
    await new Promise((r) => setTimeout(r, 20));
    // A single miss says nothing: the poll runs every ten seconds and a phone
    // drops one all the time.
    assert.deepEqual(events, []);

    await poller.pollNow();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(events, ["reconnecting"]);

    await poller.pollNow();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(events, ["reconnecting", "ok"], "and the recovery is reported");
  } finally {
    poller.stop();
    restore();
  }
  assert.equal(events.at(-1), "idle", "stopping says so");
});

test("windowStart never fetches further back than the keys reach", async () => {
  const gen = await openGeneration({ seed: newSeed(), g: 0, e0: E0, historyEpochs: 6 });
  await gen.ratchet.syncToClock(at(E0 + 20));
  const oldest = gen.ratchet.retainedEpochs()[0];
  assert.equal(oldest, E0 + 15);
  assert.equal(windowStart(gen.ratchet, at(E0 + 20)), at(oldest));
  // A point older than the window cannot be decrypted, so there is no reason to
  // pull it down at all.
  assert.ok(windowStart(gen.ratchet, at(E0 + 20)) > at(E0));
  // And the cursor never runs ahead of now.
  assert.equal(windowStart(gen.ratchet, 0), 0);
  assert.equal(windowStart({ retainedEpochs: () => [] }), 0);
});

test("the poller starts its cursor at the window, not at zero", async () => {
  // Points older than the history window cannot be decrypted, so there is no
  // reason to pull them down. The epochs here are anchored to the real clock
  // because the poller reads Date.now() for its own starting cursor.
  const head = epochAt(Date.now());
  const gen = await openGeneration({ seed: newSeed(), g: 0, e0: head - 30, historyEpochs: 6 });
  await gen.ratchet.syncToClock(Date.now());
  const oldest = gen.ratchet.retainedEpochs()[0];
  assert.equal(oldest, head - 5);

  const calls = [];
  const restore = stubGlobals([{ now: 0, members: [] }], calls);
  const poller = createPoller({
    channelId: CHANNEL,
    roster: { async ingest() {} },
    ratchet: gen.ratchet,
    onChange() {},
    onStatus() {},
  });
  try {
    poller.start();
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    poller.stop();
    restore();
  }
  assert.equal(sinceOf(calls[0].url), at(oldest));
  assert.ok(sinceOf(calls[0].url) > 0);
});

// --- the sender ------------------------------------------------------------

async function senderRig(over = {}) {
  const identity = await generateIdentity();
  const gen = await openGeneration({ seed: newSeed(), g: 0, e0: E0, historyEpochs: 6 });
  let lastTs = 0;
  const calls = [];
  const sender = createSender({
    identity,
    channelId: gen.channelId,
    ratchet: gen.ratchet,
    getLastTs: async () => lastTs,
    setLastTs: async (ts) => {
      lastTs = ts;
    },
    ...over,
  });
  return { identity, gen, sender, calls, lastTs: () => lastTs };
}

test("outgoing ts is strictly monotonic even when the clock steps backwards", async () => {
  const rig = await senderRig();
  const restore = stubGlobals([{ ok: true }], rig.calls);
  try {
    const first = await rig.sender.send({ t: "loc", lat: 1, lon: 2 });
    // A clock that jumps back must not repeat a ts: the nonce counter is the ts,
    // and repeating one under the same key is the failure GCM cannot survive.
    const realNow = Date.now;
    Date.now = () => first - 60_000;
    try {
      const second = await rig.sender.send({ t: "loc", lat: 1, lon: 2 });
      assert.ok(second > first, "the second ts is still greater");
      assert.equal(second, first + 1);
    } finally {
      Date.now = realNow;
    }
  } finally {
    restore();
  }
  assert.equal(rig.calls.length, 2);
  for (const call of rig.calls) {
    assert.match(call.url, /\/api\/v2\/f\/[0-9a-f]{32}\/loc$/);
    assert.equal(call.init.method, "POST");
    const body = JSON.parse(call.init.body);
    assert.equal(body.m, rig.identity.memberId);
    assert.equal(typeof body.e, "number");
  }
});

test("a relay clock rejection is reported as a clock problem, not a network one", async () => {
  // A device whose clock is out by more than the skew tolerance is invisible to
  // its circle. Someone relying on being visible has to be told that in those
  // words rather than shown "reconnecting".
  const rig = await senderRig();
  const restore = stubGlobals(
    [() => ({ ok: false, status: 400, json: async () => ({ error: "clock" }) })],
    rig.calls,
  );
  try {
    await assert.rejects(rig.sender.send({ t: "loc" }), (e) => e.code === "clock" && /clock is wrong/.test(e.message));
  } finally {
    restore();
  }

  const rig2 = await senderRig();
  const restore2 = stubGlobals([() => ({ ok: false, status: 500, json: async () => ({}) })], rig2.calls);
  try {
    await assert.rejects(rig2.sender.send({ t: "loc" }), (e) => e.code === undefined && /post 500/.test(e.message));
  } finally {
    restore2();
  }
});

test("cancel stops queued sends, so a rotation can guarantee an empty old channel", async () => {
  const rig = await senderRig();
  const restore = stubGlobals([{ ok: true }], rig.calls);
  try {
    rig.sender.cancel();
    await assert.rejects(rig.sender.send({ t: "loc" }), /sender cancelled/);
    assert.equal(rig.calls.length, 0, "nothing else lands on the channel we walked away from");
  } finally {
    restore();
  }
});

test("the sender refuses to send into an epoch it has no key for", async () => {
  const gen = await openGeneration({ seed: newSeed(), g: 0, e0: E0, historyEpochs: 6 });
  gen.ratchet.destroy();
  const rig = await senderRig();
  const dead = createSender({
    identity: rig.identity,
    channelId: gen.channelId,
    ratchet: gen.ratchet,
    getLastTs: async () => 0,
    setLastTs: async () => {},
  });
  const restore = stubGlobals([{ ok: true }], rig.calls);
  try {
    await assert.rejects(dead.send({ t: "loc" }), /no key for epoch/);
    assert.equal(rig.calls.length, 0);
  } finally {
    restore();
  }
});

// --- status ranking --------------------------------------------------------

test("statusOf and sortMembers rank an SOS above everything", () => {
  const now = 1_000_000;
  assert.equal(statusOf({ type: "bye", ts: now }, now), "stopped");
  assert.equal(statusOf({ type: "sos", ts: now }, now), "sos");
  assert.equal(statusOf({ type: "checkin", ts: now }, now), "checkin");
  assert.equal(statusOf({ type: "loc", ts: now }, now), "live");
  assert.equal(statusOf({ type: "loc", ts: now - STALE_MS - 1 }, now), "stale");
  // A bye is a stop even if it just arrived, and a stale sos is still stale.
  assert.equal(statusOf({ type: "bye", ts: now - STALE_MS - 1 }, now), "stopped");
  assert.equal(statusOf({ type: "sos", ts: now - STALE_MS - 1 }, now), "stale");

  const list = [
    { id: "stale", type: "loc", ts: now - STALE_MS - 1 },
    { id: "stopped", type: "bye", ts: now },
    { id: "live-old", type: "loc", ts: now - 1000 },
    { id: "sos", type: "sos", ts: now - 2000 },
    { id: "live-new", type: "loc", ts: now },
  ];
  assert.deepEqual(
    sortMembers(list, now).map((m) => m.id),
    ["sos", "live-new", "live-old", "stale", "stopped"],
  );
  assert.equal(list[0].id, "stale", "the input list is not reordered in place");
});

// --- createRoster: the fixes from the review --------------------------------
//
// These cover what an unauthenticated field on the wire, an untrusted relay's
// cap, and a bare `me` gap all cost when a review found them for real.

const RE0 = 2980471;
const rAt = (e) => e * EPOCH_MS;
const RSELF = "0".repeat(32);

// One circle, two views of it, same shape as roster.test.mjs's fixture: the
// sender's generation and the receiver's, both derived from the same seed.
async function circle({ historyEpochs = 200 } = {}) {
  const seed = newSeed();
  const send = await openGeneration({ seed: new Uint8Array(seed), g: 0, e0: RE0, historyEpochs });
  const recv = await openGeneration({ seed: new Uint8Array(seed), g: 0, e0: RE0, historyEpochs });
  return { send, recv, channelId: send.channelId };
}

const rosterFor = (c, opts = {}) =>
  createRoster({ channelId: c.channelId, ratchet: c.recv.ratchet, selfId: RSELF, pinned: new Map(), ...opts });

const pinnedWith = (...ids) =>
  new Map(ids.map((i) => [i.memberId, { alg: i.alg, pk: b64uEncode(i.pk), epk: b64uEncode(i.epk), verified: false }]));

async function rPoint(c, identity, e, ts, msg) {
  const key = await c.send.ratchet.keyFor(e, identity.memberId, rAt(e));
  const sealed = await sealMessage(key, c.channelId, identity.memberId, e, ts, msg);
  const post = await buildPost(identity, c.channelId, e, sealed, ts);
  return { e: post.e, ts: post.ts, srv: post.ts, n: post.n, c: post.c, sig: post.sig };
}

async function entryFor(c, identity, msgs) {
  const points = [];
  for (const { e, msg } of msgs) points.push(await rPoint(c, identity, e, msg.ts, msg));
  return {
    m: identity.memberId,
    alg: identity.alg,
    pk: b64uEncode(identity.pk),
    epk: b64uEncode(identity.epk),
    points,
  };
}

const rLoc = (ts, extra = {}) => ({ v: 2, t: "loc", ts, lat: 44.98, lon: -93.27, ...extra });

test("the wire's alg field is ignored: flipping it neither breaks ingestion nor erases the member", async () => {
  // alg used to be read straight off the relay's response and compared
  // against the pinned value, so flipping it looked exactly like a key
  // change: the point was dropped as onKeyChange, and because that happens
  // before the member's position is ever refreshed, enough flipped posts in a
  // row age the record out through the ordinary TTL sweep. The safety number
  // could never catch this because it does not cover alg either.
  const c = await circle();
  const alice = await generateIdentity();
  const t0 = rAt(RE0) + 1000;
  const changes = [];
  const roster = rosterFor(c, { onKeyChange: (id, keys) => changes.push([id, keys]) });

  await roster.ingest([await entryFor(c, alice, [{ e: RE0, msg: rLoc(t0) }])], t0);
  assert.ok(roster.get(alice.memberId), "first sight pins and lands the point");

  // Long enough later that an unrefreshed record would have aged out of the
  // TTL sweep, carrying a feed entry whose `alg` a relay has corrupted.
  const t1 = t0 + TTL_MS + 5000;
  const laterEpoch = epochAt(t1);
  const flipped = await entryFor(c, alice, [{ e: laterEpoch, msg: rLoc(t1, { lat: 1 }) }]);
  flipped.alg = flipped.alg === "ed25519" ? "p256" : "ed25519";
  await roster.ingest([flipped], t1);

  assert.equal(changes.length, 0, "the algorithm is derived from the key, so nothing here is a key change");
  const rec = roster.get(alice.memberId);
  assert.ok(rec, "the member must not be erased from the map by a field the relay does not even sign");
  assert.equal(rec.ts, t1, "and the position keeps updating");
});

test("createRoster enforces MEMBER_CAP itself, even when a relay offers more", async () => {
  const c = await circle();
  const now = rAt(RE0) + 1000;
  const pinned = new Map();
  const roster = createRoster({ channelId: c.channelId, ratchet: c.recv.ratchet, selfId: RSELF, pinned });

  const identities = [];
  for (let i = 0; i < MEMBER_CAP + 5; i++) identities.push(await generateIdentity());
  const entries = [];
  for (const id of identities) entries.push(await entryFor(c, id, [{ e: RE0, msg: rLoc(now) }]));

  await roster.ingest(entries, now);
  // MEMBER_CAP - 1, not MEMBER_CAP. The relay allows MEMBER_CAP rows per
  // channel and this device holds one of them, so a roster of MEMBER_CAP
  // OTHERS is one no honest relay could ever serve. The receiver was a seat
  // looser than the relay it does not trust.
  assert.equal(
    pinned.size,
    MEMBER_CAP - 1,
    "a relay offering more fabricated members cannot grow the pinned roster past the seats that exist",
  );
  assert.ok(roster.list().length <= MEMBER_CAP - 1);
});

test("a malformed agreement key is refused before it is ever pinned", async () => {
  // Right length for a raw P-256 point (65 bytes) but not a point on the
  // curve at all: importKey has to fail on it. A pinned malformed epk broke
  // re-keying for the whole circle the moment anyone tried to seal to it.
  const c = await circle();
  const alice = await generateIdentity();
  const now = rAt(RE0) + 1000;
  const badEpk = new Uint8Array(65).fill(0x02);
  const badId = await memberIdFromKeys(alice.pk, badEpk);

  const pinned = new Map();
  const roster = createRoster({ channelId: c.channelId, ratchet: c.recv.ratchet, selfId: RSELF, pinned });
  await roster.ingest(
    [{ m: badId, alg: alice.alg, pk: b64uEncode(alice.pk), epk: b64uEncode(badEpk), points: [] }],
    now,
  );

  assert.equal(pinned.size, 0, "a malformed epk must never be pinned");
  assert.equal(roster.list().length, 0);
});

test("a relay serving a later position first cannot permanently bury an earlier re-key", async () => {
  // Control messages dedup on their own bounded (member, epoch, ts) set now,
  // separate from the position high-water mark. Sharing the mark used to let
  // an untrusted relay serve a later position first, push the mark past a
  // re-key's (epoch, ts), and have that re-key rejected forever when it
  // finally arrived.
  const c = await circle();
  const alice = await generateIdentity();
  const t0 = rAt(RE0) + 1000; // the re-key: earlier
  const t5 = rAt(RE0 + 5) + 1000; // an ordinary position: later
  const control = [];
  const roster = rosterFor(c, {
    pinned: pinnedWith(alice),
    onControl: (from, obj) => control.push([from, obj.t, obj.ts]),
  });

  await roster.ingest([await entryFor(c, alice, [{ e: RE0 + 5, msg: rLoc(t5) }])], t5);
  assert.ok(roster.get(alice.memberId), "the later position lands first");

  const rekeyEntry = await entryFor(c, alice, [
    { e: RE0, msg: { v: 2, t: "rekey", ts: t0, g: 1, to: RSELF, rm: [] } },
  ]);
  await roster.ingest([rekeyEntry], t5);
  assert.equal(control.length, 1, "the earlier re-key must still be delivered even though it is behind the position mark");

  await roster.ingest([structuredClone(rekeyEntry)], t5);
  assert.equal(control.length, 1, "but a replay of it is not delivered again");
});

test("an idle poller still advances the chain: syncToClock runs on every tick", async () => {
  // A device that only listens must still forget the past on schedule.
  // Otherwise forward secrecy quietly stops the moment nobody is sending.
  const syncCalls = [];
  const ratchet = {
    syncToClock: async () => {
      syncCalls.push(1);
      return 0;
    },
    retainedEpochs: () => [],
  };
  await run(
    [
      { now: 0, members: [] },
      { now: 0, members: [] },
      { now: 0, members: [] },
    ],
    { ratchet },
  );
  assert.equal(syncCalls.length, 3, "syncToClock ran on every tick, including the ticks nothing arrived on");
});
