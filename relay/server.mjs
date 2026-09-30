// Plain-server relay: the same Worker (src/index.js) served over node:http
// with a file-backed SQLite database standing in for D1. This is the whole
// self-host escape hatch described in docs/TOR.md and docs/SELF-HOSTING.md:
// fetch-in, fetch-out, one SQL table, no Cloudflare account required.
//
// createServer() is the part a test drives directly, in-process, on a random
// port. main() at the bottom is the CLI entry point: env vars in, a listening
// server out, SIGTERM/SIGINT stop it cleanly.
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import worker from "./src/index.js";
import { makeD1 } from "./d1sqlite.mjs";
import { TTL_MS } from "../app/js/wire.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// A margin over MAX_BODY (2048, enforced inside the Worker once it has
// parsed the body): this only bounds what a slow or hostile client can make
// the server buffer in memory before the Worker ever sees it, so it does not
// have to track the wire constant exactly.
const MAX_RAW_BODY = 65536;

const sweepStmts = (env, now) => [
  env.DB.prepare("DELETE FROM points_v3 WHERE srv < ?").bind(now - TTL_MS),
  env.DB.prepare("DELETE FROM members_v3 WHERE srv < ?").bind(now - TTL_MS),
];

// The relay's own per-request sweep (relay/src/index.js) only ever touches a
// channel someone is actively polling or posting to. A channel nobody comes
// back to, an abandoned invite or a circle someone left, would otherwise sit
// in the file forever on a self-host instead of expiring with the rest. This
// timer is the plain-server equivalent of the cron trigger a Cloudflare
// deploy could add; the default relay does not run one either, for the same
// reason a busy relay does not need one: real traffic sweeps as it goes.
function startIdleSweep(env, intervalMs) {
  if (!(intervalMs > 0)) return null;
  const timer = setInterval(() => {
    try {
      env.DB.batch(sweepStmts(env, Date.now()));
    } catch {
      // Never let a sweep failure take the process down; the next request's
      // own inline sweep, or the next timer tick, tries again.
    }
  }, intervalMs);
  timer.unref();
  return timer;
}

// Behind a reverse proxy every request otherwise arrives from the proxy's own
// address, and the per-address rate limiter (RATE_GET_MIN) would treat an
// entire user base as one client. TRUST_PROXY is opt-in and off by default:
// trusting X-Forwarded-For from an untrusted client would let anyone spoof
// their rate-limit identity by sending the header themselves. With it on,
// only the LAST hop is used, the one the proxy in front of this process
// appended; that is the one thing the process directly behind a single
// reverse proxy can trust, because the proxy appends after whatever a client
// sent.
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) {
      const hops = String(xff).split(",").map((s) => s.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1];
    }
  }
  return req.socket.remoteAddress || "";
}

// Draining and discarding the rest of an oversized body, rather than
// destroying the socket mid-request, is what lets the client see a clean 413
// instead of a connection reset: destroying the socket while the client is
// still mid-write races their write against our RST and shows up to them as
// a transport failure, not an HTTP response.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_RAW_BODY) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(tooLarge ? { tooLarge: true } : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function errorResponse(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function toWebResponse(req, env, opts) {
  let body;
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    body = await readBody(req);
    if (body && body.tooLarge) return errorResponse(413, "too large");
  }

  const url = new URL(req.url, opts.publicOrigin);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (k === "host") continue; // the Fetch Request constructor rejects a Host header
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  headers.set("cf-connecting-ip", clientIp(req, opts.trustProxy));

  const init = { method: req.method, headers };
  if (body !== undefined) init.body = body;
  const request = new Request(url, init);

  try {
    return await worker.fetch(request, env);
  } catch {
    return errorResponse(500, "server error");
  }
}

async function writeWebResponse(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

// The pieces a test needs to drive: a listenable http.Server sharing the
// relay's own env (so a test can inspect env.DB._raw the same way
// relay.test.mjs does), and a close() that tears down the timer and the
// database handle along with the socket.
export function createServer({
  dbPath = ":memory:",
  trustProxy = false,
  publicOrigin,
  rateVars = {},
  sweepIntervalMs = 10 * 60_000,
} = {}) {
  const env = {
    DB: makeD1(dbPath),
    ...rateVars,
  };
  const opts = { trustProxy, publicOrigin: publicOrigin || "http://127.0.0.1" };

  const server = http.createServer((req, res) => {
    toWebResponse(req, env, opts)
      .then((response) => writeWebResponse(res, response))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "server error" }));
      });
  });

  const sweepTimer = startIdleSweep(env, sweepIntervalMs);

  async function close() {
    if (sweepTimer) clearInterval(sweepTimer);
    const closed = new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    // server.close() alone waits for every open socket to end on its own,
    // which a keep-alive client (a browser, or Node's own fetch) can hold
    // open well past the request that used it. This is a clean shutdown, not
    // a timeout: it ends currently-idle keep-alive sockets immediately and
    // lets any request actually in flight finish first.
    server.closeAllConnections?.();
    await closed;
    env.DB.close();
  }

  return { server, env, close };
}

async function main() {
  const port = Number(process.env.PORT) || 8788;
  const host = process.env.HOST || "127.0.0.1";
  const dbPath = process.env.STARLING_DB_PATH || path.join(HERE, "data", "starling.db");
  const trustProxy = process.env.TRUST_PROXY === "1";
  const publicOrigin = process.env.PUBLIC_ORIGIN || `http://${host}:${port}`;
  const sweepIntervalMs = process.env.SWEEP_INTERVAL_MS ? Number(process.env.SWEEP_INTERVAL_MS) : 10 * 60_000;

  const { server, env, close } = createServer({
    dbPath,
    trustProxy,
    publicOrigin,
    sweepIntervalMs,
    rateVars: {
      RATE_POST_MIN: process.env.RATE_POST_MIN,
      RATE_GET_MIN: process.env.RATE_GET_MIN,
      ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
      TRIM_EVERY: process.env.TRIM_EVERY,
    },
  });

  server.listen(port, host, () => {
    console.log(`starling relay listening on http://${host}:${port} (db: ${dbPath})`);
    if (trustProxy) console.log("TRUST_PROXY=1: trusting the last X-Forwarded-For hop for rate limiting");
  });

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: closing`);
    try {
      await close();
      process.exit(0);
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
