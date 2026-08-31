// App orchestration: boot, screens, sharing, demo, settings. State lives here;
// components live in ui.js, protocol I/O in net.js, map in map.js.

import {
  parseInviteFragment,
  newCircleSecret,
  deriveChannelId,
  deriveEncKey,
  generateIdentity,
  inviteFragment,
} from "./crypto.js";
import { qrSvg } from "./qr.js";
import { dbGet, dbSet, dbDel, wipeAll, persistenceBroken } from "./store.js";
import {
  newVaultKey,
  makePasscodeRecord,
  openPasscodeRecord,
  makeBioRecord,
  openBioRecord,
  sealUnderVault,
  openUnderVault,
  platformAuthenticatorAvailable,
  zero,
} from "./lock.js";
import * as ui from "./ui.js";
import { createMapView } from "./map.js";
import { createPoller, createRoster, createSender, statusOf, sortMembers, STALE_MS } from "./net.js";
import { startWatch, batteryLevel } from "./geo.js";
import { haversineMeters, coarsePos, hueFromMemberId } from "./fmt.js";
import { createDemo, DEMO_CENTER } from "./demo.js";

// Error collector so automated checks can read back anything that went wrong.
window.__starlingErrors = [];
window.addEventListener("error", (e) => {
  window.__starlingErrors.push(String(e.message || e.error || "error"));
});
window.addEventListener("unhandledrejection", (e) => {
  window.__starlingErrors.push(`unhandled: ${String(e.reason)}`);
});

const $ = ui.$;
const byTestid = (id) => document.querySelector(`[data-testid="${id}"]`);

const state = {
  screen: "onboarding",
  demo: false,
  sharing: false,
  sosActive: false,
  secret: null,
  channelId: null,
  encKey: null,
  identity: null,
  profile: null,
  settings: { precision: "precise", trail: true, basemap: "dark", theme: "dark", wakeLock: false },
  circleName: "My circle",
  me: null,
  geoDenied: false,
  geoFailed: false,
  netStatus: "idle",
  offline: !navigator.onLine,
  locked: false,
  lock: null, // { enabled, autolockMs, pass, bio } when app lock is on
  vaultKey: null, // 32 bytes in memory only while unlocked
};

let roster = null;
let poller = null;
let sender = null;
let mapView = null;
let sheet = null;
let demo = null;
let demoMembers = [];
let focusedId = null;
let focusTrailOn = false;
let stopGeo = null;
let shareTimer = 0;
let lastSentPos = null;
let wakeLock = null;
const prevStatus = new Map();

const insecureContext =
  !window.isSecureContext && !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

const members = () => (state.demo ? demoMembers : roster ? roster.list() : []);
const myHue = () => (state.identity ? hueFromMemberId(state.identity.memberId) : 205);

// ------------------------------------------------------------------ theme

const mqLight = matchMedia("(prefers-color-scheme: light)");
function resolvedTheme() {
  const t = state.settings.theme;
  return t === "auto" ? (mqLight.matches ? "light" : "dark") : t;
}
function applyTheme() {
  document.documentElement.dataset.theme = resolvedTheme();
}
mqLight.addEventListener("change", () => {
  if (state.settings.theme === "auto") applyTheme();
});

// ------------------------------------------------------------ debug hook

window.__starlingState = () => {
  const now = Date.now();
  return {
    screen: state.screen,
    sharing: !!state.sharing,
    demo: !!state.demo,
    locked: !!state.locked,
    lockEnabled: !!state.lock?.enabled,
    hasBio: !!state.lock?.bio,
    channel: state.channelId || null,
    members: sortMembers(members(), now).map((r) => ({
      id: r.id,
      name: r.name ?? null,
      lat: Number.isFinite(r.lat) ? r.lat : null,
      lon: Number.isFinite(r.lon) ? r.lon : null,
      ts: r.ts ?? null,
      type: r.type ?? null,
      stale: now - r.ts > STALE_MS,
    })),
    me:
      state.identity || state.demo
        ? {
            id: state.identity?.memberId || "demo",
            name: state.profile?.name || "You",
            lat: state.me?.lat ?? null,
            lon: state.me?.lon ?? null,
          }
        : null,
  };
};

// Debug hook: frame everyone with a position, like the demo's opening shot.
window.__starlingFit = () => {
  if (!mapView) return false;
  const pts = members().filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
  if (state.me && Number.isFinite(state.me.lat)) pts.push({ lat: state.me.lat, lon: state.me.lon });
  if (!pts.length) return false;
  mapView.fitAll(pts);
  return true;
};

// --------------------------------------------------------------- screens

