// Starling relay: a zero-knowledge drop box for ciphertext location posts.
// It stores (channel, member, epoch, ts, nonce, ciphertext) rows, verifies
// signatures against keys pinned on first write, and expires everything
// after TTL_MS. It never sees plaintext, names, or any key that decrypts
// anything, and it must never log request data.

import {
  MAX_BODY,
  MEMBER_CAP,
  TRAIL_CAP,
  TTL_MS,
  FUTURE_SKEW_MS,
  b64uDecode,
  memberIdFromKeys,
  isChannelId,
  sigBase,
  verifySig,
  checkPostShape,
  epochPlausible,
} from "../../app/js/wire.js";

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  // Force HTTPS on the apex domain and all subdomains, preload-eligible.
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
};

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: HEADERS });
}

const err = (status, msg) => json(status, { error: msg });

// A v1 client hitting this fails loudly rather than syncing into a channel
// nobody else is on: v1's channel derivation and v2's are different secrets,
// so there is no member on the other end regardless of what the relay does.
const V1_RETIRED = { error: "protocol v1 retired", upgrade: "https://starlingmap.app" };
const retired = () => json(410, V1_RETIRED);

function envInt(v, dflt) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : dflt;
}

// Per-isolate sliding-window rate limiter. Each key holds the timestamps of
// requests allowed in the last minute. The map is capped and drops its oldest
// key, so scanning many channels or IPs cannot grow it without bound.
const RATE_WINDOW_MS = 60_000;
const RATE_KEYS_MAX = 4096;

// The per-channel POST budget has to sit above what a full circle costs when
// nothing is wrong, or the limiter's first victim is the circle itself.
//
// A sharing member posts on a fixed 15 s cadence, so 4 posts a minute each,
// and a channel holds at most MEMBER_CAP of them: 64 posts a minute of pure
// steady traffic. The old default of 60 was under that floor, which meant a
// full circle rate-limited itself and the relay answered honest members with
// 429 while they believed they were visible.
//
// The default is that floor times four. The headroom is not decoration: a
// re-key adds one wrap per member in a single burst, a "bye" and an SOS ride
// the same path, and with movement posting on (the default) a member sends
// again whenever they have moved 25 m, which in a vehicle is far more often
// than every 15 s. Sixteen people all moving fast can still reach this, and a
// self-hoster whose circle does that should raise RATE_POST_MIN; the value is
// a var for exactly that reason. See relay/wrangler.toml.
const POSTS_PER_MEMBER_MIN = 4;
const RATE_POST_HEADROOM = 4;
const DEFAULT_RATE_POST_MIN = MEMBER_CAP * POSTS_PER_MEMBER_MIN * RATE_POST_HEADROOM;

// Per address, shared by reads and writes. A whole circle behind one NAT, one
// VPN exit or one Tor circuit is the population this app is built for, and it
// costs MEMBER_CAP * (4 posts + 6 polls) = 160 requests a minute, which this
// clears. Self-hosters with more than one circle behind a single address raise
// it.
const DEFAULT_RATE_IP_MIN = 240;

// One map per namespace. Sharing a single map let cheap keys evict expensive
// ones: channel ids are attacker-chosen and unlimited, so spraying random
// channels would push every IP bucket out of a shared map and hand the
// sprayer an unlimited budget. An address cannot evict itself out of a map
// that only ever holds addresses.
const rateBuckets = { c: new Map(), i: new Map() };

function rateLimited(ns, key, limit, now) {
  const buckets = rateBuckets[ns];
  const hits = buckets.get(key) || [];
  buckets.delete(key);
  while (hits.length && hits[0] <= now - RATE_WINDOW_MS) hits.shift();
  const limited = hits.length >= limit;
  if (!limited) hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > RATE_KEYS_MAX) buckets.delete(buckets.keys().next().value);
  return limited;
}

// Deterministic TTL sweep, run on every feed request.
const sweepStmts = (env, now) => [
  env.DB.prepare("DELETE FROM points_v3 WHERE srv < ?").bind(now - TTL_MS),
  env.DB.prepare("DELETE FROM members_v3 WHERE srv < ?").bind(now - TTL_MS),
];

// Origins allowed to write. The Android wrapper serves the same app from
// bundled assets on WebView's fixed pseudo-origin, so it is allowed alongside
// the relay's own origin; posts are signature-checked regardless, this check
// only stops drive-by CSRF from arbitrary websites. Self-hosters can extend
// the list with a comma-separated ALLOWED_ORIGINS var.
const APP_ORIGINS = ["https://appassets.androidplatform.net"];

function originAllowed(origin, env, url) {
  if (origin === null) return true;
  if (origin === url.origin || APP_ORIGINS.includes(origin)) return true;
  return envOrigins(env).includes(origin);
}

