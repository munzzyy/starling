// Every circle event names its kind, so the wrapper can give arrivals,
// departures and check-ins channels of their own (issue #24) while an SOS
// keeps the urgent path it always had. Driven through the real roster and
// checkAlerts; the Kotlin half is pinned as source and in EventsChannelTest.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { installDom, loadApp } from "./dom-harness.mjs";

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
const { openGeneration } = await import("../app/js/rekey.js");
const { epochAt } = await import("../app/js/ratchet.js");
const { generateIdentity, newSeed, sealMessage, buildPost } = await import("../app/js/crypto.js");
const { b64uEncode } = await import("../app/js/wire.js");

test.after(() => {
  delete globalThis.StarlingNative;
  harness.stopTimers();
});

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const kt = (name) => src(`android/app/src/main/kotlin/app/starlingmap/${name}`);

const KINDS = ["sos", "arrive", "leave", "checkin", "battery", "other"];

// The top-level arguments of the call that opens at `at`, strings and templates skipped whole.
function callArgs(text, at) {
  const args = [];
  let depth = 0;
  let start = text.indexOf("(", at) + 1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      i = j;
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) {
        args.push(text.slice(start, i).trim());
        return args;
      }
      depth--;
    } else if (c === "," && depth === 0) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  throw new Error("unclosed call");
}

