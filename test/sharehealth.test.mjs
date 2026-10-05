// The report leaves the phone by hand, so most of this is about what it must
// never carry.
import test from "node:test";
import assert from "node:assert/strict";

import { parseHealth, shareProblems, sentNote, noteAfter, sendErrorKind, shareReport, SENT_NOTE_MS } from "../app/js/sharehealth.js";
import { STALE_MS } from "../app/js/net.js";
import { loadLocale, setLocale } from "../app/js/i18n.js";

test.after(() => setLocale("en"));

const HEALTHY = {
  app: "0.13.4",
  android: "16",
  sdk: 36,
  device: "Google Pixel 7a",
  webview: "com.google.android.webview 141.0.7390.0",
  fine: true,
  coarse: true,
  fineOp: "foreground",
  notifications: true,
  locationOn: true,
  gpsOn: true,
  networkOn: true,
  battery: "unrestricted",
  powerSave: false,
  saverLocationMode: 3,
  deviceIdle: false,
  lightIdle: false,
  standbyBucket: 10,
  service: true,
  sharingMs: 42 * 60000,
  fixes: 812,
  gpsFixes: 700,
  networkFixes: 112,
  lastFixMs: 4000,
  ticks: 0,
  locationOff: false,
  windowShown: false,
  headless: true,
  holding: true,
  holderFailed: false,
  freezes: 3,
  nudges: 3,
  lastPulseMs: 4000,
  keepSharing: true,
  tor: false,
};

test("parseHealth takes an object and nothing else", () => {
  assert.deepEqual(parseHealth('{"battery":"optimized"}'), { battery: "optimized" });
  for (const bad of [null, undefined, "", "not json", "[1,2]", "null", "7", '"x"']) {
    assert.equal(parseHealth(bad), null, `refused: ${String(bad)}`);
  }
});

test("a healthy phone has nothing to fix", () => {
  assert.deepEqual(shareProblems(HEALTHY), []);
  assert.deepEqual(shareProblems(null), [], "no wrapper, no cards");
});

test("each setting that works against a share is named, worst first", () => {
  assert.deepEqual(shareProblems({ ...HEALTHY, battery: "restricted" }), ["restricted"]);
  assert.deepEqual(shareProblems({ ...HEALTHY, battery: "optimized" }), ["optimized"]);
  assert.deepEqual(shareProblems({ ...HEALTHY, locationOn: false }), ["location-off"]);
  assert.deepEqual(shareProblems({ ...HEALTHY, locationOff: true }), ["location-off"]);
  assert.deepEqual(shareProblems({ ...HEALTHY, fine: false }), ["coarse"]);
  assert.deepEqual(shareProblems({ ...HEALTHY, fine: false, coarse: false }), [], "no permission at all is the share flow's to handle");
  assert.deepEqual(
    shareProblems({ ...HEALTHY, battery: "optimized", fine: false, locationOn: false }),
    ["location-off", "coarse", "optimized"],
  );
});

test("Battery Saver is only a problem in the modes that cut location with the screen off", () => {
  for (const mode of [1, 2, 4]) {
    assert.deepEqual(shareProblems({ ...HEALTHY, powerSave: true, saverLocationMode: mode }), ["saver"], `mode ${mode}`);
  }
  for (const mode of [0, 3]) {
    assert.deepEqual(shareProblems({ ...HEALTHY, powerSave: true, saverLocationMode: mode }), [], `mode ${mode} spares a share`);
  }
  assert.deepEqual(shareProblems({ ...HEALTHY, powerSave: false, saverLocationMode: 2 }), [], "saver off");
});

test("the sent note stays quiet while posts are recent and turns honest when they stop", () => {
  const now = 10_000_000;
  const base = { startedAt: now - 3_600_000, now, staleMs: STALE_MS };
  assert.equal(sentNote({ ...base, lastOkAt: now - 5000 }), null, "a post five seconds ago is not news");
  assert.equal(sentNote({ ...base, lastOkAt: now - (SENT_NOTE_MS - 1) }), null);

  const two = sentNote({ ...base, lastOkAt: now - 2 * 60_000 });
  assert.deepEqual(two, { stale: false, text: "last sent 2 min ago" });

  const five = sentNote({ ...base, lastOkAt: now - 5 * 60_000 });
  assert.equal(five.stale, true, "past the circle's own cutoff this phone must stop saying live");
  assert.equal(five.text, "last sent 5 min ago");
});

