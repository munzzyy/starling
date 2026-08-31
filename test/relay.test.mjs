// Relay contract tests: the worker runs in-process against the D1 shim, and
// every post is built with the real device-side crypto from app/js/crypto.js.
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
  b64uEncode,
  b64uDecode,
  memberIdFromPub,
} from "../app/js/wire.js";
import {
  newCircleSecret,
  deriveChannelId,
  deriveEncKey,
  generateIdentity,
  sealMessage,
  buildPost,
  openMessage,
} from "../app/js/crypto.js";

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
  req(env, `/api/v1/f/${channel}/loc`, { method: "POST", body, ...opts });
const getFeed = (env, channel, qs = "", opts = {}) => req(env, `/api/v1/f/${channel}${qs}`, opts);

async function makeCircle() {
  const secret = newCircleSecret();
  return { secret, channel: await deriveChannelId(secret), encKey: await deriveEncKey(secret) };
}

const msgAt = (ts, extra = {}) => ({ v: 1, t: "loc", ts, lat: 44.98, lon: -93.27, acc: 12, name: "A", ...extra });

async function validPost(circle, identity, ts, msg = msgAt(ts)) {
  const sealed = await sealMessage(circle.encKey, circle.channel, identity.memberId, msg);
  return buildPost(identity, circle.channel, sealed, ts);
}

function snap(env) {
  const db = env.DB._raw;
  return {
    members: db.prepare("SELECT COUNT(*) AS n FROM members").get().n,
    points: db.prepare("SELECT COUNT(*) AS n FROM points").get().n,
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

test("health responds with security headers", async () => {
  const env = freshEnv();
  const res = await req(env, "/api/v1/health");
  assert.equal(res.status, 200);
  assertJsonHeaders(res);
  assert.deepEqual(await res.json(), { ok: true });
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
  assert.equal(typeof feed.now, "number");
  assert.equal(feed.members.length, 1);
  const mem = feed.members[0];
  assert.equal(mem.m, id.memberId);
  assert.equal(mem.alg, id.alg);
  assert.equal(mem.pk, b64uEncode(id.pk));
  assert.deepEqual(mem.points, [{ ts, n: body.n, c: body.c }]);

  const opened = await openMessage(circle.encKey, circle.channel, mem.m, b64uDecode(mem.points[0].n), b64uDecode(mem.points[0].c));
  assert.deepEqual(opened, msg);
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

test("since filters strictly older points", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const id = await generateIdentity();
  const base = Date.now();
  for (const dt of [0, 1, 2]) await postLoc(env, circle.channel, await validPost(circle, id, base + dt));

  const feed = await (await getFeed(env, circle.channel, `?since=${base + 1}`)).json();
  assert.deepEqual(feed.members[0].points.map((p) => p.ts), [base + 2]);

  const all = await (await getFeed(env, circle.channel, "?since=0")).json();
  assert.equal(all.members[0].points.length, 3);
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
  const ids = feed.members.map((m) => m.m).sort();
  assert.deepEqual(ids, [a.memberId, b.memberId].sort());
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
  const feed = await res.json();
  assert.deepEqual(feed.members, []);
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
  await assertRejected(env, req(env, "/api/v1/health", { method: "POST", body: {} }), 405, before);
  await assertRejected(env, req(env, `/api/v1/f/${chan}`, { method: "POST", body: {} }), 405, before);
  await assertRejected(env, req(env, `/api/v1/f/${chan}/loc`, { method: "GET" }), 405, before);
  await assertRejected(env, req(env, `/api/v1/f/${chan}/loc`, { method: "DELETE" }), 405, before);
});

test("unknown paths are 404", async () => {
  const env = freshEnv();
  const before = snap(env);
  for (const p of ["/", "/api", "/api/v1", "/api/v1/nope", "/api/v1/f", "/api/v1/f/", "/api/v2/health", "/api/v1/f/0123456789abcdef0123456789abcdef/loc/extra"]) {
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
    { ...ok, m: ok.m.slice(0, 15) },
    { ...ok, m: ok.m.toUpperCase() },
    { ...ok, alg: "rsa" },
    { ...ok, pk: "A".repeat(91) },
    { ...ok, n: ok.n + "!" },
    { ...ok, c: "A".repeat(721) },
    { ...ok, sig: "" },
    { ...ok, ts: -5 },
    { ...ok, ts: 1.5 },
    (() => { const v = { ...ok }; delete v.sig; return v; })(),
    (() => { const v = { ...ok }; delete v.pk; return v; })(),
    [ok],
    "null",
  ];
  for (const v of variants) {
    await assertRejected(env, postLoc(env, circle.channel, v), 400, before);
  }
});

test("pk to member-id binding mismatch is 403 and writes nothing", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const a = await generateIdentity();
  const b = await generateIdentity();
  const body = await validPost(circle, a, Date.now());
  const before = snap(env);
  await assertRejected(env, postLoc(env, circle.channel, { ...body, m: b.memberId }), 403, before);
});

test("pinned key conflict is 403 and writes nothing", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const a = await generateIdentity();
  const b = await generateIdentity();
  // Pin a's member slot to a DIFFERENT key directly in the DB, then a genuine
  // post from a (binding passes) must hit the pin check and bounce.
  env.DB._raw
    .prepare("INSERT INTO members (channel, member, alg, pk, last_ts, srv) VALUES (?, ?, ?, ?, ?, ?)")
    .run(circle.channel, a.memberId, a.alg, b64uEncode(b.pk), 1, Date.now());
  const before = snap(env);
  await assertRejected(env, postLoc(env, circle.channel, await validPost(circle, a, Date.now())), 403, before);

  // Same key bytes but a different pinned alg must bounce too.
  const c = await generateIdentity();
  env.DB._raw
    .prepare("INSERT INTO members (channel, member, alg, pk, last_ts, srv) VALUES (?, ?, ?, ?, ?, ?)")
    .run(circle.channel, c.memberId, c.alg === "ed25519" ? "p256" : "ed25519", b64uEncode(c.pk), 1, Date.now());
  const before2 = snap(env);
  await assertRejected(env, postLoc(env, circle.channel, await validPost(circle, c, Date.now())), 403, before2);
});

test("whole-body replay and equal ts are 409 and write nothing", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const id = await generateIdentity();
  const ts = Date.now();
  const body = await validPost(circle, id, ts);
  const exact = JSON.stringify(body);

  assert.equal((await postLoc(env, circle.channel, exact)).status, 200);
  const before = snap(env);
  await assertRejected(env, postLoc(env, circle.channel, exact), 409, before);

  // A fresh message reusing the same ts is still 409: ts must strictly grow.
  await assertRejected(env, postLoc(env, circle.channel, await validPost(circle, id, ts)), 409, before);
  // And an older ts too.
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

test("bad signature is 403 and writes nothing", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const id = await generateIdentity();
  const body = await validPost(circle, id, Date.now());
  const sig = b64uDecode(body.sig);
  sig[3] ^= 0x01;
  const before = snap(env);
  await assertRejected(env, postLoc(env, circle.channel, { ...body, sig: b64uEncode(sig) }), 403, before);

  // Signature over a tampered field fails as well.
  const body2 = await validPost(circle, id, Date.now() + 1);
  const n = b64uDecode(body2.n);
  n[0] ^= 0xff;
  await assertRejected(env, postLoc(env, circle.channel, { ...body2, n: b64uEncode(n) }), 403, before);
});

test("Origin mismatch is 403, matching Origin is accepted", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const id = await generateIdentity();
  const ts = Date.now();
  const body = await validPost(circle, id, ts);
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
  // A different IP is unaffected.
  assert.equal((await getFeed(env, circle.channel, "", { ip: freshIp() })).status, 200);
});