function showScreen(name) {
  state.screen = name;
  $("#screen-lock").hidden = name !== "lock";
  $("#screen-onboarding").hidden = name !== "onboarding";
  $("#screen-map").hidden = name !== "map";
  ensureWakeLock();
}

let sheetAutoOpened = false;

function showMap() {
  ensureMapUI();
  showScreen("map");
  requestAnimationFrame(() => mapView.invalidate());
  if (sheet.getSnap() !== "full") {
    // An empty circle opens at half so the invite nudge is in view.
    const wantHalf = !state.demo && state.channelId && members().length === 0 && !sheetAutoOpened;
    if (wantHalf) sheetAutoOpened = true;
    sheet.snapTo(wantHalf ? "half" : "peek", false);
  }
  render();
}

function ensureMapUI() {
  if (mapView) return;
  mapView = createMapView($("#map"), { onMarkerTap: focusMember });
  mapView.setBasemap(state.settings.basemap);
  sheet = ui.createSheet($("#sheet"), $("#sheet-drag"), $("#sheet-body"));

  byTestid("share-toggle").addEventListener("click", () => setSharing(!state.sharing));
  byTestid("checkin-button").addEventListener("click", doCheckin);
  ui.holdToFire(byTestid("sos-button"), {
    ms: 1200,
    onFire: fireSos,
    onShortTap: () => ui.toast("Press and hold to send SOS"),
  });
  byTestid("settings-open").addEventListener("click", openSettings);
  $("#fab-locate").addEventListener("click", locateMe);
  $("#banner-demo-exit").addEventListener("click", exitDemo);
  $("#nudge-invite").addEventListener("click", openInvite);
}

// ------------------------------------------------------------- rendering

function render() {
  if (state.screen !== "map" || !mapView) return;
  const now = Date.now();
  const list = sortMembers(members(), now);
  renderChrome();
  renderYou();
  ui.updateMemberList($("#member-list"), list, {
    now,
    mePos: state.me,
    statusOf,
    onTap: focusMember,
  });
  ui.updateAvaStrip($("#ava-strip"), list, { statusOf, now });
  renderMarkers(list, now);
  $("#nudge").hidden = state.demo || !state.channelId || list.length > 0;
  renderFocus(list, now);
}

function renderChrome() {
  $("#pill-name").textContent = state.demo ? "Demo circle" : state.circleName;
  const dotState = state.demo ? "ok" : state.netStatus;
  const dot = $("#status-dot");
  dot.className = `status-dot dot-${dotState}`;
  const reconnecting = !state.demo && (state.offline || state.netStatus === "reconnecting");
  $("#banner-offline").hidden = !reconnecting;
  $("#banner-insecure").hidden = !insecureContext;
  $("#banner-demo").hidden = !state.demo;
}

function renderYou() {
  const p = state.profile || {};
  $("#you-emoji").textContent = p.emoji || "\u{1F9ED}";
  $("#you-name").textContent = p.name || "You";
  $("#you-ava").style.setProperty("--m-hue", String(myHue()));
  const hasFix = !!(state.me && Number.isFinite(state.me.lat));
  let sub;
  if (!state.sharing) sub = "Not sharing";
  else if (state.sosActive) sub = hasFix ? "SOS armed · Sharing live" : "SOS armed · Locating...";
  else if (!hasFix) sub = state.geoFailed ? "No location fix yet. Still trying..." : "Locating...";
  else sub = state.settings.precision === "coarse" ? "Live · Neighborhood" : "Live · Precise";
  $("#you-sub").textContent = sub;
  const toggle = byTestid("share-toggle");
  toggle.classList.toggle("on", state.sharing);
  toggle.setAttribute("aria-pressed", String(state.sharing));
  $("#share-label").textContent = state.sharing
    ? hasFix
      ? "Sharing live"
      : "Locating..."
    : "Start sharing";
  $("#geo-warn").hidden = !state.geoDenied;
  $("#sos-notice").hidden = !state.sosActive;
  const checkBtn = byTestid("checkin-button");
  checkBtn.setAttribute(
    "aria-label",
    state.sosActive ? "Cancel SOS and check in with your circle" : "Check in with your circle",
  );
  checkBtn.classList.toggle("check-attn", state.sosActive);
  byTestid("sos-button").classList.toggle("sos-active", state.sosActive);
}