test("the sent note waits out a slower cadence before it calls a post late", () => {
  assert.equal(noteAfter(15), SENT_NOTE_MS, "the 15 second cadence keeps the old minute");
  assert.equal(noteAfter(60), SENT_NOTE_MS + 45_000);
  assert.equal(noteAfter(300), SENT_NOTE_MS + 285_000);
  const now = 10_000_000;
  const base = { startedAt: now - 3_600_000, now, staleMs: 10 * 60_000, noteMs: noteAfter(300) };
  assert.equal(sentNote({ ...base, lastOkAt: now - 4 * 60_000 }), null, "four minutes on a five minute cadence is not news");
  assert.deepEqual(sentNote({ ...base, lastOkAt: now - 6 * 60_000 }), { stale: false, text: "last sent 6 min ago" });
  assert.equal(sentNote({ ...base, lastOkAt: now - 11 * 60_000 }).stale, true);
});

test("a share that never got a post out says so, after a grace minute", () => {
  const now = 10_000_000;
  assert.equal(sentNote({ lastOkAt: 0, startedAt: now - 20_000, now, staleMs: STALE_MS }), null, "just started");
  assert.deepEqual(sentNote({ lastOkAt: 0, startedAt: now - 90_000, now, staleMs: STALE_MS }), {
    stale: false,
    text: "nothing sent yet",
  });
  assert.equal(sentNote({ lastOkAt: 0, startedAt: now - 10 * 60_000, now, staleMs: STALE_MS }).stale, true);
  assert.equal(sentNote({ lastOkAt: 0, startedAt: 0, now, staleMs: STALE_MS }), null, "no share, no note");
});

test("the sent note is translated", async () => {
  await loadLocale("es");
  setLocale("es");
  const now = 10_000_000;
  const note = sentNote({ lastOkAt: now - 2 * 60_000, startedAt: now - 3_600_000, now, staleMs: STALE_MS });
  assert.equal(note.text, "último envío hace 2 min");
  setLocale("en");
});

test("a failed post is reduced to a kind, never its message", () => {
  const url = "https://relay.example.org/api/v2/f/0123456789abcdef/loc";
  const kinds = [
    [Object.assign(new Error("device clock is wrong"), { code: "clock" }), "clock"],
    [new DOMException("signal timed out", "TimeoutError"), "timeout"],
    [new DOMException("aborted", "AbortError"), "aborted"],
    [new TypeError(`Failed to fetch ${url}`), "network"],
    [new Error("post 503"), "http 503"],
    [new Error("sender cancelled"), "cancelled"],
    [new Error("no key for epoch"), "no key"],
    [new Error(`something odd at ${url}`), "other"],
    [null, "unknown"],
  ];
  for (const [err, want] of kinds) {
    const got = sendErrorKind(err);
    assert.equal(got, want);
    assert.ok(!got.includes("example"), "no part of a message survives");
  }
});

test("the report carries versions, settings and counts", () => {
  const now = Date.UTC(2026, 8, 30, 14, 3);
  const text = shareReport({
    h: HEALTHY,
    page: { version: "0.13.4", sharing: true, startedAt: now - 42 * 60000, ok: 170, failed: 2, lastOkAt: now - 12000, lastErr: "timeout", lastErrAt: now - 8 * 60000 },
    now,
  });
  for (const want of [
    "Starling sharing report",
    "Made: 2026-09-30T14:03Z",
    "App: 0.13.4 (page 0.13.4)",
    "Android: 16 (SDK 36)",
    "Device: Google Pixel 7a",
    "WebView: com.google.android.webview 141.0.7390.0",
    "Sharing: on for 42 min",
    "Keep sharing when closed: yes",
    "App window: closed, held",
    "Location permission: precise (app op foreground)",
    "Battery use: unrestricted",
    "Standby bucket: active",
    "Fixes: 812 (GPS 700, network 112), last 4 s ago",
    "Page frozen during shares: 3 times, woken 3 times, last answered 4 s ago",
    "Posts this share: 170 sent, 2 failed",
    "Last sent: 12 s ago",
    "Last failure: timeout, 8 min ago",
    "Relay: default",
  ]) {
    assert.ok(text.includes(want), `missing: ${want}\n${text}`);
  }
});