test("TTL sweep removes rows older than TTL_MS on any feed request", async () => {
  const env = freshEnv();
  const circle = await makeCircle();
  const db = env.DB._raw;
  const old = Date.now() - TTL_MS - 60_000;
  db.prepare("INSERT INTO members (channel, member, alg, pk, last_ts, srv) VALUES (?, ?, ?, ?, ?, ?)")
    .run(circle.channel, "aaaaaaaaaaaaaaaa", "ed25519", "AAAA", 5, old);
  db.prepare("INSERT INTO points (channel, member, ts, srv, n, c) VALUES (?, ?, ?, ?, ?, ?)")
    .run(circle.channel, "aaaaaaaaaaaaaaaa", 5, old, "AAAA", "BBBB");
  assert.deepEqual(snap(env), { members: 1, points: 1 });

  const res = await getFeed(env, circle.channel);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).members, []);
  assert.deepEqual(snap(env), { members: 0, points: 0 });

  // The sweep runs on the post path too, and fresh rows survive it.
  db.prepare("INSERT INTO members (channel, member, alg, pk, last_ts, srv) VALUES (?, ?, ?, ?, ?, ?)")
    .run(circle.channel, "bbbbbbbbbbbbbbbb", "ed25519", "AAAA", 5, old);
  const id = await generateIdentity();
  assert.equal((await postLoc(env, circle.channel, await validPost(circle, id, Date.now()))).status, 200);
  const members = db.prepare("SELECT member FROM members").all().map((r) => r.member);
  assert.deepEqual(members, [id.memberId]);
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
    .prepare("SELECT COUNT(*) AS n, MIN(ts) AS lo, MAX(ts) AS hi FROM points WHERE channel = ? AND member = ?")
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
  const kp = await globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const pk = new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", kp.publicKey));
  const id = { alg: "p256", privateKey: kp.privateKey, pk, memberId: await memberIdFromPub(pk) };
  const ts = Date.now();
  const msg = msgAt(ts);
  const sealed = await sealMessage(circle.encKey, circle.channel, id.memberId, msg);
  const body = await buildPost(id, circle.channel, sealed, ts);
  assert.equal((await postLoc(env, circle.channel, body)).status, 200);

  const feed = await (await getFeed(env, circle.channel)).json();
  assert.equal(feed.members[0].alg, "p256");
  const opened = await openMessage(
    circle.encKey,
    circle.channel,
    id.memberId,
    b64uDecode(feed.members[0].points[0].n),
    b64uDecode(feed.members[0].points[0].c),
  );
  assert.deepEqual(opened, msg);
});
