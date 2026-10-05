// The reported bug, driven through the real page: sharing was on, the app got
// closed, and reopening showed sharing off. The unit checks in
// share-resume.test.mjs pin every branch of the decision, but they run against
// a DOM stub that never parses index.html, so none of them can say whether the
// person who reopens the app actually sees sharing back on and a card telling
// them the truth about it.
//
// This creates a circle in headless Chromium with the wrapper bridge planted
// the way the WebView plants it, turns sharing on, then reloads with a swipe
// record waiting, which is what a torn-down process and a fresh launch look
// like from inside the page.
//
// Then the page built with no window after a restart, open and behind the app lock.
//
// Run from the repo root:  node test/e2e_share_resume.mjs
// Ports: 8941 (http), 9341 (devtools). Everything started here is killed.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTTP_PORT = 8941;
const CDP_PORT = 9341;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;

const fails = [];
function check(name, cond, detail = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name} ${detail}`);
    fails.push(name);
  }
}

// What addJavascriptInterface exposes, plus the two calls this is about.
// __stopRecord stands in for the prefs file LocationService writes.
const BRIDGE = `window.StarlingNative = {
  platform: () => "android",
  version: () => "e2e",
  torSupported: () => false,
  bioSupported: () => false,
  startLocation: () => {},
  stopLocation: () => {},
  readStopRecord: () => window.__stopRecord || null,
  clearStopRecord: () => { window.__stopRecord = null; },
  windowShown: () => window.__shown !== false,
  headlessResume: () => window.__headless || "",
  headlessResumeState: (word) => (window.__reports ||= []).push(word),
};`;

async function waitFor(fn, desc, timeout = 25000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${desc}; last ${JSON.stringify(last)}`);
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;
  const listeners = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method && listeners.has(msg.method)) {
      listeners.get(msg.method)(msg.params);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const myId = ++id;
      pending.set(myId, resolve);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) {
      throw new Error(`page threw: ${r.result.exceptionDetails.exception?.description}`);
    }
    return r.result?.result?.value;
  };
  const on = (method, fn) => listeners.set(method, fn);
  return { send, evalJs, on, open: new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }) };
}

// Is the card a person could actually read, rather than one that merely exists
// in the DOM: on screen, not inert, not aria-hidden.
const READ_CARD = `(() => {
  const btn = document.querySelector('[data-testid="alert-stop-record-ok"]');
  const card = btn?.closest("div");
  const state = window.__starlingState();
  const item = window.__starlingInternals.alertItems().find((i) => i.id === "stop-record");
  let seen = false;
  if (card) {
    const r = card.getBoundingClientRect();
    const cs = getComputedStyle(card);
    let blocked = false;
    for (let n = card; n; n = n.parentElement) {
      if (n.inert || n.hasAttribute?.("inert") || n.getAttribute?.("aria-hidden") === "true") blocked = true;
    }
    seen = !blocked && cs.visibility === "visible" && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
  }
  return {
    sharing: state.sharing,
    text: item ? item.text : null,
    seen,
    toasts: [...document.querySelectorAll("#toasts *")].map((t) => t.textContent.trim()).filter(Boolean),
    errs: (window.__starlingErrors || []).slice(0, 5),
  };
})()`;

