// Host environment: is this the Android wrapper, and which relay do we talk to?
// On the web every fetch is same-origin and invite links use the page's own
// origin, so nothing here changes behavior. Inside the wrapper the app is
// served from bundled assets on appassets.androidplatform.net, so API calls
// and invite links must name the canonical origin instead; a custom relay
// points both at a self-hosted instance.

const CANONICAL = "https://starlingmap.app";

export const isWrapped = () => !!globalThis.StarlingNative;
export const native = () => globalThis.StarlingNative ?? null;

// Circles live in the app. The hosted web page is a landing plus the demo:
// a browser tab is the weakest place to hold a long-lived location secret
// (extensions, shared machines, no OS keystore), so the web build refuses to
// create or open circles. Local dev servers keep the full app so the test
// suites and self-hosted development still work.
const DEV_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export function shareCapable() {
  if (isWrapped()) return true;
  const host = globalThis.location?.hostname;
  return typeof host === "string" && DEV_HOSTS.includes(host);
}

// Base for invite links: the canonical origin in the wrapper (asset origins
// mean nothing outside this device), the page's own origin on the web.
export function shareUrlBase() {
  if (isWrapped()) return `${CANONICAL}/`;
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
  apiBase = custom ?? (isWrapped() ? CANONICAL : "");
}

export function apiUrl(path) {
  if (apiBase === null) setApiBase(null);
  return `${apiBase}${path}`;
}

export const getApiBase = () => {
  if (apiBase === null) setApiBase(null);
  return apiBase;
};
