// A DOM stub thin enough to import app/js/main.js in Node, and no thinner.
//
// main.js is the one module in this app that has never had unit tests, and the
// last two rounds of defects all lived in it: a lock bypass, a member cap that
// was dead in production, a pinning path that skipped its key check. Every one
// of those is invisible to a test that reimplements the rule instead of running
// it. So the real module gets loaded, against a fake page, and the checks drive
// the same functions the app does.
//
// This is deliberately NOT a general DOM: it answers what main.js, ui.js and
// map.js actually ask for while booting to onboarding, and nothing else. If a
// new call site needs more, add it here rather than reaching for a browser.

function makeEl(tag = "div") {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    dataset: {},
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" },
    classList: {
      _s: new Set(),
      add(...c) { for (const x of c) this._s.add(x); },
      remove(...c) { for (const x of c) this._s.delete(x); },
      toggle(c, on) { if (on === undefined ? this._s.has(c) : !on) this._s.delete(c); else this._s.add(c); },
      contains(c) { return this._s.has(c); },
    },
    hidden: false,
    disabled: false,
    textContent: "",
    value: "",
    id: "",
    className: "",
    scrollTop: 0,
    offsetWidth: 0,
    offsetHeight: 0,
    attrs: new Map(),
    setAttribute(k, v) { this.attrs.set(k, String(v)); },
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; },
    removeAttribute(k) { this.attrs.delete(k); },
    hasAttribute(k) { return this.attrs.has(k); },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    append(...kids) { this.children.push(...kids); },
    appendChild(kid) { this.children.push(kid); return kid; },
    insertBefore(kid) { this.children.push(kid); return kid; },
    prepend(...kids) { this.children.unshift(...kids); },
    replaceChildren(...kids) { this.children = kids; },
    remove() {},
    contains() { return false; },
    closest() { return null; },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 320, height: 640 }; },
    focus() {},
    blur() {},
    click() {},
    animate() { return { cancel() {}, finished: Promise.resolve() }; },
    setPointerCapture() {},
    releasePointerCapture() {},
  };
  return el;
}

// Leaflet is a classic script in the page, so map.js only ever touches
// globalThis.L. These are exactly the calls createMapView makes.
function makeLeaflet() {
  const layer = () => ({
    addTo() { return this; },
    remove() {},
    on() { return this; },
    setLatLng() { return this; },
    setZIndexOffset() {},
    setStyle() {},
    setLatLngs() {},
    setRadius() {},
    addAttribution() {},
    setOpacity() {},
  });
  const map = {
    setView() { return this; },
    distance: () => 0,
    getZoom: () => 12,
    project: () => ({ x: 0, y: 0 }),
    unproject: () => ({ lat: 0, lng: 0 }),
    flyTo() {},
    fitBounds() {},
    invalidateSize() {},
    on() { return this; },
    off() { return this; },
    addLayer() {},
    removeLayer() {},
    getPane: () => makeEl(),
    createPane: () => makeEl(),
  };
  return {
    map: () => map,
    tileLayer: layer,
    marker: layer,
    circle: layer,
    polyline: layer,
    divIcon: () => ({}),
    latLngBounds: () => ({ isValid: () => true, extend() { return this; }, pad() { return this; } }),
    control: { attribution: () => ({ addTo() { return this; }, addAttribution() {} }) },
  };
}

// Install the fake page. Returns a handle with the pieces a check may want to
// steer: the fetch queue and the collected toasts.
export function installDom({ hostname = "127.0.0.1" } = {}) {
  const head = makeEl("head");
  const body = makeEl("body");
  // Nodes are cached by the string that asked for them, so #join-waiting-text
  // is the same object on every lookup. Without that, a check can drive the
  // app but cannot read back a word of what it put on screen.
  const nodes = new Map();
  const node = (sel) => {
    if (!nodes.has(sel)) nodes.set(sel, makeEl());
    return nodes.get(sel);
  };
  const doc = {
    documentElement: makeEl("html"),
    head,
    body,
    visibilityState: "visible",
    createElement: (t) => makeEl(t),
    createElementNS: (_ns, t) => makeEl(t),
    createTextNode: (t) => ({ textContent: t }),
    createDocumentFragment: () => makeEl("fragment"),
    getElementById: (id) => node(`#${id}`),
    querySelector: (sel) => node(sel),
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
  };
  globalThis.document = doc;
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.L = makeLeaflet();
  globalThis.location = {
    hostname,
    href: `http://${hostname}/`,
    origin: `http://${hostname}`,
    pathname: "/",
    search: "",
    hash: "",
    reload() {},
  };
  globalThis.history = { replaceState() {} };
  globalThis.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(0), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.btoa ??= (s) => Buffer.from(s, "binary").toString("base64");
  globalThis.atob ??= (s) => Buffer.from(s, "base64").toString("binary");
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  // ui.js feature-detects `inert` off the prototype before it uses it.
  globalThis.HTMLElement = class HTMLElement {};
  globalThis.HTMLElement.prototype.inert = false;

  // Every timer the app arms is tracked so a check can stop the app dead at
  // the end. The poll loop, the re-key timer and the five second repaint all
  // re-arm themselves forever, and a leaked one keeps the test runner alive
  // long after the assertions are done.
  const timers = new Set();
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  globalThis.setTimeout = (...a) => {
    const id = realSetTimeout(...a);
    timers.add(id);
    return id;
  };
  globalThis.setInterval = (...a) => {
    const id = realSetInterval(...a);
    timers.add(id);
    return id;
  };

  // Nothing in a check may reach a network. Every request is answered from a
  // handler the check installs, and an unhandled one is a failure rather than
  // a silent empty feed.
  const state = { handler: null, calls: [] };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    state.calls.push({ url: u, init });
    const res = state.handler ? await state.handler(u, init) : null;
    if (res) return res;
    return { ok: true, status: 200, json: async () => ({ members: [] }) };
  };
  return {
    calls: state.calls,
    onFetch(fn) { state.handler = fn; },
    makeEl,
    // The element a selector resolves to, for reading back what was rendered.
    node,
    stopTimers() {
      for (const id of timers) {
        clearTimeout(id);
        clearInterval(id);
      }
      timers.clear();
    },
  };
}

// main.js boots on import and its boot is async, so a check has to wait for it
// to settle before touching state.
export async function loadApp(harness) {
  const mod = await import("../app/js/main.js");
  await settle();
  return { mod, internals: globalThis.window.__starlingInternals, api: globalThis.window.__starlingApi, harness };
}

export const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