function renderMarkers(list, now) {
  const wanted = new Set();
  for (const rec of list) {
    if (!Number.isFinite(rec.lat) || !Number.isFinite(rec.lon)) continue;
    wanted.add(rec.id);
    mapView.upsert(rec.id, {
      lat: rec.lat,
      lon: rec.lon,
      name: rec.name || "Member",
      emoji: rec.emoji || "",
      hue: rec.hue ?? hueFromMemberId(rec.id),
      status: statusOf(rec, now),
    });
  }
  if (state.me && Number.isFinite(state.me.lat)) {
    wanted.add("me");
    mapView.upsert("me", {
      lat: state.me.lat,
      lon: state.me.lon,
      name: "You",
      emoji: state.profile?.emoji || "\u{1F9ED}",
      hue: myHue(),
      status: state.sosActive ? "sos" : "live",
      self: true,
      sharing: state.sharing,
    });
  }
  for (const id of mapView.markerIds()) {
    if (!wanted.has(id)) mapView.removeMarker(id);
  }
  if (focusedId && focusTrailOn && state.settings.trail) {
    const rec = list.find((r) => r.id === focusedId);
    if (rec?.trail?.length > 1) {
      mapView.setTrail(focusedId, rec.trail, rec.hue ?? hueFromMemberId(rec.id));
    }
  }
  // In the demo every walker gets a short comet tail; it sells the motion.
  if (state.demo) {
    for (const rec of list) {
      if (rec.id === focusedId && focusTrailOn) continue;
      if (rec.trail?.length > 1) {
        mapView.setTrail(rec.id, rec.trail.slice(-50), rec.hue ?? 0);
      }
    }
  }
}

function renderFocus(list, now) {
  const card = $("#focus-card");
  if (!focusedId) {
    card.hidden = true;
    return;
  }
  const rec = list.find((r) => r.id === focusedId);
  if (!rec) {
    unfocus();
    return;
  }
  ui.renderFocusCard(card, rec, {
    now,
    mePos: state.me,
    statusOf,
    trailOn: focusTrailOn && state.settings.trail,
    onTrailToggle: () => {
      focusTrailOn = !focusTrailOn;
      if (!focusTrailOn) mapView.clearTrail(focusedId);
      render();
    },
    onClose: unfocus,
  });
}

// ---------------------------------------------------------------- focus

function focusMember(id) {
  if (id === "me") {
    locateMe();
    return;
  }
  const rec = members().find((r) => r.id === id);
  if (!rec) return;
  // Switching focus directly between members must not leave the previous
  // member's trail painted on the map.
  if (focusedId && focusedId !== id) mapView.clearTrail(focusedId);
  focusedId = id;
  focusTrailOn = state.settings.trail;
  if (Number.isFinite(rec.lat)) mapView.focusOn(rec.lat, rec.lon);
  render();
}

function unfocus() {
  if (focusedId) mapView.clearTrail(focusedId);
  focusedId = null;
  const card = $("#focus-card");
  card.hidden = true;
  card.dataset.member = "";
  render();
}

function locateMe() {
  if (state.me && Number.isFinite(state.me.lat)) {
    mapView.focusOn(state.me.lat, state.me.lon, 16, 0);
  } else {
    ui.toast("No location yet. Start sharing to place yourself.");
  }
}

// ---------------------------------------------------------------- circle

async function enterCircle() {
  state.channelId = await deriveChannelId(state.secret);
  state.encKey = await deriveEncKey(state.secret);
  setupNet();
  showMap();
}

function setupNet() {
  poller?.stop();
  roster = createRoster({
    channelId: state.channelId,
    encKey: state.encKey,
    selfId: state.identity.memberId,
  });
  sender = createSender({
    identity: state.identity,
    channelId: state.channelId,
    encKey: state.encKey,
    getLastTs: () => dbGet("lastSentTs"),
    setLastTs: (ts) => dbSet("lastSentTs", ts),
  });
  poller = createPoller({
    channelId: state.channelId,
    roster,
    onChange: () => {
      checkAlerts();
      render();
    },
    onStatus: (s) => {
      state.netStatus = s;
      if (state.screen === "map") renderChrome();
    },
  });
  if (!state.demo) poller.start();
}

async function persistCircle() {
  await writeSecretAtRest();
  await dbSet("identity", {
    alg: state.identity.alg,
    privateKey: state.identity.privateKey,
    pk: state.identity.pk,
    memberId: state.identity.memberId,
  });
  await dbSet("lastSentTs", 0);
}

// The circle secret is the crown jewel. With app lock on it is written only
// sealed under the in-memory vault key; with lock off it is stored as bytes,
// same as an unlocked phone's other app data. Exactly one form is ever on disk.
async function writeSecretAtRest() {
  if (state.lock?.enabled) {
    // Fail closed: with lock on, the secret is NEVER written in plaintext. If
    // the vault key is not in memory we are locked or mid-teardown and must not
    // be persisting a secret at all, so refuse rather than silently downgrade.
    if (!state.vaultKey) throw new Error("locked: refusing to write the secret");
    await dbSet("vaultSecret", await sealUnderVault(state.vaultKey, state.secret));
    await dbDel("secret");
  } else {
    await dbSet("secret", state.secret);
    await dbDel("vaultSecret");
  }
}

