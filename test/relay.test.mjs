// Relay contract tests: the worker runs in-process against the D1 shim, which
// executes the real SQL from relay/schema.sql on node:sqlite, and every post is
// built with the real device-side crypto from app/js/crypto.js.
//
// The relay is untrusted by design. Everything it checks here is also checked
// by receivers; it does these to keep junk out of storage, not because anyone
// relies on the answer. What it must never do is store something a receiver
// would then have to reject, or lose something a receiver needs.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../relay/src/index.js";
import { makeD1 } from "./d1shim.mjs";
import {
  MAX_BODY,
  MEMBER_CAP,
  TRAIL_CAP,
  TTL_MS,
  FUTURE_SKEW_MS,
  MAX_SKEW_EPOCHS,
  b64uEncode,
  b64uDecode,
  memberIdFromKeys,
} from "../app/js/wire.js";
import { EPOCH_MS, epochAt, chainInit, createRatchet } from "../app/js/ratchet.js";
import { openGeneration } from "../app/js/rekey.js";
import { newSeed, generateIdentity, sealMessage, buildPost, openMessage } from "../app/js/crypto.js";

const ORIGIN = "http://127.0.0.1:8899";

// Rate limits are per-isolate module state shared by every test in this file,
// so the shared env raises them out of the way; rate tests use fresh channels
// and fresh IPs with low limits.
function freshEnv(over = {}) {
  return { DB: makeD1(), RATE_POST_MIN: "1000000", RATE_GET_MIN: "1000000", ...over };
}

let ipN = 0;
const freshIp = () => `10.9.${Math.floor(ipN / 200)}.${(ipN++ % 200) + 1}`;

function req(env, path, { method = "GET", body, headers = {}, ip = "10.0.0.1" } = {}) {
  const init = { method, headers: { "cf-connecting-ip": ip, ...headers } };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
}

const postLoc = (env, channel, body, opts = {}) =>
  req(env, `/api/v2/f/${channel}/loc`, { method: "POST", body, ...opts });
const getFeed = (env, channel, qs = "", opts = {}) => req(env, `/api/v2/f/${channel}${qs}`, opts);

// One generation of one circle, wide enough that a test can post into any
// epoch it is going to reach.
async function makeCircle() {
  const gen = await openGeneration({
    seed: newSeed(),
    g: 0,
    e0: epochAt(Date.now()) - 1,
    historyEpochs: 144,
  });
  return { channel: gen.channelId, ratchet: gen.ratchet };
}

const msgAt = (ts, extra = {}) => ({ v: 2, t: "loc", ts, lat: 44.98, lon: -93.27, acc: 12, name: "A", ...extra });

async function validPost(circle, identity, ts, msg = msgAt(ts)) {
  const e = epochAt(ts);
  const key = await circle.ratchet.keyFor(e, identity.memberId, ts);
  assert.ok(key, `test setup: no content key for epoch ${e}`);
  const sealed = await sealMessage(key, circle.channel, identity.memberId, e, ts, msg);
  return buildPost(identity, circle.channel, e, sealed, ts);
}

// A properly signed post carrying an epoch index the relay's own clock will not
// believe. The key comes from a throwaway chain, because the relay never
// decrypts anything and a receiver would drop this on the epoch alone.
async function postWithEpoch(circle, identity, ts, e) {
  const throwaway = createRatchet({ e0: e, ck0: await chainInit(newSeed()), historyEpochs: 1 });
  const key = await throwaway.keyFor(e, identity.memberId, e * EPOCH_MS);
  const sealed = await sealMessage(key, circle.channel, identity.memberId, e, ts, msgAt(ts));
  return buildPost(identity, circle.channel, e, sealed, ts);
}

function snap(env) {
  const db = env.DB._raw;
  return {
    members: db.prepare("SELECT COUNT(*) AS n FROM members_v3").get().n,
    points: db.prepare("SELECT COUNT(*) AS n FROM points_v3").get().n,
  };
}

function assertJsonHeaders(res) {
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
}

async function assertRejected(env, promise, status, before) {
  const res = await promise;
  assert.equal(res.status, status);
  const body = await res.json();
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.equal(typeof body.error, "string");
  assert.deepEqual(snap(env), before, "a rejected request must write nothing");
  return res;
}

test("the shim runs the shipped schema, tables and all", () => {
  const env = freshEnv();
  const tables = env.DB._raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, ["members_v3", "points_v3"]);
  // The migration drops the v1 tables, so a redeploy over an old database
  // leaves nothing behind that still holds ciphertext under the old scheme.
  assert.ok(!tables.includes("points_v2"));
  const cols = (t) => env.DB._raw.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name);
  assert.deepEqual(cols("members_v3"), ["channel", "member", "alg", "pk", "epk", "last_ts", "srv"]);
  assert.deepEqual(cols("points_v3"), ["channel", "member", "e", "ts", "srv", "n", "c", "sig"]);
});

