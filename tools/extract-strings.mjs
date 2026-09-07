// Collect every translatable English source string: t("...") literals,
// data-i18n tagged text and attributes in the app screens, the strings that
// flow through the el()/btn()/toast()/overlay-title chokepoints, and the
// vocabulary tables (chips, help statuses). Prints one JSON object with
// every key mapped to "" so a translator can fill a new catalog, and is the
// same list the catalog test holds Spanish to.
//
// Run: node tools/extract-strings.mjs [--keys]
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const norm = (s) => s.replace(/\s+/g, " ").trim();

const keys = new Set();
const add = (s) => {
  const n = norm(s);
  if (!n || !/[A-Za-z]/.test(n)) return;
  // Language-invariant strings: the product name plus a version number is
  // the same in every catalog and would otherwise demand a fake entry per
  // release.
  if (/^Starling [0-9][0-9.]*$/.test(n)) return;
  keys.add(n);
};

const JS_FILES = ["app/js/main.js", "app/js/ui.js", "app/js/helpview.js", "app/js/fmt.js", "app/js/demo.js"];

// Unescape the source spelling of a double-quoted literal.
const unq = (s) => s.replaceAll('\\"', '"').replaceAll("\\'", "'").replaceAll("\\n", " ");

for (const f of JS_FILES) {
  const src = read(f);
  // t("...") first arguments.
  for (const m of src.matchAll(/\bt\(\s*\n?\s*"((?:[^"\\]|\\.)+)"/g)) add(unq(m[1]));
  // Chokepoint literals: el(tag, cls, "text"), btn(cls, "text"[, "label"]),
  // toast("text"), and the object fields whose values render as user copy.
  for (const m of src.matchAll(/\bel\(\s*"[^"]*",\s*"[^"]*",\s*"((?:[^"\\]|\\.)+)"/g)) add(unq(m[1]));
  for (const m of src.matchAll(/\bbtn\(\s*"[^"]*",\s*"((?:[^"\\]|\\.)+)"(?:,\s*"((?:[^"\\]|\\.)+)")?/g)) {
    add(unq(m[1]));
    if (m[2]) add(unq(m[2]));
  }
  for (const m of src.matchAll(/\btoast\(\s*\n?\s*"((?:[^"\\]|\\.)+)"/g)) add(unq(m[1]));
  for (const m of src.matchAll(/\b(?:title|text|label|note|intro|cta|placeholder|lead|msg)\s*:\s*"((?:[^"\\]|\\.)+)"/g)) add(unq(m[1]));
  // Vocabulary tables.
  for (const m of src.matchAll(/\b(?:CHIP_TEXT|STATUS_LINE)\s*=\s*\{([^}]+)\}/g)) {
    for (const v of m[1].matchAll(/"((?:[^"\\]|\\.)+)"/g)) add(unq(v[1]));
  }
}

// Static page: data-i18n text nodes and data-i18n-attr attributes.
const html = read("app/index.html") + read("app/help.html");
for (const m of html.matchAll(/<([a-z0-9]+)[^>]*\bdata-i18n\b[^>]*>([^<]*)(?=<)/g)) add(m[2]);
for (const m of html.matchAll(/<[^>]*\bdata-i18n-attr="([^"]+)"[^>]*>/g)) {
  const tag = m[0];
  for (const attr of m[1].split(",")) {
    const v = tag.match(new RegExp(`\\b${attr}="([^"]*)"`));
    if (v) add(v[1]);
  }
}

const sorted = [...keys].sort((a, b) => a.localeCompare(b));
if (process.argv.includes("--keys")) {
  for (const k of sorted) console.log(k);
} else {
  console.log(JSON.stringify(Object.fromEntries(sorted.map((k) => [k, ""])), null, 2));
}
console.error(`${sorted.length} strings`);