// ------------------------------------------------------------------ app lock

let lockTimer = 0;
let lockWired = false;

async function enableLock(passcode) {
  const K = newVaultKey();
  const pass = await makePasscodeRecord(passcode, K);
  state.vaultKey = K;
  state.lock = { enabled: true, autolockMs: 60000, pass, bio: null };
  await dbSet("vaultSecret", await sealUnderVault(K, state.secret));
  await dbSet("lock", state.lock);
  await dbDel("secret");
}

async function disableLock(passcode) {
  const K = await openPasscodeRecord(state.lock.pass, passcode);
  if (!K) return false;
  zero(state.vaultKey);
  state.vaultKey = null;
  state.lock = null;
  await dbSet("secret", state.secret);
  await dbDel("vaultSecret");
  await dbDel("lock");
  return true;
}

async function changePasscode(oldPc, newPc) {
  const K = await openPasscodeRecord(state.lock.pass, oldPc);
  if (!K) return false;
  state.lock = { ...state.lock, pass: await makePasscodeRecord(newPc, K) };
  await dbSet("lock", state.lock);
  zero(K);
  return true;
}

async function enableBiometric() {
  if (!state.vaultKey) return false;
  const rec = await makeBioRecord(state.vaultKey);
  if (!rec) return false;
  state.lock = { ...state.lock, bio: rec };
  await dbSet("lock", state.lock);
  return true;
}

async function disableBiometric() {
  state.lock = { ...state.lock, bio: null };
  await dbSet("lock", state.lock);
}

async function setAutolock(ms) {
  state.lock = { ...state.lock, autolockMs: ms };
  await dbSet("lock", state.lock);
}

// Unlock recovers the vault key by one of the two paths, decrypts the sealed
// secret, and enters the circle. Returns false on a wrong passcode or a failed
// biometric so the lock screen can say so; the sealed secret never leaves disk
// until a path actually authenticates.
async function unlockWith(recoverKey) {
  const K = await recoverKey();
  if (!K) return false;
  const sealed = await dbGet("vaultSecret");
  const secret = await openUnderVault(K, sealed);
  if (!secret) {
    zero(K);
    return false;
  }
  state.vaultKey = K;
  state.secret = secret;
  state.identity = await dbGet("identity");
  if (!state.identity) {
    zero(K);
    return false;
  }
  state.locked = false;
  clearTimeout(lockTimer);
  await enterCircle();
  return true;
}

// Drop every key from memory, tear down the live circle, and show the lock
// screen. After this the process holds no plaintext secret or vault key.
function lockNow() {
  if (!state.lock?.enabled || state.locked) return;
  clearTimeout(lockTimer);
  if (state.sharing) {
    sendMsg("bye").catch(() => {});
    stopSharingInternals();
  }
  poller?.stop();
  poller = null;
  sender?.cancel?.();
  sender = null;
  roster = null;
  zero(state.vaultKey);
  zero(state.secret);
  state.vaultKey = null;
  state.secret = null;
  state.encKey = null;
  state.channelId = null;
  state.me = null;
  focusedId = null;
  prevStatus.clear();
  state.locked = true;
  // Drop decrypted member positions from the map and dismiss any open sheet so
  // nothing sensitive sits behind the lock screen.
  ui.closeAllOverlays();
  mapView?.clearAll();
  $("#focus-card").hidden = true;
  ensureLockUI();
  paintLockScreen();
  showScreen("lock");
}

function paintLockScreen() {
  const bioBtn = $("#lock-bio");
  bioBtn.hidden = !state.lock?.bio;
  const err = $("#lock-error");
  err.hidden = true;
  const input = $("#lock-input");
  input.value = "";
  input.disabled = false;
}

function showLockError(msg) {
  const err = $("#lock-error");
  err.textContent = msg;
  err.hidden = false;
  const input = $("#lock-input");
  input.value = "";
  input.focus();
  $("#screen-lock").classList.remove("shake");
  // Reflow so the animation restarts on repeated wrong tries.
  void $("#screen-lock").offsetWidth;
  $("#screen-lock").classList.add("shake");
}

