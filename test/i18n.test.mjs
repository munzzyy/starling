// The translation layer: the engine's behavior, and every shipped catalog held
// to the extractor's full string list so a new UI string cannot ship
// silently untranslated (adding one fails this test until each catalog gets it).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { t, loadLocale, setLocale, resolveLocale, currentLocale, norm, LOCALE_CHOICES } from "../app/js/i18n.js";

// Read as data for the coverage checks; the app itself only gets them through loadLocale.
const CATALOGS = {};
for (const code of ["es", "de", "fr", "pt"]) CATALOGS[code] = (await import(`../app/js/strings-${code}.js`))[code];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test.after(() => setLocale("en"));

test("t passes unknown strings through and interpolates placeholders", () => {
  setLocale("en");
  assert.equal(t("Not a real key"), "Not a real key");
  assert.equal(t("{who} arrived at {place}", { who: "Juno", place: "Home" }), "Juno arrived at Home");
});

test("resolveLocale honors explicit choices and falls back to English", () => {
  for (const code of Object.keys(CATALOGS)) {
    assert.equal(resolveLocale(code), code);
    assert.ok(LOCALE_CHOICES.some((c) => c.id === code), `${code} is offered in settings`);
  }
  assert.equal(resolveLocale("en"), "en");
  assert.equal(resolveLocale("xx"), "en");
  assert.ok(["en", ...Object.keys(CATALOGS)].includes(resolveLocale("auto")));
});

test("every catalog translates the core vocabulary and leaves user text alone", async () => {
  for (const code of Object.keys(CATALOGS)) {
    await loadLocale(code);
    setLocale(code);
    assert.equal(currentLocale(), code);
    assert.notEqual(t("Locked"), "Locked", `${code}: a core string is actually translated`);
    assert.notEqual(t("Start sharing"), "Start sharing", code);
    assert.equal(t("Wren's own words 12345"), "Wren's own words 12345", "unknown text passes through");
    const who = t("{who} wants to join", { who: "Mabel" });
    assert.ok(who.includes("Mabel"), who);
  }
  setLocale("en");
  assert.equal(t("Locked"), "Locked");
});

