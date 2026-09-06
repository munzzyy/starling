// Translation, gettext style: the English source string is the key. That
// keeps English as the always-complete baseline (an untranslated string
// degrades to English instead of to a key or a blank), keeps every test
// asserting real copy valid, and makes extraction mechanical. Catalogs map
// normalized English to the target language; {name}-style placeholders are
// substituted after lookup, so translators can reorder them freely.
//
// No build step, no external service: catalogs are plain modules, shipped
// with the app like everything else.

import { es } from "./strings-es.js";

const CATALOGS = { es };

// Direction by locale, for the day an RTL catalog lands. The engine and the
// document wiring are ready for it; the CSS keeps earning it separately.
const DIR = { ar: "rtl", fa: "rtl", he: "rtl", ur: "rtl" };

export const LOCALE_CHOICES = [
  { id: "auto", label: "Auto" },
  { id: "en", label: "English" },
  { id: "es", label: "Español" },
];

let active = null; // null means English source text passes through
let activeCode = "en";

export const norm = (s) => String(s).replace(/\s+/g, " ").trim();

// Which locale a preference resolves to. "auto" walks the browser's list and
// takes the first language there is a catalog for; English wins ties because
// it is the source.
export function resolveLocale(pref) {
  if (pref && pref !== "auto") return pref === "en" || CATALOGS[pref] ? pref : "en";
  for (const tag of navigator.languages || [navigator.language || "en"]) {
    const code = String(tag).slice(0, 2).toLowerCase();
    if (code === "en") return "en";
    if (CATALOGS[code]) return code;
  }
  return "en";
}

export function setLocale(code) {
  activeCode = code === "en" || CATALOGS[code] ? code : "en";
  active = activeCode === "en" ? null : CATALOGS[activeCode];
  if (globalThis.document) {
    document.documentElement.lang = activeCode;
    document.documentElement.dir = DIR[activeCode] || "ltr";
  }
}

export const currentLocale = () => activeCode;

export function t(text, vars) {
  let out = text;
  if (active) {
    if (active[text] !== undefined) {
      out = active[text];
    } else {
      // Catalog keys are whitespace-normalized; a source string carrying
      // deliberate leading or trailing space (glue for composed sentences)
      // keeps that space around the translation.
      const hit = active[norm(text)];
      if (hit !== undefined) out = text.match(/^\s*/)[0] + hit + text.match(/\s*$/)[0];
    }
  }
  if (vars) {
    // One pass over the TEMPLATE, never over substituted output: a member
    // who names themselves "{gone}" must not have another variable's value
    // re-substituted into their slot. Sequential replaceAll had exactly
    // that hole, in the who-removed-whom strings of all places.
    out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  }
  return out;
}

// Translate the static page: every [data-i18n] element's text is looked up
// by its normalized English source. The source is stashed on first touch so
// a later locale switch translates from English again, not from the last
// translation.
export function translateDom(root) {
  // Node imports these modules for tests; no document means nothing to do.
  const scope = root || globalThis.document;
  if (!scope?.querySelectorAll) return;
  for (const node of scope.querySelectorAll("[data-i18n]")) {
    if (!node.dataset.i18nSrc) node.dataset.i18nSrc = norm(node.textContent);
    node.textContent = t(node.dataset.i18nSrc);
  }
  for (const node of scope.querySelectorAll("[data-i18n-attr]")) {
    for (const attr of node.dataset.i18nAttr.split(",")) {
      // Plain attributes, not dataset: attr names like "aria-label" are not
      // legal DOMStringMap property names.
      const stash = `data-i18n-src-${attr}`;
      if (!node.hasAttribute(stash)) node.setAttribute(stash, norm(node.getAttribute(attr) || ""));
      node.setAttribute(attr, t(node.getAttribute(stash)));
    }
  }
}
