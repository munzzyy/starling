// Run the relay worker plus the static app as one local HTTP server, the same
// shape production has (Workers assets with run_worker_first on /api/*).
// Not for production.
//   node test/serve_local.mjs [port]
// STARLING_TEST=1 additionally registers GET /debug/dump (raw DB rows).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../relay/src/index.js";
import { makeD1 } from "./d1shim.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, "..", "app");
const port = Number(process.argv[2]) || 8899;
const TEST_MODE = process.env.STARLING_TEST === "1";

const db = makeD1();
const env = { DB: db, RATE_POST_MIN: process.env.RATE_POST_MIN, RATE_GET_MIN: process.env.RATE_GET_MIN };

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Mirrors app/_headers, which Workers assets applies in production.
const STATIC_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "geolocation=(self), camera=(), microphone=()",
  "cross-origin-opener-policy": "same-origin",
};

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${port}`).pathname);
  } catch {
    res.statusCode = 400;
    return res.end("bad request");
  }

  if (pathname.startsWith("/api/")) {
    const init = { method: req.method, headers: { ...req.headers } };
    if (body.length && req.method !== "GET" && req.method !== "HEAD") init.body = body;
    init.headers["cf-connecting-ip"] = req.socket.remoteAddress || "127.0.0.1";
    const resp = await worker.fetch(new Request(`http://127.0.0.1:${port}${req.url}`, init), env);
    res.statusCode = resp.status;
    resp.headers.forEach((v, k) => res.setHeader(k, v));
    return res.end(Buffer.from(await resp.arrayBuffer()));
  }

  if (TEST_MODE && pathname === "/debug/dump" && req.method === "GET") {
    const dump = {
      members: db._raw.prepare("SELECT * FROM members").all(),
      points: db._raw.prepare("SELECT * FROM points").all(),
    };
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    return res.end(JSON.stringify(dump));
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    return res.end("method not allowed");
  }

  const rel = pathname === "/" ? "/index.html" : pathname;
  const fp = path.resolve(APP_DIR, "." + rel);
  if (fp !== APP_DIR && !fp.startsWith(APP_DIR + path.sep)) {
    res.statusCode = 404;
    return res.end("not found");
  }
  let data;
  try {
    data = fs.readFileSync(fp);
  } catch {
    res.statusCode = 404;
    return res.end("not found");
  }
  res.statusCode = 200;
  for (const [k, v] of Object.entries(STATIC_HEADERS)) res.setHeader(k, v);
  res.setHeader("content-type", TYPES[path.extname(fp).toLowerCase()] || "application/octet-stream");
  return res.end(req.method === "HEAD" ? undefined : data);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`starling local on http://127.0.0.1:${port}${TEST_MODE ? " (test mode: /debug/dump on)" : ""}`);
});