test("a catalog loads only when its language is chosen", async () => {
  const src = readFileSync(path.join(ROOT, "app/js/i18n.js"), "utf8");
  assert.doesNotMatch(src, /from "\.\/strings-/, "no catalog is in the static import graph");

  const fresh = await import("../app/js/i18n.js?lazy");
  fresh.setLocale("de");
  assert.equal(fresh.currentLocale(), "en", "a language whose catalog is not loaded stays English, not half translated");
  assert.equal(fresh.t("Locked"), "Locked");

  await fresh.loadLocale("de");
  fresh.setLocale("de");
  assert.equal(fresh.currentLocale(), "de");
  assert.notEqual(fresh.t("Locked"), "Locked");

  fresh.setLocale("es");
  assert.equal(fresh.currentLocale(), "en", "loading German did not bring Spanish with it");
  await fresh.loadLocale("en");
  await fresh.loadLocale("../strings-es");
  fresh.setLocale("es");
  assert.equal(fresh.currentLocale(), "en", "English and unknown codes load nothing");
  fresh.setLocale("en");
});

test("every catalog covers every extracted string, and carries nothing the app lost", () => {
  const out = execFileSync("node", [path.join(ROOT, "tools", "extract-strings.mjs"), "--keys"], {
    encoding: "utf8",
  });
  const keys = out.split("\n").filter(Boolean);
  assert.ok(keys.length > 300, `extractor found ${keys.length} strings`);
  // Strings rendered through a variable (a settings option list, a heading
  // built by a helper) never reach the extractor, so a catalog may carry
  // keys beyond its list. What it may not carry is a key the app's source
  // no longer spells anywhere: that is a translation of nothing.
  const known = new Set(keys);
  const appDir = path.join(ROOT, "app");
  const source = [
    ...readdirSync(path.join(appDir, "js")).filter((f) => f.endsWith(".js") && !f.startsWith("strings-")).map((f) => path.join(appDir, "js", f)),
    path.join(appDir, "index.html"),
    path.join(appDir, "help.html"),
  ].map((f) => readFileSync(f, "utf8").replace(/\s+/g, " ")).join("\n");
  for (const [code, cat] of Object.entries(CATALOGS)) {
    const missing = keys.filter((k) => !(norm(k) in cat) && !(k in cat));
    assert.deepEqual(missing, [], `${code} untranslated: ${missing.slice(0, 8).join(" | ")}`);
    const dead = Object.keys(cat).filter((k) => !known.has(k) && !source.includes(k));
    assert.deepEqual(dead, [], `${code} carries strings the app no longer has: ${dead.slice(0, 8).join(" | ")}`);
  }
});

test("every translation keeps its placeholders and carries no em dashes", () => {
  // Spelled as escapes so this file passes the very gate it enforces.
  const dash = new RegExp("[\\u2013\\u2014]");
  for (const [code, cat] of Object.entries(CATALOGS)) {
    for (const [k, v] of Object.entries(cat)) {
      assert.ok(v && typeof v === "string", `${code}: empty translation for: ${k}`);
      assert.ok(!dash.test(v), `${code}: dash in translation of: ${k}`);
      for (const m of k.matchAll(/\{(\w+)\}/g)) {
        assert.ok(v.includes(`{${m[1]}}`), `${code}: placeholder {${m[1]}} lost in: ${k} -> ${v}`);
      }
    }
  }
});

test("substituted values are never re-scanned for other placeholders", () => {
  setLocale("en");
  // A member who names themselves "{gone}" must not have the removed
  // member's name substituted into their slot.
  assert.equal(
    t("{who} removed {gone}", { who: "{gone}", gone: "Bob" }),
    "{gone} removed Bob",
  );
  assert.equal(t("{a}{b}", { a: "{b}", b: "X" }), "{b}X");
  assert.equal(t("{a} and {missing}", { a: "ok" }), "ok and {missing}");
});

// Literals an expression yields with nothing wrapping them: `x ? t("a") : "b"` yields "b".
function bareLiterals(expr) {
  const out = [];
  let depth = 0;
  let prev = "^";
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < expr.length && expr[j] !== c) j += expr[j] === "\\" ? 2 : 1;
      if (c !== "`" && depth === 0 && "^?:|+".includes(prev)) out.push(expr.slice(i + 1, j));
      prev = c;
      i = j;
      continue;
    }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    if (!/\s/.test(c)) prev = c;
  }
  return out;
}