test("health responds with security headers", async () => {
  const env = freshEnv();
  const res = await req(env, "/api/v2/health");
  assert.equal(res.status, 200);
  assertJsonHeaders(res);
  assert.deepEqual(await res.json(), { ok: true });
});

test("v1 is retired with a 410 and an upgrade pointer, not with silence", async () => {
  // v1 and v2 derive different channel ids from the same circle, so a v1 client
  // would otherwise poll an empty channel forever with nothing to tell it why.
  const env = freshEnv();
  for (const p of [
    "/api/v1/health",
    "/api/v1/f/0123456789abcdef0123456789abcdef",
    "/api/v1/f/0123456789abcdef0123456789abcdef/loc",
    "/api/v1/anything",
  ]) {
    const res = await req(env, p);
    assert.equal(res.status, 410, p);
    assertJsonHeaders(res);
    const body = await res.json();
    assert.equal(body.error, "protocol v1 retired");
    assert.equal(body.upgrade, "https://starlingmap.app");
  }
  // A POST to a v1 path is retired too, and writes nothing.
  const before = snap(env);
  const res = await req(env, "/api/v1/f/x/loc", { method: "POST", body: {} });
  assert.equal(res.status, 410);
  assert.equal((await res.json()).error, "protocol v1 retired");
  assert.deepEqual(snap(env), before);
});

test("post then get round trip keeps fields intact and decryptable", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const id = await generateIdentity();
  const ts = Date.now();
  const msg = msgAt(ts, { name: "Cole", hue: 210 });
  const body = await validPost(circle, id, ts, msg);

  const res = await postLoc(env, circle.channel, body);
  assert.equal(res.status, 200);
  assertJsonHeaders(res);
  const posted = await res.json();
  assert.equal(posted.ok, true);
  assert.equal(typeof posted.now, "number");

  const feedRes = await getFeed(env, circle.channel);
  assert.equal(feedRes.status, 200);
  assertJsonHeaders(feedRes);
  const feed = await feedRes.json();
  assert.equal(feed.members.length, 1);
  const mem = feed.members[0];
  assert.equal(mem.m, id.memberId);
  assert.equal(mem.alg, id.alg);
  assert.equal(mem.pk, b64uEncode(id.pk));
  // The agreement key is pinned alongside the signing key, because the member
  // id commits to both and re-key material is sealed to the agreement key.
  assert.equal(mem.epk, b64uEncode(id.epk));
  assert.equal(mem.points.length, 1);
  assert.equal(mem.points[0].e, body.e, "the epoch travels with every point");
  assert.equal(mem.points[0].ts, ts);
  assert.equal(mem.points[0].n, body.n);
  assert.equal(mem.points[0].c, body.c);
  assert.equal(mem.points[0].sig, body.sig, "and so does the signature, so receivers verify for themselves");
  assert.equal(typeof mem.points[0].srv, "number");

  const key = await circle.ratchet.keyFor(mem.points[0].e, mem.m, ts);
  const opened = await openMessage(
    key,
    circle.channel,
    mem.m,
    mem.points[0].e,
    mem.points[0].ts,
    b64uDecode(mem.points[0].n),
    b64uDecode(mem.points[0].c),
  );
  assert.deepEqual(opened, msg);
});

test("points from two epochs come back with their own epoch indices", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const id = await generateIdentity();
  const now = Date.now();
  const earlier = now - EPOCH_MS;
  assert.equal((await postLoc(env, circle.channel, await validPost(circle, id, earlier))).status, 200);
  assert.equal((await postLoc(env, circle.channel, await validPost(circle, id, now))).status, 200);

  const feed = await (await getFeed(env, circle.channel)).json();
  const points = feed.members[0].points;
  assert.equal(points.length, 2);
  assert.deepEqual(points.map((p) => p.e), [epochAt(earlier), epochAt(now)]);
  assert.notEqual(points[0].e, points[1].e, "two epochs, two content keys, both stored");
});

test("multiple points come back ascending by ts", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const id = await generateIdentity();
  const base = Date.now();
  for (const dt of [0, 1, 2, 3]) {
    const res = await postLoc(env, circle.channel, await validPost(circle, id, base + dt));
    assert.equal(res.status, 200);
  }
  const feed = await (await getFeed(env, circle.channel)).json();
  const tss = feed.members[0].points.map((p) => p.ts);
  assert.deepEqual(tss, [base, base + 1, base + 2, base + 3]);
});

