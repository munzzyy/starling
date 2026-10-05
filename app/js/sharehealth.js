// A running share in words: the sent note, the cards, and the bug report.
//
// The report is built from a fixed list of fields, each held to its shape, so
// it can never carry a position, key, name, place, circle or relay address.

import { t } from "./i18n.js";
import { fmtRelTime } from "./fmt.js";

// A minute, ahead of the viewers' three minute STALE_MS.
export const SENT_NOTE_MS = 60 * 1000;

// On a slower cadence the note waits the extra too: a post that is not due
// yet is not late.
export function noteAfter(cadenceS) {
  return SENT_NOTE_MS + Math.max(0, cadenceS - 15) * 1000;
}

// Mode 3, foreground only, spares a foreground service.
const SAVER_CUTS_LOCATION = new Set([1, 2, 4]);

export function parseHealth(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const h = JSON.parse(raw);
    return h && typeof h === "object" && !Array.isArray(h) ? h : null;
  } catch {
    return null;
  }
}

// Only what the person can change, worst first.
export function shareProblems(h) {
  if (!h) return [];
  const out = [];
  if (h.battery === "restricted") out.push("restricted");
  if (h.locationOn === false || h.locationOff === true) out.push("location-off");
  if (h.fine === false && h.coarse === true) out.push("coarse");
  if (h.powerSave === true && SAVER_CUTS_LOCATION.has(h.saverLocationMode)) out.push("saver");
  if (h.battery === "optimized") out.push("optimized");
  return out;
}

// `stale`: the circle already shows this phone as quiet, so stop saying "Live".
export function sentNote({ lastOkAt, startedAt, now, staleMs, noteMs = SENT_NOTE_MS }) {
  const since = lastOkAt || startedAt;
  if (!since || now - since < noteMs) return null;
  const age = now - since;
  if (!lastOkAt) return { stale: age >= staleMs, text: t("nothing sent yet") };
  return { stale: age >= staleMs, text: t("last sent {ago} ago", { ago: fmtRelTime(age) }) };
}

// Never the message: a network error can carry a URL.
export function sendErrorKind(e) {
  if (!e) return "unknown";
  if (e.code === "clock") return "clock";
  const name = typeof e.name === "string" ? e.name : "";
  if (name === "TimeoutError") return "timeout";
  if (name === "AbortError") return "aborted";
  if (name === "TypeError") return "network";
  const msg = typeof e.message === "string" ? e.message : "";
  const http = /^post (\d{3})$/.exec(msg);
  if (http) return `http ${http[1]}`;
  if (msg === "sender cancelled") return "cancelled";
  if (msg === "no key for epoch") return "no key";
  return "other";
}

