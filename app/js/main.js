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
  bioAvailable,
  zero,
} from "./lock.js";
import { isWrapped, native, shareUrlBase, normalizeRelay, setApiBase, shareCapable } from "./env.js";
import {
  writeCirclesAtRest,
  readCirclesAtRest,
  switchActive,
  leaveActive,
  reconcileCircles,
  adoptPairedIdentity,
  sameSecret,
  enableLockTransition,
  disableLockTransition,
} from "./circles.js";
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
  relay: "", // custom relay URL; "" means the default
  circles: [], // inactive circles, in memory only while unlocked
};

// The kv face circles.js writes through, and the lock context it needs to
// decide sealed versus plaintext at rest.
const kv = { get: dbGet, set: dbSet, del: dbDel };
const lockCtx = () =>
  state.lock?.enabled ? { enabled: true, vaultKey: state.vaultKey } : null;
const persistCirclesAtRest = () => writeCirclesAtRest(kv, lockCtx(), state.circles);

// The active circle as a storable record, for stashing before a switch.
async function activeRecord() {
  return {
    name: state.circleName,
    secret: state.secret,
    identity: state.identity,
    profile: state.profile,
    lastTs: (await dbGet("lastSentTs")) || 0,
  };
}

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
  const t = resolvedTheme();
  document.documentElement.dataset.theme = t;
  // Match the browser chrome (status bar, address bar) to the active theme.
  const bar = document.querySelector('meta[name="theme-color"]');
  if (bar) bar.setAttribute("content", t === "light" ? "#f4f6fb" : "#0a0d14");
}
const onSchemeChange = () => {
  if (state.settings.theme === "auto") applyTheme();
};
// Safari < 14 only has the legacy MediaQueryList.addListener.
if (mqLight.addEventListener) mqLight.addEventListener("change", onSchemeChange);
else if (mqLight.addListener) mqLight.addListener(onSchemeChange);

// ------------------------------------------------------------ debug hook