test("since pages on server receive time, not client ts", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const id = await generateIdentity();
  const base = Date.now();
  for (const dt of [0, 1, 2]) await postLoc(env, circle.channel, await validPost(circle, id, base + dt));

  const all = await (await getFeed(env, circle.channel, "?since=0")).json();
  const pts = all.members[0].points;
  assert.equal(pts.length, 3);
  for (const p of pts) assert.equal(typeof p.srv, "number");
  assert.ok(pts[0].srv <= pts[1].srv && pts[1].srv <= pts[2].srv);

  // Paging from the newest srv returns only boundary-ms points (inclusive
  // filter), and never anything with an earlier srv.
  const maxSrv = pts[2].srv;
  const tail = await (await getFeed(env, circle.channel, `?since=${maxSrv}`)).json();
  for (const p of tail.members[0].points) assert.ok(p.srv >= maxSrv);

  const empty = await (await getFeed(env, circle.channel, `?since=${maxSrv + 1}`)).json();
  assert.equal((empty.members[0]?.points || []).length, 0);
});

test("bad since values get 400", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  for (const bad of ["abc", "-1", "1.5", "1e999", "9007199254740993"]) {
    const res = await getFeed(env, circle.channel, `?since=${bad}`);
    assert.equal(res.status, 400, `since=${bad}`);
  }
});

test("second member joins and both are returned", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const a = await generateIdentity();
  const b = await generateIdentity();
  const ts = Date.now();
  assert.equal((await postLoc(env, circle.channel, await validPost(circle, a, ts))).status, 200);
  assert.equal((await postLoc(env, circle.channel, await validPost(circle, b, ts + 1))).status, 200);

  const feed = await (await getFeed(env, circle.channel)).json();
  assert.equal(feed.members.length, 2);
  assert.deepEqual(feed.members.map((m) => m.m).sort(), [a.memberId, b.memberId].sort());
  for (const mem of feed.members) assert.equal(mem.points.length, 1);
});

test("channels are isolated", async () => {
  const env = freshEnv();
  const circleA = await makeCircle();
  const circleB = await makeCircle();
  const a = await generateIdentity();
  const b = await generateIdentity();
  const ts = Date.now();
  await postLoc(env, circleA.channel, await validPost(circleA, a, ts));
  await postLoc(env, circleB.channel, await validPost(circleB, b, ts));

  const feedA = await (await getFeed(env, circleA.channel)).json();
  assert.deepEqual(feedA.members.map((m) => m.m), [a.memberId]);
  const feedB = await (await getFeed(env, circleB.channel)).json();
  assert.deepEqual(feedB.members.map((m) => m.m), [b.memberId]);
});

test("unknown channel with valid format is 200 and empty", async () => {
  const env = freshEnv();
  const res = await getFeed(env, "0123456789abcdef0123456789abcdef");
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).members, []);
});

test("malformed channel ids are 404", async () => {
  const env = freshEnv();
  const before = snap(env);
  for (const bad of ["zz", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef0123456789abcde", "x".repeat(32)]) {
    await assertRejected(env, getFeed(env, bad), 404, before);
    await assertRejected(env, postLoc(env, bad, { m: "x" }), 404, before);
  }
});

test("wrong methods are 405", async () => {
  const env = freshEnv();
  const chan = "0123456789abcdef0123456789abcdef";
  const before = snap(env);
  await assertRejected(env, req(env, "/api/v2/health", { method: "POST", body: {} }), 405, before);
  await assertRejected(env, req(env, `/api/v2/f/${chan}`, { method: "POST", body: {} }), 405, before);
  await assertRejected(env, req(env, `/api/v2/f/${chan}/loc`, { method: "GET" }), 405, before);
  await assertRejected(env, req(env, `/api/v2/f/${chan}/loc`, { method: "DELETE" }), 405, before);
});

test("unknown paths are 404", async () => {
  const env = freshEnv();
  const before = snap(env);
  const paths = [
    "/", "/api", "/api/v2", "/api/v2/nope", "/api/v2/f", "/api/v2/f/",
    "/api/v3/health", "/api/v2/f/0123456789abcdef0123456789abcdef/loc/extra",
  ];
  for (const p of paths) {
    const res = await assertRejected(env, req(env, p), 404, before);
    assertJsonHeaders(res);
  }
});

test("body over MAX_BODY is 413 and writes nothing", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const before = snap(env);
  await assertRejected(env, postLoc(env, circle.channel, "x".repeat(MAX_BODY + 1)), 413, before);
});

test("non-JSON body is 400 and writes nothing", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const before = snap(env);
  await assertRejected(env, postLoc(env, circle.channel, "not json {"), 400, before);
  await assertRejected(env, postLoc(env, circle.channel, ""), 400, before);
});