test("every notifyEvent call in the app names a kind the wrapper knows", () => {
  const main = src("app/js/main.js");
  const calls = [...main.matchAll(/\bnotifyEvent\(/g)].filter((m) => !main.slice(m.index - 9, m.index).includes("function"));
  assert.ok(calls.length >= 10, `found ${calls.length} calls`);
  for (const m of calls) {
    const args = callArgs(main, m.index);
    const line = main.slice(m.index, main.indexOf("\n", m.index));
    assert.equal(args.length, 4, `four arguments: ${line}`);
    const kind = args[3];
    if (kind === "ev.type") continue;
    const lit = kind.match(/^"(\w+)"$/)?.[1];
    assert.ok(lit && KINDS.includes(lit), `a known kind literal, not ${kind}: ${line}`);
  }
  const kinds = calls.map((m) => callArgs(main, m.index)[3]);
  assert.equal(kinds.filter((k) => k === '"sos"').length, 3, "an SOS, an SOS gone quiet and a missed check-in are the urgent three");
});

test("the call-site guard catches a boolean where a kind belongs", () => {
  assert.deepEqual(callArgs('notifyEvent(t("x", { a }), "", `sos-${id}`, true);', 0), ['t("x", { a })', '""', "`sos-${id}`", "true"]);
  assert.deepEqual(callArgs('notifyEvent(msg, "a, b", tag, ev.type)', 0)[3], "ev.type");
});

function bridge({ kinds = true } = {}) {
  const calls = [];
  globalThis.StarlingNative = {
    windowShown: () => false,
    notify: (title, body, tag, urgent) => calls.push({ via: "notify", title, tag, urgent }),
    cancelNotify: () => {},
  };
  if (kinds) globalThis.StarlingNative.notifyKind = (title, body, tag, kind) => calls.push({ via: "notifyKind", title, tag, kind });
  return calls;
}

test("a routine event goes out by kind, and an SOS never leaves the urgent path", () => {
  state.demo = false;
  const calls = bridge();
  internals.notifyEvent("Juno arrived at Home", "", "place-1", "arrive");
  internals.notifyEvent("Juno left Home", "", "place-1", "leave");
  internals.notifyEvent("Juno checked in", "The SOS is cleared.", "sos-1", "checkin");
  internals.notifyEvent("Juno's phone is at 9%", "", "bat-1", "battery");
  internals.notifyEvent("Someone wants to join", "", "join-req");
  internals.notifyEvent("Something new", "", "x", "fireworks");
  internals.notifyEvent("SOS from Juno", "", "sos-1", "sos");
  assert.deepEqual(
    calls.map((c) => [c.via, c.kind ?? c.urgent]),
    [
      ["notifyKind", "arrive"],
      ["notifyKind", "leave"],
      ["notifyKind", "checkin"],
      ["notifyKind", "battery"],
      ["notifyKind", "other"],
      ["notifyKind", "other"],
      ["notify", true],
    ],
  );
});

test("an older wrapper without notifyKind still gets every event, urgent only for an SOS", () => {
  state.demo = false;
  const calls = bridge({ kinds: false });
  internals.notifyEvent("Juno arrived at Home", "", "place-1", "arrive");
  internals.notifyEvent("SOS from Juno", "", "sos-1", "sos");
  assert.deepEqual(
    calls.map((c) => [c.via, c.urgent]),
    [
      ["notify", false],
      ["notify", true],
    ],
  );
});

test("the demo reaches neither method", () => {
  const calls = bridge();
  state.demo = true;
  try {
    internals.notifyEvent("Juno arrived at Home", "", "place-1", "arrive");
    internals.notifyEvent("SOS from Juno", "", "sos-1", "sos");
  } finally {
    state.demo = false;
  }
  assert.deepEqual(calls, []);
});

const BASE = { lat: 40.0, lon: -75.0 };
const north = (m) => ({ lat: BASE.lat + m / 111320, lon: BASE.lon });
const HOME = { id: "aaaaaaaa", name: "Home", lat: BASE.lat, lon: BASE.lon, radius: 250 };

async function circleWith(places) {
  state.demo = false;
  state.locked = false;
  state.lock = null;
  state.settings = { ...state.settings, placeAlerts: true, batAlerts: true };
  state.identity = await generateIdentity();
  state.gen = await openGeneration({ seed: new Uint8Array(newSeed()), g: 0, e0: epochAt(Date.now()) });
  state.gen.at = Date.now();
  state.genRoster = new Set();
  state.pinned = new Map();
  internals.setupNet();
  internals.resetMemberAlerts();
  state.places = places;
  await internals.savePlaces();
}

async function postAs(who, fields, ts = Date.now()) {
  const gen = state.gen;
  const e = epochAt(ts);
  const key = await gen.ratchet.keyFor(e, who.memberId, ts);
  const sealed = await sealMessage(key, gen.channelId, who.memberId, e, ts, { v: 2, ts, name: "Juno", acc: 5, mode: "precise", ...fields });
  const post = await buildPost(who, gen.channelId, e, sealed, ts);
  await internals.roster().ingest(
    [{ m: who.memberId, alg: who.alg, pk: b64uEncode(who.pk), epk: b64uEncode(who.epk), points: [{ e: post.e, ts: post.ts, srv: post.ts, n: post.n, c: post.c, sig: post.sig }] }],
    ts,
  );
}

async function at(ts, fn) {
  const realNow = Date.now;
  Date.now = () => ts + 500;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

test("checkAlerts tags arrivals, departures, check-ins and low battery with their kinds", async () => {
  await circleWith([HOME]);
  const calls = bridge();
  const who = await generateIdentity();
  const t0 = Date.now();
  await postAs(who, { t: "loc", ...north(2000) }, t0);
  await at(t0, () => internals.checkAlerts());
  await postAs(who, { t: "loc", ...BASE }, t0 + 60_000);
  await at(t0 + 60_000, () => internals.checkAlerts());
  await postAs(who, { t: "loc", ...north(2000), bat: 0.08 }, t0 + 210_000);
  await at(t0 + 210_000, () => internals.checkAlerts());
  await postAs(who, { t: "sos", ...north(2000) }, t0 + 240_000);
  await at(t0 + 240_000, () => internals.checkAlerts());
  await postAs(who, { t: "checkin", ...north(2000) }, t0 + 270_000);
  await at(t0 + 270_000, () => internals.checkAlerts());
  await postAs(who, { t: "loc", ...north(2000), ask: state.identity.memberId.slice(0, 8), ak: t0 + 299_000 }, t0 + 300_000);
  await at(t0 + 300_000, () => internals.checkAlerts());

  const seen = calls.map((c) => [c.title, c.via === "notify" ? (c.urgent ? "urgent" : "routine") : c.kind]);
  assert.deepEqual(seen, [
    ["Juno arrived at Home", "arrive"],
    ["Juno left Home", "leave"],
    ["Juno's phone is at 8%", "battery"],
    ["SOS from Juno", "urgent"],
    ["Juno checked in", "checkin"],
    ["Juno asked you to check in", "checkin"],
  ]);
});

test("Android gives arrivals, departures and check-ins channels of their own and the SOS channel stays out of reach", () => {
  const main = kt("MainActivity.kt");
  const ids = ["EVENTS_CHANNEL", "ARRIVE_CHANNEL", "LEAVE_CHANNEL", "CHECKIN_CHANNEL", "SOS_CHANNEL"].map(
    (n) => main.match(new RegExp(`const val ${n} = "([^"]+)"`))?.[1],
  );
  assert.equal(new Set(ids).size, 5, `five distinct channel ids: ${ids}`);
  assert.equal(ids[0], "events", "the general channel keeps its id, so existing sound choices stay");

  const events = kt("Events.kt");
  assert.match(events, /"arrive" -> MainActivity\.ARRIVE_CHANNEL\r?\n\s*"leave" -> MainActivity\.LEAVE_CHANNEL\r?\n\s*"checkin" -> MainActivity\.CHECKIN_CHANNEL\r?\n\s*else -> MainActivity\.EVENTS_CHANNEL/);
  assert.doesNotMatch(events.slice(events.indexOf("fun channelFor"), events.indexOf("fun post")), /SOS_CHANNEL/);
  assert.match(events, /val channelId = if \(urgent\) ensureSosChannel\(ctx\) else routine/);
  assert.match(events, /createNotificationChannels\(ROUTINE\.map \{ buildChannel\(ctx, it\.first, false\) \}\)/, "every routine channel exists after the first alert");
  for (const n of ["ARRIVE", "LEAVE", "CHECKIN"]) {
    assert.match(events, new RegExp(`MainActivity\\.${n}_CHANNEL to R\\.string\\.notif_${n.toLowerCase()}_channel`));
  }

  const bridgeSrc = kt("StarlingBridge.kt");
  assert.match(bridgeSrc, /fun notifyKind\(title: String, body: String, tag: String, kind: String\) \{\s*Events\.post\(app, title\.take\(80\), body\.take\(160\), tag\.take\(64\), false, kind\.take\(16\)\)/, "a kind never makes anything urgent");
  assert.match(bridgeSrc, /fun openAlertSounds\(\) \{\s*ui \{ it\.openAlertSounds\(\) \}/);
  assert.match(main, /fun openAlertSounds\(\) \{\s*Events\.ensureEventChannels\(this\)\s*openNotificationSettings\(\)/, "the channels exist before their page opens");

  const wipe = kt("Wipe.kt");
  for (const n of ["ARRIVE", "LEAVE", "CHECKIN"]) assert.match(wipe, new RegExp(`MainActivity\\.${n}_CHANNEL,`), `the panic wipe deletes ${n}`);
});

test("every channel name is in all five string files, and Settings offers the page only where the wrapper has it", () => {
  for (const dir of ["values", "values-es", "values-fr", "values-de", "values-pt"]) {
    const xml = src(`android/app/src/main/res/${dir}/strings.xml`);
    for (const name of ["notif_arrive_channel", "notif_leave_channel", "notif_checkin_channel"]) {
      assert.match(xml, new RegExp(`<string name="${name}">[^<]+</string>`), `${dir} ${name}`);
    }
  }
  assert.match(src("app/js/ui.js"), /if \(typeof native\(\)\?\.openAlertSounds === "function"\) \{\s*const box/);
});