window.__starlingState = () => {
  const now = Date.now();
  return {
    screen: state.screen,
    sharing: !!state.sharing,
    demo: !!state.demo,
    locked: !!state.locked,
    lockEnabled: !!state.lock?.enabled,
    circles: state.circles.length,
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
  byTestid("circle-open").addEventListener("click", openCircles);
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
  // Belt and braces: the boot gate already keeps the hosted page out of
  // here, but a circle must never materialize where sharing is not allowed.
  if (!shareCapable()) return;
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
  // Identity first, secret last. This is a NEW circle's first landing (create,
  // join, rotate) and its identity exists nowhere else, so a crash between
  // the two writes must resolve as "the change never happened": old secret
  // with a fresh, never-used identity is a cosmetic stray, while the reverse
  // (new secret, old identity) would announce an existing pseudonym on the
  // new channel and link the two circles. Switch and leave keep the opposite
  // order in circles.js writeActive, where the array holds the paired copy.
  await dbSet("identity", {
    alg: state.identity.alg,
    privateKey: state.identity.privateKey,
    pk: state.identity.pk,
    memberId: state.identity.memberId,
  });
  await dbSet("lastSentTs", 0);
  await writeSecretAtRest();
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

// Lock transitions rewrite the same slots the circle mutations do, so they
// take the same guard, and memory adopts the new lock state only AFTER the
// at-rest transition commits: a thrown storage op must never leave the
// session believing one thing while the disk says another, because the next
// mutation would then persist in the wrong form and boot's stray purge would
// finish the loss.
async function enableLock(passcode) {
  if (!takeCircleGuard()) return false;
  try {
    const K = newVaultKey();
    const pass = await makePasscodeRecord(passcode, K);
    const lockRecord = { enabled: true, autolockMs: 60000, pass, bio: null };
    try {
      // Ordering lives in circles.js so the crash-window tests can drive it:
      // sealed forms durable before the lock record flips, plaintext deleted
      // only after, and a throw unwinds back to the unlocked form.
      await enableLockTransition(kv, {
        vaultKey: K,
        lockRecord,
        secret: state.secret,
        circles: state.circles,
      });
    } catch (e) {
      zero(K);
      throw e;
    }
    state.vaultKey = K;
    state.lock = lockRecord;
    return true;
  } finally {
    releaseCircleGuard();
  }
}

async function disableLock(passcode) {
  const K = await openPasscodeRecord(state.lock.pass, passcode);
  if (!K) return false;
  zero(K);
  if (!takeCircleGuard()) return false;
  try {
    // Mirror image of enableLock: plaintext forms first, the lock record
    // next, the stale sealed copies last. The transition resolves only when
    // the lock record is genuinely gone from disk; until then memory keeps
    // the vault key and stays locked-consistent.
    await disableLockTransition(kv, { secret: state.secret, circles: state.circles });
    zero(state.vaultKey);
    state.vaultKey = null;
    state.lock = null;
    return true;
  } finally {
    releaseCircleGuard();
  }
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
  if (!sealed) {
    // The passcode is right but there is no sealed secret at all: a crash
    // mid last-circle leave, or mid recovery, took the sealed slots and left
    // the lock record behind. The plaintext slots are checked FIRST: the
    // recovery sequence below writes them before deleting the lock record,
    // so a crash in its last window leaves a fully restored plaintext circle
    // that only needs the stale record cleared, never onboarding.
    const [plainSecret, plainIdentity, plainCircles] = await Promise.all([
      dbGet("secret"),
      dbGet("identity"),
      dbGet("circles"),
    ]);
    if (plainSecret && plainIdentity) {
      zero(K);
      state.locked = false;
      state.lock = null;
      state.vaultKey = null;
      clearTimeout(lockTimer);
      state.secret = plainSecret;
      state.identity = plainIdentity;
      state.circleName = (await dbGet("circleName")) || state.circleName;
      const arr = Array.isArray(plainCircles) ? plainCircles : [];
      state.circles = reconcileCircles({
        activeSecret: plainSecret,
        activeMemberId: plainIdentity.memberId,
        circles: arr,
      });
      if (state.circles.length !== arr.length) await persistCirclesAtRest().catch(() => {});
      await dbDel("lock");
      await enterCircle();
      return true;
    }
    // A sealed array that will not authenticate is quarantined exactly like
    // the main path does, never silently deleted: in this shape it may be
    // the only copy of every circle on the device.
    const inactiveRead = await readCirclesAtRest(kv, { enabled: true, vaultKey: K });
    if (inactiveRead === null) {
      const blob = await dbGet("vaultCircles");
      if (blob) await dbSet("vaultCirclesCorrupt", blob).catch(() => {});
      ui.toast("Your other circles could not be read and were dropped.", "warn");
    }
    const inactive = inactiveRead || [];
    zero(K);
    state.locked = false;
    state.lock = null;
    state.vaultKey = null;
    clearTimeout(lockTimer);
    if (inactive.length) {
      state.circles = inactive.slice(1);
      applyActive(inactive[0]);
      // Plaintext forms first, the lock record last: a crash in between
      // lands back in this recovery, which now reads plaintext first.
      await dbSet("circleName", state.circleName);
      await persistCircle();
      await persistCirclesAtRest();
      await dbDel("lock");
      await enterCircle();
      return true;
    }
    await dbDel("vaultCircles");
    await dbDel("circleIdentities");
    await dbDel("lock");
    showScreen("onboarding");
    return true;
  }
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
  // The inactive circles ride the same vault key. A blob that will not
  // authenticate under a K that just opened the active secret is corrupt or
  // tampered; dropping it beats refusing the unlock, and the user hears it.
  // The unreadable blob itself is parked under a quarantine key first, so a
  // transient fault stays recoverable instead of being overwritten by the
  // next persist.
  const inactive = await readCirclesAtRest(kv, { enabled: true, vaultKey: K });
  if (inactive === null) {
    const blob = await dbGet("vaultCircles");
    if (blob) await dbSet("vaultCirclesCorrupt", blob).catch(() => {});
    state.circles = [];
    ui.toast("Your other circles could not be read and were dropped.", "warn");
  } else {
    // A torn writeActive can pair this secret with another circle's identity;
    // the array still holds the properly paired record, so adopt it before
    // anything announces the wrong pseudonym on this channel.
    const paired = adoptPairedIdentity({
      activeSecret: secret,
      activeMemberId: state.identity.memberId,
      circles: inactive,
    });
    if (paired) {
      state.identity = paired.identity;
      state.circleName = paired.name;
      if (paired.profile) state.profile = paired.profile;
      await dbSet("identity", paired.identity);
      await dbSet("circleName", paired.name);
      if (paired.profile) await dbSet("profile", paired.profile);
    }
    // A crash mid-switch while locked can leave the active circle duplicated
    // in the sealed array, same as the unlocked boot path; reconcile it here
    // with the same both-must-match rule.
    state.circles = reconcileCircles({
      activeSecret: secret,
      activeMemberId: state.identity.memberId,
      circles: inactive,
    });
    if (state.circles.length !== inactive.length) await persistCirclesAtRest();
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
  // A circle mutation is mid-write: zeroing the vault key and the secrets it
  // is sealing with would corrupt what lands on disk. Lock the moment the
  // guard releases instead.
  if (circleBusy) {
    lockPending = true;
    return;
  }
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
  for (const c of state.circles) zero(c.secret);
  state.circles = [];
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
  if (!shareCapable() || state.locked) return;
  ui.openIdentitySheet({
    title: state.secret ? "New circle" : "Create your circle",
    intro: "How you appear to the people you invite. This never leaves your circle.",
    cta: "Create circle",
    profile: state.profile,
    circleName: { value: state.secret ? "" : state.circleName },
    onSave: (p) =>
      withCircleGuard(async () => {
        // Whether this ADDS a circle is decided now, not when the sheet
        // opened: overlays stack, and a join that committed underneath this
        // sheet must not be silently overwritten.
        const addMode = !!state.secret;
        if (state.demo) exitDemo();
        // Snapshot the outgoing circle BEFORE the new profile is saved, so
        // a per-circle pseudonym stays with its circle instead of bleeding
        // into the one being left.
        const outgoing = addMode ? await activeRecord() : null;
        await saveProfile(p);
        if (state.sharing) await awaitBye(await setSharing(false));
        const prev = {
          secret: state.secret,
          identity: state.identity,
          circleName: state.circleName,
          circles: state.circles,
        };
        try {
          if (addMode) {
            // The current circle goes into the inactive array before anything
            // touches the active slots, so no failure below can lose it.
            state.circles = [...state.circles, outgoing];
            await persistCirclesAtRest();
          }
          state.secret = newCircleSecret();
          state.identity = await generateIdentity();
          state.circleName = p.circleName || (addMode ? "New circle" : prev.circleName);
          await dbSet("circleName", state.circleName);
          await persistCircle();
        } catch (e) {
          // Undo the in-memory swap AND put the disk array back in step with
          // it, so a later rotation cannot resurrect a stale entry the boot
          // reconcile no longer recognizes.
          state.secret = prev.secret;
          state.identity = prev.identity;
          state.circleName = prev.circleName;
          state.circles = prev.circles;
          await persistCirclesAtRest().catch(() => {});
          throw e;
        }
        state.me = null;
        focusedId = null;
        prevStatus.clear();
        sheetAutoOpened = false;
        mapView?.clearAll();
        if (state.locked) return;
        await enterCircle();
        openInvite();
      }),
  });
}

function promptJoin(secret) {
  if (!shareCapable() || state.locked) return;
  // The same invite twice is a switch, not a second copy of the circle.
  if (state.secret && sameSecret(state.secret, secret)) {
    ui.toast("You are already in this circle.");
    return;
  }
  const known = state.circles.findIndex((c) => sameSecret(c.secret, secret));
  if (known >= 0) {
    // A tapped invite must do something visible even from inside the demo,
    // so the demo ends before the switch instead of swallowing it.
    if (state.demo) exitDemo();
    switchCircle(known).catch(() => ui.toast("Could not switch. Try again.", "warn"));
    return;
  }
  ui.openJoinSheet({
    profile: state.profile,
    hasCircle: !!state.secret,
    circleName: { value: "" },
    onJoin: (p) =>
      withCircleGuard(async () => {
        // Everything about the current state is re-read now, at commit time:
        // sheets stack, and another circle may have been joined or switched
        // underneath this one while it sat open.
        if (state.secret && sameSecret(state.secret, secret)) {
          ui.toast("You are already in this circle.");
          return;
        }
        const nowKnown = state.circles.findIndex((c) => sameSecret(c.secret, secret));
        if (nowKnown >= 0) {
          if (state.demo) exitDemo();
          await doSwitchCircle(nowKnown);
          return;
        }
        const addMode = !!state.secret;
        // Joining from inside the demo ends the demo first, so the real
        // circle and its poller take over instead of the demo walkers.
        if (state.demo) exitDemo();
        const outgoing = addMode ? await activeRecord() : null;
        await saveProfile(p);
        if (state.sharing) await awaitBye(await setSharing(false));
        const prev = {
          secret: state.secret,
          identity: state.identity,
          circleName: state.circleName,
          circles: state.circles,
        };
        try {
          if (addMode) {
            state.circles = [...state.circles, outgoing];
            await persistCirclesAtRest();
          }
          state.secret = secret;
          state.identity = await generateIdentity();
          state.circleName = p.circleName || (addMode ? "New circle" : prev.circleName);
          await dbSet("circleName", state.circleName);
          await persistCircle();
        } catch (e) {
          state.secret = prev.secret;
          state.identity = prev.identity;
          state.circleName = prev.circleName;
          state.circles = prev.circles;
          await persistCirclesAtRest().catch(() => {});
          throw e;
        }
        state.me = null;
        focusedId = null;
        prevStatus.clear();
        sheetAutoOpened = false;
        mapView?.clearAll();
        if (state.locked) return;
        await enterCircle();
        ui.toast("You joined the circle.");
      }),
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

// Rotation rewrites the active slots, so it shares the circle guard.
const rotateCircle = () => withCircleGuard(() => doRotateCircle());

async function doRotateCircle() {
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

// ------------------------------------------------------- multiple circles

// One circle mutation at a time. Switch, leave, create, join, rotate, and
// the two lock transitions all rewrite the same kv slots; two of them
// interleaving is how secrets get lost, so a second call simply bails while
// one is in flight. An autolock that fires mid-mutation is deferred to the
// guard release instead of zeroing key material out from under an await.
let circleBusy = false;
let lockPending = false;

function takeCircleGuard() {
  if (circleBusy) {
    ui.toast("Hold on, still finishing the last circle change.");
    return false;
  }
  circleBusy = true;
  return true;
}

function releaseCircleGuard() {
  circleBusy = false;
  if (lockPending) {
    lockPending = false;
    lockNow();
  }
}

async function withCircleGuard(fn) {
  if (!takeCircleGuard()) return false;
  try {
    return await fn();
  } finally {
    releaseCircleGuard();
  }
}

// Give a queued departure "bye" a real chance to reach the old channel
// before the sender is torn down, without letting a dead network hang the
// UI: whichever finishes first wins.
function awaitBye(bye, ms = 1500) {
  if (!bye || typeof bye.then !== "function") return Promise.resolve();
  return Promise.race([bye, new Promise((r) => setTimeout(r, ms))]);
}

// Tear down everything talking to the current channel, exactly as rotation
// does; nothing may land on the old channel after a switch.
function teardownNet() {
  poller?.stop();
  poller = null;
  sender?.cancel();
  sender = null;
  roster = null;
}

function applyActive(c) {
  state.secret = c.secret;
  state.identity = c.identity;
  if (c.profile) state.profile = c.profile;
  state.circleName = c.name;
  state.me = null;
  lastSentPos = null;
  focusedId = null;
  prevStatus.clear();
  sheetAutoOpened = false;
  mapView?.clearAll();
  $("#focus-card").hidden = true;
}

// The unguarded body, for callers already inside withCircleGuard. Returns
// true on a completed switch so sheet code can tell success from a bail.
async function doSwitchCircle(i) {
  if (!shareCapable() || state.demo || state.locked || !state.secret) return false;
  // Sharing never carries across circles: stop it, give the bye a moment to
  // actually land on the old channel, and let the user turn sharing back on
  // where they arrive.
  if (state.sharing) await awaitBye(await setSharing(false));
  const prev = {
    secret: state.secret,
    identity: state.identity,
    circleName: state.circleName,
    circles: state.circles,
  };
  teardownNet();
  try {
    const res = await switchActive(kv, lockCtx(), {
      outgoing: await activeRecord(),
      circles: state.circles,
      toIndex: i,
    });
    state.circles = res.circles;
    applyActive(res.active);
  } catch (e) {
    // Both secrets are on disk whatever happened; put memory back on the
    // circle we were in and keep it live. Autolock is deferred while the
    // guard is held, so state.locked cannot flip mid-switch; the check is
    // belt and braces against any future path that locks synchronously.
    state.secret = prev.secret;
    state.identity = prev.identity;
    state.circleName = prev.circleName;
    state.circles = prev.circles;
    if (!state.locked) await enterCircle();
    throw e;
  }
  if (state.locked) return false;
  await enterCircle();
  ui.toast(`Switched to ${state.circleName}.`);
  return true;
}

const switchCircle = (i) => withCircleGuard(() => doSwitchCircle(i));

const leaveCircle = () =>
  withCircleGuard(async () => {
    if (!shareCapable() || state.demo || state.locked || !state.secret) return false;
    if (state.sharing) await awaitBye(await setSharing(false));
    teardownNet();
    // Last circle: the lock record goes FIRST. If a crash lands between the
    // deletions, boot sees an intentionally emptied device instead of a lock
    // screen that no passcode can ever satisfy.
    const last = state.circles.length === 0;
    if (last && state.lock?.enabled) {
      zero(state.vaultKey);
      state.vaultKey = null;
      state.lock = null;
      await dbDel("lock");
    }
    let res;
    try {
      res = await leaveActive(kv, lockCtx(), { circles: state.circles, toIndex: 0 });
    } catch (e) {
      // Storage refused; the active circle is untouched on disk, so bring
      // its network back instead of leaving a dead map behind the error.
      await enterCircle();
      throw e;
    }
    if (res.active) {
      state.circles = res.circles;
      applyActive(res.active);
      await enterCircle();
      ui.toast(`You left. Now in ${state.circleName}.`);
      return true;
    }
    // Back where a fresh install starts.
    state.secret = null;
    state.identity = null;
    state.channelId = null;
    state.encKey = null;
    state.circleName = "My circle";
    state.circles = [];
    state.me = null;
    mapView?.clearAll();
    showScreen("onboarding");
    ui.toast("You left the circle.");
    return true;
  });

function openCircles() {
  if (!shareCapable()) return;
  if (state.demo) {
    ui.toast("Exit the demo first.");
    return;
  }
  if (state.locked || !state.secret) return;
  ui.openCircleSheet({
    current: { name: state.circleName },
    others: state.circles.map((c) => ({ name: c.name })),
    onSwitch: switchCircle,
    onCreate: promptCreate,
    onJoin: promptPasteInvite,
  });
}

// In the wrapper the page lives on an asset origin that means nothing off this
// device, so invites always name the canonical web origin instead.
const inviteLink = () => `${shareUrlBase()}${inviteFragment(state.secret)}`;

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
  const bioOk = await bioAvailable();
  const n = native();
  let tor = null;
  if (n?.torSupported) {
    try {
      if (n.torSupported()) tor = { enabled: !!n.torEnabled() };
    } catch {
      tor = null;
    }
  }
  ui.openSettingsSheet({
    values: {
      circleName: state.circleName,
      profile: state.profile || { name: "", emoji: "\u{1F9ED}" },
      settings: state.settings,
      // The relay choice is wrapper-only: the web deployment's CSP pins
      // connect-src to its own origin, so a cross-origin relay set there
      // could never be reached. Web self-hosters serve app and relay from
      // one origin and need no setting.
      relay: isWrapped() ? state.relay || "" : null,
    },
    demo: state.demo,
    tor,
    lock: {
      enabled: !!state.lock?.enabled,
      hasBio: !!state.lock?.bio,
      bioAvailable: bioOk,
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
    onLeave: leaveCircle,
  });
}

async function onSettingChange(key, value) {
  if (key === "circleName") {
    state.circleName = value;
    await dbSet("circleName", value);
  } else if (key === "relay") {
    const norm = normalizeRelay(value);
    if (String(value).trim() && !norm) {
      ui.toast("A relay must be an https URL, like https://relay.example.org", "warn");
      return;
    }
    state.relay = norm || "";
    if (norm) await dbSet("relay", norm);
    else await dbDel("relay");
    ui.toast("Relay saved. It applies the next time Starling starts.");
  } else if (key === "tor") {
    try {
      native()?.setTor(!!value);
    } catch {
      ui.toast("Could not change the Orbot setting.", "warn");
    }
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
    // Returned so circle switches can wait for the departure to actually
    // reach the old channel before the sender is cancelled; every other
    // caller ignores it and keeps the old fire-and-forget behavior.
    const bye = sendMsg("bye").catch(() => {});
    render();
    return bye;
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
  } else if (err && err.native) {
    // The foreground service quit (notification Stop, refused start, no
    // provider) and will not retry. Anything short of a full stop here would
    // keep the share timer republishing the last fix as if it were fresh.
    if (state.sharing) setSharing(false);
    if (!err.stopped) ui.toast(`Location stopped: ${err.message || "service error"}`, "warn");
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
  // Hosted web never joins; the landing card points the invite at the app.
  if (!shareCapable()) {
    $("#landing-invite").hidden = false;
    return;
  }
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
  // Everything downstream needs WebCrypto and IndexedDB. A secure context
  // without them is an outdated engine and gets a plain explanation instead
  // of a page of silent errors. An insecure context also lacks crypto.subtle,
  // but that case keeps its own banner and degraded boot below.
  if (!insecureContext && (!globalThis.crypto?.subtle || !globalThis.indexedDB)) {
    $("#screen-oldweb").hidden = false;
    $("#screen-onboarding").hidden = true;
    return;
  }

  const params = new URLSearchParams(location.search);
  const invite = parseInviteFragment(location.hash);
  if (invite) history.replaceState(null, "", location.pathname + location.search);

  byTestid("onboarding-demo").addEventListener("click", startDemo);
  if (shareCapable()) {
    byTestid("onboarding-create").addEventListener("click", promptCreate);
    byTestid("onboarding-join").addEventListener("click", promptPasteInvite);
  } else {
    // Hosted web: circles are app-only, so the create and join paths do not
    // exist here at all. The app card leads, the demo trails it.
    byTestid("onboarding-create").hidden = true;
    byTestid("onboarding-join").hidden = true;
    const wrap = $("#screen-onboarding .ob-wrap");
    wrap.insertBefore($("#landing-app"), $("#screen-onboarding .ob-actions"));
  }

  // Ask the OS not to evict our store under storage pressure. Wrapper only:
  // the WebView grants or denies silently, while desktop Firefox turns a bare
  // persist() into a permission prompt the web app never used to show.
  if (isWrapped()) navigator.storage?.persist?.().catch(() => {});

  // The landing's download card is for browser visitors; the Android app and
  // installed PWAs do not advertise themselves to themselves.
  if (isWrapped() || matchMedia("(display-mode: standalone)").matches) {
    $("#landing-app").hidden = true;
  }

  // Persistence is optional. If the store cannot be read, boot with defaults
  // to onboarding instead of a dead page.
  let secret = null;
  let identity = null;
  let lock = null;
  let storedCircles = null;
  try {
    const [sec, id, profile, settings, circleName, lk, relay, circs] = await Promise.all([
      dbGet("secret"),
      dbGet("identity"),
      dbGet("profile"),
      dbGet("settings"),
      dbGet("circleName"),
      dbGet("lock"),
      dbGet("relay"),
      dbGet("circles"),
    ]);
    secret = sec;
    identity = id;
    lock = lk;
    storedCircles = Array.isArray(circs) ? circs : null;
    if (profile) state.profile = profile;
    if (settings) state.settings = { ...state.settings, ...settings };
    if (circleName) state.circleName = circleName;
    if (typeof relay === "string") state.relay = relay;
  } catch (e) {
    window.__starlingErrors.push(`store: ${String(e)}`);
  }
  // The API base is fixed for this run before any poller or sender is built.
  setApiBase(state.relay);
  applyTheme();

  if (!shareCapable()) {
    // Hosted web: landing and demo only. A circle stored by the old web app
    // is never opened or decrypted here (its bytes are only tested for
    // existence); the card offers the eraser instead. An invite fragment
    // gets pointed at the app (the secret was already stripped from the
    // address bar above and never leaves the device).
    if (lock?.enabled || (secret && identity) || storedCircles?.length) {
      $("#landing-legacy").hidden = false;
      byTestid("landing-erase").addEventListener("click", async () => {
        await wipeAll();
        location.reload();
      });
    }
    if (invite) $("#landing-invite").hidden = false;
    showScreen("onboarding");
    if (params.get("demo") === "1") startDemo();
  } else {
    try {
      if (!lock?.enabled) {
        // No lock record means any sealed copies are strays from an
        // interrupted lock transition; the plaintext is authoritative.
        await dbDel("vaultSecret");
        await dbDel("vaultCircles");
        await dbDel("circleIdentities");
      }
      if (lock?.enabled) {
        // A locked circle starts locked on every launch. Nothing is decrypted
        // until the passcode or a biometric recovers the vault key. Plaintext
        // slots a crash mid-lock-enable left behind are purged ONLY when
        // their sealed twin actually exists: before that point the plaintext
        // is the only copy there is.
        const [sealedSecret, sealedCircles] = await Promise.all([
          dbGet("vaultSecret"),
          dbGet("vaultCircles"),
        ]);
        if (sealedSecret) await dbDel("secret");
        if (sealedCircles) await dbDel("circles");
        if (!sealedSecret && !secret && !sealedCircles && !storedCircles?.length) {
          // Nothing to protect in either form: a crash mid last-circle leave
          // left a stale lock record. Clear it and start fresh instead of
          // presenting a lock no passcode can satisfy.
          await dbDel("lock");
          showScreen("onboarding");
        } else {
          state.lock = lock;
          state.locked = true;
          ensureLockUI();
          paintLockScreen();
          showScreen("lock");
        }
      } else if (secret && identity) {
        state.secret = secret;
        state.identity = identity;
        if (storedCircles?.length) {
          // A torn writeActive can pair this secret with another circle's
          // identity; the array still holds the properly paired record, so
          // adopt it before anything announces the wrong pseudonym.
          const paired = adoptPairedIdentity({
            activeSecret: secret,
            activeMemberId: identity.memberId,
            circles: storedCircles,
          });
          if (paired) {
            state.identity = paired.identity;
            state.circleName = paired.name;
            if (paired.profile) state.profile = paired.profile;
            await dbSet("identity", paired.identity);
            await dbSet("circleName", paired.name);
            if (paired.profile) await dbSet("profile", paired.profile);
          }
          // A crash mid-switch can leave the active circle duplicated in the
          // inactive array; reconcile drops the copy.
          state.circles = reconcileCircles({
            activeSecret: secret,
            activeMemberId: state.identity.memberId,
            circles: storedCircles,
          });
          if (state.circles.length !== storedCircles.length) await persistCirclesAtRest();
        }
        await enterCircle();
      } else if (storedCircles?.length) {
        // A crash mid-leave can clear the active slots with circles still
        // waiting; promote the first instead of pretending this is a fresh
        // install.
        const res = await leaveActive(kv, lockCtx(), { circles: storedCircles, toIndex: 0 });
        state.circles = res.circles;
        applyActive(res.active);
        await enterCircle();
      } else {
        showScreen("onboarding");
      }
    } catch (e) {
      window.__starlingErrors.push(`enter: ${String(e)}`);
      showScreen("onboarding");
    }

    // Demo and invite auto-actions only apply past the lock screen.
    if (!state.locked) {
      if (params.get("demo") === "1") startDemo();
      else if (invite) promptJoin(invite);
    }
  }

  if (persistenceBroken()) {
    ui.toast("This browser is blocking storage. Starling runs, but nothing is saved after you close it.", "warn");
  }

  if (params.get("sheet") === "full" && sheet) sheet.snapTo("full", false);

  setInterval(() => {
    if (state.screen === "map" && !state.demo) render();
  }, 5000);

  // The wrapper serves assets locally already and WebView never wires up
  // service worker interception, so registration is web-only.
  if (!insecureContext && !isWrapped() && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch((e) => {
      window.__starlingErrors.push(`sw: ${String(e)}`);
    });
    // The cache-first shell means a returning visitor's first load after a
    // deploy runs the previous build; reload once when the fresh worker takes
    // over so security-motivated changes apply within seconds, not visits.
    // Guarded on an existing controller so a first-ever install never loops.
    if (navigator.serviceWorker.controller) {
      let reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloaded) return;
        reloaded = true;
        location.reload();
      });
    }
  }
}

boot().catch((e) => {
  window.__starlingErrors.push(`boot: ${String(e)}`);
  // Last resort: never leave a blank page.
  try {
    state.screen = "onboarding";
    $("#screen-onboarding").hidden = false;
    $("#screen-map").hidden = true;
    ui.toast("Starling hit a problem while starting.", "warn");
  } catch {
    // the error above is already recorded
  }
});
