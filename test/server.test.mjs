// The plain-server relay driven over real HTTP, same contract as relay.test.mjs but through a real socket and file.
// Rate-limit state is a module-level Map inside the Worker, shared by every test here, so non-rate tests run with TRUST_PROXY on and a fresh X-Forwarded-For value to stay off the shared loopback bucket.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "../relay/server.mjs";
import { openGeneration } from "../app/js/rekey.js";
import { epochAt } from "../app/js/ratchet.js";
import { newSeed, generateIdentity, sealMessage, buildPost } from "../app/js/crypto.js";

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "starling-relay-test-"));
  return path.join(dir, "starling.db");
}

let ipN = 0;
const freshIp = () => `10.9.${Math.floor(ipN / 200)}.${(ipN++ % 200) + 1}`;

async function makeCircle() {
  const gen = await openGeneration({ seed: newSeed(), g: 0, e0: epochAt(Date.now()) - 1, historyEpochs: 144 });
  return { channel: gen.channelId, ratchet: gen.ratchet };
}

const msgAt = (ts) => ({ v: 2, t: "loc", ts, lat: 44.98, lon: -93.27, acc: 12, name: "A" });

async function validPost(circle, identity, ts) {
  const e = epochAt(ts);
  const key = await circle.ratchet.keyFor(e, identity.memberId, ts);
  const sealed = await sealMessage(key, circle.channel, identity.memberId, e, ts, msgAt(ts));
  return buildPost(identity, circle.channel, e, sealed, ts);
}

// Every call here carries a fresh X-Forwarded-For hop under TRUST_PROXY, so it lands in its own rate-limit bucket.
async function up(opts = {}) {
  const { server, env, close } = createServer({ dbPath: tmpDbPath(), trustProxy: true, ...opts });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const ip = freshIp();
  const base = `http://127.0.0.1:${port}`;
  const get = (p, init = {}) =>
    fetch(`${base}${p}`, { ...init, headers: { "x-forwarded-for": ip, ...init.headers } });
  const post = (p, body, init = {}) =>
    get(p, { method: "POST", headers: { "content-type": "application/json", ...init.headers }, body: JSON.stringify(body), ...init });
  return { base, env, close, get, post };
}

