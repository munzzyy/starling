// Poll cursor behavior: one member's future-skewed clock must not starve the
// other members' updates, and points the relay re-delivers because of the
// clamped cursor must not be ingested twice.
import test from "node:test";
import assert from "node:assert/strict";

import { createPoller } from "../app/js/net.js";

const A = "a".repeat(32);
const B = "b".repeat(32);
const CHANNEL = "c".repeat(32);

function stubGlobals(responses, urls) {
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, "document");
  const prevFetch = globalThis.fetch;
  globalThis.document = {
    visibilityState: "visible",
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const body = responses[Math.min(urls.length - 1, responses.length - 1)];
    return { ok: true, json: async () => body };
  };
  return () => {
    if (prevDoc) Object.defineProperty(globalThis, "document", prevDoc);
    else delete globalThis.document;
    globalThis.fetch = prevFetch;
  };
}

const sinceOf = (url) => Number(new URL(url, "http://x").searchParams.get("since"));

test("a member clock 8 min fast cannot push the cursor past server now or starve others", async () => {
  const T = 1_000_000_000;
  // Poll 1: B claims ts 8 min in the future, A posts an honest ts = T.
  // Poll 2: the relay (filtering ts > since) re-delivers B's future point and
  // A's next honest point. Poll 3: nothing new.
  const responses = [
    {
      now: T,
      members: [
        { m: B, alg: "ed25519", pk: "pkb", points: [{ ts: T + 480_000, n: "bn1", c: "bc1" }] },
        { m: A, alg: "ed25519", pk: "pka", points: [{ ts: T, n: "an1", c: "ac1" }] },
      ],
    },
    {
      now: T + 10_000,
      members: [
        { m: B, alg: "ed25519", pk: "pkb", points: [{ ts: T + 480_000, n: "bn1", c: "bc1" }] },
        { m: A, alg: "ed25519", pk: "pka", points: [{ ts: T + 5_000, n: "an2", c: "ac2" }] },
      ],
    },
    { now: T + 20_000, members: [] },
  ];
  const urls = [];
  const restore = stubGlobals(responses, urls);
  const polls = [];
  const roster = {
    async ingest(entries) {
      polls.push(entries.flatMap((e) => e.points.map((p) => `${e.m}|${p.n}`)));
    },
  };
  const poller = createPoller({ channelId: CHANNEL, roster, onChange() {}, onStatus() {} });
  try {
    poller.start();
    await new Promise((r) => setTimeout(r, 20));
    await poller.pollNow();
    await new Promise((r) => setTimeout(r, 20));
    await poller.pollNow();
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    poller.stop();
    restore();
  }

  assert.equal(urls.length, 3);
  assert.equal(sinceOf(urls[0]), 0);
  // The cursor is clamped to poll 1's server now, not B's future ts.
  assert.equal(sinceOf(urls[1]), T);
  assert.equal(sinceOf(urls[2]), T + 10_000);
  // The cursor never exceeds the server clock reported by the prior response.
  assert.ok(sinceOf(urls[1]) <= responses[0].now);
  assert.ok(sinceOf(urls[2]) <= responses[1].now);

  // Poll 1 ingested both members' points.
  assert.deepEqual([...polls[0]].sort(), [`${A}|an1`, `${B}|bn1`]);
  // Poll 2 still ingested A's next point (A is not starved by B's fast
  // clock), and did not hand B's already-seen point to the roster again.
  assert.deepEqual(polls[1], [`${A}|an2`]);
  assert.deepEqual(polls[2], []);
});

test("a response without a server clock falls back to paging on max seen ts", async () => {
  const T = 2_000_000_000;
  const responses = [
    { members: [{ m: A, alg: "ed25519", pk: "pka", points: [{ ts: T, n: "an1", c: "ac1" }] }] },
    { members: [] },
  ];
  const urls = [];
  const restore = stubGlobals(responses, urls);
  const roster = { async ingest() {} };
  const poller = createPoller({ channelId: CHANNEL, roster, onChange() {}, onStatus() {} });
  try {
    poller.start();
    await new Promise((r) => setTimeout(r, 20));
    await poller.pollNow();
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    poller.stop();
    restore();
  }
  assert.equal(sinceOf(urls[0]), 0);
  assert.equal(sinceOf(urls[1]), T);
});

test("pages on server receive time so a late point behind the cursor is still delivered", async () => {
  // The residual the review flagged: a point can reach the relay late with a
  // client ts behind the poll cursor. Paging on srv (server receive time)
  // delivers it anyway; paging on client ts would have dropped it forever.
  const T = 3_000_000_000;
  const responses = [
    {
      now: T + 200,
      members: [{ m: A, alg: "ed25519", pk: "pka", points: [{ ts: T, srv: T + 100, n: "an1", c: "ac1" }] }],
    },
    {
      now: T + 400,
      members: [
        // ts is 5 s BEHIND the first point, but srv is later (arrived late).
        { m: A, alg: "ed25519", pk: "pka", points: [{ ts: T - 5_000, srv: T + 300, n: "an2", c: "ac2" }] },
      ],
    },
    { now: T + 600, members: [] },
  ];
  const urls = [];
  const restore = stubGlobals(responses, urls);
  const polls = [];
  const roster = {
    async ingest(entries) {
      polls.push(entries.flatMap((e) => e.points.map((p) => `${e.m}|${p.n}`)));
    },
  };
  const poller = createPoller({ channelId: CHANNEL, roster, onChange() {}, onStatus() {} });
  try {
    poller.start();
    await new Promise((r) => setTimeout(r, 20));
    await poller.pollNow();
    await new Promise((r) => setTimeout(r, 20));
    await poller.pollNow();
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    poller.stop();
    restore();
  }
  // Cursor pages on srv, not ts.
  assert.equal(sinceOf(urls[0]), 0);
  assert.equal(sinceOf(urls[1]), T + 100);
  assert.equal(sinceOf(urls[2]), T + 300);
  // The late, ts-behind point was still delivered to the roster.
  assert.deepEqual(polls[0], [`${A}|an1`]);
  assert.deepEqual(polls[1], [`${A}|an2`]);
});