test("shape rejects are 400 and write nothing", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const id = await generateIdentity();
  const ok = await validPost(circle, id, Date.now());
  const before = snap(env);

  const variants = [
    { ...ok, m: ok.m.slice(0, 31) },
    { ...ok, m: ok.m.toUpperCase() },
    { ...ok, alg: "rsa" },
    { ...ok, pk: "A".repeat(91) },
    { ...ok, epk: "A".repeat(91) },
    { ...ok, e: -1 },
    { ...ok, e: 1.5 },
    { ...ok, e: "2980471" },
    { ...ok, n: ok.n + "!" },
    { ...ok, c: "A".repeat(721) },
    { ...ok, sig: "" },
    { ...ok, ts: -5 },
    { ...ok, ts: 1.5 },
    (() => { const v = { ...ok }; delete v.sig; return v; })(),
    (() => { const v = { ...ok }; delete v.pk; return v; })(),
    (() => { const v = { ...ok }; delete v.epk; return v; })(),
    (() => { const v = { ...ok }; delete v.e; return v; })(),
    [ok],
    "null",
  ];
  for (const v of variants) {
    await assertRejected(env, postLoc(env, circle.channel, v), 400, before);
  }
});

test("member-id binding is recomputed from BOTH keys and must match", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const a = await generateIdentity();
  const b = await generateIdentity();
  const body = await validPost(circle, a, Date.now());
  const before = snap(env);

  await assertRejected(env, postLoc(env, circle.channel, { ...body, m: b.memberId }), 403, before);
  // Swapping in another agreement key breaks the binding even though the
  // signing key and the signature are untouched. That is the whole reason the
  // id commits to both: otherwise a relay could pair a signing key it cannot
  // forge with an agreement key it holds the private half of, and re-key
  // material sealed to that member would be sealed to the relay.
  await assertRejected(env, postLoc(env, circle.channel, { ...body, epk: b64uEncode(b.epk) }), 403, before);
  await assertRejected(env, postLoc(env, circle.channel, { ...body, pk: b64uEncode(b.pk) }), 403, before);
  assert.equal(await memberIdFromKeys(b64uDecode(body.pk), b64uDecode(body.epk)), body.m);
});

test("pinned key conflict is 403 and writes nothing", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const a = await generateIdentity();
  const b = await generateIdentity();
  const pin = (id, alg, pk, epk) =>
    env.DB._raw
      .prepare("INSERT INTO members_v3 (channel, member, alg, pk, epk, last_ts, srv) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(circle.channel, id, alg, pk, epk, 1, Date.now());

  // Pinned to a different signing key.
  pin(a.memberId, a.alg, b64uEncode(b.pk), b64uEncode(a.epk));
  let before = snap(env);
  await assertRejected(env, postLoc(env, circle.channel, await validPost(circle, a, Date.now())), 403, before);

  // Pinned to a different agreement key.
  const c = await generateIdentity();
  pin(c.memberId, c.alg, b64uEncode(c.pk), b64uEncode(b.epk));
  before = snap(env);
  await assertRejected(env, postLoc(env, circle.channel, await validPost(circle, c, Date.now())), 403, before);

  // Same key bytes, different pinned alg.
  const d = await generateIdentity();
  pin(d.memberId, d.alg === "ed25519" ? "p256" : "ed25519", b64uEncode(d.pk), b64uEncode(d.epk));
  before = snap(env);
  await assertRejected(env, postLoc(env, circle.channel, await validPost(circle, d, Date.now())), 403, before);
});

test("whole-body replay and equal ts are 409 and write nothing", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const id = await generateIdentity();
  const ts = Date.now();
  const exact = JSON.stringify(await validPost(circle, id, ts));

  assert.equal((await postLoc(env, circle.channel, exact)).status, 200);
  const before = snap(env);
  await assertRejected(env, postLoc(env, circle.channel, exact), 409, before);

  // A fresh message reusing the same ts is still 409: ts must strictly grow.
  await assertRejected(env, postLoc(env, circle.channel, await validPost(circle, id, ts)), 409, before);
  await assertRejected(env, postLoc(env, circle.channel, await validPost(circle, id, ts - 10)), 409, before);
});

test("ts too far in the future is 400 and writes nothing", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const id = await generateIdentity();
  const before = snap(env);
  const far = Date.now() + FUTURE_SKEW_MS + 60_000;
  await assertRejected(env, postLoc(env, circle.channel, await validPost(circle, id, far)), 400, before);
});