function ensureLockUI() {
  if (lockWired) return;
  lockWired = true;
  const form = $("#lock-form");
  const input = $("#lock-input");
  const unlockBtn = $("#lock-unlock");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pc = input.value;
    if (!pc) return;
    input.disabled = true;
    unlockBtn.disabled = true;
    unlockBtn.textContent = "Unlocking...";
    let ok = false;
    try {
      ok = await unlockWith(() => openPasscodeRecord(state.lock.pass, pc));
    } catch {
      ok = false;
    }
    unlockBtn.disabled = false;
    unlockBtn.textContent = "Unlock";
    input.disabled = false;
    if (!ok) showLockError("Wrong passcode. Try again.");
  });
  $("#lock-bio").addEventListener("click", async () => {
    if (!state.lock?.bio) return;
    let ok = false;
    try {
      ok = await unlockWith(() => openBioRecord(state.lock.bio));
    } catch {
      ok = false;
    }
    if (!ok) showLockError("Biometric unlock did not work. Use your passcode.");
  });
  $("#lock-wipe").addEventListener("click", forgotPasscode);
}

function forgotPasscode() {
  const ov = ui.openOverlay({ title: "Forgot passcode", testid: "forgot-sheet" });
  ov.body.append(
    ui.el(
      "p",
      "ov-note",
      "Starling cannot recover a forgotten passcode. Nothing about your circle leaves your device unencrypted, so there is no reset link. You can erase this device and rejoin your circle from a fresh invite. Hold the button to erase everything on this device.",
    ),
  );
  const hold = ui.el("button", "btn btn-danger btn-hold", "Hold to erase this device");
  hold.type = "button";
  ui.holdToFire(hold, { ms: 1500, onFire: panic });
  ov.body.append(hold);
}

// Auto-lock: relock after the chosen idle delay once the tab is hidden, and
// always start locked on a fresh launch (handled in boot).
document.addEventListener("visibilitychange", () => {
  if (!state.lock?.enabled || state.locked) return;
  clearTimeout(lockTimer);
  if (document.visibilityState === "hidden") {
    lockTimer = setTimeout(lockNow, state.lock.autolockMs);
  }
});

async function saveProfile(p) {
  state.profile = { name: p.name, emoji: p.emoji };
  await dbSet("profile", state.profile);
}

function promptCreate() {
  if (state.locked) return;
  ui.openIdentitySheet({
    title: "Create your circle",
    intro: "How you appear to the people you invite. This never leaves your circle.",
    cta: "Create circle",
    profile: state.profile,
    onSave: async (p) => {
      await saveProfile(p);
      const prevSecret = state.secret;
      const prevIdentity = state.identity;
      state.secret = newCircleSecret();
      state.identity = await generateIdentity();
      try {
        await persistCircle();
      } catch (e) {
        // Undo the in-memory swap so a failed create does not leave the app
        // claiming this device is already in a circle.
        state.secret = prevSecret;
        state.identity = prevIdentity;
        throw e;
      }
      await enterCircle();
      openInvite();
    },
  });
}

function promptJoin(secret) {
  if (state.locked) return;
  ui.openJoinSheet({
    profile: state.profile,
    hasCircle: !!state.secret,
    onJoin: async (p) => {
      // Joining from inside the demo ends the demo first, so the real circle
      // and its poller take over instead of the demo walkers.
      if (state.demo) exitDemo();
      await saveProfile(p);
      if (state.sharing) await setSharing(false);
      const prevSecret = state.secret;
      const prevIdentity = state.identity;
      state.secret = secret;
      state.identity = await generateIdentity();
      try {
        await persistCircle();
      } catch (e) {
        state.secret = prevSecret;
        state.identity = prevIdentity;
        throw e;
      }
      state.me = null;
      focusedId = null;
      prevStatus.clear();
      await enterCircle();
      ui.toast("You joined the circle.");
    },
  });
}

function promptPasteInvite() {
  const ov = ui.openOverlay({ title: "Join with a link", testid: "paste-sheet" });
  ov.body.append(
    ui.el("p", "ov-note", "Paste the invite link someone sent you. The circle secret stays in the link fragment and never touches a server."),
  );
  const field = ui.el("label", "field");
  field.append(ui.el("span", "field-label", "Invite link"));
  const input = ui.el("input", "text-input");
  input.type = "text";
  input.placeholder = "https://.../#j=...";
  input.autocomplete = "off";
  input.setAttribute("aria-describedby", "paste-invite-error");
  field.append(input);
  const err = ui.el("p", "ov-warn-note", "That does not look like a Starling invite link.");
  err.id = "paste-invite-error";
  err.setAttribute("role", "alert");
  err.hidden = true;
  const go = ui.el("button", "btn btn-primary", "Continue");
  go.type = "button";
  go.addEventListener("click", () => {
    const text = input.value.trim();
    const idx = text.indexOf("#j=");
    const frag = idx >= 0 ? text.slice(idx) : text.startsWith("j=") ? `#${text}` : text;
    const secret = parseInviteFragment(frag);
    if (!secret) {
      err.hidden = false;
      return;
    }
    ov.close();
    promptJoin(secret);
  });
  ov.body.append(field, err, go);
  input.focus();
}

