// Runs relay/src/index.js under plain node:http with a file-backed SQLite database instead of D1.
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import worker from "./src/index.js";
import { makeD1 } from "./d1sqlite.mjs";
import { TTL_MS } from "../app/js/wire.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Margin over MAX_BODY (2048): bounds what a slow client can make the server buffer before the Worker sees it.
const MAX_RAW_BODY = 65536;

const sweepStmts = (env, now) => [
  env.DB.prepare("DELETE FROM points_v3 WHERE srv < ?").bind(now - TTL_MS),
  env.DB.prepare("DELETE FROM members_v3 WHERE srv < ?").bind(now - TTL_MS),
];

// A self-host has no cron trigger, so an idle channel needs this to expire; a busy one sweeps on its own traffic.
function startIdleSweep(env, intervalMs) {
  if (!(intervalMs > 0)) return null;
  const timer = setInterval(() => {
    env.DB.batch(sweepStmts(env, Date.now())).catch(() => {});
  }, intervalMs);
  timer.unref();
  return timer;
}

// TRUST_PROXY is opt-in and reads only the LAST X-Forwarded-For hop, the one the adjacent proxy itself appended.
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

// Drains and discards an oversized body instead of destroying the socket, so the client sees a clean 413, not a reset.
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

// Returns the listenable server, its env (for tests to reach env.DB._raw), and a close() that tears both down.
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
    server.closeAllConnections?.(); // a keep-alive client would otherwise hold server.close()'s callback open indefinitely
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
