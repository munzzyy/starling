// The translation layer: the engine's behavior, and the Spanish catalog held
// to the extractor's full string list so a new UI string cannot ship
// silently untranslated (adding one fails this test until es gets it).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { t, setLocale, resolveLocale, norm, LOCALE_CHOICES } from "../app/js/i18n.js";
import { es } from "../app/js/strings-es.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test.after(() => setLocale("en"));

test("t passes unknown strings through and interpolates placeholders", () => {
  setLocale("en");
  assert.equal(t("Not a real key"), "Not a real key");
  assert.equal(t("{who} arrived at {place}", { who: "Juno", place: "Home" }), "Juno arrived at Home");
});

test("resolveLocale honors explicit choices and falls back to English", () => {
  assert.equal(resolveLocale("es"), "es");
  assert.equal(resolveLocale("en"), "en");
  assert.equal(resolveLocale("xx"), "en");
  assert.ok(["en", "es"].includes(resolveLocale("auto")));
  assert.ok(LOCALE_CHOICES.some((c) => c.id === "es"));
});

test("Spanish translates the core vocabulary and leaves user text alone", () => {
  setLocale("es");
  assert.notEqual(t("Locked"), "Locked", "a core string is actually translated");
  assert.notEqual(t("Start sharing"), "Start sharing");
  assert.equal(t("Wren's own words 12345"), "Wren's own words 12345", "unknown text passes through");
  const who = t("{who} wants to join", { who: "Mabel" });
  assert.ok(who.includes("Mabel"), who);
  setLocale("en");
  assert.equal(t("Locked"), "Locked");
});

test("the Spanish catalog covers every extracted string", () => {
  const out = execFileSync("node", [path.join(ROOT, "tools", "extract-strings.mjs"), "--keys"], {
    encoding: "utf8",
  });
  const keys = out.split("\n").filter(Boolean);
  assert.ok(keys.length > 300, `extractor found ${keys.length} strings`);
  const missing = keys.filter((k) => !(norm(k) in es) && !(k in es));
  assert.deepEqual(missing, [], `untranslated: ${missing.slice(0, 8).join(" | ")}`);
});

test("every translation keeps its placeholders and carries no em dashes", () => {
  // Spelled as escapes so this file passes the very gate it enforces.
  const dash = new RegExp("[\\u2013\\u2014]");
  for (const [k, v] of Object.entries(es)) {
    assert.ok(v && typeof v === "string", `empty translation for: ${k}`);
    assert.ok(!dash.test(v), `dash in translation of: ${k}`);
    for (const m of k.matchAll(/\{(\w+)\}/g)) {
      assert.ok(v.includes(`{${m[1]}}`), `placeholder {${m[1]}} lost in: ${k} -> ${v}`);
    }
  }
});
