// Alert cards and the wrapper's notice, read back in German against their English source.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installDom, loadApp } from "./dom-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
const { loadLocale, setLocale } = await import("../app/js/i18n.js");
const { fmtCountdown, circleLabel } = await import("../app/js/ui.js");
const { de } = await import("../app/js/strings-de.js");
await loadLocale("de");

test.after(() => {
  setLocale("en");
  harness.stopTimers();
});

function raiseEveryCard() {
  state.demo = false;
  state.chainWipeFailed = { at: Date.now(), why: "QuotaExceededError" };
  state.chainDestroyed = true;
  state.chainWiped = { at: Date.now() };
  state.missedRekey = true;
  state.rosterMismatch = { by: "f".repeat(32) };
  state.clockError = { skewMs: 12 * 60000 };
  state.joinIncomplete = { got: 1, want: 3 };
  state.joinRequests = [{ memberId: "e".repeat(32), name: "Bo" }];
  state.foreground = { active: true, elapsedMs: 120000, wakeLock: true, since: Date.now() };
  state.lastRekey = { byName: "Ana", removedNames: [], at: Date.now() };
}

const byId = (items) => new Map(items.map((i) => [i.id, i]));

test("every alert card reads in the chosen language, not in its English source", () => {
  raiseEveryCard();
  setLocale("en");
  const en = byId(internals.alertItems());
  setLocale("de");
  const translated = byId(internals.alertItems());
  setLocale("en");
  for (const id of ["chain-wipe-failed", "chain-destroyed", "chain-wiped", "missed", "mismatch", "clock", "join-incomplete", "foreground", "rekey"]) {
    assert.ok(en.has(id) && translated.has(id), `${id} is raised`);
  }
  for (const [id, item] of translated) {
    const source = en.get(id);
    assert.notEqual(item.title, source.title, `${id} title is still English: ${item.title}`);
    assert.notEqual(item.text, source.text, `${id} text is still English: ${item.text}`);
  }
  assert.equal(translated.get("mismatch").text.startsWith(de["A member"]), true, "even the stand-in for an unknown name");
});

test("the one-record and many-record versions of an incomplete invite both translate", () => {
  raiseEveryCard();
  for (const shape of [{ got: 0, want: 1 }, { got: 2, want: 5 }]) {
    state.joinIncomplete = shape;
    setLocale("en");
    const en = internals.alertItems().find((i) => i.id === "join-incomplete");
    setLocale("de");
    const translated = internals.alertItems().find((i) => i.id === "join-incomplete");
    setLocale("en");
    assert.notEqual(translated.text, en.text);
    assert.ok(translated.text.includes(String(shape.want)) && translated.text.includes(String(shape.got)));
  }
});

test("the wrapper's Orbot notice is a code, and the page says it in the reader's language", () => {
  const toasts = harness.node("#toasts").children;
  setLocale("de");
  window.__starlingNotice("orbot-silent");
  const said = toasts[toasts.length - 1].textContent;
  setLocale("en");
  const key = "Orbot did not answer. If sharing stalls, turn on Power User Mode in Orbot's settings, or use Orbot's per-app VPN mode instead.";
  assert.equal(said, de[key]);

  window.__starlingNotice("A line some older wrapper sent as is");
  assert.equal(toasts[toasts.length - 1].textContent, "A line some older wrapper sent as is", "any other string still toasts as it always did");
  window.__starlingNotice("constructor");
  assert.equal(toasts[toasts.length - 1].textContent, "constructor", "a code lookup never reaches the prototype");

  const kotlin = path.join(ROOT, "android/app/src/main/kotlin/app/starlingmap");
  const calls = [];
  for (const f of readdirSync(kotlin).filter((n) => n.endsWith(".kt"))) {
    const src = readFileSync(path.join(kotlin, f), "utf8");
    for (const m of src.matchAll(/PageHost\.notice\(\s*([^)]*)\)/g)) calls.push(`${f}: ${m[1].trim()}`);
  }
  assert.ok(calls.length >= 1, "found the wrapper's notices");
  for (const c of calls) assert.match(c, /: "[a-z0-9-]+"$/, `Kotlin has no catalog, so it sends a code: ${c}`);
});

test("countdown words and an unnamed circle follow the language", () => {
  setLocale("de");
  try {
    assert.equal(fmtCountdown(30000), de["under a minute"]);
    assert.equal(fmtCountdown(0), de.expired);
    assert.equal(fmtCountdown(42 * 60000), "42 min", "the unit stays the short form fmtRelTime uses");
    assert.equal(circleLabel(""), de["My circle"]);
    assert.equal(circleLabel("Field team"), "Field team", "a name somebody chose is never translated");
  } finally {
    setLocale("en");
  }
  assert.equal(circleLabel(""), "My circle");
  assert.equal(state.circleName, "", "a fresh device holds no English default name as data");
  for (const f of ["app/js/main.js", "app/js/ui.js", "app/js/circles.js"]) {
    const src = readFileSync(path.join(ROOT, f), "utf8");
    const bare = [...src.matchAll(/(?<!t\()"My circle"/g)];
    assert.deepEqual(bare.map((m) => m.index), [], `${f} writes the default name as data instead of rendering it`);
  }
});