test("an epoch outside the skew window is answered 'clock', not a generic 400", async () => {
  // A device whose clock is wrong by more than the skew tolerance is invisible
  // to its circle. The client turns this error into "your clock is wrong"
  // rather than "network error", because the one thing worse than being
  // invisible is being invisible quietly.
  const env = freshEnv();
  const circle = await makeCircle();
  const id = await generateIdentity();
  const ts = Date.now();
  const nowEpoch = epochAt(ts);
  const before = snap(env);

  for (const e of [nowEpoch + MAX_SKEW_EPOCHS + 1, nowEpoch - MAX_SKEW_EPOCHS - 1, 0]) {
    const res = await postLoc(env, circle.channel, await postWithEpoch(circle, id, ts, e));
    assert.equal(res.status, 400, `e=${e}`);
    assert.deepEqual(await res.json(), { error: "clock" }, `e=${e}`);
    assert.deepEqual(snap(env), before, "a clock rejection writes nothing");
  }
  // The tolerance itself is accepted, so a phone a few minutes out still works.
  let k = 1;
  for (const e of [nowEpoch + MAX_SKEW_EPOCHS, nowEpoch - MAX_SKEW_EPOCHS]) {
    const res = await postLoc(env, circle.channel, await postWithEpoch(circle, id, ts + k++, e));
    assert.equal(res.status, 200, `e=${e}`);
  }
});

test("member cap: the 17th member is 403 and writes nothing", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const base = Date.now();
  for (let i = 0; i < MEMBER_CAP; i++) {
    const id = await generateIdentity();
    const res = await postLoc(env, circle.channel, await validPost(circle, id, base + i));
    assert.equal(res.status, 200, `member ${i + 1}`);
  }
  const before = snap(env);
  assert.equal(before.members, MEMBER_CAP);
  const extra = await generateIdentity();
  await assertRejected(env, postLoc(env, circle.channel, await validPost(circle, extra, base + 999)), 403, before);
});

test("member cap holds under concurrent new-member posts", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const base = Date.now();
  const total = MEMBER_CAP + 8;
  const bodies = [];
  for (let i = 0; i < total; i++) {
    bodies.push(await validPost(circle, await generateIdentity(), base + i));
  }

  // Fire every request at once so the handlers interleave at their awaits: all
  // of them read the same under-cap COUNT before any batch commits, so only an
  // in-batch guard can hold the cap here.
  const results = await Promise.all(bodies.map((b) => postLoc(env, circle.channel, b)));
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 200).length, MEMBER_CAP);
  assert.equal(statuses.filter((s) => s === 403).length, total - MEMBER_CAP);

  const after = snap(env);
  assert.equal(after.members, MEMBER_CAP);
  assert.equal(after.points, MEMBER_CAP);
  const feed = await (await getFeed(env, circle.channel)).json();
  assert.equal(feed.members.length, MEMBER_CAP);
});

test("bad signature is 403 and writes nothing", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const id = await generateIdentity();
  const body = await validPost(circle, id, Date.now());
  const sig = b64uDecode(body.sig);
  sig[3] ^= 0x01;
  const before = snap(env);
  await assertRejected(env, postLoc(env, circle.channel, { ...body, sig: b64uEncode(sig) }), 403, before);

  // A signature over a tampered field fails too, and the epoch is one of those
  // fields: a point cannot be moved between epochs on the way in.
  const body2 = await validPost(circle, id, Date.now() + 1);
  const n = b64uDecode(body2.n);
  n[0] ^= 0xff;
  await assertRejected(env, postLoc(env, circle.channel, { ...body2, n: b64uEncode(n) }), 403, before);
  await assertRejected(env, postLoc(env, circle.channel, { ...body2, e: body2.e + 1 }), 403, before);

  // And a signature lifted from another member's point does not travel.
  const other = await generateIdentity();
  const otherBody = await validPost(circle, other, Date.now() + 2);
  await assertRejected(env, postLoc(env, circle.channel, { ...body2, sig: otherBody.sig }), 403, before);
});

test("Origin mismatch is 403, matching Origin is accepted", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const id = await generateIdentity();
  const body = await validPost(circle, id, Date.now());
  const before = snap(env);
  await assertRejected(
    env,
    postLoc(env, circle.channel, body, { headers: { origin: "https://evil.example" } }),
    403,
    before,
  );
  const res = await postLoc(env, circle.channel, body, { headers: { origin: ORIGIN } });
  assert.equal(res.status, 200);
});

test("the wrapper's asset origin and ALLOWED_ORIGINS entries may write", async () => {
  const env = freshEnv({ ALLOWED_ORIGINS: "https://relay.example.org, https://alt.example.org" });
  const circle = await makeCircle();
  const id = await generateIdentity();
  let res = await postLoc(env, circle.channel, await validPost(circle, id, Date.now()), {
    headers: { origin: "https://appassets.androidplatform.net" },
  });
  assert.equal(res.status, 200);
  res = await postLoc(env, circle.channel, await validPost(circle, id, Date.now() + 1), {
    headers: { origin: "https://alt.example.org" },
  });
  assert.equal(res.status, 200);
  const before = snap(env);
  await assertRejected(
    env,
    postLoc(env, circle.channel, await validPost(circle, id, Date.now() + 2), {
      headers: { origin: "https://evil.example" },
    }),
    403,
    before,
  );
});