test("the report never carries a position, a key, a name or a relay address", () => {
  const now = Date.now();
  const secretish = {
    ...HEALTHY,
    lat: 40.78512,
    lon: -73.96841,
    location: { lat: 40.78512, lon: -73.96841 },
    key: "k3y-MATERIAL-9f8e7d",
    name: "Juno Park",
    circle: "The Hendersons",
    relay: "https://relay.juno.example",
    device: 'Pixel <script>"40.78512"',
    webview: "com.google.android.webview 40.78512,-73.96841 extra",
  };
  const text = shareReport({
    h: secretish,
    page: {
      version: "0.13.4",
      sharing: true,
      startedAt: now - 60000,
      ok: 1,
      failed: 1,
      lastOkAt: now,
      lastErr: "https://relay.juno.example/loc?lat=40.78512",
      lastErrAt: now,
      customRelay: true,
      me: { lat: 40.78512, lon: -73.96841 },
      name: "Juno Park",
    },
    now,
  });
  for (const leak of ["40.78", "73.96", "k3y", "Juno", "Hendersons", "juno.example", "<script>"]) {
    assert.ok(!text.includes(leak), `leaked ${leak}:\n${text}`);
  }
  assert.ok(text.includes("Relay: custom"), "a custom relay is said to exist, not where");
});

test("the report still says something useful with no wrapper", () => {
  const text = shareReport({ h: null, page: { version: "0.13.4", sharing: false }, now: Date.now() });
  assert.ok(text.includes("Wrapper: none, or too old to report"));
  assert.ok(text.includes("Sharing: off"));
  assert.ok(text.includes("Last sent: never"));
});

test("the report says whether a share can come back by itself, in words from a fixed list", () => {
  const now = Date.UTC(2026, 9, 5, 12, 0);
  const page = { version: "0.18.0", sharing: true, startedAt: now - 60000 };
  const report = (over) => shareReport({ h: { ...HEALTHY, autoBoot: true, autoUpdate: false, background: "granted", resumedBy: "boot", headlessResumes: 1, headlessAbandons: 0, ...over }, page, now });
  const text = report({});
  for (const want of [
    "Comes back by itself: after a restart yes, after an update no",
    "Location all the time: allowed",
    "This share came back by itself: after a restart",
    "Shares that came back by itself since the app started: 1, given up: 0",
  ]) {
    assert.ok(text.includes(want), `missing: ${want}\n${text}`);
  }
  const words = [
    ["dialog", "not allowed"],
    ["settings", "not allowed"],
    ["notNeeded", "not needed (Android 9)"],
    ["noLocation", "no location permission"],
    ["granted 40.78512", "unknown"],
    ["toString", "unknown"],
    [7, "unknown"],
  ];
  for (const [background, want] of words) {
    assert.ok(report({ background }).includes(`Location all the time: ${want}\n`), `${background} -> ${want}`);
  }
  for (const [resumedBy, want] of [["update", "after an update"], ["", "no"], ["Juno's phone", "unknown"], ["constructor", "unknown"], [null, "unknown"]]) {
    assert.ok(report({ resumedBy }).includes(`This share came back by itself: ${want}\n`), `${resumedBy} -> ${want}`);
  }
  assert.ok(report({ headlessResumes: "40.78" }).includes("Shares that came back by itself since the app started: unknown, given up: 0"));
  const older = shareReport({ h: HEALTHY, page, now });
  assert.doesNotMatch(older, /by itself|all the time/, "a wrapper without the switches is not reported as unknown about them");
});
