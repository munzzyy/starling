// Your own server (munzzyy/starling#10): your own position, in OwnTracks' HTTP
// format, to a server you run. A second destination for a position is also what
// someone holding your phone would set, so these pin that it stays loud, stays
// behind the passcode, and never leaves outside Tor.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { installDom, loadApp, settle } from "./dom-harness.mjs";

const harness = installDom();

globalThis.indexedDB ??= {
  open() {
    throw new Error("no indexeddb in the harness");
  },
  deleteDatabase() {
    const req = {};
    setTimeout(() => req.onsuccess?.(), 0);
    return req;
  },
};

const { internals } = await loadApp(harness);
const state = internals.state;
const { normalizeForward, normalizeForwardTid } = await import("../app/js/env.js");
const { makePasscodeRecord, randomBytes } = await import("../app/js/lock.js");
const { buildDataExport } = await import("../app/js/export.js");

test.after(() => harness.stopTimers());

const kt = (name) =>
  readFileSync(new URL(`../android/app/src/main/kotlin/app/starlingmap/${name}`, import.meta.url), "utf8");

const URL_WITH_KEY = "https://relay.example.org/owntracks?api_key=s3cret";

let sets = [];
let status = { host: null, tor: false, sent: 0, failed: 0, last: 0 };
let accept = true;

function bridge() {
  sets = [];
  globalThis.StarlingNative = {
    startLocation() {},
    stopLocation() {},
    clearStopRecord() {},
    forwardStatus: () => JSON.stringify(status),
    setForward: (url) => {
      sets.push(url);
      return accept;
    },
  };
  internals.resetForwardCache();
  state.demo = false;
  state.lock = null;
}

test("the address rule: https with a host, path and query kept, no user or fragment", () => {
  assert.equal(normalizeForward(URL_WITH_KEY), URL_WITH_KEY);
  assert.equal(normalizeForward("  https://reitti.example.com/api/v1/ingest/owntracks?token=t  "), "https://reitti.example.com/api/v1/ingest/owntracks?token=t");
  for (const bad of [
    "http://relay.example.org/owntracks",
    "https://user:pass@relay.example.org/owntracks",
    "https://relay.example.org/owntracks#frag",
    "ftp://relay.example.org/x",
    "relay.example.org/owntracks",
    "https://",
    "",
    "   ",
    null,
    42,
    "https://relay.example.org/" + "a".repeat(2100),
  ]) {
    assert.equal(normalizeForward(bad), null, String(bad).slice(0, 60));
  }
});

test("without the app lock a valid address goes straight to the wrapper, and \"\" stops it", async () => {
  bridge();
  assert.equal(await internals.saveForward(URL_WITH_KEY), true);
  assert.deepEqual(sets, [URL_WITH_KEY]);
  assert.equal(await internals.saveForward(""), true);
  assert.deepEqual(sets, [URL_WITH_KEY, ""]);
});

test("a bad address never reaches the wrapper, and a wrapper refusal is reported as a failure", async () => {
  bridge();
  assert.equal(await internals.saveForward("http://relay.example.org/owntracks"), false);
  assert.deepEqual(sets, []);
  accept = false;
  try {
    assert.equal(await internals.saveForward(URL_WITH_KEY), false);
  } finally {
    accept = true;
  }
});

test("with the app lock on nothing changes until the passcode is given", async () => {
  bridge();
  state.lock = { enabled: true, pass: null, autolockMs: 60_000 };
  let done = false;
  internals.saveForward(URL_WITH_KEY).then(() => (done = true));
  await settle(50);
  assert.deepEqual(sets, [], "the wrapper is not told while the passcode sheet is open");
  assert.equal(done, false, "the save waits on the passcode");
  state.lock = null;
});

test("the passcode check takes the real passcode and nothing else", async () => {
  const K = randomBytes(32);
  state.lock = { enabled: true, pass: await makePasscodeRecord("2468", K, 1000) };
  try {
    assert.equal(await internals.passcodeMatches("2468"), true);
    assert.equal(await internals.passcodeMatches("1111"), false);
    assert.equal(await internals.passcodeMatches(""), false);
  } finally {
    state.lock = null;
  }
});

test("the line under your name names the host while you share, and not under Tor", async () => {
  const { openGeneration } = await import("../app/js/rekey.js");
  const { epochAt } = await import("../app/js/ratchet.js");
  const { generateIdentity, newSeed } = await import("../app/js/crypto.js");
  state.identity = state.identity || (await generateIdentity());
  if (!state.gen) {
    state.gen = await openGeneration({ seed: new Uint8Array(newSeed()), g: 0, e0: epochAt(Date.now()) });
    state.gen.at = Date.now();
    state.genRoster = new Set();
    state.pinned = new Map();
  }
  await internals.enterCircle();
  assert.equal(state.screen, "map", "the line is on the map screen");
  bridge();
  state.sharing = true;
  state.me = { lat: 40.78, lon: -73.97, ts: Date.now(), acc: 5 };
  status = { host: "relay.example.org", tor: false, sent: 3, failed: 0, last: 200 };
  internals.onShareSignal({ paused: "" });
  assert.match(harness.node("#you-sub").textContent, /also to relay\.example\.org/);
  status = { ...status, tor: true };
  internals.resetForwardCache();
  internals.onShareSignal({ paused: "" });
  assert.doesNotMatch(harness.node("#you-sub").textContent, /also to/);
  status = { host: null, tor: false, sent: 0, failed: 0, last: 0 };
  internals.resetForwardCache();
  state.sharing = false;
});

