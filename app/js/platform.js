// What this browser can actually do, from feature detection, never from
// navigator.userAgent. UA strings lie on purpose (privacy browsers rewrite
// them, iPadOS presents as a Mac's) and even an honest one only says what a
// browser claims to be, not what it will grant. main.js and ui.js read these
// instead of sniffing, so a browser that ships a capability later starts
// getting it for free.
//
// The facts this module is built to be honest about: iOS gives a PWA zero
// background execution (geolocation is [Exposed=Window], so even a
// push-woken service worker cannot read a position), so any "sharing" here
// only ever runs while the tab has focus and the screen is on. That is not
// a bug to hide; it is the thing the UI has to say out loud.

import { isWrapped } from "./env.js";

// navigator.standalone exists only in Apple's WebKit on iOS and iPadOS, in a
// browser tab or on the home screen. No other engine ships it, so its mere
// presence is as reliable an "this is iOS Safari's engine" signal as
// capability detection gets.
export function isIOS() {
  return typeof navigator.standalone === "boolean";
}

// Chrome, Firefox and every other iOS browser runs on the same WebKit engine
// Apple requires, so isIOS() is true for all of them, but only Safari itself
// exposes Share -> Add to Home Screen. There is no capability that
// distinguishes them; this is the one place in this module that reads the UA,
// and it is used only to pick which install instructions to print, never to
// gate a security or sharing decision.
export function isIOSSafari() {
  if (!isIOS()) return false;
  const ua = navigator.userAgent || "";
  return !/CriOS|FxiOS|EdgiOS|OPiOS|Mercury/.test(ua);
}

// Installed to the home screen, or, on Chromium, launched as its own window.
// iOS never sets display-mode from an ordinary browser tab and Chromium never
// sets navigator.standalone, so the two checks are complementary, not
// redundant; asking both is how one function answers "installed?" everywhere.
export function isInstalled() {
  if (typeof navigator.standalone === "boolean") return navigator.standalone;
  return typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches;
}

// The Android wrapper runs a foreground service that keeps delivering fixes
// with the screen off (see geo.js). No web engine offers anything like it:
// Background Sync and Periodic Sync exist but cannot touch geolocation, so a
// PWA's sharing, on iOS or anywhere else, only ever runs foreground. This is
// therefore just isWrapped() today, named for what the UI actually needs to
// ask, so the day some engine ships a real background location API this is
// the one place that changes.
export function canShareInBackground() {
  return isWrapped();
}

export function hasWakeLock() {
  return "wakeLock" in navigator;
}

// ---------------------------------------------------------- storage persist

// Cached last-known answer so a synchronous read (e.g. painting a banner) has
// something to show before the async check below resolves. Starts null, not
// false, so callers can tell "not asked yet" from "asked and refused".
let persistedCache = null;

export function persistedCached() {
  return persistedCache;
}

// Safari only grants persist() reliably once the app has been added to the
// home screen; a bare tab sits under the 7 day ITP storage cap regardless of
// what this returns, and asking from one just spends a permission prompt on
// a "no" the cap enforces anyway. Callers should ask again after every
// install-state change, since the answer can only improve.
export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  if (!isWrapped() && !isInstalled()) return false;
  try {
    persistedCache = await navigator.storage.persist();
  } catch {
    persistedCache = false;
  }
  return persistedCache;
}

// A read that does not ask for anything, for the boot-time "should we warn
// that circle keys can be evicted" check. Not every engine implements
// persisted(); where it is missing this falls back to the last requestPersistence()
// result rather than claiming to know.
export async function isPersisted() {
  if (!navigator.storage?.persisted) return persistedCache ?? false;
  try {
    persistedCache = await navigator.storage.persisted();
  } catch {
    // leave the cache as it was
  }
  return persistedCache ?? false;
}

// ------------------------------------------------------------- foreground session

// The thing keeping a share (or a beacon view) alive on a platform with no
// background execution is a screen the user leaves on and a Wake Lock that
// fights the OS dimming it. iOS releases a Wake Lock the instant the tab is
// backgrounded (screen lock, app switch, even Control Center) and does not
// say why; re-acquiring on every visibilitychange is the only way back once
// the tab is foreground again, so this owns that loop rather than asking
// every caller to reimplement it.
//
// onTick(elapsedMs) exists so the UI can paint a running timer instead of a
// static "sharing" label: the fact that this only works with the screen on
// is exactly what the timer is for.
export function createForegroundSession({ onTick, onWakeLockChange } = {}) {
  let wakeLock = null;
  let startedAt = null;
  let tickId = null;
  let active = false;

  async function acquire() {
    if (!hasWakeLock() || document.visibilityState !== "visible") return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
        onWakeLockChange?.(false);
      });
      onWakeLockChange?.(true);
    } catch {
      // Denied, Low Power Mode, or the tab went hidden again before the
      // request resolved. Sharing keeps running foreground either way; the
      // UI's job is to say the lock did not take, not to retry silently.
      wakeLock = null;
      onWakeLockChange?.(false);
    }
  }

  function onVisibility() {
    if (!active || document.visibilityState !== "visible") return;
    acquire();
  }

  function start() {
    if (active) return;
    active = true;
    startedAt = Date.now();
    acquire();
    document.addEventListener("visibilitychange", onVisibility);
    if (onTick) {
      onTick(0);
      tickId = setInterval(() => onTick(Date.now() - startedAt), 1000);
    }
  }

  async function stop() {
    if (!active) return;
    active = false;
    document.removeEventListener("visibilitychange", onVisibility);
    if (tickId) {
      clearInterval(tickId);
      tickId = null;
    }
    startedAt = null;
    const lock = wakeLock;
    wakeLock = null;
    if (lock) {
      try {
        await lock.release();
      } catch {
        // already released, e.g. the tab was already hidden
      }
    }
  }

  return {
    start,
    stop,
    get active() {
      return active;
    },
  };
}

// --------------------------------------------------------------- install prompt

// iOS has no install-prompt API: Share -> Add to Home Screen is the only
// path and it only exists inside Safari itself (isIOSSafari() above is what
// the UI needs to decide whether to show it). Chromium ships
// beforeinstallprompt instead, fired once, and the event is only ever usable
// if something holds onto it: calling preventDefault() suppresses Chromium's
// own mini-infobar and lets the app replay the prompt from its own button
// later, but the browser drops the event forever if nothing captures it here.
let deferredPrompt = null;

globalThis.addEventListener?.("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
});

globalThis.addEventListener?.("appinstalled", () => {
  deferredPrompt = null;
});

export function canPromptInstall() {
  return deferredPrompt !== null;
}

// Resolves to "accepted", "dismissed", or null if there was nothing to prompt
// (already installed, iOS, or the event never fired). The captured event is
// single use, so this always clears it whether the user accepts or not.
export async function promptInstall() {
  if (!deferredPrompt) return null;
  const evt = deferredPrompt;
  deferredPrompt = null;
  evt.prompt();
  const choice = await evt.userChoice;
  return choice.outcome;
}
