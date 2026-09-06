// The installed app is the app, not the website. This drives the REAL page in
// headless Chromium twice over CDP: once with window.StarlingNative injected
// before any page script runs (exactly what the Android WebView's
// addJavascriptInterface does), once bare. Inside the wrapper the marketing
// sections must be gone from the DOM entirely and the one link out to the
// site revealed; on the web every section stays and the link never shows.
//
// Chromium because only CDP's Page.addScriptToEvaluateOnNewDocument can plant
// the bridge before module scripts execute; Marionette cannot. Node's
// built-in WebSocket keeps this dependency-free.
//
// Run from the repo root:  node test/e2e_wrapper.mjs
// Ports: 8933 (http), 9334 (devtools). Everything started here is killed.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTTP_PORT = 8933;
const CDP_PORT = 9334;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const SHOTS = path.join(ROOT, "test", "screenshots");

const fails = [];
function check(name, cond, detail = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name} ${detail}`);
    fails.push(name);
  }
}

const BRIDGE_STUB = `window.StarlingNative = {
  platform: () => "android",
  version: () => "e2e",
  torSupported: () => false,
  bioSupported: () => false,
  startLocation: () => {},
  stopLocation: () => {},
};`;

async function waitFor(fn, desc, timeout = 20000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${desc}; last: ${JSON.stringify(last)}`);
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const myId = ++id;
      pending.set(myId, resolve);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true });
    if (r.result?.exceptionDetails) {
      throw new Error(`page threw: ${JSON.stringify(r.result.exceptionDetails.exception?.description)}`);
    }
    return r.result?.result?.value;
  };
  return {
    send,
    evalJs,
    open: new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    }),
    close: () => ws.close(),
  };
}

async function newTab() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" });
  const tab = await res.json();
  const c = connect(tab.webSocketDebuggerUrl);
  await c.open;
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  return c;
}

async function bootAndRead(c, { wrapper }) {
  if (wrapper) await c.send("Page.addScriptToEvaluateOnNewDocument", { source: BRIDGE_STUB });
  await c.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await c.send("Page.navigate", { url: BASE + "/" });
  await waitFor(
    () => c.evalJs("!!window.__starlingApi && !document.getElementById('screen-onboarding').hidden"),
    "onboarding on screen",
  );
  return c.evalJs(`(() => {
    const about = document.getElementById("ob-about");
    return {
      webOnly: document.querySelectorAll(".web-only").length,
      landingApp: !!document.getElementById("landing-app"),
      installCard: (() => { const c = document.getElementById("install-card"); return !!c && !c.hidden; })(),
      faq: !!document.querySelector(".lnd-faq"),
      footer: !!document.querySelector(".land-footer"),
      aboutShown: !!about && !about.hidden,
      aboutHref: document.getElementById("about-site")?.getAttribute("href") ?? null,
      createShown: !document.querySelector('[data-testid="onboarding-create"]').hidden,
      demoShown: !document.querySelector('[data-testid="onboarding-demo"]').hidden,
      errs: (window.__starlingErrors || []).slice(0, 5),
    };
  })()`);
}

async function main() {
  const profile = mkdtempSync(path.join(tmpdir(), "starling-wrapper-e2e-"));
  const server = spawn("node", [path.join(ROOT, "test", "serve_local.mjs"), String(HTTP_PORT)], {
    cwd: ROOT,
    env: { ...process.env, STARLING_TEST: "1", RATE_POST_MIN: "100000", RATE_GET_MIN: "100000" },
    stdio: "ignore",
  });
  const chromium = spawn(
    "chromium",
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      "--user-data-dir=" + profile,
      "--no-sandbox",
      "--disable-gpu",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  try {
    await waitFor(async () => {
      try {
        const [a, b] = await Promise.all([
          fetch(`${BASE}/api/v2/health`).then((r) => r.ok).catch(() => false),
          fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.ok).catch(() => false),
        ]);
        return a && b;
      } catch {
        return false;
      }
    }, "server and devtools up");

    const wrap = await newTab();
    const w = await bootAndRead(wrap, { wrapper: true });
    check("wrapper: every web-only section removed from the DOM", w.webOnly === 0, String(w.webOnly));
    check("wrapper: no APK download card inside the app", !w.landingApp);
    check("wrapper: no install-yourself nudge inside the app", !w.installCard);
    check("wrapper: no FAQ, no site footer", !w.faq && !w.footer);
    check("wrapper: about link shown and points at the bare site", w.aboutShown && w.aboutHref === "https://starlingmap.app/", w.aboutHref);
    check("wrapper: create and demo buttons present", w.createShown && w.demoShown);
    check("wrapper: console clean", w.errs.length === 0, JSON.stringify(w.errs));
    const shot = await wrap.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.join(SHOTS, "22-wrapper-start.png"), Buffer.from(shot.result.data, "base64"));
    wrap.close();

    const web = await newTab();
    const v = await bootAndRead(web, { wrapper: false });
    check("web: all seven web-only sections still present", v.webOnly === 7, String(v.webOnly));
    check("web: download card still exists", v.landingApp);
    check("web: about link never shows", !v.aboutShown);
    check("web: console clean", v.errs.length === 0, JSON.stringify(v.errs));

    // The demo tours Places with invented spots: two rings, off-grid, banner up.
    await web.send("Page.navigate", { url: BASE + "/?demo=1" });
    await waitFor(
      () => web.evalJs("!!window.__starlingApi && window.__starlingApi.state.demo === true"),
      "demo running",
    );
    await waitFor(
      () => web.evalJs("document.querySelectorAll('.place-ring').length === 2"),
      "two demo place rings",
    );
    const demoState = await web.evalJs(`(() => ({
      offgrid: document.getElementById("map").classList.contains("offgrid"),
      banner: !document.getElementById("banner-demo").hidden,
      tags: [...document.querySelectorAll(".place-tag")].map((t) => t.textContent).sort().join(","),
      errs: (window.__starlingErrors || []).slice(0, 5),
    }))()`);
    check("demo: forced off-grid with the banner up", demoState.offgrid && demoState.banner);
    check("demo: the invented places are Home and The fountain", demoState.tags === "Home,The fountain", demoState.tags);
    check("demo: console clean", demoState.errs.length === 0, JSON.stringify(demoState.errs));
    web.close();
  } finally {
    chromium.kill();
    server.kill();
    rmSync(profile, { recursive: true, force: true });
  }
  if (fails.length) {
    console.log("FAILS:", fails.join("; "));
    process.exit(1);
  }
  console.log("E2E WRAPPER PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