async function rotateCircle() {
  const prev = {
    secret: state.secret,
    identity: state.identity,
    channelId: state.channelId,
    encKey: state.encKey,
  };
  // Build the new circle completely before touching anything live.
  const secret = newCircleSecret();
  const identity = await generateIdentity();
  const channelId = await deriveChannelId(secret);
  const encKey = await deriveEncKey(secret);
  // Nothing may land on the old channel from here on: stop the poller and
  // cancel the old sender, including any POST already in flight.
  poller?.stop();
  sender?.cancel();
  sender = null;
  state.secret = secret;
  state.identity = identity;
  state.channelId = channelId;
  state.encKey = encKey;
  try {
    await persistCircle();
  } catch (e) {
    // Roll back so the invite link and the live channel never diverge.
    state.secret = prev.secret;
    state.identity = prev.identity;
    state.channelId = prev.channelId;
    state.encKey = prev.encKey;
    try {
      await persistCircle();
    } catch {
      // storage is failing; in-memory state stays consistent either way
    }
    setupNet();
    render();
    throw e;
  }
  lastSentPos = null;
  focusedId = null;
  prevStatus.clear();
  setupNet();
  render();
}

const inviteLink = () =>
  `${location.origin}${location.pathname}${inviteFragment(state.secret)}`;

function qrColors() {
  return resolvedTheme() === "light"
    ? { dark: "#101522", light: "#ffffff" }
    : { dark: "#0a0d14", light: "#ffffff" };
}

function openInvite() {
  if (state.demo) {
    ui.toast("Exit the demo to invite your people.");
    return;
  }
  if (!state.secret) return;
  ui.openInviteSheet({
    getLink: inviteLink,
    qrSvgFor: (link) => qrSvg(link, qrColors()),
    onRotate: rotateCircle,
  });
}

// -------------------------------------------------------------- settings

async function openSettings() {
  const bioAvailable = await platformAuthenticatorAvailable();
  ui.openSettingsSheet({
    values: {
      circleName: state.circleName,
      profile: state.profile || { name: "", emoji: "\u{1F9ED}" },
      settings: state.settings,
    },
    demo: state.demo,
    lock: {
      enabled: !!state.lock?.enabled,
      hasBio: !!state.lock?.bio,
      bioAvailable,
      autolockMs: state.lock?.autolockMs ?? 60000,
    },
    lockActions: {
      enable: enableLock,
      disable: disableLock,
      change: changePasscode,
      enableBio: enableBiometric,
      disableBio: disableBiometric,
      setAutolock,
    },
    onChange: onSettingChange,
    onInvite: openInvite,
    onPanic: panic,
  });
}

async function onSettingChange(key, value) {
  if (key === "circleName") {
    state.circleName = value;
    await dbSet("circleName", value);
  } else if (key === "name" || key === "emoji") {
    state.profile = { ...(state.profile || {}), [key]: value };
    await dbSet("profile", state.profile);
    if (state.sharing && !state.demo) sendLoc(true);
  } else {
    state.settings = { ...state.settings, [key]: value };
    await dbSet("settings", state.settings);
    if (key === "theme") applyTheme();
    if (key === "basemap" && mapView) {
      // The demo promises zero network traffic; the choice is saved and
      // applied when the demo exits.
      if (state.demo) ui.toast("The demo stays off-grid. Your choice applies when you exit.");
      else mapView.setBasemap(value);
    }
    if (key === "wakeLock") ensureWakeLock();
    if (key === "precision" && state.sharing && !state.demo) sendLoc(true);
    if (key === "trail" && !value && mapView && focusedId) mapView.clearTrail(focusedId);
  }
  render();
}

async function panic() {
  await wipeAll();
  location.reload();
}

// --------------------------------------------------------------- sharing

async function setSharing(on) {
  if (state.demo) {
    state.sharing = on;
    if (!on) state.sosActive = false;
    render();
    return;
  }
  if (on === state.sharing) return;
  if (on) {
    state.sharing = true;
    state.geoDenied = false;
    state.geoFailed = false;
    stopGeo = startWatch(onFix, onGeoError);
    // startWatch can report an error synchronously and turn sharing back off.
    if (state.sharing) shareTimer = setInterval(() => sendLoc(true), 15000);
  } else {
    state.sharing = false;
    state.sosActive = false;
    state.geoFailed = false;
    clearInterval(shareTimer);
    stopGeo?.();
    stopGeo = null;
    lastSentPos = null;
    sendMsg("bye").catch(() => {});
  }
  render();
}

