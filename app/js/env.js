// Host environment: is this one of the wrappers, and which relay do we talk
// to? On the web every fetch is same-origin and invite links use the page's
// own origin, so nothing here changes behavior. Inside a wrapper the app is
// served from bundled assets (appassets.androidplatform.net on Android, the
// starling: scheme on iOS), so API calls and invite links must name the
// canonical origin instead; a custom relay points both at a self-hosted
// instance.

const CANONICAL = "https://starlingmap.app";

export const isWrapped = () => !!globalThis.StarlingNative;
export const native = () => globalThis.StarlingNative ?? null;

// The iOS wrapper serves this same bundle on its own scheme. There is no
// StarlingNative there, and must not be until iOS can actually deliver what
// the bridge names (background fixes, notifications, the OS wipe), so
// isWrapped() stays false and every capability that hangs off it keeps
// reading as absent. What the scheme does say: this page came out of a
// signed app bundle, not off the network.
export const isIOSWrapped = () => globalThis.location?.protocol === "starling:";

// Served from bundled assets rather than the web: the Android asset origin
// or the iOS wrapper's scheme. Same-origin fetches and same-origin invite
// links mean nothing outside the device in either case, so both route to
// the canonical origin instead.
export const isBundled = () => isWrapped() || isIOSWrapped();

// Circles live in the app. The hosted web page is a landing plus the demo:
// a browser tab is the weakest place to hold a long-lived location secret
// (extensions, shared machines, no OS keystore, and served code can be
// re-targeted at one visitor in a way a signed, reproducible APK cannot), so
// the web build refuses to create or open circles. Local dev servers keep the
// full app so the test suites and self-hosted development still work.
const DEV_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

// THE gate, and the only one. Everything above this line is context; this is
// the single switch that decides whether a browser tab may hold a circle
// secret at all. It stays false for starlingmap.app.
//
// A self-hoster who accepts the browser-tab tradeoff above flips this
// constant to true in their own deployment and rebuilds. Nothing else in the
// app reads the hostname to make this decision; flipping it is the whole
// change, and it is a decision for whoever runs that deployment, not for
// the hosted site.
//
// The iOS wrapper is not that tradeoff and does not use this switch: its
// page is a pinned bundle in an app sandbox, with no extensions and no
// server that could re-target one visitor, which beats a hosted tab on
// every count the paragraph above worries about. It passes shareCapable on
// its own arm. What it does NOT get is background location: there is no
// bridge on iOS, canShareInBackground() stays false, and the UI keeps
// saying that sharing runs foreground-only.
const WEB_SHARE_ENABLED = false;

// Test hooks are a debugging convenience and an attack surface, and the second
// matters more here. The strict CSP makes injected script hard, but "hard" is
// not the bar for a handle that hands out live state or calls the unlock path,
// so they exist only where the tests that need them run: a loopback dev
// server. Never on the hosted site, and never inside the shipped Android app,
// which serves the same bundle from its own asset origin.
//
// This does NOT cover __starlingFix or __starlingBio. Those are not debug
// hooks, they are the callbacks the native side invokes to deliver a location
// fix and a biometric result, and the app does not work without them.
// A loopback dev server is http(s) on a loopback name. The protocol check
// is load-bearing: the iOS wrapper's origin is starling://localhost, whose
// HOSTNAME is on the dev list, and a hostname match alone would switch the
// debug surface on inside a shipped app.
function isDevServer() {
  const loc = globalThis.location;
  if (!loc || (loc.protocol !== "http:" && loc.protocol !== "https:")) return false;
  return typeof loc.hostname === "string" && DEV_HOSTS.includes(loc.hostname);
}

export function debugHooks() {
  return isDevServer();
}

export function shareCapable() {
  if (isBundled()) return true;
  if (WEB_SHARE_ENABLED) return true;
  return isDevServer();
}

// Base for invite links: the canonical origin when served from bundled
// assets (those origins mean nothing outside this device), the page's own
// origin on the web.
export function shareUrlBase() {
  if (isBundled()) return `${CANONICAL}/`;
  return `${globalThis.location.origin}${globalThis.location.pathname}`;
}

// A custom relay is an https URL, origin plus optional path, no credentials,
// query, or fragment. Returns the normalized string or null on junk.
export function normalizeRelay(value) {
  if (typeof value !== "string") return null;
  const s = value.trim().replace(/\/+$/, "");
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.username || u.password || u.search || u.hash) return null;
  const path = u.pathname.replace(/\/+$/, "");
  return u.origin + (path === "" || path === "/" ? "" : path);
}

// The API base is set once at boot, before any poller or sender exists.
// "" means same-origin (the web default).
let apiBase = null;

export function setApiBase(customRelay) {
  const custom = normalizeRelay(customRelay);
  apiBase = custom ?? (isBundled() ? CANONICAL : "");
}

export function apiUrl(path) {
  if (apiBase === null) setApiBase(null);
  return `${apiBase}${path}`;
}

export const getApiBase = () => {
  if (apiBase === null) setApiBase(null);
  return apiBase;
};

// Base for beacon (emergency help) links. The viewer page must poll the same
// relay the beacon posts to, and the hosted site's CSP header pins
// connect-src to its own origin (the wrappers' meta CSP allows https:, which
// is what lets their fetches reach the canonical relay at all), so the link
// names the relay's origin: the custom relay when one is set (self-hosters
// serve app and relay from one origin), otherwise the canonical origin in
// the wrapper or this page's origin on the web.
// `/help`, not `/help.html`: the host serves the page there and answers the
// .html spelling with a redirect. An emergency link should not spend a round
// trip on a redirect, and should not be the thing that discovers a client
// which drops the fragment across one.
export function helpUrlBase() {
  const base = getApiBase();
  if (base) return `${base}/help`;
  return `${globalThis.location.origin}/help`;
}