// English whatever the app's language, so the report can be searched.
function age(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "never";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s ago`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return `${h} h ${String(min % 60).padStart(2, "0")} min ago`;
}

function span(ms) {
  return age(ms).replace(/ ago$/, "");
}

function yn(v) {
  return v === true ? "yes" : v === false ? "no" : "unknown";
}

function num(v) {
  return Number.isFinite(v) ? String(v) : "unknown";
}

// No decimals in a device name, dotted numbers in a version, words from a list.
const shaped = (re) => (v) => (typeof v === "string" && re.test(v) ? v : "unknown");
const version = shaped(/^\d{1,4}(\.\d{1,6}){0,4}$/);
const release = shaped(/^[A-Za-z0-9]{1,12}(\.\d{1,2}){0,2}$/);
const device = shaped(/^[A-Za-z0-9 ()+_/-]{1,60}$/);
const webview = shaped(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+ \d{1,4}(\.\d{1,6}){0,4}$/);
const oneOf = (...words) => (v) => (words.includes(v) ? v : "unknown");
const batteryWord = oneOf("unrestricted", "optimized", "restricted");
const BACKGROUND_WORDS = {
  granted: "allowed",
  dialog: "not allowed",
  settings: "not allowed",
  notNeeded: "not needed (Android 9)",
  noLocation: "no location permission",
};
const CAME_BACK = { boot: "after a restart", update: "after an update", "": "no" };
const STILL_SETTING = { on: "on", off: "off", steady: "off, Steady sending is on", sos: "off during the SOS" };
const opWord = oneOf("allowed", "foreground", "ignored", "errored", "default");
const failWord = (v) =>
  typeof v === "string" && (/^http \d{3}$/.test(v) || ["clock", "timeout", "aborted", "network", "cancelled", "no key", "other"].includes(v))
    ? v
    : "unknown";

const BUCKETS = { 5: "exempted", 10: "active", 20: "working set", 30: "frequent", 40: "rare", 45: "restricted", 50: "never" };

export function shareReport({ h, page, now }) {
  const p = page || {};
  const lines = ["Starling sharing report"];
  lines.push(`Made: ${new Date(now).toISOString().slice(0, 16)}Z`);
  lines.push(`App: ${version(h?.app ?? p.version)} (page ${version(p.version)})`);
  if (h) {
    lines.push(`Android: ${release(h.android)} (SDK ${num(h.sdk)})`);
    lines.push(`Device: ${device(h.device)}`);
    lines.push(`WebView: ${webview(h.webview)}`);
  } else {
    lines.push("Wrapper: none, or too old to report");
  }
  lines.push("");
  lines.push(`Sharing: ${p.sharing ? `on for ${span(now - (p.startedAt || now))}` : "off"}`);
  if (h) {
    lines.push(`Keep sharing when closed: ${yn(h.keepSharing)}`);
    // Older wrappers have no such switches, and saying "unknown" about them would mislead.
    if ("autoBoot" in h) {
      lines.push(`Comes back by itself: after a restart ${yn(h.autoBoot)}, after an update ${yn(h.autoUpdate)}`);
      lines.push(`Location all the time: ${Object.hasOwn(BACKGROUND_WORDS, h.background) ? BACKGROUND_WORDS[h.background] : "unknown"}`);
      lines.push(`This share came back by itself: ${Object.hasOwn(CAME_BACK, h.resumedBy) ? CAME_BACK[h.resumedBy] : "unknown"}`);
      lines.push(`Shares that came back by itself since the app started: ${num(h.headlessResumes)}, given up: ${num(h.headlessAbandons)}`);
    }
    const where = h.windowShown ? "on screen" : h.headless ? (h.holding ? "closed, held" : "closed") : "in the background";
    lines.push(`App window: ${where}`);
    lines.push(`Location permission: ${h.fine ? "precise" : h.coarse ? "approximate only" : "none"} (app op ${opWord(h.fineOp)})`);
    lines.push(`Location: switch ${h.locationOn ? "on" : "off"}, GPS ${h.gpsOn ? "on" : "off"}, network ${h.networkOn ? "on" : "off"}`);
    lines.push(`Notifications allowed: ${yn(h.notifications)}`);
    lines.push(`Battery use: ${batteryWord(h.battery)}`);
    lines.push(`Battery Saver: ${h.powerSave ? "on" : "off"} (location mode ${num(h.saverLocationMode)})`);
    lines.push(`Device idle: ${h.deviceIdle ? "deep" : h.lightIdle ? "light" : "no"}`);
    lines.push(`Standby bucket: ${BUCKETS[h.standbyBucket] || num(h.standbyBucket)}`);
    lines.push(`Tor: ${yn(h.tor)}`);
  }
  lines.push(`Relay: ${p.customRelay ? "custom" : "default"}`);
  lines.push("");
  if (h) {
    lines.push(`Share service: ${h.service ? `running for ${span(h.sharingMs)}` : "not running"}`);
    lines.push(`Fixes: ${num(h.fixes)} (GPS ${num(h.gpsFixes)}, network ${num(h.networkFixes)}), last ${age(h.lastFixMs)}`);
    lines.push(`Minutes with no fix: ${num(h.ticks)}, location requests renewed ${num(h.rewatches)} times`);
    if ("stillSupported" in h) {
      const setting = h.stillSupported !== true ? "no motion sensor on this phone" : Object.hasOwn(STILL_SETTING, p.still) ? STILL_SETTING[p.still] : "unknown";
      lines.push(`Save battery when still: ${setting}`);
      lines.push(`Still: ${h.still === true ? "now" : "no"}, ${num(h.stillSpells)} times this share, ${span(h.stillMs)} in all`);
    }
    lines.push(`Page frozen during shares: ${num(h.freezes)} times, woken ${num(h.nudges)} times, last answered ${age(h.lastPulseMs)}`);
    if (h.holderFailed) lines.push("Could not hold the page after the app closed");
  }
  lines.push(`Posts this share: ${num(p.ok ?? 0)} sent, ${num(p.failed ?? 0)} failed`);
  lines.push(`Last sent: ${p.lastOkAt ? age(now - p.lastOkAt) : "never"}`);
  if (p.lastErr) lines.push(`Last failure: ${failWord(p.lastErr)}, ${age(now - (p.lastErrAt || now))}`);
  return lines.join("\n");
}