function onFix(fix) {
  const first = !state.me;
  state.me = fix;
  state.geoDenied = false;
  state.geoFailed = false;
  if (first && mapView) mapView.focusOn(fix.lat, fix.lon, 16, 0);
  if (
    state.sharing &&
    (!lastSentPos || haversineMeters(lastSentPos.lat, lastSentPos.lon, fix.lat, fix.lon) > 25)
  ) {
    sendLoc();
  }
  render();
}

function stopSharingInternals() {
  state.sharing = false;
  state.sosActive = false;
  clearInterval(shareTimer);
  stopGeo?.();
  stopGeo = null;
}

function onGeoError(err) {
  if (err && err.code === 1) {
    state.geoDenied = true;
    if (state.sharing) stopSharingInternals();
  } else if (err && err.code === 2 && !navigator.geolocation) {
    // No geolocation API at all: sharing can never work here.
    if (state.sharing) stopSharingInternals();
    ui.toast("Location is not available in this browser.", "warn");
  } else if (state.sharing && !state.me) {
    // Timeout or no fix yet: say so instead of claiming the user is visible.
    if (!state.geoFailed) ui.toast("No location fix yet. Still trying...", "warn");
    state.geoFailed = true;
  }
  render();
}

async function sendLoc(force = false) {
  if (!state.sharing || state.demo || !state.me || !sender) return;
  if (!force && lastSentPos && Date.now() - lastSentPos.at < 3000) return;
  lastSentPos = { lat: state.me.lat, lon: state.me.lon, at: Date.now() };
  try {
    await sendMsg(state.sosActive ? "sos" : "loc");
  } catch {
    // poll loop surfaces connectivity trouble
  }
}

async function sendMsg(type) {
  if (state.demo || !sender) return;
  const fields = {
    t: type,
    name: state.profile?.name || "Someone",
    emoji: state.profile?.emoji || "\u{1F9ED}",
    hue: myHue(),
    mode: state.settings.precision,
    st: "",
  };
  if (state.me) {
    let { lat, lon } = state.me;
    if (state.settings.precision === "coarse") ({ lat, lon } = coarsePos(lat, lon));
    fields.lat = lat;
    fields.lon = lon;
    if (state.settings.precision === "precise" && Number.isFinite(state.me.acc)) {
      fields.acc = state.me.acc;
    }
  }
  const bat = await batteryLevel();
  if (bat != null) fields.bat = bat;
  await sender.send(fields);
}

async function doCheckin() {
  const wasSos = state.sosActive;
  state.sosActive = false;
  const okMsg = wasSos
    ? "SOS cleared. Your circle sees you checked in."
    : "Checked in with your circle";
  if (state.demo) {
    ui.toast(okMsg);
    render();
    return;
  }
  try {
    await sendMsg("checkin");
    ui.toast(okMsg);
  } catch {
    // The circle still sees the SOS, so keep showing it here too.
    state.sosActive = wasSos;
    ui.toast("Check-in failed. Reconnecting...", "warn");
  }
  render();
}

async function fireSos() {
  navigator.vibrate?.([120, 60, 120]);
  state.sosActive = true;
  if (state.demo) {
    ui.toast("SOS sent to your circle. Tap the check mark to cancel.", "sos");
    render();
    return;
  }
  // An SOS while not sharing turns sharing on: the circle needs to see you.
  if (!state.sharing) setSharing(true);
  try {
    await sendMsg("sos");
    ui.toast("SOS sent to your circle. Tap the check mark to cancel.", "sos");
  } catch {
    ui.toast("SOS failed to send. Reconnecting...", "warn");
  }
  render();
}

function checkAlerts() {
  const now = Date.now();
  for (const rec of members()) {
    const st = statusOf(rec, now);
    const prev = prevStatus.get(rec.id);
    if (st === "sos" && prev !== "sos") {
      ui.toast(`SOS from ${rec.name || "a member"}`, "sos");
      navigator.vibrate?.([160, 80, 160, 80, 240]);
    } else if (st === "checkin" && prev === "sos") {
      ui.toast(`${rec.name || "A member"} checked in`);
    }
    prevStatus.set(rec.id, st);
  }
}

// ------------------------------------------------------------------ demo

function startDemo() {
  if (state.demo) return;
  if (state.sharing) setSharing(false);
  state.demo = true;
  state.sharing = true;
  state.sosActive = false;
  poller?.stop();
  prevStatus.clear();
  demo = createDemo({
    profile: state.profile,
    onTick: (list, me) => {
      demoMembers = list;
      state.me = { lat: me.lat, lon: me.lon, ts: me.ts };
      checkAlerts();
      render();
    },
  });
  showMap();
  // The demo is fully offline: no tiles, no network. Off-grid is forced and
  // the user's saved basemap comes back on exit.
  mapView.setBasemap("none");
  demo.start();
  mapView.fitAll([DEMO_CENTER, ...demoMembers]);
  render();
}