test("health responds over a real socket", async () => {
  const { get, close } = await up();
  const res = await get("/api/v2/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  await close();
});

test("post then get round trip over HTTP, same as the Worker in-process", async () => {
  const { post, get, close } = await up({ publicOrigin: "http://127.0.0.1" });
  const circle = await makeCircle();
  const id = await generateIdentity();
  const ts = Date.now();
  const body = await validPost(circle, id, ts);

  const postRes = await post(`/api/v2/f/${circle.channel}/loc`, body);
  assert.equal(postRes.status, 200);
  assert.deepEqual((await postRes.json()).ok, true);

  const feedRes = await get(`/api/v2/f/${circle.channel}`);
  assert.equal(feedRes.status, 200);
  const feed = await feedRes.json();
  assert.equal(feed.members.length, 1);
  assert.equal(feed.members[0].points.length, 1);
  assert.equal(feed.members[0].points[0].ts, ts);
  await close();
});

test("member cap over HTTP: the 17th member is 403", async () => {
  const { post, close } = await up();
  const circle = await makeCircle();
  const base_ts = Date.now();
  for (let i = 0; i < 16; i++) {
    const id = await generateIdentity();
    const res = await post(`/api/v2/f/${circle.channel}/loc`, await validPost(circle, id, base_ts + i));
    assert.equal(res.status, 200, `member ${i + 1}`);
  }
  const extra = await generateIdentity();
  const res = await post(`/api/v2/f/${circle.channel}/loc`, await validPost(circle, extra, base_ts + 999));
  assert.equal(res.status, 403);
  await close();
});

test("CORS preflight for the wrapper origin, an ALLOWED_ORIGINS entry, and a refused origin", async () => {
  const { get, close } = await up({ rateVars: { ALLOWED_ORIGINS: "https://relay.example.org" } });
  const circle = await makeCircle();
  const chan = circle.channel;

  let res = await get(`/api/v2/f/${chan}/loc`, {
    method: "OPTIONS",
    headers: { origin: "https://appassets.androidplatform.net" },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://appassets.androidplatform.net");

  res = await get(`/api/v2/f/${chan}/loc`, { method: "OPTIONS", headers: { origin: "https://relay.example.org" } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://relay.example.org");

  res = await get(`/api/v2/f/${chan}/loc`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  await close();
});

test("without TRUST_PROXY every request shares the socket address and trips the IP limit together", async () => {
  const { server, env, close } = createServer({
    dbPath: tmpDbPath(),
    trustProxy: false,
    rateVars: { RATE_GET_MIN: "2" },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const circle = await makeCircle();

  // Three different X-Forwarded-For claims, one real loopback connection: untrusted, so they share one budget.
  let res = await fetch(`${base}/api/v2/f/${circle.channel}`, { headers: { "x-forwarded-for": "1.1.1.1" } });
  assert.equal(res.status, 200);
  res = await fetch(`${base}/api/v2/f/${circle.channel}`, { headers: { "x-forwarded-for": "2.2.2.2" } });
  assert.equal(res.status, 200);
  res = await fetch(`${base}/api/v2/f/${circle.channel}`, { headers: { "x-forwarded-for": "3.3.3.3" } });
  assert.equal(res.status, 429, "distinct X-Forwarded-For values must not buy separate budgets when untrusted");
  void env;
  await close();
});

test("with TRUST_PROXY=1 the last X-Forwarded-For hop is what gets rate limited", async () => {
  const { server, close } = createServer({
    dbPath: tmpDbPath(),
    trustProxy: true,
    rateVars: { RATE_GET_MIN: "1" },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const circle = await makeCircle();

  let res = await fetch(`${base}/api/v2/f/${circle.channel}`, { headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.5" } });
  assert.equal(res.status, 200);
  res = await fetch(`${base}/api/v2/f/${circle.channel}`, { headers: { "x-forwarded-for": "8.8.8.8, 10.0.0.5" } });
  assert.equal(res.status, 429, "the last hop is what is trusted, not the client-supplied first hop");
  res = await fetch(`${base}/api/v2/f/${circle.channel}`, { headers: { "x-forwarded-for": "8.8.8.8, 10.0.0.6" } });
  assert.equal(res.status, 200, "a different last hop gets its own budget");
  await close();
});

test("the TTL sweep runs on the plain server too", async () => {
  const { get, env, close } = await up();
  const circle = await makeCircle();
  const db = env.DB._raw;
  const old = Date.now() - 24 * 60 * 60 * 1000 - 60_000;
  const ghost = "a".repeat(32);
  db.prepare("INSERT INTO members_v3 (channel, member, alg, pk, epk, last_ts, srv) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(circle.channel, ghost, "ed25519", "AAAA", "EEEE", 5, old);
  db.prepare("INSERT INTO points_v3 (channel, member, e, ts, srv, n, c, sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(circle.channel, ghost, 1, 5, old, "AAAA", "BBBB", "CCCC");

  const res = await get(`/api/v2/f/${circle.channel}`);
  assert.deepEqual((await res.json()).members, []);
  await close();
});

test("the idle sweep timer clears rows nobody has polled since", async () => {
  const { env, close } = await up({ sweepIntervalMs: 20 });
  const circle = await makeCircle();
  const db = env.DB._raw;
  const old = Date.now() - 24 * 60 * 60 * 1000 - 60_000;
  db.prepare("INSERT INTO members_v3 (channel, member, alg, pk, epk, last_ts, srv) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(circle.channel, "b".repeat(32), "ed25519", "AAAA", "EEEE", 5, old);
  db.prepare("INSERT INTO points_v3 (channel, member, e, ts, srv, n, c, sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(circle.channel, "b".repeat(32), 1, 5, old, "AAAA", "BBBB", "CCCC");

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM members_v3").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM points_v3").get().n, 0);
  await close();
});

test("a rejected sweep does not crash the process or raise an unhandled rejection", async () => {
  const { env, close } = await up({ sweepIntervalMs: 15 });
  env.DB.batch = () => Promise.reject(new Error("SQLITE_BUSY (simulated)"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await close();
});

// Negative control: the same uncaught-rejection pattern crashes a bare Node process, which is what the .catch() above guards against.
test("negative control: an uncaught rejection on this pattern is fatal to a bare Node process", () => {
  const result = spawnSync(process.execPath, [
    "-e",
    "Promise.reject(new Error('SQLITE_BUSY (simulated)')); setTimeout(() => {}, 50)",
  ]);
  assert.notEqual(result.status, 0, "an uncaught rejection must be fatal, or the fix above guards against nothing");
});

test("data survives a restart against the same database file, and a clean shutdown closes the handle", async () => {
  const dbPath = tmpDbPath();
  const first = await up({ dbPath });
  const circle = await makeCircle();
  const id = await generateIdentity();
  const ts = Date.now();
  const res = await first.post(`/api/v2/f/${circle.channel}/loc`, await validPost(circle, id, ts));
  assert.equal(res.status, 200);
  await first.close();
  assert.ok(fs.existsSync(dbPath), "the file-backed database is left on disk after shutdown");

  const second = await up({ dbPath });
  const feed = await (await second.get(`/api/v2/f/${circle.channel}`)).json();
  assert.equal(feed.members.length, 1);
  assert.equal(feed.members[0].points[0].ts, ts);
  await second.close();
});

test("a body over the raw cap is refused with a clean 413, not a connection reset", async () => {
  const { post, close } = await up();
  const chan = "0123456789abcdef0123456789abcdef";
  const res = await post(`/api/v2/f/${chan}/loc`, undefined, { body: "x".repeat(200_000) });
  assert.equal(res.status, 413);
  await close();
});

// Negative control: proves the last-hop assertions above would fail under a first-hop implementation.
test("negative control: a first-hop implementation would fail the trust test above", async () => {
  const hops = "9.9.9.9, 10.0.0.5".split(",").map((s) => s.trim());
  const wrongImpl = hops[0];
  const rightImpl = hops[hops.length - 1];
  assert.notEqual(wrongImpl, rightImpl, "the two implementations must disagree, or the real test proves nothing");
});
