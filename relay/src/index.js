// Starling relay: a zero-knowledge drop box for ciphertext location posts.
// It stores (channel, member, ts, nonce, ciphertext) rows, verifies signatures
// against keys pinned on first write, and expires everything after TTL_MS.
// It never sees plaintext, names, or any key that decrypts anything, and it
// must never log request data.

import {
  MAX_BODY,
  MEMBER_CAP,
  TRAIL_CAP,
  TTL_MS,
  FUTURE_SKEW_MS,
  b64uDecode,
  memberIdFromPub,
  isChannelId,
  sigBase,
  verifySig,
  checkPostShape,
} from "../../app/js/wire.js";

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: HEADERS });
}

const err = (status, msg) => json(status, { error: msg });

function envInt(v, dflt) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : dflt;
}

// Per-isolate sliding-window rate limiter. Each key holds the timestamps of
// requests allowed in the last minute. The map is capped and drops its oldest
// key, so scanning many channels or IPs cannot grow it without bound.
const RATE_WINDOW_MS = 60_000;
const RATE_KEYS_MAX = 4096;
const rateBuckets = new Map();

function rateLimited(key, limit, now) {
  const hits = rateBuckets.get(key) || [];
  rateBuckets.delete(key);
  while (hits.length && hits[0] <= now - RATE_WINDOW_MS) hits.shift();
  const limited = hits.length >= limit;
  if (!limited) hits.push(now);
  rateBuckets.set(key, hits);
  if (rateBuckets.size > RATE_KEYS_MAX) rateBuckets.delete(rateBuckets.keys().next().value);
  return limited;
}

// Deterministic TTL sweep, run on every feed request.
const sweepStmts = (env, now) => [
  env.DB.prepare("DELETE FROM points WHERE srv < ?").bind(now - TTL_MS),
  env.DB.prepare("DELETE FROM members WHERE srv < ?").bind(now - TTL_MS),
];

async function handlePost(request, env, channel, url) {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) return err(403, "forbidden");

  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY) return err(413, "too large");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err(400, "bad request");
  }
  const body = checkPostShape(parsed);
  if (!body) return err(400, "bad request");

  let pkBytes;
  try {
    pkBytes = b64uDecode(body.pk);
  } catch {
    return err(400, "bad request");
  }
  if ((await memberIdFromPub(pkBytes)) !== body.m) return err(403, "forbidden");

  const now = Date.now();
  if (body.ts > now + FUTURE_SKEW_MS) return err(400, "bad request");

  const pinned = await env.DB
    .prepare("SELECT alg, pk, last_ts FROM members WHERE channel = ? AND member = ?")
    .bind(channel, body.m)
    .first();
  if (pinned) {
    if (pinned.alg !== body.alg || pinned.pk !== body.pk) return err(403, "forbidden");
    if (body.ts <= pinned.last_ts) return err(409, "conflict");
  } else {
    // Early reject for the sequential case; the batch below enforces the cap
    // atomically, so this read is a fast path, not the guard.
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE channel = ?").bind(channel).first();
    if (row.n >= MEMBER_CAP) return err(403, "forbidden");
  }

  let sigBytes;
  try {
    sigBytes = b64uDecode(body.sig);
  } catch {
    return err(403, "forbidden");
  }
  const base = sigBase(channel, body.m, body.ts, body.n, body.c);
  if (!(await verifySig(body.alg, pkBytes, sigBytes, base))) return err(403, "forbidden");

  const ip = request.headers.get("cf-connecting-ip") || "";
  if (
    rateLimited("c:" + channel, envInt(env.RATE_POST_MIN, 60), now) ||
    rateLimited("i:" + ip, envInt(env.RATE_GET_MIN, 240), now)
  ) {
    return err(429, "rate limited");
  }

  // The member cap is enforced inside this batch, not by the COUNT read
  // above: a new member row lands only while the channel holds fewer than
  // MEMBER_CAP members, and the point insert requires the member row, so a
  // request rejected by the cap writes nothing. D1 runs a batch as one
  // transaction against a single-writer SQLite database, so concurrent
  // admissions serialize here. Already-pinned members pass via the EXISTS
  // arm regardless of the count.
  let results;
  try {
    results = await env.DB.batch([
      env.DB
        .prepare(
          "INSERT INTO members (channel, member, alg, pk, last_ts, srv) " +
            "SELECT ?, ?, ?, ?, ?, ? " +
            "WHERE EXISTS (SELECT 1 FROM members WHERE channel = ? AND member = ?) " +
            "OR (SELECT COUNT(*) FROM members WHERE channel = ?) < ? " +
            "ON CONFLICT (channel, member) DO UPDATE SET last_ts = excluded.last_ts, srv = excluded.srv",
        )
        .bind(channel, body.m, body.alg, body.pk, body.ts, now, channel, body.m, channel, MEMBER_CAP),
      env.DB
        .prepare(
          "INSERT INTO points (channel, member, ts, srv, n, c) " +
            "SELECT ?, ?, ?, ?, ?, ? " +
            "WHERE EXISTS (SELECT 1 FROM members WHERE channel = ? AND member = ?)",
        )
        .bind(channel, body.m, body.ts, now, body.n, body.c, channel, body.m),
      env.DB
        .prepare(
          "DELETE FROM points WHERE channel = ? AND member = ? AND ts NOT IN " +
            "(SELECT ts FROM points WHERE channel = ? AND member = ? ORDER BY ts DESC LIMIT ?)",
        )
        .bind(channel, body.m, channel, body.m, TRAIL_CAP),
      ...sweepStmts(env, now),
    ]);
  } catch {
    // The points primary key backstops the replay rule under concurrency.
    return err(409, "conflict");
  }
  if (!results[0]?.meta?.changes) return err(403, "forbidden");
  return json(200, { ok: true, now });
}