test("CORS: allowed foreign origins get a preflight and echoed headers, others get nothing", async () => {
  const env = freshEnv({ ALLOWED_ORIGINS: "https://alt.example.org" });
  const circle = await makeCircle();
  const wrapper = "https://appassets.androidplatform.net";

  let res = await req(env, `/api/v2/f/${circle.channel}/loc`, { method: "OPTIONS", headers: { origin: wrapper } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), wrapper);
  assert.equal(res.headers.get("access-control-allow-methods"), "GET, POST");
  assert.equal(res.headers.get("access-control-allow-headers"), "content-type");
  assert.equal(res.headers.get("vary"), "origin");

  res = await req(env, `/api/v2/f/${circle.channel}/loc`, {
    method: "OPTIONS",
    headers: { origin: "https://evil.example" },
  });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("access-control-allow-origin"), null);

  res = await req(env, `/api/v2/f/${circle.channel}?since=0`, { headers: { origin: wrapper } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), wrapper);
  const id = await generateIdentity();
  res = await postLoc(env, circle.channel, await validPost(circle, id, Date.now()), { headers: { origin: wrapper } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), wrapper);
  res = await req(env, `/api/v2/f/${circle.channel}?since=0`);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  res = await req(env, `/api/v2/f/${circle.channel}?since=0`, { headers: { origin: "https://evil.example" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("ALLOWED_ORIGINS entries are normalized to origins before matching", async () => {
  const env = freshEnv({ ALLOWED_ORIGINS: "HTTPS://Relay.Example.org/, not a url" });
  const circle = await makeCircle();
  const id = await generateIdentity();
  const res = await postLoc(env, circle.channel, await validPost(circle, id, Date.now()), {
    headers: { origin: "https://relay.example.org" },
  });
  assert.equal(res.status, 200);
});

test("assetlinks.json is served with the exact type Android verification wants", async () => {
  const env = freshEnv();
  const res = await req(env, "/.well-known/assetlinks.json");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  const body = await res.json();
  assert.equal(body[0].relation[0], "delegate_permission/common.handle_all_urls");
  assert.equal(body[0].target.package_name, "app.starlingmap");
  for (const fp of body[0].target.sha256_cert_fingerprints) {
    assert.match(fp, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  }
  assert.equal((await req(env, "/.well-known/assetlinks.json", { method: "POST", body: {} })).status, 405);
});

test("post rate limit trips at RATE_POST_MIN=3 and not under it", async () => {
  const env = freshEnv({ RATE_POST_MIN: "3" });
  const circle = await makeCircle();
  const id = await generateIdentity();
  const ip = freshIp();
  const base = Date.now();
  for (let i = 0; i < 3; i++) {
    const res = await postLoc(env, circle.channel, await validPost(circle, id, base + i), { ip });
    assert.equal(res.status, 200, `post ${i + 1} must stay under the limit`);
  }
  const before = snap(env);
  await assertRejected(env, postLoc(env, circle.channel, await validPost(circle, id, base + 10), { ip }), 429, before);
});

test("get rate limit is per IP", async () => {
  const env = freshEnv({ RATE_GET_MIN: "2" });
  const circle = await makeCircle();
  const ip = freshIp();
  assert.equal((await getFeed(env, circle.channel, "", { ip })).status, 200);
  assert.equal((await getFeed(env, circle.channel, "", { ip })).status, 200);
  assert.equal((await getFeed(env, circle.channel, "", { ip })).status, 429);
  assert.equal((await getFeed(env, circle.channel, "", { ip: freshIp() })).status, 200);
});

// A limiter whose first victim is the circle it protects is not a limiter, it
// is an outage. A sharing member posts every 15 s, so 4 writes a minute, and a
// channel holds MEMBER_CAP of them: 64 writes a minute with nothing wrong at
// all. The old default of 60 sat under that floor, so a full circle throttled
// itself and honest members were told 429 while they believed they were
// visible. This runs that exact minute against the shipped default.
test("the default post budget clears a full circle's own steady traffic", async () => {
  const env = { DB: makeD1() };
  const circle = await makeCircle();
  const ids = [];
  for (let i = 0; i < MEMBER_CAP; i++) ids.push(await generateIdentity());
  const base = Date.now();

  // Every member on its own address, which is the ordinary case.
  let sent = 0;
  for (let round = 0; round < 4; round++) {
    for (const [i, id] of ids.entries()) {
      const res = await postLoc(env, circle.channel, await validPost(circle, id, base + round * 15_000 + i), {
        ip: freshIp(),
      });
      assert.equal(res.status, 200, `steady post ${++sent} of ${MEMBER_CAP * 4} must not be rate limited`);
    }
  }
  assert.equal(sent, 64, "MEMBER_CAP members at 4 posts a minute");

  // And the same circle behind one NAT, VPN exit or Tor circuit, which is the
  // population this app is built for. Those 64 writes plus the 96 polls the
  // same members make have to fit the per-address budget too.
  const nat = { DB: makeD1() };
  const oneIp = freshIp();
  const natCircle = await makeCircle();
  for (let round = 0; round < 4; round++) {
    for (const [i, id] of ids.entries()) {
      const res = await postLoc(nat, natCircle.channel, await validPost(natCircle, id, base + round * 15_000 + i), {
        ip: oneIp,
      });
      assert.equal(res.status, 200, "a whole circle behind one address must still be served");
    }
  }
  for (let i = 0; i < 96; i++) {
    assert.equal((await getFeed(nat, natCircle.channel, "", { ip: oneIp })).status, 200, `poll ${i + 1}`);
  }
});

// Order of work, not just verdict. Every check above the rate limit is one an
// attacker gets to spend for free by sending a request that was never going to
// be stored: the limiter used to sit below two D1 reads and a signature
// verification, so it bounded what reached storage and not what reached the
// CPU. Any 32 hex characters name a channel, so a sprayer picking a fresh one
// each time never met the per-channel limit at all.
function countingEnv(over = {}) {
  const db = makeD1();
  let queries = 0;
  return {
    env: {
      DB: {
        prepare: (sql) => {
          queries += 1;
          return db.prepare(sql);
        },
        batch: (stmts) => db.batch(stmts),
        _raw: db._raw,
      },
      ...over,
    },
    reset: () => {
      queries = 0;
    },
    queries: () => queries,
  };
}

test("a rate limited post costs no database work and no signature check", async () => {
  const c = countingEnv({ RATE_POST_MIN: "1", RATE_GET_MIN: "1000000" });
  const circle = await makeCircle();
  const id = await generateIdentity();
  const ip = freshIp();
  const base = Date.now();

  assert.equal((await postLoc(c.env, circle.channel, await validPost(circle, id, base), { ip })).status, 200);
  c.reset();

  const res = await postLoc(c.env, circle.channel, await validPost(circle, id, base + 1), { ip });
  assert.equal(res.status, 429);
  assert.equal(c.queries(), 0, "a refused post must not touch the database");

  // Over budget, the body is not even parsed: junk that would otherwise be a
  // 400 is refused by the limiter first, because the limiter is cheaper.
  const junk = await postLoc(c.env, circle.channel, { nope: true }, { ip });
  assert.equal(junk.status, 429);
  assert.equal(c.queries(), 0);
});

test("spraying fresh channels is stopped by the address budget before any work", async () => {
  // The per-channel limiter cannot see this at all: every request names a
  // channel nobody has used, so its bucket is always empty. The per-address
  // budget is what catches it, and it has to catch it before the reads and the
  // verification, or the spray still costs the relay everything it was going
  // to cost.
  const c = countingEnv({ RATE_POST_MIN: "1000000", RATE_GET_MIN: "2" });
  const circle = await makeCircle();
  const id = await generateIdentity();
  const ip = freshIp();
  const base = Date.now();

  for (let i = 0; i < 2; i++) {
    const fresh = await makeCircle();
    assert.equal((await postLoc(c.env, fresh.channel, await validPost(fresh, id, base + i), { ip })).status, 200);
  }
  c.reset();
  const res = await postLoc(c.env, circle.channel, await validPost(circle, id, base + 9), { ip });
  assert.equal(res.status, 429, "a fresh channel every time must not buy an unlimited budget");
  assert.equal(c.queries(), 0, "and the refusal must be free");
});

test("TTL sweep removes rows older than TTL_MS on any feed request", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const db = env.DB._raw;
  const old = Date.now() - TTL_MS - 60_000;
  const ghost = "a".repeat(32);
  db.prepare("INSERT INTO members_v3 (channel, member, alg, pk, epk, last_ts, srv) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(circle.channel, ghost, "ed25519", "AAAA", "EEEE", 5, old);
  db.prepare("INSERT INTO points_v3 (channel, member, e, ts, srv, n, c, sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(circle.channel, ghost, 1, 5, old, "AAAA", "BBBB", "CCCC");
  assert.deepEqual(snap(env), { members: 1, points: 1 });

  const res = await getFeed(env, circle.channel);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).members, []);
  assert.deepEqual(snap(env), { members: 0, points: 0 });

  // The sweep runs on the post path too, and fresh rows survive it.
  db.prepare("INSERT INTO members_v3 (channel, member, alg, pk, epk, last_ts, srv) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(circle.channel, "b".repeat(32), "ed25519", "AAAA", "EEEE", 5, old);
  const id = await generateIdentity();
  assert.equal((await postLoc(env, circle.channel, await validPost(circle, id, Date.now()))).status, 200);
  assert.deepEqual(db.prepare("SELECT member FROM members_v3").all().map((r) => r.member), [id.memberId]);
  assert.deepEqual(snap(env), { members: 1, points: 1 });
});

test("trail is pruned to the newest TRAIL_CAP points", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const id = await generateIdentity();
  const extra = 5;
  const base = Date.now() - TRAIL_CAP - extra;
  for (let i = 0; i < TRAIL_CAP + extra; i++) {
    const res = await postLoc(env, circle.channel, await validPost(circle, id, base + i));
    assert.equal(res.status, 200, `post ${i + 1}`);
  }
  const stored = env.DB._raw
    .prepare("SELECT COUNT(*) AS n, MIN(ts) AS lo, MAX(ts) AS hi FROM points_v3 WHERE channel = ? AND member = ?")
    .get(circle.channel, id.memberId);
  assert.equal(stored.n, TRAIL_CAP);
  assert.equal(stored.lo, base + extra);
  assert.equal(stored.hi, base + TRAIL_CAP + extra - 1);

  const feed = await (await getFeed(env, circle.channel)).json();
  assert.equal(feed.members[0].points.length, TRAIL_CAP);
});

test("a p256 member is accepted end to end", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const subtle = globalThis.crypto.subtle;
  const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const pk = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
  const ec = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const epk = new Uint8Array(await subtle.exportKey("raw", ec.publicKey));
  const id = {
    alg: "p256",
    privateKey: kp.privateKey,
    pk,
    ecdhPrivate: ec.privateKey,
    epk,
    memberId: await memberIdFromKeys(pk, epk),
  };
  const ts = Date.now();
  const msg = msgAt(ts);
  assert.equal((await postLoc(env, circle.channel, await validPost(circle, id, ts, msg))).status, 200);

  const feed = await (await getFeed(env, circle.channel)).json();
  const mem = feed.members[0];
  assert.equal(mem.alg, "p256");
  assert.equal(mem.pk.length, 87, "a 65-byte raw P-256 key");
  const key = await circle.ratchet.keyFor(mem.points[0].e, mem.m, ts);
  assert.deepEqual(
    await openMessage(key, circle.channel, mem.m, mem.points[0].e, mem.points[0].ts, b64uDecode(mem.points[0].n), b64uDecode(mem.points[0].c)),
    msg,
  );
});

test("last_ts never walks backwards, even if an older post lands second", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const id = await generateIdentity();
  const now = Date.now();

  assert.equal((await postLoc(env, circle.channel, await validPost(circle, id, now))).status, 200);
  assert.equal((await postLoc(env, circle.channel, await validPost(circle, id, now + 5000))).status, 200);
  const pinned = () =>
    env.DB._raw.prepare("SELECT last_ts FROM members_v3 WHERE channel = ?").get(circle.channel).last_ts;
  assert.equal(pinned(), now + 5000);

  await assertRejected(env, postLoc(env, circle.channel, await validPost(circle, id, now + 1000)), 409, snap(env));
  assert.equal(pinned(), now + 5000, "a rejected replay must leave the pin at its high-water mark");
});

test("spraying channels cannot evict an address out of its own rate limit", async () => {
  // A shared bucket map let an attacker push their own IP bucket out by
  // creating enough channel buckets, which reset their budget to zero used.
  const env = freshEnv({ RATE_GET_MIN: "3" });
  const ip = freshIp();
  const chan = "d".repeat(32);
  for (let i = 0; i < 3; i++) {
    assert.equal((await getFeed(env, chan, "", { ip })).status, 200);
  }
  const spray = freshEnv({ RATE_GET_MIN: "1000000" });
  for (let i = 0; i < 5000; i++) {
    await getFeed(spray, i.toString(16).padStart(32, "0"), "", { ip: "10.250.0.1" });
  }
  assert.equal((await getFeed(env, chan, "", { ip })).status, 429, "the address is still limited");
});

test("the relay stores ciphertext and nothing that decrypts it", async () => {
  // A subpoena of this database should get ciphertext, pinned public keys, and
  // timing. Nothing else is written, so nothing else can be handed over.
  const env = freshEnv();
  const circle = await makeCircle();
  const id = await generateIdentity();
  const ts = Date.now();
  const secret = "a-name-nobody-should-be-able-to-read";
  await postLoc(env, circle.channel, await validPost(circle, id, ts, msgAt(ts, { name: secret })));

  const dump = JSON.stringify([
    env.DB._raw.prepare("SELECT * FROM members_v3").all(),
    env.DB._raw.prepare("SELECT * FROM points_v3").all(),
  ]);
  assert.ok(!dump.includes(secret));
  assert.ok(!dump.includes("44.98"), "no coordinates in the clear either");
  assert.ok(dump.includes(circle.channel));
});