// Entries are normalized to canonical origin form, so a trailing slash or
// uppercase host in the var cannot silently never-match a real Origin header.
function envOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return new URL(s).origin;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// CORS: the wrapper's WebView fetches the API from its own asset origin, so
// allowed cross origins get their Origin echoed back; everyone else gets no
// header and the browser blocks the read. Writes stay guarded by
// originAllowed + signatures regardless; CORS only opens the read path, and
// reading requires the unguessable channel id either way.
function corsHeaders(origin, env, url) {
  if (origin === null || origin === url.origin) return {};
  if (!originAllowed(origin, env, url)) return {};
  return { "access-control-allow-origin": origin, vary: "origin" };
}

async function handlePost(request, env, channel, url) {
  const origin = request.headers.get("origin");
  if (!originAllowed(origin, env, url)) return err(403, "forbidden");

  // Rate limits first, ahead of every database read and the signature check.
  //
  // These are the only checks that cost nothing: two in-memory array walks,
  // no I/O, no crypto. Running them last, as this did, meant a request that
  // was going to be refused anyway had already spent two D1 round trips and
  // an Ed25519 verification getting there, so the limiter bounded what
  // reached storage and not what reached the CPU. Any 32 hex characters name
  // a channel, so an attacker picking a fresh channel per request never met
  // the per-channel limit at all and the per-address budget was the only
  // thing standing between a spray and unbounded work. Cheapest first.
  const now = Date.now();
  const ip = request.headers.get("cf-connecting-ip") || "";
  if (
    rateLimited("i", ip, envInt(env.RATE_GET_MIN, DEFAULT_RATE_IP_MIN), now) ||
    rateLimited("c", channel, envInt(env.RATE_POST_MIN, DEFAULT_RATE_POST_MIN), now)
  ) {
    return err(429, "rate limited");
  }

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

  let pkBytes, epkBytes;
  try {
    pkBytes = b64uDecode(body.pk);
    epkBytes = b64uDecode(body.epk);
  } catch {
    return err(400, "bad request");
  }
  // The member id commits to both keys, so recomputing it here and requiring
  // it to equal the posted m is what stops a relay, or anyone else, from
  // pairing a signing key with an agreement key of their choosing.
  if ((await memberIdFromKeys(pkBytes, epkBytes)) !== body.m) return err(403, "forbidden");

  if (body.ts > now + FUTURE_SKEW_MS) return err(400, "bad request");
  // Bounds-check only: the relay's clock is untrusted and this exists to keep
  // junk out of storage, not to decide which key a receiver uses.
  //
  // It gets its own error string rather than a generic 400 because of what it
  // means to the person holding the phone. A device whose clock is wrong by
  // more than the skew tolerance cannot be seen by its circle at all, and the
  // one thing worse than that happening is it happening silently while someone
  // is relying on being visible. The client turns this into "your clock is
  // wrong", not "network error".
  if (!epochPlausible(body.e, now)) return err(400, "clock");

  const pinned = await env.DB
    .prepare("SELECT alg, pk, epk, last_ts FROM members_v3 WHERE channel = ? AND member = ?")
    .bind(channel, body.m)
    .first();
  if (pinned) {
    if (pinned.alg !== body.alg || pinned.pk !== body.pk || pinned.epk !== body.epk) return err(403, "forbidden");
    if (body.ts <= pinned.last_ts) return err(409, "conflict");
  } else {
    // Early reject for the sequential case; the batch below enforces the cap
    // atomically, so this read is a fast path, not the guard.
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM members_v3 WHERE channel = ?").bind(channel).first();
    if (row.n >= MEMBER_CAP) return err(403, "forbidden");
  }

  let sigBytes;
  try {
    sigBytes = b64uDecode(body.sig);
  } catch {
    return err(403, "forbidden");
  }
  const base = sigBase(channel, body.m, body.e, body.ts, body.n, body.c);
  if (!(await verifySig(body.alg, pkBytes, sigBytes, base))) return err(403, "forbidden");

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
          "INSERT INTO members_v3 (channel, member, alg, pk, epk, last_ts, srv) " +
            "SELECT ?, ?, ?, ?, ?, ?, ? " +
            "WHERE EXISTS (SELECT 1 FROM members_v3 WHERE channel = ? AND member = ?) " +
            "OR (SELECT COUNT(*) FROM members_v3 WHERE channel = ?) < ? " +
            // last_ts only ever moves forward. Two concurrent posts from one
            // member can both pass the read-side replay check above, and if
            // the older one lands second a blind assignment would walk the
            // pin backwards and re-open the window it exists to close.
            "ON CONFLICT (channel, member) DO UPDATE SET " +
            "last_ts = MAX(members_v3.last_ts, excluded.last_ts), srv = excluded.srv",
        )
        .bind(channel, body.m, body.alg, body.pk, body.epk, body.ts, now, channel, body.m, channel, MEMBER_CAP),
      env.DB
        .prepare(
          "INSERT INTO points_v3 (channel, member, e, ts, srv, n, c, sig) " +
            "SELECT ?, ?, ?, ?, ?, ?, ?, ? " +
            "WHERE EXISTS (SELECT 1 FROM members_v3 WHERE channel = ? AND member = ?)",
        )
        .bind(channel, body.m, body.e, body.ts, now, body.n, body.c, body.sig, channel, body.m),
      env.DB
        .prepare(
          "DELETE FROM points_v3 WHERE channel = ? AND member = ? AND ts NOT IN " +
            "(SELECT ts FROM points_v3 WHERE channel = ? AND member = ? ORDER BY ts DESC LIMIT ?)",
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
  if (rateLimited("i", ip, envInt(env.RATE_GET_MIN, DEFAULT_RATE_IP_MIN), Date.now())) return err(429, "rate limited");

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
    await env.DB
      .prepare("SELECT member, alg, pk, epk FROM members_v3 WHERE channel = ? ORDER BY member")
      .bind(channel)
      .all()
  ).results;
  const points = (
    await env.DB
      .prepare("SELECT member, e, ts, srv, n, c, sig FROM points_v3 WHERE channel = ? AND srv >= ? ORDER BY srv, ts")
      .bind(channel, since)
      .all()
  ).results;

  const out = new Map();
  for (const r of members) out.set(r.member, { m: r.member, alg: r.alg, pk: r.pk, epk: r.epk, points: [] });
  // sig and e travel with every point: receivers verify and pick their own
  // key rather than taking the relay's word for either.
  for (const r of points) out.get(r.member)?.points.push({ e: r.e, ts: r.ts, srv: r.srv, n: r.n, c: r.c, sig: r.sig });
  return json(200, { now, members: [...out.values()] });
}