function exitDemo() {
  demo?.stop();
  demo = null;
  state.demo = false;
  state.sharing = false;
  state.sosActive = false;
  demoMembers = [];
  state.me = null;
  focusedId = null;
  $("#focus-card").hidden = true;
  prevStatus.clear();
  for (const id of mapView.markerIds()) mapView.removeMarker(id);
  mapView.setBasemap(state.settings.basemap);
  if (state.channelId) {
    poller?.start();
    showMap();
  } else {
    showScreen("onboarding");
  }
  render();
}

// -------------------------------------------------------------- wake lock

async function ensureWakeLock() {
  const want =
    state.settings.wakeLock && state.screen === "map" && document.visibilityState === "visible";
  try {
    if (want && !wakeLock && navigator.wakeLock?.request) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    } else if (!want && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      await lock.release();
    }
  } catch {
    wakeLock = null;
  }
}
document.addEventListener("visibilitychange", ensureWakeLock);

// ----------------------------------------------------------------- boot

window.addEventListener("online", () => {
  state.offline = false;
  poller?.pollNow();
  render();
});
window.addEventListener("offline", () => {
  state.offline = true;
  render();
});

// An invite link opened into an already-loaded tab arrives as a same-document
// hash change; treat it exactly like a fresh boot with a fragment.
window.addEventListener("hashchange", () => {
  const invite = parseInviteFragment(location.hash);
  if (!invite) return;
  history.replaceState(null, "", location.pathname + location.search);
  // A locked circle must be unlocked before any join can touch its state.
  if (state.locked) return;
  promptJoin(invite);
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (ui.closeTopOverlay()) return;
  if (focusedId) {
    unfocus();
    return;
  }
  if (sheet && sheet.getSnap() === "full") sheet.snapTo("half");
  else if (sheet && sheet.getSnap() === "half") sheet.snapTo("peek");
});

async function boot() {
  const params = new URLSearchParams(location.search);
  const invite = parseInviteFragment(location.hash);
  if (invite) history.replaceState(null, "", location.pathname + location.search);

  byTestid("onboarding-create").addEventListener("click", promptCreate);
  byTestid("onboarding-join").addEventListener("click", promptPasteInvite);
  byTestid("onboarding-demo").addEventListener("click", startDemo);

  // Persistence is optional. If the store cannot be read, boot with defaults
  // to onboarding instead of a dead page.
  let secret = null;
  let identity = null;
  let lock = null;
  try {
    const [sec, id, profile, settings, circleName, lk] = await Promise.all([
      dbGet("secret"),
      dbGet("identity"),
      dbGet("profile"),
      dbGet("settings"),
      dbGet("circleName"),
      dbGet("lock"),
    ]);
    secret = sec;
    identity = id;
    lock = lk;
    if (profile) state.profile = profile;
    if (settings) state.settings = { ...state.settings, ...settings };
    if (circleName) state.circleName = circleName;
  } catch (e) {
    window.__starlingErrors.push(`store: ${String(e)}`);
  }
  applyTheme();

  try {
    if (lock?.enabled) {
      // A locked circle starts locked on every launch. Nothing is decrypted
      // until the passcode or a biometric recovers the vault key.
      state.lock = lock;
      state.locked = true;
      ensureLockUI();
      paintLockScreen();
      showScreen("lock");
    } else if (secret && identity) {
      state.secret = secret;
      state.identity = identity;
      await enterCircle();
    } else {
      showScreen("onboarding");
    }
  } catch (e) {
    window.__starlingErrors.push(`enter: ${String(e)}`);
    showScreen("onboarding");
  }

  if (persistenceBroken()) {
    ui.toast("This browser is blocking storage. Starling runs, but nothing is saved after you close it.", "warn");
  }

  // Demo and invite auto-actions only apply past the lock screen.
  if (!state.locked) {
    if (params.get("demo") === "1") startDemo();
    else if (invite) promptJoin(invite);
  }

  if (params.get("sheet") === "full" && sheet) sheet.snapTo("full", false);

  setInterval(() => {
    if (state.screen === "map" && !state.demo) render();
  }, 5000);

  if (!insecureContext && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch((e) => {
      window.__starlingErrors.push(`sw: ${String(e)}`);
    });
  }
}

boot().catch((e) => {
  window.__starlingErrors.push(`boot: ${String(e)}`);
  // Last resort: never leave a blank page.
  try {
    state.screen = "onboarding";
    $("#screen-onboarding").hidden = false;
    $("#screen-map").hidden = true;
    ui.toast("Starling hit a problem while starting. You can still create or join a circle.", "warn");
  } catch {
    // the error above is already recorded
  }
});