async function handleGet(request, env, channel, url) {
  const ip = request.headers.get("cf-connecting-ip") || "";
  if (rateLimited("i:" + ip, envInt(env.RATE_GET_MIN, 240), Date.now())) return err(429, "rate limited");

  // The feed cursor is the relay's own receive time (srv), never the
  // client-claimed ts, so one member's skewed clock can never filter another
  // member's honest points out of the feed. srv is not unique per insert, so
  // the filter is inclusive (srv >= since) and the client dedups by
  // member+ts+nonce; that refetches only the boundary millisecond, never loses.
  const sinceRaw = url.searchParams.get("since");
  let since = 0;
  if (sinceRaw !== null) {
    since = Number(sinceRaw);
    if (!Number.isSafeInteger(since) || since < 0) return err(400, "bad request");
  }

  const now = Date.now();
  await env.DB.batch(sweepStmts(env, now));

  const members = (
    await env.DB.prepare("SELECT member, alg, pk FROM members WHERE channel = ? ORDER BY member").bind(channel).all()
  ).results;
  const points = (
    await env.DB
      .prepare("SELECT member, ts, srv, n, c FROM points WHERE channel = ? AND srv >= ? ORDER BY srv, ts")
      .bind(channel, since)
      .all()
  ).results;

  const out = new Map();
  for (const r of members) out.set(r.member, { m: r.member, alg: r.alg, pk: r.pk, points: [] });
  for (const r of points) out.get(r.member)?.points.push({ ts: r.ts, srv: r.srv, n: r.n, c: r.c });
  return json(200, { now, members: [...out.values()] });
}

async function route(request, env) {
  const url = new URL(request.url);
  const p = url.pathname;

  if (p === "/api/v1/health") {
    if (request.method !== "GET") return err(405, "method not allowed");
    return json(200, { ok: true });
  }

  const m = /^\/api\/v1\/f\/([^/]+)(\/loc)?$/.exec(p);
  if (!m) return err(404, "not found");
  const [, seg, loc] = m;
  if (!isChannelId(seg)) return err(404, "not found");

  if (loc) {
    if (request.method !== "POST") return err(405, "method not allowed");
    return handlePost(request, env, seg, url);
  }
  if (request.method !== "GET") return err(405, "method not allowed");
  return handleGet(request, env, seg, url);
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch {
      return err(500, "server error");
    }
  },
};