// Digital Asset Links: proves to Android that the app and this origin belong
// together, so starlingmap.app links open straight in the installed app.
// Served by the worker because verification is strict about the exact path,
// the content type, and following no redirects. The first fingerprint is the
// developer upload key that signs sideloaded and F-Droid builds; the Play App
// Signing fingerprint joins it once Google mints one.
const ASSETLINKS = [
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: "app.starlingmap",
      sha256_cert_fingerprints: [
        "DB:B0:C4:91:53:0F:74:75:40:9C:4C:29:53:E9:F6:8A:52:51:9C:2F:68:1D:D9:E5:F6:99:38:F3:BF:9B:8C:9E",
      ],
    },
  },
];

async function route(request, env) {
  const url = new URL(request.url);
  const p = url.pathname;

  if (p === "/.well-known/assetlinks.json") {
    if (request.method !== "GET") return err(405, "method not allowed");
    return new Response(JSON.stringify(ASSETLINKS), {
      status: 200,
      headers: { ...HEADERS, "content-type": "application/json", "cache-control": "max-age=3600" },
    });
  }

  // v1 fails loudly rather than syncing into silence against a channel
  // nobody else is on: v1 and v2 derive different channel ids from the same
  // circle secret, so a v1 client polling here would just see an empty feed
  // forever with no signal anything is wrong.
  if (p.startsWith("/api/v1/")) return retired();

  if (p === "/api/v2/health") {
    if (request.method !== "GET") return err(405, "method not allowed");
    return json(200, { ok: true });
  }

  const m = /^\/api\/v2\/f\/([^/]+)(\/loc)?$/.exec(p);
  if (!m) return err(404, "not found");
  const [, seg, loc] = m;
  if (!isChannelId(seg)) return err(404, "not found");

  if (request.method === "OPTIONS") {
    const origin = request.headers.get("origin");
    const cors = corsHeaders(origin, env, url);
    if (!cors["access-control-allow-origin"]) return err(403, "forbidden");
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
      },
    });
  }

  if (loc) {
    if (request.method !== "POST") return err(405, "method not allowed");
    return handlePost(request, env, seg, url);
  }
  if (request.method !== "GET") return err(405, "method not allowed");
  return handleGet(request, env, seg, url);
}

// Feed and post responses carry CORS headers for allowed foreign origins; the
// route handlers themselves stay origin-unaware.
async function withCors(request, env, response) {
  const url = new URL(request.url);
  if (!/^\/api\/v2\/f\//.test(url.pathname)) return response;
  const cors = corsHeaders(request.headers.get("origin"), env, url);
  if (!cors["access-control-allow-origin"]) return response;
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env) {
    try {
      return await withCors(request, env, await route(request, env));
    } catch {
      return err(500, "server error");
    }
  },
};