test("the export names the host, never the address or its key", () => {
  const out = buildDataExport({ profile: {}, settings: {}, places: [], circles: [], pinned: [], forwardHost: "relay.example.org" });
  assert.deepEqual(out.ownServer, { host: "relay.example.org" });
  assert.doesNotMatch(JSON.stringify(out), /s3cret|api_key|owntracks/);
  assert.equal(buildDataExport({ profile: {}, settings: {}, places: [], circles: [], pinned: [] }).ownServer, null);
});

test("the page asks for the passcode before it tells the wrapper", () => {
  const src = readFileSync(new URL("../app/js/main.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("async function saveForward("), src.indexOf("function confirmPasscode("));
  const gate = body.indexOf("if (state.lock?.enabled && !(await confirmPasscode())) return false;");
  const tell = body.indexOf("n.setForward(url)");
  assert.ok(gate > 0 && tell > gate, "the passcode gate comes first");
});

test("the wrapper sends over https only, never under Tor, and never follows a redirect", () => {
  const src = kt("Forward.kt");
  assert.match(src, /if \(u\.scheme\?\.lowercase\(\) != "https" \|\| u\.host\.isNullOrEmpty\(\)\) return null/);
  assert.match(src, /if \(u\.rawUserInfo != null \|\| u\.rawFragment != null\) return null/);
  const send = src.slice(src.indexOf("fun maybeSend("), src.indexOf("fun payload("));
  const tor = send.search(/if \(torOn\(ctx\)\) \{\s*queue\.clear\(\)\s*return\s*\}/);
  assert.ok(tor > 0 && send.indexOf("queue.add(body)") > tor && send.indexOf("sender.execute") > tor, "Tor on empties the queue before anything is queued");
  const drain = src.slice(src.indexOf("private fun drain("), src.indexOf("fun payload("));
  assert.match(
    drain,
    /val target = url\(app\)\s*if \(target == null \|\| torOn\(app\)\) \{\s*queue\.clear\(\)\s*null\s*\} else \{\s*post\(app, target, body\)\s*\}/,
    "every retry checks Tor and the address again",
  );
  assert.match(send, /now - lastAt < MIN_GAP_MS/);
  assert.match(src, /MIN_GAP_MS = 15000L/);
  const post = src.slice(src.indexOf("private fun post("));
  assert.match(post, /c\.instanceFollowRedirects = false/);
  assert.match(post, /c\.connectTimeout = TIMEOUT_MS/);
  assert.match(post, /c\.readTimeout = TIMEOUT_MS/);
  assert.match(post, /finally \{[\s\S]*if \(wake\.isHeld\) wake\.release\(\)/);
});

test("what the page can read back is the host, never the address", () => {
  const src = kt("Forward.kt");
  const status = src.slice(src.indexOf("fun status("), src.indexOf("fun set("));
  assert.match(status, /put\("host", host\(ctx\)/);
  assert.doesNotMatch(status, /url\(ctx\)/);
  const bridgeSrc = kt("StarlingBridge.kt");
  assert.match(bridgeSrc, /fun forwardStatus\(\): String = Forward\.status\(app\)/);
  assert.match(bridgeSrc, /val ok = Forward\.set\(app, url\)\s+if \(ok\) LocationService\.refreshNotification\(\)/);
});

test("it only runs inside a share, and the lock screen never shows the host", () => {
  const svc = kt("LocationService.kt");
  const fix = svc.slice(svc.indexOf("override fun onLocationChanged(location: Location) {"));
  assert.match(fix.slice(0, fix.indexOf("\n    }\n")), /Forward\.maybeSend\(this, location\)/);
  assert.match(svc, /if \(!running\) \{\s+stopAsked = false\s+Forward\.shareStarted\(\)/);
  assert.match(svc, /\.setContentText\(getString\(R\.string\.notif_text\)\)\s+[\s\S]*?\.setContentText\(text\)/);
  assert.match(svc, /val forwardHost = if \(Forward\.torOn\(this\)\) null else Forward\.host\(this\)/);
  const refresh = svc.slice(svc.indexOf("fun refreshNotification()"), svc.indexOf("fun refreshNotification()") + 400);
  assert.match(refresh, /if \(!running\) return/);
});

test("a tracker ID follows the forwarder's rule: up to 64 characters on one line, and \"\" clears it", () => {
  assert.equal(normalizeForwardTid("phone1"), "phone1");
  assert.equal(normalizeForwardTid("  alice  "), "alice");
  assert.equal(normalizeForwardTid(""), "");
  assert.equal(normalizeForwardTid("   "), "");
  assert.equal(normalizeForwardTid("x".repeat(64)), "x".repeat(64));
  for (const bad of ["x".repeat(65), "a\nb", "tab\there", "nul\u0000", "del\u007f", null, 7]) {
    assert.equal(normalizeForwardTid(bad), null, JSON.stringify(bad));
  }
});

test("the tracker ID needs no passcode, and a bad one never reaches the wrapper", async () => {
  bridge();
  const tids = [];
  globalThis.StarlingNative.setForwardTid = (v) => {
    tids.push(v);
    return true;
  };
  state.lock = { enabled: true, pass: null, autolockMs: 60_000 };
  try {
    assert.equal(await internals.saveForwardTid("phone1"), true);
    assert.equal(await internals.saveForwardTid("a\nb"), false);
    assert.equal(await internals.saveForwardTid(""), true);
    assert.deepEqual(tids, ["phone1", ""]);
  } finally {
    state.lock = null;
  }
});

test("a wrapper without setForwardTid is left alone", async () => {
  bridge();
  assert.equal(await internals.saveForwardTid("phone1"), false);
});

test("the wrapper sends tid only when one is set, and reports it back", () => {
  const src = kt("Forward.kt");
  assert.match(src, /fun payload\(l: Location, batt: Int\?, tid: String\? = null\): String/);
  assert.match(src, /if \(tid != null\) o\.put\("tid", tid\)/);
  assert.match(src, /val body = payload\(location, battery\(ctx\), tid\(ctx\)\)/);
  assert.match(src, /\.put\("tid", tid\(ctx\) \?: JSONObject\.NULL\)/);
  assert.match(src, /if \(s\.length > MAX_TID \|\| s\.any \{ it\.code < 0x20 \|\| it\.code == 0x7f \}\) return null/);
  assert.match(src, /MAX_TID = 64/);
  assert.match(kt("StarlingBridge.kt"), /fun setForwardTid\(tid: String\?\): Boolean = Forward\.setTid\(app, tid\)/);
});


test("the wrapper names no phone model, and points waiting on a retry stay in memory and end with the share", () => {
  const src = kt("Forward.kt");
  const post = src.slice(src.indexOf("private fun post("));
  assert.match(post, /c\.setRequestProperty\("User-Agent", USER_AGENT\)\s*c\.outputStream/);
  assert.match(src, /private const val USER_AGENT = "Starling"\n/);
  assert.equal(src.match(/sender\.execute/g).length, 1);
  assert.match(src, /if \(queue\.add\(body\)\) sender\.execute \{ drain\(app\) \}/);
  assert.match(src, /private val queue = ForwardQueue\(\)/);
  assert.match(kt("ForwardQueue.kt"), /class ForwardQueue\(private val capacity: Int = 20\)/);

  const writes = [...src.matchAll(/\.put(?:String|Int|Long|Boolean|Float|StringSet)\((\w+)/g)].map((m) => m[1]);
  assert.deepEqual(writes, ["PREF_TID", "PREF_URL"], "the address and the tracker ID are all it keeps");
  for (const name of ["Forward.kt", "ForwardQueue.kt"]) {
    assert.doesNotMatch(kt(name), /java\.io\.File|openFileOutput|FileOutputStream|writeText|writeBytes|getExternal|cacheDir|filesDir/, name);
  }
  assert.doesNotMatch(kt("ForwardQueue.kt"), /SharedPreferences|Context|import /);

  const set = src.slice(src.indexOf("fun set("), src.indexOf("fun shareStarted("));
  assert.match(set, /queue\.clear\(\)/, "a new address never gets the old one's points");
  assert.match(src, /fun shareStarted\(\) \{\s*queue\.clear\(\)/);
  assert.match(src, /fun shareEnded\(\) = queue\.clear\(\)/);
  const svc = kt("LocationService.kt");
  const destroy = svc.slice(svc.indexOf("override fun onDestroy() {"));
  assert.match(destroy.slice(0, destroy.indexOf("\n    }\n")), /running = false\s*Forward\.shareEnded\(\)/);

  assert.match(src, /fun dropWaiting\(\) = queue\.clear\(\)/);
  const main = kt("MainActivity.kt");
  const tor = main.slice(main.indexOf("fun setTorEnabled("));
  assert.match(
    tor.slice(0, tor.indexOf("\n    }\n")),
    /putBoolean\(PREF_TOR, on\)\.apply\(\)\s*if \(on\) Forward\.dropWaiting\(\)/,
    "turning Tor mode on drops the waiting points then, not at the next fix",
  );
});