test("no user-visible literal bypasses the translator", () => {
  // The class the verifier caught: English assigned straight to textContent
  // or a spoken attribute, invisible to both the chokepoints and the
  // extractor. Anything matching here must be wrapped in t() or allowlisted
  // with a reason.
  const files = ["app/js/main.js", "app/js/ui.js", "app/js/helpview.js"];
  const allow = new Set([
    // product name + version, language-invariant
    "Starling ${VERSION}",
  ]);
  const hits = [];
  for (const f of files) {
    const src = readFileSync(path.join(ROOT, f), "utf8");
    for (const m of src.matchAll(/\.textContent\s*=\s*"([^"]{6,})"/g)) {
      if (!allow.has(m[1])) hits.push(`${f}: textContent "${m[1]}"`);
    }
    for (const m of src.matchAll(/setAttribute\(\s*"(?:aria-label|placeholder|title)",\s*"([^"]{6,})"/g)) {
      if (!allow.has(m[1])) hits.push(`${f}: attr "${m[1]}"`);
    }
    const spoken = /\.(textContent|placeholder|title|ariaLabel|alt)\s*=(?!=)((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[^;"'`])*);/g;
    for (const m of src.matchAll(spoken)) {
      for (const lit of bareLiterals(m[2])) {
        const words = lit.replace(/\\u\{[0-9A-Fa-f]+\}|\\u[0-9A-Fa-f]{4}/g, "");
        if (/[A-Za-z]{2,}/.test(words) && !allow.has(lit) && !/^https?:\/\//.test(lit)) hits.push(`${f}: ${m[1]} "${lit.slice(0, 40)}"`);
      }
    }
    // A direct property write skips the chokepoints the same way (starling#1, 2026-10-02).
    for (const m of src.matchAll(/\.(?:placeholder|title|ariaLabel|alt)\s*=\s*"([^"]{4,})"/g)) {
      if (!allow.has(m[1]) && !/^https?:\/\//.test(m[1])) hits.push(`${f}: property "${m[1]}"`);
    }
    // el() translates its text, but an interpolated template is never a catalog key.
    for (const m of src.matchAll(/\bel\(\s*"\w+",\s*"[^"]*",\s*`([^`]*\$\{[^`]*)`/g)) {
      if (!allow.has(m[1])) hits.push(`${f}: el() template "${m[1].slice(0, 40)}"`);
    }
  }
  assert.deepEqual(hits, [], hits.slice(0, 12).join("\n"));
});

test("the bypass guard sees a bare literal and leaves wrapped ones alone", () => {
  assert.deepEqual(bareLiterals(` inv ? t("Expires in {left}", { left }) : "This link is gone."`), ["This link is gone."]);
  assert.deepEqual(bareLiterals(` n ? "One here" : "None here"`), ["One here", "None here"]);
  assert.deepEqual(bareLiterals(` t(n === 1 ? "{n} place" : "{n} places", { n })`), []);
  assert.deepEqual(bareLiterals(` a ? t("x") : b ? t("y") : "Third arm"`), ["Third arm"]);
  assert.deepEqual(bareLiterals(` given.placeholder || "Family, friends"`), ["Family, friends"]);
  assert.deepEqual(bareLiterals(` 'Type "leave"'`), ['Type "leave"']);
  assert.deepEqual(bareLiterals(` state === "ok" ? t("Connected") : t("Not connected")`), []);
});

test("every alert card's title and text is translated where it is written", () => {
  // updateAlerts puts these on screen as they are, so a bare literal stays English.
  const src = readFileSync(path.join(ROOT, "app/js/main.js"), "utf8");
  const start = src.indexOf("function alertItems() {");
  const body = src.slice(start, src.indexOf("\nlet announcedAlerts", start));
  assert.ok(start >= 0 && body.length > 5000, "found alertItems");
  const valueAt = (i) => {
    let depth = 0;
    for (let j = i; j < body.length; j++) {
      const c = body[j];
      if (c === '"' || c === "`") {
        let k = j + 1;
        while (k < body.length && body[k] !== c) k += body[k] === "\\" ? 2 : 1;
        j = k;
      } else if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) {
        if (depth === 0) return body.slice(i, j);
        depth--;
      } else if (c === "," && depth === 0) return body.slice(i, j);
    }
    return body.slice(i);
  };
  const hits = [];
  for (const m of body.matchAll(/\b(title|text):\s*/g)) {
    const v = valueAt(m.index + m[0].length).trim();
    const words = v.startsWith("`") ? v.replace(/\$\{[^}]*\}/g, "") : "";
    if (/[A-Za-z]{2,}/.test(words) || bareLiterals(v).length) hits.push(`${m[1]}: ${v.slice(0, 50)}`);
  }
  assert.deepEqual(hits, [], hits.join("\n"));
});

test("every label table is in the extractor's list", () => {
  // STATUS_CHIPS went through t() at render time but never reached a catalog,
  // so Spanish users saw English chips (starling#1, 2026-10-02).
  const keys = new Set(
    execFileSync("node", [path.join(ROOT, "tools", "extract-strings.mjs"), "--keys"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean),
  );
  const missing = [];
  for (const f of ["app/js/main.js", "app/js/ui.js", "app/js/helpview.js"]) {
    const src = readFileSync(path.join(ROOT, f), "utf8");
    for (const m of src.matchAll(/\bconst ([A-Z_]+) = \[((?:\s*"[^"]*",?)+)\s*\]/g)) {
      for (const v of m[2].matchAll(/"([^"]*)"/g)) {
        const words = v[1].replace(/\\u\{[0-9A-Fa-f]+\}|\\u[0-9A-Fa-f]{4}/g, "");
        if (/[A-Za-z]{2,}/.test(words) && !keys.has(v[1])) missing.push(`${f} ${m[1]}: "${v[1]}"`);
      }
    }
  }
  assert.deepEqual(missing, [], missing.slice(0, 8).join("\n"));
});