async function main() {
  const profile = mkdtempSync(path.join(tmpdir(), "starling-resume-e2e-"));
  const server = spawn("node", [path.join(ROOT, "test", "serve_local.mjs"), String(HTTP_PORT)], {
    cwd: ROOT,
    env: { ...process.env, STARLING_TEST: "1", RATE_POST_MIN: "100000", RATE_GET_MIN: "100000" },
    stdio: "ignore",
  });
  const chromium = spawn("chromium", [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    "--user-data-dir=" + profile,
    "--no-sandbox",
    "--disable-gpu",
    "about:blank",
  ], { stdio: "ignore" });

  try {
    await waitFor(async () => {
      const [a, b] = await Promise.all([
        fetch(`${BASE}/api/v2/health`).then((r) => r.ok).catch(() => false),
        fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.ok).catch(() => false),
      ]);
      return a && b;
    }, "server and devtools up");

    const tab = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })).json();
    const c = connect(tab.webSocketDebuggerUrl);
    await c.open;
    await c.send("Page.enable");
    await c.send("Runtime.enable");
    // A wrapped page posts to the canonical relay; send that to the local one instead.
    const cors = [
      { name: "access-control-allow-origin", value: BASE },
      { name: "access-control-allow-methods", value: "GET, POST" },
      { name: "access-control-allow-headers", value: "content-type" },
    ];
    c.on("Fetch.requestPaused", async ({ requestId, request }) => {
      if (request.method === "OPTIONS") {
        await c.send("Fetch.fulfillRequest", { requestId, responseCode: 204, responseHeaders: cors });
        return;
      }
      const u = new URL(request.url);
      const res = await fetch(`${BASE}${u.pathname}${u.search}`, {
        method: request.method,
        headers: request.postData ? { "content-type": "application/json" } : {},
        body: request.postData,
      }).catch(() => null);
      if (!res) {
        await c.send("Fetch.failRequest", { requestId, errorReason: "ConnectionRefused" });
        return;
      }
      const body = Buffer.from(await res.arrayBuffer()).toString("base64");
      await c.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: res.status,
        responseHeaders: [...cors, { name: "content-type", value: res.headers.get("content-type") || "application/json" }],
        body,
      });
    });
    await c.send("Fetch.enable", { patterns: [{ urlPattern: "https://starlingmap.app/*", requestStage: "Request" }] });
    await c.send("Page.addScriptToEvaluateOnNewDocument", { source: BRIDGE });
    await c.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

    await c.send("Page.navigate", { url: BASE + "/" });
    await waitFor(
      () => c.evalJs("!!window.__starlingApi && !document.getElementById('screen-onboarding').hidden"),
      "onboarding on screen",
    );
    await c.evalJs(`document.querySelector('[data-testid="onboarding-create"]').click()`);
    await waitFor(() => c.evalJs(`!!document.querySelector('[data-testid="identity-sheet"]')`), "identity sheet");
    await c.evalJs(`(() => {
      const sheet = document.querySelector('[data-testid="identity-sheet"]');
      [...sheet.querySelectorAll("input[type=text], input:not([type])")].forEach((el, i) => {
        el.value = i === 0 ? "Probe" : "Probe circle";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
    })()`);
    await c.evalJs(`document.querySelector('[data-testid="identity-save"]').click()`);
    await waitFor(() => c.evalJs("window.__starlingState && window.__starlingState().screen === 'map'"), "map after create");
    await c.evalJs(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await sleep(500);

    // Sharing on, from the button, with the wrapper feeding fixes the way the
    // location service does.
    await c.evalJs(`(() => {
      setInterval(() => window.__starlingFix && window.__starlingFix(JSON.stringify({
        lat: 45.06, lon: 13.23, ts: Date.now(), acc: 8,
      })), 1000);
      document.querySelector('[data-testid="share-toggle"]').click();
    })()`);
    await waitFor(() => c.evalJs("window.__starlingState().sharing === true"), "sharing on");
    const armed = await c.evalJs(`(async () => {
      const { dbGet } = await import("/js/store.js");
      const a = await dbGet("shareArmed");
      return a ? { at: a.at, deadline: a.deadline } : null;
    })()`);
    check("turning sharing on writes the share down", !!armed && armed.at > 0, JSON.stringify(armed));
    check("and writes down no position with it", !!armed && !("lat" in armed), JSON.stringify(armed));

    // The swipe: the service writes its record, the process dies, the person
    // opens the app again.
    await c.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__stopRecord = JSON.stringify({ route: "swipe", at: Date.now() - 45000 });`,
    });
    await c.send("Page.reload");
    await waitFor(() => c.evalJs("window.__starlingState && window.__starlingState().screen === 'map'"), "map after reopen");
    await waitFor(() => c.evalJs("window.__starlingState().sharing === true"), "sharing back on after the reopen");

    const after = await c.evalJs(READ_CARD);
    check("the share is on again without anybody touching the toggle", after.sharing === true);
    check("the person is told, not left to notice", after.toasts.some((t) => /back on/i.test(t)), JSON.stringify(after.toasts));
    check("the card is on the glass, not just in the DOM", after.seen === true);
    check(
      "and it says the share came back rather than that closing the app always ends it",
      /put it back on/.test(after.text || "") && !/stops it every time/.test(after.text || ""),
      after.text,
    );
    check("no page errors through any of it", after.errs.length === 0, JSON.stringify(after.errs));

    // The other half of the rule, on the same page: a Stop the person pressed
    // is a decision, and reopening does not undo it.
    await c.evalJs(`document.querySelector('[data-testid="share-toggle"]').click()`);
    await waitFor(() => c.evalJs("window.__starlingState().sharing === false"), "sharing off");
    await c.evalJs(`document.querySelector('[data-testid="share-toggle"]').click()`);
    await waitFor(() => c.evalJs("window.__starlingState().sharing === true"), "sharing on again");
    await c.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__stopRecord = JSON.stringify({ route: "notif", at: Date.now() });`,
    });
    await c.send("Page.reload");
    await waitFor(() => c.evalJs("window.__starlingState && window.__starlingState().screen === 'map'"), "map after the second reopen");
    await sleep(2500);
    const stopped = await c.evalJs(READ_CARD);
    check("a Stop from the notification is not undone by reopening", stopped.sharing === false);
    check("and that card names the notification instead", /notification/i.test(stopped.text || ""), stopped.text);

    // A restart with Also after a restart on.
    await c.evalJs(`document.querySelector('[data-testid="share-toggle"]').click()`);
    await waitFor(() => c.evalJs("window.__starlingState().sharing === true"), "sharing on before the restart");
    await c.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__stopRecord = null; window.__headless = "boot"; window.__shown = false;`,
    });
    await c.send("Page.reload");
    await waitFor(() => c.evalJs("(window.__reports || []).includes('started')"), "the page reports started");
    await c.evalJs(`window.__starlingFix(JSON.stringify({ lat: 45.06, lon: 13.23, ts: Date.now(), acc: 8 }))`);
    await waitFor(() => c.evalJs("(window.__reports || []).includes('delivered')"), "the page reports delivered");
    const headless = await c.evalJs(`(() => ({
      reports: window.__reports,
      sharing: window.__starlingState().sharing,
      offgrid: document.getElementById("map").classList.contains("offgrid"),
      tiles: document.querySelectorAll('#map img.leaflet-tile').length,
      warmed: !!document.querySelector('link[href="https://tile.openstreetmap.org"]'),
      toasts: [...document.querySelectorAll("#toasts *")].map((t) => t.textContent.trim()).filter(Boolean),
      card: window.__starlingInternals.alertItems().find((i) => i.id === "auto-resumed")?.title || null,
      errs: (window.__starlingErrors || []).slice(0, 5),
    }))()`);
    check("the share came back with nobody at the window", headless.sharing === true);
    check("and said so once, then said its first post got through", JSON.stringify(headless.reports) === '["started","delivered"]', JSON.stringify(headless.reports));
    check("no map tiles and no tile host warmed while nobody looks", headless.offgrid && headless.tiles === 0 && !headless.warmed, JSON.stringify(headless));
    check("no toast for nobody", !headless.toasts.some((t) => /back on/i.test(t)), JSON.stringify(headless.toasts));
    check("the card is waiting for whoever opens the app", headless.card === "Sharing came back on by itself", headless.card);
    check("no page errors with no window", headless.errs.length === 0, JSON.stringify(headless.errs));

    await c.evalJs(`window.__shown = true; document.dispatchEvent(new Event("visibilitychange"))`);
    const looked = await c.evalJs(`!document.getElementById("map").classList.contains("offgrid")`);
    check("the map gets its saved basemap the first time a window shows it", looked === true);

    // The same restart behind the app lock: a locked page holds no keys.
    check("the app lock goes on", (await c.evalJs(`window.__starlingInternals.enableLock("2468")`)) === true);
    await c.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__reports = []; window.__shown = false;` });
    await c.send("Page.reload");
    await waitFor(() => c.evalJs("(window.__reports || []).length > 0"), "the locked page reports");
    await sleep(1500);
    const locked = await c.evalJs(`({ reports: window.__reports, sharing: window.__starlingState().sharing, screen: window.__starlingState().screen })`);
    check("behind the app lock the page reports locked and nothing else", JSON.stringify(locked.reports) === '["locked"]', JSON.stringify(locked));
    check("and shares nothing", locked.sharing === false && locked.screen === "lock", JSON.stringify(locked));
  } finally {
    chromium.kill();
    server.kill();
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }

  if (fails.length) {
    console.log(`\n${fails.length} failed: ${fails.join(", ")}`);
    process.exit(1);
  }
  console.log("\nshare resume e2e: all checks passed");
}

main().catch((e) => {
  console.error("e2e failed:", e.stack || e.message);
  process.exit(1);
});
