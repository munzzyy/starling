// App orchestration: boot, screens, sharing, demo, settings. State lives here;
// components live in ui.js, protocol I/O in net.js, map in map.js.

import {
  parseInviteFragment,
  newSeed,
  newInviteSecret,
  deriveInviteChannelId,
  deriveInviteKey,
  generateIdentity,
  generateEphemeral,
  inviteFragment,
  inviterCommitment,
  openMessage,
  sealTo,
} from "./crypto.js";
import { openGeneration, buildRekey, applyRekey, rosterAgrees } from "./rekey.js";
import {
  admissionCheck,
  inviteMintedBy,
  inviteWatchDecision,
  joinPromptVerdict,
  mintDecision,
  recordOverflows,
  screenJoinRequest,
  screenWelcomeMessage,
  slotFailure,
  undoAdmission,
  welcomePlan,
  welcomeRoster,
  welcomeVerdict,
} from "./joinflow.js";
import {
  assembleWelcome,
  circleControl,
  welcomeContext,
} from "./membership.js";
// The roster and pinning decisions: who may be pinned and in what form, what
// a key change is, when a roster disagreement is real, and who a re-key wraps
// to. Verdicts only, so the awaits and the writes below stay here.
import {
  acceptedKeyChange,
  admitPinned,
  canonKey,
  canonPinned,
  describeKeyChange,
  genRosterFrom,
  keyChangeVerdict,
  pendingAfterRekey,
  pinnedFromRecipients,
  reconcileVerdict,
  rekeyRecipients,
  rosterAfterRekey,
  sameKey,
} from "./roster.js";
import { createRatchet, epochAt, HISTORY_CHOICES, DEFAULT_HISTORY_EPOCHS } from "./ratchet.js";
import {
  INVITE_TTL_MS,
  MAX_SKEW_EPOCHS,
  MEMBER_CAP,
  EPOCH_MS,
  algFromPk,
  epochPlausible,
  b64uDecode,
  b64uEncode,
  memberIdFromKeys,
  safetyNumber,
  sigBase,
  verifySig,
} from "./wire.js";
import {
  canPromptInstall,
  canShareInBackground,
  createForegroundSession,
  isIOS,
  isIOSSafari,
  isInstalled,
  promptInstall,
} from "./platform.js";
import { qrSvg } from "./qr.js";
import { dbGet, dbSet, dbDel, wipeAll, persistenceBroken } from "./store.js";
// The at-rest, lock and destruct decisions: may this be written and under
// which key, what an unlock attempt just found, what this launch found, and
// the order a circle erases itself in. Verdicts and one plan, so every await
// and every write below stays here.
import { atRestForm, bootVerdict, slotsVerdict, unlockVerdict } from "./atrest.js";
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
import { debugHooks, apiUrl, isWrapped, native, shareUrlBase, normalizeRelay, setApiBase, shareCapable } from "./env.js";
import {
  isSealedRecordError,
  GEN_SLOT,
  PINNED_SLOT,
  INVITE_SLOT,
  STAGED_SLOT,
  SEALED_KEYS,
  writeCirclesAtRest,
  readCirclesAtRest,
  writeRecordAtRest,
  readRecordAtRest,
  packGenMeta,
  readGenMeta,
  packPinned,
  pinnedMap,
  packInvite,
  readInvite,
  packStagedGen,
  readStagedGen,
  switchActive,
  leaveActive,
  finishPendingLeave,
  reconcileCircles,
  adoptPairedCircle,
  enableLockTransition,
  disableLockTransition,
} from "./circles.js";
import * as ui from "./ui.js";
import { createMapView } from "./map.js";
import { createPoller, createRoster, createSender, statusOf, sortMembers, STALE_MS } from "./net.js";
import { startBeacon } from "./beacon.js";
import { startWatch, batteryLevel } from "./geo.js";
import { haversineMeters, coarsePos, hueFromMemberId, fmtRelTime } from "./fmt.js";
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
const te = new TextEncoder();

const state = {
  screen: "onboarding",
  demo: false,
  sharing: false,
  sosActive: false,
  // The live generation: { g, e0, channelId, ratchet }. Everything that used to
  // hang off a circle secret that lived forever hangs off this instead, and a
  // re-key replaces the whole of it.
  gen: null,
  // memberId -> { alg, pk, epk, verified, name }. Who this device believes is
  // in the circle, and which keys each of them is.
  pinned: new Map(),
  // The subset of that roster which may re-key: the members this generation
  // opened with. See onControl for why first sight is not enough.
  genRoster: new Set(),
  // { secret, commit, by, createdAt, expiresAt } while an invitation is out.
  // `by` is the identity that minted it, so a credential can never outlive the
  // circle it belongs to.
  invite: null,
  identity: null,
  profile: null,
  settings: {
    precision: "precise",
    trail: true,
    basemap: "dark",
    theme: "dark",
    wakeLock: false,
    history: "default", // an id from ratchet.js HISTORY_CHOICES
    steady: false, // post on a fixed cadence whether or not you have moved
  },
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
  // Things a person has to be told about rather than have reconciled behind
  // their back. Stage 2 draws these; nothing here resolves itself.
  keyChanges: new Map(), // memberId -> the keys presented instead of the pinned pair
  rosterMismatch: null, // { by } when a re-key disagreed about who is in the circle
  // A disagreement that has not been surfaced yet, because the likeliest cause
  // is a member who was just admitted and has not posted anything. It becomes
  // rosterMismatch only if it fails to resolve. See reconcileRoster.
  rosterPending: null,
  // The person whose link this device joined on, and their safety number, so
  // the joiner can check the number of whoever let them in.
  joinedVia: null,
  // A welcome that arrived without all of its member records. This device
  // cannot follow a re-key it cannot attribute, so it says so instead.
  joinIncomplete: null,
  missedRekey: false, // a re-key landed for a generation this device cannot reach
  // The ratchet destroyed itself: this device was off past the catch-up cap,
  // so it holds no key this circle still uses and cannot be given one.
  chainDestroyed: false,
  // The same thing, found at the next unlock rather than while the app was
  // open: { at }. A circle went away without the user doing anything, and they
  // are on a different one now, so it is said out loud rather than left to be
  // noticed.
  chainWiped: null,
  // Set when the destruct could not erase the circle from disk. The keys are
  // out of memory either way; this says the storage half did not happen.
  chainWipeFailed: null,
  clockError: null, // { skewMs, at } when the relay refused our epoch
  retired: false, // the relay answered 410: this build can no longer connect
  v1Data: false, // storage written by a v1 client, which cannot be carried over
  joinRequests: [], // join requests waiting on our invite channel
  joining: null, // { status, since } while this device waits to be let in
  foreground: null, // { active, elapsedMs, wakeLock } where sharing needs the screen on
  // A re-key somebody else made. A toast is gone in three seconds, and "your
  // circle's keys changed" is not a three-second fact, so it stays until it is
  // read: { byName, removedNames, at }.
  lastRekey: null,
  installDismissed: false, // the home-screen nudge was answered
};

// The kv face circles.js writes through, and the lock context it needs to
// decide sealed versus plaintext at rest.
const kv = { get: dbGet, set: dbSet, del: dbDel };
const lockCtx = () =>
  state.lock?.enabled ? { enabled: true, vaultKey: state.vaultKey } : null;
const persistCirclesAtRest = () => writeCirclesAtRest(kv, lockCtx(), state.circles);

const channelId = () => state.gen?.channelId || null;
const historyEpochs = (id = state.settings.history) =>
  HISTORY_CHOICES.find((c) => c.id === id)?.epochs ?? DEFAULT_HISTORY_EPOCHS;

// The generation as it goes to disk: the oldest chain key still retained, plus
// the numbers and the channel that key alone cannot name.
function genRecord() {
  const snap = state.gen.ratchet.snapshot();
  if (!snap) throw new Error("no chain key to persist");
  return {
    g: state.gen.g,
    e0: state.gen.e0,
    ckEpoch: snap.e0,
    channelId: state.gen.channelId,
    at: state.gen.at || 0,
    genRoster: [...state.genRoster],
    ck: snap.ck0,
  };
}

// The active circle as a storable record, for stashing before a switch.
async function activeRecord() {
  const rec = genRecord();
  return {
    name: state.circleName,
    secret: rec.ck,
    identity: state.identity,
    g: rec.g,
    e0: rec.e0,
    ckEpoch: rec.ckEpoch,
    channelId: rec.channelId,
    at: rec.at,
    genRoster: rec.genRoster,
    pinned: packPinned(state.pinned),
    profile: state.profile,
    lastTs: (await dbGet("lastSentTs")) || 0,
  };
}

let roster = null;
let poller = null;
let sender = null;
// The invite-channel loops: one on the inviting side watching for join
// requests, one on the joining side waiting for a welcome. Both are plain stop
// functions, and both are memory only.
let invitePoll = null;
let joinPoll = null;
let rekeyTimer = 0;
// The foreground session that keeps sharing alive where there is no background
// execution to lean on (see platform.js).
let foreground = null;
// The beacon viewer the SOS flow mints, so the help sheet has a link to show.
let sosViewer = null;
// Viewer links, keyed by viewer id, memory only. beacon.list() deliberately
// does not carry them: a link is handed back once, at mint time, and this is
// the only place it is kept so the help sheet can show each one again.
const beaconLinks = new Map();
// The chain-key epoch already on disk, so the ratchet is only rewritten when
// it has actually moved.
let storedCkEpoch = -1;
// The live emergency beacon, if an SOS is running. Memory only by design:
// it must not outlive the process that can also cancel it.
let beacon = null;
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

// Sheets that draw live state and have to follow it while they are open: a
// join request lands, a member's keys change, a help link runs down. Each one
// registers here and is refreshed from render().
const liveSheets = new Set();
function keepLive(make) {
  const sheet = make(() => liveSheets.delete(sheet));
  liveSheets.add(sheet);
  return sheet;
}

const members = () => (state.demo ? demoMembers : roster ? roster.list() : []);
// Who a member id belongs to, in the words a person would use. The live roster
// name is the one they are posting under; the pinned name is what they were
// called when we pinned them, and is all that is left after they are removed.
const displayName = (id, fallback = "A member") =>
  members().find((r) => r.id === id)?.name || state.pinned.get(id)?.name || fallback;
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

if (debugHooks()) window.__starlingState = () => {
  const now = Date.now();
  return {
    screen: state.screen,
    sharing: !!state.sharing,
    demo: !!state.demo,
    locked: !!state.locked,
    lockEnabled: !!state.lock?.enabled,
    circles: state.circles.length,
    hasBio: !!state.lock?.bio,
    sosActive: !!state.sosActive,
    beacon: !!beacon,
    channel: channelId(),
    g: state.gen?.g ?? null,
    pinned: state.pinned.size,
    keyChanges: [...state.keyChanges.keys()],
    joinRequests: state.joinRequests.length,
    joining: state.joining?.status || null,
    joinIncomplete: !!state.joinIncomplete,
    genRoster: [...state.genRoster],
    invite: !!state.invite,
    clockError: !!state.clockError,
    chainDestroyed: !!state.chainDestroyed,
    retired: !!state.retired,
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
if (debugHooks()) window.__starlingFit = () => {
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
  const notice = document.getElementById("screen-notice");
  if (notice) notice.hidden = name !== "notice";
  ensureWakeLock();
}

// A full-screen dead end for the two states there is no way back from inside
// the app: storage this build cannot read, and a relay that has retired the
// protocol this build speaks. Built here rather than in the page so it can say
// exactly what happened; stage 2 owns how it looks.
function showNotice({ title, body, actions = [] }) {
  let notice = document.getElementById("screen-notice");
  if (!notice) {
    notice = document.createElement("section");
    notice.id = "screen-notice";
    notice.className = "screen";
    notice.dataset.testid = "notice-screen";
    const wrap = ui.el("div", "ob-wrap");
    const hero = ui.el("div", "ob-hero");
    hero.append(ui.el("h1", "ob-wordmark", "starling"));
    hero.append(ui.el("p", "ob-tagline"));
    wrap.append(hero);
    wrap.append(ui.el("div", "ob-actions"));
    notice.append(wrap);
    document.body.append(notice);
  }
  notice.querySelector(".ob-wordmark").textContent = title;
  notice.querySelector(".ob-tagline").textContent = body;
  const acts = notice.querySelector(".ob-actions");
  acts.replaceChildren();
  for (const a of actions) {
    const btn = ui.el("button", a.variant ? `btn ${a.variant}` : "btn", a.label);
    btn.type = "button";
    btn.dataset.testid = a.testid;
    btn.addEventListener("click", a.onClick);
    acts.append(btn);
  }
  showScreen("notice");
}

let sheetAutoOpened = false;

function showMap() {
  ensureMapUI();
  showScreen("map");
  requestAnimationFrame(() => mapView.invalidate());
  if (sheet.getSnap() !== "full") {
    // An empty circle opens at half so the invite nudge is in view.
    const wantHalf = !state.demo && state.gen && members().length === 0 && !sheetAutoOpened;
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
  $("#sos-help").addEventListener("click", openHelpLink);
  byTestid("members-open").addEventListener("click", openMembers);
  $("#banner-keys-open").addEventListener("click", openMembers);
}

// ------------------------------------------------------------- rendering

function render() {
  renderOnboarding();
  for (const s of liveSheets) {
    try {
      s.refresh();
    } catch (e) {
      window.__starlingErrors.push(`sheet: ${String(e)}`);
    }
  }
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
  $("#nudge").hidden = state.demo || !state.gen || list.length > 0;
  renderFocus(list, now);
  renderAlerts();
  renderTools();
}

function renderChrome() {
  $("#pill-name").textContent = state.demo ? "Demo circle" : state.circleName;
  const dotState = state.demo ? "ok" : state.netStatus;
  const dot = $("#status-dot");
  dot.className = `status-dot dot-${dotState}`;
  const reconnecting = !state.demo && (state.offline || state.netStatus === "reconnecting");
  $("#banner-offline").hidden = !reconnecting;
  // A key change is the one warning that must not wait behind a collapsed
  // sheet, so it also rides in the chrome, where nothing can cover it.
  const changed = state.demo ? 0 : state.keyChanges.size;
  $("#banner-keys").hidden = !changed;
  if (changed) {
    const [first] = [...state.keyChanges.keys()];
    $("#banner-keys-text").textContent =
      changed === 1 ? `${displayName(first)}'s keys changed` : `${changed} members' keys changed`;
  }
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
  // No background execution on this platform, so sharing runs only while the
  // app is in front. It belongs on the line that claims you are live, not in a
  // help page nobody opens mid-emergency.
  if (state.sharing && state.foreground) sub += " · Keep this screen on";
  // The relay refuses every post from a phone whose clock is out of tolerance.
  // The one thing this line may never say in that state is that you are live.
  if (state.sharing && state.clockError) sub = "Not visible: this phone's clock is wrong";
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
  $("#sos-help").hidden = !(state.sosActive && beacon);
  const checkBtn = byTestid("checkin-button");
  checkBtn.setAttribute(
    "aria-label",
    state.sosActive ? "Cancel SOS and check in with your circle" : "Check in with your circle",
  );
  checkBtn.classList.toggle("check-attn", state.sosActive);
  byTestid("sos-button").classList.toggle("sos-active", state.sosActive);
}

// The surfaced-not-silent list: everything the app refuses to reconcile on its
// own, in the order a frightened person needs it. Keys first, because a key
// change is either a reinstall or somebody standing in for a member, and only
// a human can tell which.
function alertItems() {
  const items = [];
  if (state.demo) return items;

  for (const id of state.keyChanges.keys()) {
    const who = displayName(id);
    items.push({
      id: `key:${id}`,
      kind: "sos",
      title: `${who}'s keys changed`,
      text: `That phone is answering with keys this device has never seen. It is a reinstall, or somebody else in ${who}'s place, and nothing here can tell you which. Their location stays off your map until you check the number with them and accept it.`,
      actions: [
        { label: "Check the numbers", variant: "btn-primary", testid: "alert-keys", onClick: openMembers },
      ],
    });
  }

  if (state.chainWipeFailed) {
    // The honest version of the card below. Said plainly, because somebody who
    // went away for a month and came back to a phone that could not finish
    // erasing needs to know the difference between "gone" and "still here".
    items.push({
      id: "chain-wipe-failed",
      kind: "warn",
      title: "That circle expired, and this phone could not erase it",
      text: "Its keys are out of memory and nothing you send arrives any more, but this device could not delete them from its own storage, most likely because there is no room left. They are still on the disk. Free some space and open Starling again to finish clearing it, or use Panic to erase everything now.",
      actions: [{ label: "Try again", testid: "alert-wipe-retry", onClick: () => syncRatchet() }],
    });
  }

  if (state.chainDestroyed) {
    // The actions are the point. The card has always said "ask for a fresh
    // invite link", and until the teardown started clearing the circle it left
    // behind, following that advice was the one thing this device could not
    // do: every path that admits a new circle threw on the dead generation.
    const actions = [
      { label: "Join with a link", variant: "btn-primary", testid: "alert-destroyed-join", onClick: promptPasteInvite },
      { label: "Start a new circle", testid: "alert-destroyed-new", onClick: promptCreate },
    ];
    if (state.circles.length) {
      actions.push({ label: "Your other circles", testid: "alert-destroyed-circles", onClick: openCircles });
    }
    items.push({
      id: "chain-destroyed",
      kind: "warn",
      title: "This phone has been offline too long",
      text: "Starling throws a circle's keys away rather than carry them for weeks, and this device passed that point while it was away. Its keys are gone from memory and from storage, and so is this phone's own identity in that circle, so nothing you send arrives and nothing sent to you can be read. Ask somebody in the circle for a fresh invite link.",
      actions,
    });
  }

  if (state.chainWiped) {
    // Only what is actually true of this device: a phone with no app lock has
    // none to reassure anybody about, and a card that names a protection the
    // person does not have is the same defect as a card that claims an erase
    // that did not happen.
    const kept = state.lock?.enabled
      ? "Your app lock and your other circles were not touched."
      : "Your other circles were not touched.";
    items.push({
      id: "chain-wiped",
      kind: "warn",
      title: "One of your circles expired while this phone was away",
      text: `Starling throws a circle's keys away rather than carry them for weeks, and that circle passed the point where this device could still read it, so it was erased from this phone. ${kept} Ask somebody in that circle for a fresh invite link if you want back in.`,
      // It stays until it is read, like a re-key somebody else made, and then
      // it goes. Nothing else cleared it, so it sat on the map for good.
      //
      // This is also the only place the mark on disk is spent. It used to be
      // spent by the entry that raised this card, microseconds after the
      // destruct wrote it, which left the notice living in memory alone: a
      // routine autolock dropped it, and the person came back into a different
      // circle from the one they went away in with nothing said at all.
      actions: [
        {
          label: "Got it",
          testid: "alert-chain-wiped-ok",
          onClick: () => {
            state.chainWiped = null;
            void clearDestroyMark();
            render();
          },
        },
      ],
    });
  }

  if (state.missedRekey) {
    items.push({
      id: "missed",
      kind: "warn",
      title: "Your circle moved on without this phone",
      text: "New keys were made while this device could not be reached, and they cannot be worked out from the old ones. Nothing you send now arrives. Ask somebody in the circle for a fresh invite link.",
    });
  }

  if (state.rosterMismatch) {
    items.push({
      id: "mismatch",
      kind: "warn",
      title: "Your list of members does not match",
      text: `${displayName(state.rosterMismatch.by)} made new keys for a circle with a different list of people than this phone has. One of you is looking at a member the other is not.`,
      actions: [{ label: "See who is here", testid: "alert-mismatch", onClick: openMembers }],
    });
  }

  if (state.clockError) {
    const skew = state.clockError.skewMs;
    const off =
      Number.isFinite(skew) && Math.abs(skew) >= CLOCK_TOLERANCE_MS
        ? ` It is about ${Math.round(Math.abs(skew) / 60000)} minutes ${skew > 0 ? "behind" : "ahead"}.`
        : "";
    items.push({
      id: "clock",
      kind: "warn",
      title: "This phone's clock is wrong",
      text: `Your circle cannot see you. The relay refuses anything stamped with a time that far out, so your position is not going anywhere.${off} Turn on automatic date and time, then check again.`,
      actions: [{ label: "Check again", testid: "alert-clock", onClick: recheckClock }],
    });
  }

  for (const req of state.joinRequests) {
    items.push({
      id: `join:${req.memberId}`,
      kind: "info",
      title: `${req.name || "Someone"} wants to join`,
      text: "Check their safety number with them first. Accepting is what lets them see everyone's location.",
      actions: [
        { label: "Review the request", variant: "btn-primary", testid: "alert-review", onClick: openInvite },
      ],
    });
  }

  if (state.joining && state.gen) {
    // Somebody answering the link who is not the person who sent it is the
    // attack this whole handshake exists to stop. It was stopped, and the
    // person still needs to know it happened.
    const jumped = state.joining.imposters
      ? " Somebody answered this link who is not the person who sent it. Their welcome was refused. Check with whoever gave you the link before you use it again."
      : "";
    items.push({
      id: "joining",
      kind: state.joining.imposters ? "warn" : "info",
      title: `Waiting to be let into ${state.joining.circleName}`,
      text: `Somebody already in that circle has to accept your request. Read them your number: ${state.joining.safety || "not ready yet"}${jumped}`,
      actions: [{ label: "Cancel the request", testid: "alert-cancel-join", onClick: cancelJoin }],
    });
  }

  if (state.joinIncomplete) {
    const { got, want } = state.joinIncomplete;
    items.push({
      id: "join-incomplete",
      kind: "warn",
      title: "That invitation arrived incomplete",
      text: `The circle sent ${want} member ${want === 1 ? "record" : "records"} and only ${got} arrived, so this device would not be able to tell who is making new keys and would quietly stop keeping up. You were not joined. Ask for a fresh invite link.`,
      actions: [
        {
          label: "Got it",
          testid: "alert-join-incomplete-ok",
          onClick: () => {
            state.joinIncomplete = null;
            render();
          },
        },
      ],
    });
  }

  if (state.joinedVia) {
    const v = state.joinedVia;
    items.push({
      id: "joined-via",
      kind: "info",
      title: `Check ${displayName(v.memberId, "the person who let you in")}'s number`,
      text: `Their number is ${v.safety || "not available"}. Yours is ${v.mine || "not available"}. Read them to each other out loud, on a line you already trust. Nothing else in this circle has been checked by a person yet.`,
      actions: [
        { label: "Open members", variant: "btn-primary", testid: "alert-joined-via", onClick: openMembers },
        {
          label: "Done",
          testid: "alert-joined-via-ok",
          onClick: () => {
            state.joinedVia = null;
            render();
          },
        },
      ],
    });
  }

  if (state.foreground) {
    const run = state.foreground.elapsedMs >= 60000 ? ` for ${fmtRelTime(state.foreground.elapsedMs)}` : "";
    items.push({
      id: "foreground",
      kind: "info",
      title: `Sharing${run}, and this screen has to stay on`,
      text: state.foreground.wakeLock
        ? "This phone gives a web app no way to send a position in the background, so Starling only sends while it is open and in front. It is holding the screen awake for you."
        : "This phone gives a web app no way to send a position in the background, so Starling only sends while it is open and in front. It could not hold the screen awake, so stop the phone locking itself.",
    });
  }

  if (state.lastRekey) {
    const r = state.lastRekey;
    const gone = r.removedNames;
    items.push({
      id: "rekey",
      kind: "info",
      title: gone.length
        ? `${r.byName} removed ${gone.length === 1 ? gone[0] : `${gone.length} people`}`
        : `${r.byName} changed the keys`,
      text: gone.length
        ? `${gone.length === 1 ? gone[0] : "They"} can read nothing this circle sends from now on. Everyone still here got new keys.`
        : "Everyone in the circle has new keys. Nobody was removed, and nothing on your map goes away.",
      actions: [
        {
          label: "Got it",
          testid: "alert-rekey-ok",
          onClick: () => {
            state.lastRekey = null;
            render();
          },
        },
      ],
    });
  }

  // iOS hands a web app in a tab no background execution and a store the OS
  // evicts under pressure. Installed, the circle keys get a real home. Said
  // once, and it takes an answer.
  if (state.gen && isIOS() && !isInstalled() && !state.installDismissed) {
    items.push({
      id: "install",
      kind: "info",
      title: "Add Starling to your home screen",
      text: isIOSSafari()
        ? "In a tab, iOS can throw your circle's keys away when storage runs low, and sharing stops the moment you switch apps. Tap the Share button, then Add to Home Screen, and open Starling from there."
        : "In a tab, iOS can throw your circle's keys away when storage runs low. Open this page in Safari, tap Share, then Add to Home Screen.",
      actions: [{ label: "Not now", testid: "alert-install-no", onClick: dismissInstall }],
    });
  }

  return items;
}

function renderAlerts() {
  ui.updateAlerts($("#alerts"), alertItems());
}

// The way in to the members screen, and the only place the app says out loud
// how much of its own roster has actually been checked by a person.
function renderTools() {
  const tools = $(".sheet-tools");
  if (!tools) return;
  tools.hidden = state.demo || !state.gen;
  const changed = state.keyChanges.size;
  const unchecked = [...state.pinned.values()].filter((r) => !r.verified).length;
  $("#members-tool-sub").textContent = changed
    ? "Keys changed. Check before you trust it."
    : unchecked
      ? `${unchecked} ${unchecked === 1 ? "person" : "people"} you have not checked`
      : state.pinned.size
        ? "Everyone here is checked"
        : "Nobody else in this circle yet";
  const badge = $("#members-badge");
  const count = changed || unchecked;
  badge.hidden = !count;
  badge.textContent = String(count);
  badge.classList.toggle("tool-badge-alert", changed > 0);
}

// The onboarding screen carries the join wait, because a device with no circle
// yet has nowhere else to put it: without this, asking to join looks exactly
// like nothing happening.
let installWired = false;
function renderOnboarding() {
  const card = document.getElementById("join-waiting");
  if (!card) return;
  const waiting = !!state.joining && !state.gen;
  card.hidden = !waiting;
  if (waiting) {
    // No circle name here: the joiner has not been told one, and a made-up
    // label in a sentence about who is deciding their access reads as fact.
    $("#join-waiting-text").textContent = state.joining.imposters
      ? "Somebody answered this link who is not the person who sent it, and their welcome was refused. Your request is still waiting for the person who actually invited you. Check with them before you use the link again."
      : "Your request is waiting on the relay. Somebody already in the circle has to check your number and accept it, and they do not have to be online right now.";
    ui.setSafety($("#join-waiting-safety"), state.joining.safety);
  }

  const install = document.getElementById("install-card");
  const canPrompt = canPromptInstall();
  const wantInstall =
    shareCapable() && !state.demo && !state.installDismissed && ((isIOS() && !isInstalled()) || canPrompt);
  install.hidden = !wantInstall;
  if (wantInstall) {
    $("#install-text").textContent = isIOS()
      ? isIOSSafari()
        ? "In a Safari tab, iOS can throw your circle's keys away when storage runs low, and sharing stops the moment you switch apps. Tap the Share button, then Add to Home Screen."
        : "In a browser tab, iOS can throw your circle's keys away when storage runs low. Open this page in Safari, tap Share, then Add to Home Screen."
      : "Installed, Starling opens without browser chrome and its storage is harder for the browser to evict. Nothing is uploaded either way.";
    const go = $("#install-go");
    go.hidden = !canPrompt;
    if (canPrompt && !installWired) {
      installWired = true;
      go.addEventListener("click", async () => {
        go.disabled = true;
        const outcome = await promptInstall();
        go.disabled = false;
        if (outcome === "accepted") dismissInstall();
        render();
      });
    }
  }
}

async function dismissInstall() {
  state.installDismissed = true;
  await dbSet("installDismissed", true).catch(() => {});
  render();
}

// A wrong clock is measured, not guessed, so the way out of it is another
// measurement rather than a hopeful retry.
async function recheckClock() {
  const skewMs = await measureClockSkew();
  if (skewMs === null) {
    ui.toast("Could not reach the relay to check the time.", "warn");
    return;
  }
  if (Math.abs(skewMs) < CLOCK_TOLERANCE_MS) {
    state.clockError = null;
    ui.toast("The clock looks right now. Your circle can see you again.");
  } else {
    state.clockError = { skewMs, at: Date.now() };
    ui.toast(`Still about ${Math.round(Math.abs(skewMs) / 60000)} minutes out.`, "warn");
  }
  render();
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
  // The same floor for the lock. Every caller that can reach here across an
  // await checks state.locked for itself, and this is what catches the one
  // that forgets: a circle that materializes behind the lock screen puts the
  // map, the roster and everyone's position back on screen with no passcode
  // asked, which is the lock bypassed rather than a circle entered.
  if (state.locked) return;
  if (!state.gen) return;
  // Before the sync, not after: this circle is in the active slots, so an
  // earlier self-destruct has something true to say here, and a chain that
  // destroys itself on the very next line has to be able to leave its own mark
  // behind.
  //
  // This is the only place the mark is ever READ. Nothing read it on the
  // unlocked path, which is the configuration the app ships with, so a person
  // whose circle expired while the phone was away came back to the next circle
  // in the list with nothing said at all, and went on believing they were
  // visible to a circle that could not see them.
  //
  // Reading is all this does. Spending it here spent it in the same tick the
  // destruct wrote it, because the destruct promotes the next circle and
  // enters it immediately, and everything after that can lose the card: a
  // sixty second autolock drops state.chainWiped and there was then no record
  // anywhere that a circle had expired. The person dismissing the card is what
  // spends the mark.
  if (!state.chainWiped && (await hasDestroyMark())) state.chainWiped = { at: Date.now() };
  state.gen.ratchet.setHistoryEpochs(historyEpochs());
  await syncRatchet();
  // The sync can end the circle rather than advance it: a chain asked to walk
  // further than the catch-up cap destroys itself, and the teardown takes the
  // generation with it. There is nothing left here to point a poller at, and
  // the alert the teardown raised is already on screen.
  if (!state.gen) return;
  setupNet();
  startRekeyTimer();
  startInviteWatch();
  showMap();
}

// The one call that actually destroys expired key material. Nothing else walks
// the chain forward on a device that is only listening, so a phone that has
// been switched off for a week would otherwise come back still holding the
// week's keys. Called on entry and on every resume, and the survivor is written
// down, because a chain key left on disk is a chain key a seized phone has.
async function syncRatchet() {
  if (!state.gen || state.locked) return;
  // A null head means the chain destroyed itself rather than walk a jump it
  // is not allowed to walk. Nobody used to read this, so the app carried on
  // showing a connected circle it could neither send to nor read.
  if ((await state.gen.ratchet.syncToClock()) === null) {
    await onChainDestroyed();
    return;
  }
  await persistRatchet();
}

async function persistRatchet() {
  if (!state.gen || state.locked || circleBusy) return;
  const snap = state.gen.ratchet.snapshot();
  // No snapshot means the chain has been destroyed. Returning early here left
  // the last chain key sitting in the slot, which is the one thing the
  // self-destruct exists to remove: a phone that has been off for a month
  // would still hand a seizer a key on disk. It is also how the poll path
  // learns about it at all, because the poller advances the chain itself and
  // has no way to report back.
  if (!snap) {
    await onChainDestroyed();
    return;
  }
  if (snap.e0 === storedCkEpoch) return;
  try {
    await writeGenAtRest();
  } catch (e) {
    window.__starlingErrors.push(`ratchet: ${String(e)}`);
  }
}

// The chain is gone and there is no way back to this circle from this device.
//
// Everything the ratchet held was older than the relay's own 24 hour
// retention, so nothing readable was lost, but nothing sent from here arrives
// either and nothing arriving here opens. The stored form goes with it: a
// self-destruct that only happens in memory is not a self-destruct, it is a
// reboot away from being undone. Then the person is told, in those words,
// instead of being left looking at a map that says Live.
async function onChainDestroyed() {
  if (state.chainDestroyed) return;
  state.chainDestroyed = true;
  if (state.sharing) stopSharingInternals();
  teardownNet();
  // The join goes the way lockNow and cancelJoin send it, not half of it.
  // Stopping the poll and leaving the record behind left state.joining holding
  // a live invite secret for a rendezvous nothing was listening to any more,
  // with the screen still saying "waiting to be let in" and cancel the only
  // way out of it.
  stopJoinWatch();
  if (state.joining) zero(state.joining.secret);
  state.joining = null;
  clearInterval(rekeyTimer);
  // The invitation is a live credential for a circle this device can no
  // longer reach, so it leaves memory in the same breath as the slot.
  if (state.invite) zero(state.invite.secret);
  state.invite = null;
  state.joinRequests = [];
  // Positions decrypted from a circle this device can no longer read do not
  // get to sit on the map looking current.
  lastSentPos = null;
  prevStatus.clear();
  mapView?.clearAll();
  // And the circle itself goes, because there is no longer one here.
  //
  // This used to stop at the network: state.gen stayed live, holding a ratchet
  // with no key left in it, and every path that writes the outgoing circle
  // down before changing circles threw on it. That took out the one thing the
  // alert card tells the person to do. Create, switch and join all start that
  // way, and on the join path the throw lands inside a promise nobody reads,
  // so the welcome was swallowed while the inviter had already re-keyed the
  // circle and burned the link. Clearing it here is what makes the advice on
  // screen true.
  state.gen?.ratchet.destroy();
  state.gen = null;
  state.pinned = new Map();
  state.genRoster = new Set();
  state.keyChanges.clear();
  state.rosterPending = null;
  state.rosterMismatch = null;
  state.missedRekey = false;
  state.lastRekey = null;
  state.joinedVia = null;
  storedCkEpoch = -1;
  state.me = null;
  focusedId = null;
  $("#focus-card").hidden = true;
  try {
    if (await leaveDestroyedCircle(state.circles)) await enterCircle();
  } catch (e) {
    // The erase threw, so the circle is still whole on disk: leaveActive
    // writes its journal before it deletes anything and rethrows if even that
    // will not land. The keys are out of memory, which is worth something, but
    // the card claims they are gone from STORAGE and right now that is false.
    //
    // A card naming a protection the person does not have is the same defect
    // as a card claiming an erase that did not happen, and this comes up on
    // exactly the device the catch-up destruct exists for: one with no room
    // left to write. So say what actually happened and keep the retry alive
    // for the next launch, rather than leaving a reassuring sentence on screen
    // over a disk that still holds the chain key.
    state.chainDestroyed = false;
    state.chainWipeFailed = { at: Date.now(), why: String(e) };
    window.__starlingErrors.push(`self destruct: ${String(e)}`);
  }
  render();
}

// The self-destruct's journal.
//
// A device that has just erased its own chain looks, on disk, exactly like a
// device whose last-circle leave was cut short, because that is now what it
// is: the same leaveActive, the same purge, the same journal. What the two
// cannot share is the app lock. A leave is asked for, so it takes the lock
// with it rather than leaving a lock screen no passcode can satisfy; a
// self-destruct is not asked for and must never cost anybody their lock. So
// the disk says which of the two this was.
//
// That is the whole of what this flag does. It changes the words the person
// reads and it keeps the lock record alive through an empty launch. It steers
// no repair, because there is no repair left to steer: the destruct finishes
// its own leave at the moment it happens.
//
// Like the leave journal beside it, it is a flag and nothing else: it names no
// circle and holds no key, so it needs no sealed spelling and a device that
// cannot open the vault can still read it.
const DESTROYED_KEY = "destroyed";

// Is there a mark? Reading one never spends it.
async function hasDestroyMark() {
  try {
    return !!(await dbGet(DESTROYED_KEY));
  } catch (e) {
    window.__starlingErrors.push(`destroy mark: ${String(e)}`);
    return false;
  }
}

// Spend it. One caller, and it is the person tapping "Got it" on the card that
// explains the circle that went away, because that tap is the only evidence
// anybody was actually told.
//
// So it is still only ever cleared where a circle genuinely holds the active
// slots, since that is the only place the card is raised. Clearing it while
// the disk was still empty is what cost the app lock twice: the launch after
// that saw a lock record with nothing behind it, read it as an abandoned
// install, and deleted it.
async function clearDestroyMark() {
  try {
    await dbDel(DESTROYED_KEY);
  } catch (e) {
    // A mark nobody clears only ever makes a later launch say it again, so a
    // failure here is noted rather than raised.
    window.__starlingErrors.push(`destroy mark: ${String(e)}`);
  }
}

// The self-destruct's exit from the circle, which is a LEAVE.
//
// Three review rounds running, the bespoke machinery that used to live here
// produced a critical defect: a wire field that let any member fire the
// destruct, then a recovery that deleted the app lock at the next unlock, then
// the same deletion arriving one launch later. Every round it grew and broke
// somewhere new. So it is gone. Erasing a circle is leaving it, and leaving is
// the path this app has tested to death.
//
// What comes with that path, none of it written twice: the promotion of the
// next circle in the list, the journal that finishes an interrupted purge on
// the following launch, the fence that refuses a roster write queued before
// the leave, and LEAVE_PURGE_KEYS, which is what finally takes the things
// forgetChainAtRest left sitting on the disk while the card claimed the keys
// were gone. This device's keypair for the circle is the one that matters:
// it carries the member id this phone posted under, and that ties a seized
// phone to a channel the relay has logs of.
//
// The only difference from the leave a person asks for is the wording, and the
// mark is the whole of it. The app lock is emphatically NOT deleted here.
//
// This does the disk and the memory adopt and answers whether a circle took
// the slots. Entering it belongs to the caller, because the unlock cannot call
// itself unlocked until this has come back: a storage failure there has to
// leave the lock screen up with a lock screen's state behind it, not an
// unlocked session holding nothing.
async function leaveDestroyedCircle(circles) {
  // The mark is bookkeeping. It changes wording and it keeps a lock record
  // alive through an empty launch, and that is all it does.
  //
  // It used to be written BEFORE the erase, copying the leave journal's
  // ordering, and that copied the wrong property. The leave journal is written
  // first because it is what makes an interrupted delete recoverable. This
  // mark recovers nothing, so putting it first only gave a failed bookkeeping
  // write a veto over the erase: on a device with no storage quota left, the
  // dbSet rejected, the throw was swallowed, leaveActive never ran, and the
  // chain key, the channel id, the roster and the invitation all stayed on
  // disk while the card on screen said the keys were gone. That is the exact
  // device class the catch-up destruct exists for.
  //
  // So: erase first, and let the bookkeeping fail on its own if it must.
  const res = await leaveActive(kv, lockCtx(), { circles, toIndex: 0 });
  try {
    await dbSet(DESTROYED_KEY, 1);
  } catch {
    // The circle is already gone from disk, which is the part that matters.
    // Losing the mark costs an explanation, not a secret.
  }
  state.circles = res.circles;
  if (res.active) {
    // The move promoteCircle and boot already make. applyActive clears
    // chainDestroyed for the circle arriving, and chainWiped is what says the
    // one that went away went on its own rather than being left.
    applyActive(res.active);
    state.chainWiped = { at: Date.now() };
    return true;
  }
  // Nothing took the slots, so the purge above took this device's keypair and
  // the circle's name with it, and memory has to say what the disk says.
  state.identity = null;
  state.circleName = "My circle";
  if (res.pending) {
    ui.toast(
      "That circle expired, and this device could not erase all of it. Open Starling again to finish clearing it.",
      "warn",
    );
  }
  return false;
}

// What a launch says when a circle erased itself and there was no other circle
// for the slots to fall to. Both launches that can find that shape, locked and
// unlocked, say it with this, so there is one wording and one set of ways out.
function showDestroyedNotice() {
  const lockLine = state.lock?.enabled
    ? " Your app lock is untouched and still protects whatever you set up next."
    : "";
  showNotice({
    title: "Those keys are gone",
    body: `Starling throws a circle's keys away rather than carry them for weeks, and this phone passed that point while it was away. The circle was erased from this device, and there was no other circle to fall back to.${lockLine} Ask somebody for a fresh invite link, or start a new circle.`,
    actions: [
      { label: "Join with a link", variant: "btn-primary", testid: "notice-destroyed-join", onClick: promptPasteInvite },
      { label: "Start a new circle", testid: "notice-destroyed-new", onClick: promptCreate },
    ],
  });
}

// Write the live generation into the active slots.
//
// The whole record goes into one staged slot first, because the chain key and
// the record naming it have to change together and two kv writes are not one
// write. A crash in between would leave a chain key filed under the wrong
// epoch, or a channel with no key that can read it, and either way the member
// silently stops being visible to their circle. Boot applies whatever the
// staging slot still holds and then clears it, so a torn write finishes on the
// next launch instead of costing a circle.
async function writeGenAtRest() {
  const rec = genRecord();
  const lock = lockCtx();
  await writeRecordAtRest(kv, lock, STAGED_SLOT, packStagedGen({ ...rec, pinned: state.pinned }));
  await writeRecordAtRest(kv, lock, GEN_SLOT, packGenMeta(rec));
  await writeRecordAtRest(kv, lock, PINNED_SLOT, packPinned(state.pinned));
  await writeSecretAtRest(rec.ck);
  await writeRecordAtRest(kv, lock, STAGED_SLOT, null);
  storedCkEpoch = rec.ckEpoch;
}

// createRoster pins a member the first time it sees a point whose id genuinely
// commits to the keys it carries. That is a durable decision about who this
// circle is, so it is written down as it is made.
const pinnedStore = {
  get: (id) => state.pinned.get(id),
  set: (id, rec) => {
    // net.js hands over the keys as the relay spelled them. What lands in the
    // durable roster is the canonical spelling of the same bytes.
    state.pinned.set(id, canonPinned(rec));
    persistPinned();
  },
  // The receiver-side member cap in net.js reads this. It was missing, so
  // `pinned.size >= MEMBER_CAP` compared undefined and was false forever: the
  // cap passed its own tests against a bare Map and did nothing at all in the
  // app, and a malicious relay could still pin unlimited fabricated members
  // into the durable roster. A getter rather than a copied number, because a
  // re-key REPLACES state.pinned instead of mutating it, and a number read
  // once would go stale the moment a generation changed.
  get size() {
    return state.pinned.size;
  },
};

let pinnedWrite = Promise.resolve();
function persistPinned() {
  // A circle mutation is rewriting these same slots for a different circle;
  // its own write covers the roster, and a stray one from a roster that is
  // being torn down must not land on top of it. A destroyed chain has already
  // had its slots erased and nothing gets to put them back.
  if (state.locked || !state.gen || circleBusy || state.chainDestroyed) return;
  pinnedWrite = pinnedWrite
    .then(() => writeRecordAtRest(kv, lockCtx(), PINNED_SLOT, packPinned(state.pinned)))
    .catch((e) => window.__starlingErrors.push(`pinned: ${String(e)}`));
}

function setupNet() {
  poller?.stop();
  sender?.cancel?.();
  const gen = state.gen;
  roster = createRoster({
    channelId: gen.channelId,
    ratchet: gen.ratchet,
    selfId: state.identity.memberId,
    pinned: pinnedStore,
    onControl,
    onKeyChange,
  });
  sender = createSender({
    identity: state.identity,
    channelId: gen.channelId,
    ratchet: gen.ratchet,
    getLastTs: () => dbGet("lastSentTs"),
    setLastTs: (ts) => dbSet("lastSentTs", ts),
  });
  poller = createPoller({
    channelId: gen.channelId,
    roster,
    ratchet: gen.ratchet,
    onChange: () => {
      checkAlerts();
      persistRatchet();
      reconcileRoster().catch((e) => window.__starlingErrors.push(`roster: ${String(e)}`));
      render();
    },
    onStatus: (s) => {
      state.netStatus = s;
      if (state.screen === "map") renderChrome();
    },
    onRetired: onRelayRetired,
  });
  if (!state.demo) poller.start();
}

// The relay answered 410: it no longer speaks this build's protocol. Going
// quiet here would look exactly like an empty circle, so the app says so and
// stops pretending to be connected.
function onRelayRetired() {
  state.retired = true;
  teardownNet();
  stopInviteWatch();
  showNotice({
    title: "Update Starling",
    body: "The relay no longer speaks this version's protocol, so this app cannot connect and your circle cannot see you. Install the current version to get back on. Your circle and its keys are untouched on this device.",
  });
}

// A pinned member's keys changed. The member id commits to both public keys,
// so this is either a second preimage or a record written by an older
// derivation, and the client cannot tell which. It never re-pins on its own:
// the member's points are dropped, both safety numbers are kept, and a human
// decides.
async function onKeyChange(id, presented) {
  const known = state.pinned.get(id);
  if (keyChangeVerdict(known, presented) === "same") return;
  state.keyChanges.set(id, await describeKeyChange({ known, presented, now: Date.now() }));
  roster?.drop(id);
  mapView?.removeMarker(id);
  if (focusedId === id) unfocus();
  ui.toast(`${known?.name || "A member"}'s keys changed. Their location is hidden until you accept it.`, "warn");
  // At peek the sheet body is inert and the warning would be invisible. The
  // chrome banner shows either way; this puts the card itself in front too.
  if (state.screen === "map" && sheet && sheet.getSnap() === "peek") sheet.snapTo("half");
  render();
}

// The only way a key change is ever accepted, and it takes a human saying so
// after comparing the new safety number out of band.
async function acceptKeyChange(id) {
  const change = state.keyChanges.get(id);
  if (!change) return false;
  const entry = await acceptedKeyChange({ known: state.pinned.get(id), presented: change.presented });
  if (!entry) {
    state.keyChanges.delete(id);
    ui.toast("Those new keys are malformed. They were not accepted.", "warn");
    render();
    return false;
  }
  state.pinned.set(id, entry);
  state.keyChanges.delete(id);
  persistPinned();
  render();
  return true;
}

// Verification is local state: the protocol carries no verified bit, because a
// bit an attacker controls the transport for is not evidence of anything.
async function markVerified(id, verified = true) {
  const rec = state.pinned.get(id);
  if (!rec) return false;
  state.pinned.set(id, { ...rec, verified: !!verified });
  persistPinned();
  render();
  return true;
}

async function safetyNumberFor(id) {
  const rec = id === state.identity?.memberId
    ? { pk: b64uEncode(state.identity.pk), epk: b64uEncode(state.identity.epk) }
    : state.pinned.get(id);
  if (!rec) return null;
  try {
    return await safetyNumber(b64uDecode(rec.pk), b64uDecode(rec.epk));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ control

// Control messages arriving on the circle's own channel, already decrypted and
// already signature-checked against the key the sender's id commits to.
async function onControl(senderId, msg, epoch) {
  // No circle, nothing to control. The poller and its roster go with the
  // generation, so this is the belt to their braces: a control message that
  // was already in flight when the chain destroyed itself must not be read
  // against a generation that is no longer there.
  if (!state.gen) return;
  // Locked means every key this device holds has been zeroed and the lock
  // screen is up. Nothing arriving from the relay gets to start work that
  // ends in a live circle. adoptRekey checks again for itself, because the
  // lock can fall between here and there.
  if (state.locked) return;
  // A `member` record belongs to a welcome, on an invite channel, sealed to
  // one joiner. On this channel it is an ordinary message any member can
  // write, and acting on one grafts a keypair of their choosing onto every
  // device's roster for good: removing the member who posted it does not
  // remove the graft, because a re-key wraps to whoever is pinned. That is the
  // one defence this threat model offers against a compromised member, so the
  // record is refused here rather than filtered somewhere downstream.
  if (circleControl(msg) !== "rekey") {
    if (msg?.t === "member") window.__starlingErrors.push("member record on the circle channel: dropped");
    return;
  }
  // A member admitted by the last re-key is pinned the first time they post,
  // which is usually before they ever re-key. Converging here as well as on
  // the poll means their first act can be a re-key without splitting the
  // circle.
  await reconcileRoster();
  // A re-key has to come from a member this generation started with, not
  // merely from someone in the pinned roster. The roster pins a member the
  // first time a point of theirs verifies, and that pin happens inside the
  // same ingest pass that then hands the control message over here, so
  // "is pinned" on its own would be satisfied by a key we had never seen
  // before this message. Accepting a generation from a key like that is the
  // whole of the burgle-into-the-group attack, so it is refused: a stranger
  // has to be admitted by a member, through a re-key somebody else signs,
  // before anything they sign moves this circle.
  if (!state.genRoster.has(senderId) || !state.pinned.has(senderId)) {
    window.__starlingErrors.push("rekey from an unpinned member: dropped");
    return;
  }
  if (msg.to !== state.identity.memberId) return; // somebody else's wrap
  if (Number.isSafeInteger(msg.g) && msg.g > state.gen.g + 1) {
    // The generation in between never reached us and its seed cannot be
    // guessed, so this circle has moved on without this device. Say so; a
    // fresh invitation is the only way back.
    state.missedRekey = true;
    render();
    return;
  }
  const applied = await applyRekey({ identity: state.identity, gen: state.gen, msg, epoch, senderId });
  if (!applied) return;
  // Waits for the circle guard rather than bailing on it. A dropped re-key is
  // not retried: the wrap is consumed, the poller will not hand it over twice,
  // and this device would be left on a generation nobody else is on.
  await withCircleGuardWaiting(() => adoptRekey(applied, senderId));
}

// Does this device now agree with the rotator about who is in the circle?
// reconcileVerdict answers that; this is what the answer costs. Widening the
// generation's roster is a write, and a disagreement that outlived its grace
// is something a person has to be told.
async function reconcileRoster() {
  const p = state.rosterPending;
  if (!p || !state.gen || !state.identity || state.locked) return false;
  const verdict = await reconcileVerdict({
    pinned: state.pinned.keys(),
    self: state.identity.memberId,
    pending: p,
    now: Date.now(),
  });
  state.rosterPending = null;
  if (verdict === "converged") {
    state.genRoster = new Set(state.pinned.keys());
    await persistGeneration();
    render();
    return true;
  }
  if (verdict === "wait") {
    state.rosterPending = p;
    return false;
  }
  state.rosterMismatch = { by: p.by, at: Date.now() };
  ui.toast(`${displayName(p.by)} made new keys, but your list of members does not match theirs.`, "warn");
  render();
  return false;
}

// genRoster lives in the generation record, so widening it after an admission
// is a write. It goes through the same staged path every other generation
// write does, because the chain key and the record naming it may never be
// written apart.
async function persistGeneration() {
  if (state.locked || !state.gen || circleBusy || state.chainDestroyed) return;
  try {
    await writeGenAtRest();
  } catch (e) {
    window.__starlingErrors.push(`genRoster: ${String(e)}`);
  }
}

// Pin a member from a record carrying their keys, if admitPinned says the
// record may be pinned. This is the write half: everything it refuses, and the
// form it pins in, is decided in roster.js.
//
// Uncapped, and deliberately so for now. The records this reaches come out of
// a welcome, whose own count is bounded when it is read, and adding an
// occupancy bound here would change who lands in a roster on a path six review
// rounds have not touched. The other two pinning paths carry their own cap and
// this one has never had one; giving all three the same one is a change of
// behaviour, so it is written down rather than smuggled in with a move.
async function addPinned(rec) {
  const verdict = await admitPinned({ pinned: state.pinned, rec, cap: Infinity });
  if (!verdict.ok) return null;
  // Already known, so nothing is written: a re-pin would drop whatever this
  // person has since verified.
  if (verdict.already) return verdict.entry;
  state.pinned.set(verdict.memberId, verdict.entry);
  persistPinned();
  render();
  return verdict.entry;
}

// ------------------------------------------------------------------- re-key

const REKEY_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Everyone in a circle runs this timer, and two members re-keying in the same
// breath would leave the circle split across two generations that cannot talk.
// Each device therefore waits its own extra hour, derived from its member id,
// and any re-key that arrives first resets the clock for everyone who receives
// it. In practice one device does it and the rest never fire.
function rekeyDue(now = Date.now()) {
  if (!state.gen?.at || !state.identity) return false;
  const jitter = (parseInt(state.identity.memberId.slice(0, 6), 16) % 3600) * 1000;
  return now - state.gen.at > REKEY_INTERVAL_MS + jitter;
}

function startRekeyTimer() {
  clearInterval(rekeyTimer);
  rekeyTimer = setInterval(() => {
    if (!rekeyDue() || circleBusy || state.locked || state.demo || !sender) return;
    withCircleGuard(() => doRekey({ reason: "daily" })).catch(() => {});
  }, 60000);
}

// Move the circle to a new generation, keeping the circle and its people.
//
// This replaces v1's rotation, which minted a whole new circle and left
// everyone behind on a channel the rotator had walked away from. Here the
// current chain key is mixed with fresh random bytes delivered to each retained
// member over an ephemeral ECDH, so a relay cannot forge a generation and a
// removed member cannot follow one.
async function doRekey({ removed = [], admit = null, reason = "manual" } = {}) {
  if (!state.gen || state.demo || state.locked || !sender) return null;
  const recipients = rekeyRecipients({ pinned: state.pinned, removed, admit });

  const built = await buildRekey({ identity: state.identity, gen: state.gen, recipients, removed, now: Date.now() });
  if (!built) {
    // The epoch we would have mixed from has already left the history window.
    ui.toast("Could not make new keys right now. Try again in a moment.", "warn");
    return null;
  }

  // The wraps go out on the CURRENT channel, and this is the last thing that
  // ever happens there.
  const results = await Promise.allSettled(built.posts.map((p) => sender.send(p)));
  const failed = results.filter((r) => r.status === "rejected").length;
  if (built.posts.length && failed === built.posts.length) {
    // Nobody got the new material. Staying put is recoverable; moving would
    // leave the whole circle behind.
    zero(built.seed);
    await noteSendFailure(results[0].reason);
    ui.toast("Could not reach anyone with the new keys. Nothing changed.", "warn");
    return null;
  }
  if (failed) {
    ui.toast(`${failed} of ${built.posts.length} members did not get the new keys yet.`, "warn");
  }

  // The welcome needs the seed and openGeneration destroys it, so the copy is
  // taken before the generation opens and zeroed by the caller.
  const seedCopy = admit ? new Uint8Array(built.seed) : null;
  const next = await openGeneration({
    seed: built.seed,
    g: built.g,
    e0: built.e0,
    historyEpochs: historyEpochs(),
  });
  next.at = Date.now();

  const nextPinned = pinnedFromRecipients(recipients);

  teardownNet();
  const prev = state.gen;
  state.gen = next;
  state.pinned = nextPinned;
  state.genRoster = new Set(nextPinned.keys());
  // The rotator wrapped to everyone itself, so there is nothing for it to
  // reconcile against and no hash of somebody else's to hold on to.
  state.rosterPending = null;
  for (const id of removed) state.keyChanges.delete(id);
  state.rosterMismatch = null;
  state.missedRekey = false;
  state.lastRekey = null;
  lastSentPos = null;
  prevStatus.clear();
  mapView?.clearAll();
  await commitGeneration(prev);
  await enterCircle();
  void reason;
  // Keyed entries, not bare values: a member pinned from the network is stored
  // under its id and the record itself does not repeat it, and the welcome
  // filters the joiner out of its own roster by id.
  return { seed: seedCopy, members: [...nextPinned].map(([memberId, rec]) => ({ ...rec, memberId })) };
}

// Write the new generation down and drop the old one.
//
// The wraps are already on the relay by the time this runs, so everyone else
// has moved and there is no going back to the old generation. If the write
// fails the app keeps running on the new keys, because that is where the
// circle is, and says plainly that a restart would strand this device: the
// alternative is to look fine now and be silently alone after a reboot. The
// old chain keys are only destroyed once the new ones are durable.
async function commitGeneration(prev) {
  try {
    await writeGenAtRest();
    prev.ratchet.destroy();
  } catch (e) {
    window.__starlingErrors.push(`rekey persist: ${String(e)}`);
    ui.toast(
      "Your circle has new keys, but they could not be saved. If Starling restarts you will need a fresh invitation.",
      "warn",
    );
  }
}

// Apply a re-key somebody else signed. The generation is sound whatever the
// roster says, so a membership disagreement is surfaced rather than resolved:
// one side is looking at a circle the other is not, and only a person can say
// which is right.
async function adoptRekey(applied, senderId) {
  // The app locked while this re-key was being opened, and the lock screen is
  // now up with every key zeroed. Adopting it would open a fresh generation
  // and call enterCircle, which puts the map and everyone's position back on
  // screen without a passcode: the lock bypassed, not a re-key applied.
  // doRekey and completeJoin have always refused here; this path did not.
  //
  // Refusing does not cost the re-key. Locking destroyed the roster and its
  // dedup set along with the poller, so the relay serves the same wrap again
  // to the poller the next unlock builds, and the seed goes now rather than
  // sit in memory behind a lock screen.
  if (state.locked) {
    zero(applied.seed);
    return false;
  }
  // Names first: teardownNet below takes the roster with it, and the people
  // being removed leave the pinned map a few lines later.
  const senderName = displayName(senderId, "Someone");
  const removedNames = applied.removed.map((id) => displayName(id, "a member"));
  const { pinned: nextPinned, view: ours } = rosterAfterRekey({
    pinned: state.pinned,
    removed: applied.removed,
    self: state.identity.memberId,
    by: senderId,
  });
  const agrees = await rosterAgrees(applied.rh, ours);

  const next = await openGeneration({
    seed: applied.seed,
    g: applied.g,
    e0: applied.e0,
    historyEpochs: historyEpochs(),
  });
  next.at = Date.now();

  teardownNet();
  const prev = state.gen;
  state.gen = next;
  state.pinned = nextPinned;
  state.genRoster = new Set(nextPinned.keys());
  for (const id of applied.removed) state.keyChanges.delete(id);
  state.rosterMismatch = null;
  // reconcileRoster resolves this or surfaces it. The hash it reconciles
  // against is the rotator's own, sealed inside the wrap, so nobody else could
  // have written it.
  state.rosterPending = pendingAfterRekey({ agrees, rh: applied.rh, by: senderId, now: Date.now() });
  state.missedRekey = false;
  state.lastRekey = { byName: senderName, removedNames, at: Date.now() };
  lastSentPos = null;
  prevStatus.clear();
  mapView?.clearAll();
  await commitGeneration(prev);
  await enterCircle();
  if (removedNames.length === 1) {
    ui.toast(`${senderName} removed ${removedNames[0]}.`);
  } else if (removedNames.length) {
    ui.toast(`${senderName} removed ${removedNames.length} people from the circle.`);
  } else {
    ui.toast(`${senderName} changed the keys.`);
  }
  render();
  return true;
}

// The three things stage 2 calls. Each is a real re-key: the circle survives
// and its people come with it.
// Returns true only when the circle actually moved to a new generation, so a
// sheet cannot claim a re-key that did not happen.
const rekeyCircle = () => withCircleGuard(async () => (await doRekey({ reason: "manual" })) !== null);
const removeMember = (memberId) =>
  withCircleGuard(async () => {
    if (!state.pinned.has(memberId)) return null;
    const out = await doRekey({ removed: [memberId], reason: "remove" });
    if (out) {
      roster?.drop(memberId);
      mapView?.removeMarker(memberId);
      if (focusedId === memberId) unfocus();
    }
    return out;
  });

async function persistCircle() {
  // Identity first, generation last. This is a NEW circle's first landing
  // (create, join) and its identity exists nowhere else, so a crash between
  // the two writes must resolve as "the change never happened": an old chain
  // key with a fresh, never-used identity is a cosmetic stray, while the
  // reverse would announce an existing pseudonym on the new channel and link
  // the two circles. It also has to hold because writeGenAtRest stages the
  // generation as one record that boot will apply: the identity it belongs to
  // must already be on disk when that record appears. Switch and leave keep
  // the opposite order in circles.js writeActive, where the array holds the
  // paired copy.
  await dbSet("identity", {
    alg: state.identity.alg,
    privateKey: state.identity.privateKey,
    pk: state.identity.pk,
    ecdhPrivate: state.identity.ecdhPrivate,
    epk: state.identity.epk,
    memberId: state.identity.memberId,
  });
  await dbSet("lastSentTs", 0);
  // One invite slot, and this circle has not minted anything yet. The previous
  // circle's live credential does not get to sit in it: the watch would answer
  // that link on this circle's behalf and admit a stranger to it.
  await writeRecordAtRest(kv, lockCtx(), INVITE_SLOT, null);
  await writeGenAtRest();
}

// The chain key is the crown jewel. With app lock on it is written only sealed
// under the in-memory vault key; with lock off it is stored as bytes, same as
// an unlocked phone's other app data. Exactly one form is ever on disk.
async function writeSecretAtRest(ck) {
  return writeChainKey(lockCtx(), ck);
}

async function writeChainKey(lock, ck) {
  // May this be written, and under which key. atRestForm is the one place that
  // answers it, including the fail-closed half: with the lock on and no usable
  // vault key we are locked or mid-teardown, and the crown jewel does not get
  // written in either form.
  const form = atRestForm(lock);
  if (!form.ok) throw new Error("locked: refusing to write the chain key");
  if (form.sealed) {
    await dbSet("vaultSecret", await sealUnderVault(form.vaultKey, ck));
    await dbDel("secret");
  } else {
    await dbSet("secret", ck);
    await dbDel("vaultSecret");
  }
}

// The members this generation opened with, as written down with it, read out
// of a record that may predate the field.
function adoptGenRoster(meta) {
  return genRosterFrom(meta, state.pinned.keys());
}

// An invitation only belongs to the circle whose identity minted it. There is
// one invite slot on this device and there can be several circles, so a
// credential that names another identity is somebody else's live link and is
// dropped rather than answered.
function scopedInvite(inv, identity) {
  if (!inv) return null;
  if (!inviteMintedBy(inv, identity?.memberId)) {
    zero(inv.secret);
    return null;
  }
  return inv;
}

// A live generation rebuilt from disk. The chain key that survives is the
// oldest one still inside the history window, and ckEpoch is the epoch it
// belongs to; the generation's own e0 is older than that and is kept only
// because it names the generation.
function restoreGeneration(meta, ck) {
  return {
    g: meta.g,
    e0: meta.e0,
    at: meta.at,
    channelId: meta.channelId,
    ratchet: createRatchet({ e0: meta.ckEpoch, ck0: ck, historyEpochs: historyEpochs() }),
  };
}

// Finish a generation write that a crash interrupted. The staged record is the
// newer generation and the identity it belongs to was already on disk when it
// was staged, so applying it is always the repair.
async function applyStagedGen(lock) {
  let raw;
  try {
    raw = await readRecordAtRest(kv, lock, STAGED_SLOT);
  } catch (e) {
    // A record that will not authenticate is not the same as one that is not
    // there, and the storage layer says so by throwing rather than by
    // returning nothing. Park it rather than delete it, the same way an
    // unreadable circle array is parked, so a damaged install can still be
    // looked at instead of being quietly destroyed.
    if (isSealedRecordError(e)) {
      const blob = await dbGet(STAGED_SLOT.sealed);
      if (blob) await dbSet("vaultGenNextCorrupt", blob).catch(() => {});
      await writeRecordAtRest(kv, lock, STAGED_SLOT, null).catch(() => {});
    }
    return;
  }
  if (raw === null || raw === undefined) return;
  const staged = readStagedGen(raw);
  if (!staged) {
    await writeRecordAtRest(kv, lock, STAGED_SLOT, null).catch(() => {});
    return;
  }
  await writeRecordAtRest(kv, lock, GEN_SLOT, packGenMeta(staged));
  await writeRecordAtRest(kv, lock, PINNED_SLOT, staged.pinned);
  await writeChainKey(lock, staged.ck);
  await writeRecordAtRest(kv, lock, STAGED_SLOT, null);
}

// Everything the active slots hold, after any interrupted generation write has
// been finished. `ck` is the caller's chain key and is only a fallback: a
// staged record may have replaced it a moment ago, so the slot is re-read.
async function readActiveSlots(lock, ck) {
  await applyStagedGen(lock);
  let fresh = ck;
  const form = atRestForm(lock);
  if (form.sealed) {
    const sealed = await dbGet("vaultSecret");
    // The same question the writers ask, in the reading direction: a sealed
    // record with no usable key behind it is not something to open, it is a
    // session that has no business holding the chain key at all.
    if (sealed && !form.ok) throw new Error("locked: refusing to read the chain key");
    const opened = sealed ? await openUnderVault(form.vaultKey, sealed) : null;
    if (opened) fresh = opened;
  } else {
    const plain = await dbGet("secret");
    if (plain) fresh = plain;
  }
  const [identity, meta, pinned, invite] = await Promise.all([
    dbGet("identity"),
    readRecordAtRest(kv, lock, GEN_SLOT),
    readRecordAtRest(kv, lock, PINNED_SLOT),
    readRecordAtRest(kv, lock, INVITE_SLOT),
  ]);
  return {
    ck: fresh,
    identity,
    meta: readGenMeta(meta === undefined ? null : meta),
    pinned: pinned === undefined ? [] : pinned,
    invite: invite === undefined ? null : invite,
  };
}

// Adopt an active circle read off disk into memory.
function adoptActive({ ck, identity, meta, pinned, invite }) {
  state.identity = identity;
  state.gen = restoreGeneration(meta, ck);
  // Canonical on the way in too. A roster written by an older build holds
  // whatever the relay spelled at the time, and a member whose record comes
  // back spelled differently from the live one is the same false alarm on the
  // first launch after an update.
  state.pinned = new Map([...pinnedMap(pinned)].map(([id, rec]) => [id, canonPinned(rec)]));
  state.genRoster = adoptGenRoster(meta);
  state.invite = scopedInvite(readInvite(invite), identity);
  storedCkEpoch = meta.ckEpoch;
}

// v1 wrote a circle root under `secret` and no generation record at all. That
// root is not a chain key, it names no v2 channel, and a v1 client cannot talk
// to a v2 relay in the first place, so there is nothing honest to migrate. Say
// so out loud and offer the eraser: a silent failure here would look exactly
// like a circle where nobody ever posts.
function showV1Notice() {
  state.v1Data = true;
  showNotice({
    title: "Start fresh",
    body: "This device holds a circle from an older version of Starling. The encryption changed, and old circles cannot be carried across: the keys mean different things now. Erase this device's Starling data and create or join a circle again. Nothing was sent anywhere.",
    actions: [{ label: "Erase and start over", variant: "btn-primary", testid: "notice-action", onClick: panic }],
  });
}

// ------------------------------------------------------------------ app lock

let lockTimer = 0;
let lockWired = false;
let damagedAtRest = false;

// Lock transitions rewrite the same slots the circle mutations do, so they
// take the same guard, and memory adopts the new lock state only AFTER the
// at-rest transition commits: a thrown storage op must never leave the
// session believing one thing while the disk says another, because the next
// mutation would then persist in the wrong form and boot's stray purge would
// finish the loss.
async function enableLock(passcode) {
  if (!state.gen) return false;
  if (!takeCircleGuard()) return false;
  try {
    const K = newVaultKey();
    const pass = await makePasscodeRecord(passcode, K);
    const lockRecord = { enabled: true, autolockMs: 60000, pass, bio: null };
    const rec = genRecord();
    try {
      // Ordering lives in circles.js so the crash-window tests can drive it:
      // sealed forms durable before the lock record flips, plaintext deleted
      // only after, and a throw unwinds back to the unlocked form.
      await enableLockTransition(kv, {
        vaultKey: K,
        lockRecord,
        secret: rec.ck,
        circles: state.circles,
        genMeta: packGenMeta(rec),
        pinned: packPinned(state.pinned),
        invite: packInvite(state.invite),
      });
    } catch (e) {
      zero(K);
      throw e;
    }
    state.vaultKey = K;
    state.lock = lockRecord;
    storedCkEpoch = rec.ckEpoch;
    return true;
  } finally {
    releaseCircleGuard();
  }
}

async function disableLock(passcode) {
  if (!state.gen) return false;
  const K = await openPasscodeRecord(state.lock.pass, passcode);
  if (!K) return false;
  zero(K);
  if (!takeCircleGuard()) return false;
  try {
    // Mirror image of enableLock: plaintext forms first, the lock record
    // next, the stale sealed copies last. The transition resolves only when
    // the lock record is genuinely gone from disk; until then memory keeps
    // the vault key and stays locked-consistent.
    const rec = genRecord();
    await disableLockTransition(kv, {
      secret: rec.ck,
      circles: state.circles,
      genMeta: packGenMeta(rec),
      pinned: packPinned(state.pinned),
      invite: packInvite(state.invite),
    });
    storedCkEpoch = rec.ckEpoch;
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
//
// The vault key is zeroed on EVERY exit that is not a completed unlock, the
// thrown ones included. A sealed record that will not authenticate makes
// readActiveSlots throw, and state.vaultKey is assigned before that call, so
// without this the lock screen came back with the key still live in memory:
// the wrong-passcode path wiped it and the damaged-install path, which is the
// one a seizer can create by corrupting a byte, did not. The lock is worth
// what the process holds after it, and after a failed unlock that has to be
// nothing.
async function unlockWith(recoverKey) {
  const K = await recoverKey();
  if (!K) return false;
  let unlocked = false;
  try {
    unlocked = await openVaultWith(K);
    return unlocked;
  } finally {
    if (!unlocked) {
      zero(K);
      state.vaultKey = null;
    }
  }
}

// The inactive array, read the way the recovery paths have to read it: a blob
// that will not authenticate under a key that just opened the passcode record
// is corrupt or tampered, and dropping it beats refusing the unlock, but the
// bytes are parked under a quarantine key first so a transient fault stays
// recoverable instead of being overwritten by the next persist. In these
// shapes it can be the only copy of every circle left on the device.
async function readInactiveAtRest(lock) {
  const read = await readCirclesAtRest(kv, lock);
  if (read !== null) return read;
  const blob = await dbGet("vaultCircles");
  if (blob) await dbSet("vaultCirclesCorrupt", blob).catch(() => {});
  ui.toast("Your other circles could not be read and were dropped.", "warn");
  return [];
}

// The body of an unlock, once a key has been recovered. Split out so the
// zeroing above covers every way out of it, including the ways it throws.
async function openVaultWith(K) {
  const lock = { enabled: true, vaultKey: K };
  const sealed = await dbGet("vaultSecret");
  if (!sealed) {
    // Which of the ways this happened decides everything below, so the disk is
    // read before anything is repaired. unlockVerdict holds why each shape
    // means what it means.
    const destroyed = !!(await dbGet(DESTROYED_KEY).catch(() => null));
    // The plaintext slots are read only when there is no mark. A device that
    // destroyed itself is being resumed rather than repaired, and it is the
    // device class whose store fails: an unguarded read that throws there
    // would come back as "wrong passcode" on a passcode that was right.
    const [plainSecret, plainIdentity, plainCircles] = destroyed
      ? [null, null, null]
      : await Promise.all([dbGet("secret"), dbGet("identity"), dbGet("circles")]);
    const found = unlockVerdict({ sealed: false, opened: false, destroyed, plainSecret, plainIdentity });
    if (found.kind === "resume-destroyed") {
      state.vaultKey = K;
      const inactive = await readInactiveAtRest(lock);
      // Nothing is unsealed into plaintext and nothing touches the lock: the
      // vault key stays live and the remaining circles stay sealed under it.
      //
      // The leave here is the same one the destruct itself runs, not a second
      // copy of it. On a device whose destruct finished, it walks over slots
      // that are already empty and costs a handful of deletes; on one written
      // by a build whose destruct only erased the chain key, it is the leave
      // finally being made, which is how the keypair and the circle name that
      // build left behind come off the disk. Either way it runs before the
      // session calls itself unlocked.
      const promoted = await leaveDestroyedCircle(inactive);
      state.locked = false;
      clearTimeout(lockTimer);
      if (promoted) await enterCircle();
      else showDestroyedNotice();
      render();
      return true;
    }
    // The passcode is right but there is no sealed chain key at all: a crash
    // mid last-circle leave, or mid recovery, took the sealed slots and left
    // the lock record behind. This is the repair, and it is the one path that
    // takes the lock off, because a leave is something the person asked for.
    if (found.kind === "restore-plaintext") {
      zero(K);
      state.locked = false;
      state.lock = null;
      state.vaultKey = null;
      clearTimeout(lockTimer);
      await dbDel("lock");
      const slots = await readActiveSlots(null, plainSecret);
      if (slotsVerdict({ identity: plainIdentity, meta: slots.meta }).kind === "v1") {
        showV1Notice();
        return true;
      }
      adoptActive({ ...slots, identity: plainIdentity });
      state.circleName = (await dbGet("circleName")) || state.circleName;
      const arr = Array.isArray(plainCircles) ? plainCircles : [];
      state.circles = reconcileCircles({
        activeSecret: slots.ck,
        activeMemberId: plainIdentity.memberId,
        circles: arr,
      });
      if (state.circles.length !== arr.length) await persistCirclesAtRest().catch(() => {});
      await enterCircle();
      return true;
    }
    // Reading the array is not free: an unreadable blob is quarantined and the
    // person is told about it. So the question is asked again with the count
    // in hand, because an array nobody has read yet is not an empty one.
    const inactive = await readInactiveAtRest(lock);
    zero(K);
    state.locked = false;
    state.lock = null;
    state.vaultKey = null;
    clearTimeout(lockTimer);
    const stray = unlockVerdict({
      sealed: false,
      opened: false,
      destroyed,
      plainSecret,
      plainIdentity,
      circles: inactive.length,
    });
    if (stray.kind === "promote-circles") {
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
    for (const k of SEALED_KEYS) await dbDel(k);
    await dbDel("lock");
    showScreen("onboarding");
    return true;
  }
  const ck = await openUnderVault(K, sealed);
  // The sealed chain key is the verifier. It did not open, so this is a wrong
  // passcode or a failed biometric and nothing on disk is touched over it.
  if (unlockVerdict({ sealed: true, opened: !!ck }).kind === "wrong-passcode") {
    zero(K);
    return false;
  }
  state.vaultKey = K;
  let slots;
  try {
    slots = await readActiveSlots(lock, ck);
  } catch (e) {
    // The chain key opened but the records naming it did not. This is the
    // damaged-install exit, and the chain key is the crown jewel, so it does
    // not get to sit in memory behind the lock screen any more than the vault
    // key does.
    zero(ck);
    throw e;
  }
  const inSlots = slotsVerdict(slots);
  if (inSlots.kind === "no-identity") {
    zero(K);
    state.vaultKey = null;
    return false;
  }
  // A locked install written by v1 has a sealed secret and no generation
  // record. It opens fine and means nothing, so say so rather than entering a
  // circle that can never talk to anyone.
  if (inSlots.kind === "v1") {
    zero(K);
    state.vaultKey = null;
    state.locked = false;
    clearTimeout(lockTimer);
    showV1Notice();
    return true;
  }
  adoptActive(slots);
  // The inactive circles ride the same vault key. A blob that will not
  // authenticate under a K that just opened the active chain key is corrupt or
  // tampered; dropping it beats refusing the unlock, and the user hears it.
  // The unreadable blob itself is parked under a quarantine key first, so a
  // transient fault stays recoverable instead of being overwritten by the
  // next persist.
  const inactive = await readCirclesAtRest(kv, lock);
  if (inactive === null) {
    const blob = await dbGet("vaultCircles");
    if (blob) await dbSet("vaultCirclesCorrupt", blob).catch(() => {});
    state.circles = [];
    ui.toast("Your other circles could not be read and were dropped.", "warn");
  } else {
    // A torn writeActive can pair this chain key with another circle's
    // identity or another circle's generation; the array still holds the
    // properly paired record, so adopt it before anything announces the wrong
    // pseudonym or posts under a key that channel cannot read.
    const paired = adoptPairedCircle({
      activeSecret: slots.ck,
      activeMemberId: state.identity.memberId,
      activeGen: state.gen,
      circles: inactive,
    });
    if (paired) {
      applyActive(paired);
      await dbSet("identity", paired.identity);
      await dbSet("circleName", paired.name);
      if (paired.profile) await dbSet("profile", paired.profile);
      await writeGenAtRest();
    }
    // A crash mid-switch while locked can leave the active circle duplicated
    // in the sealed array, same as the unlocked boot path; reconcile it here
    // with the same both-must-match rule.
    state.circles = reconcileCircles({
      activeSecret: state.gen.ratchet.snapshot().ck0,
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
  stopInviteWatch();
  stopJoinWatch();
  if (state.joining) zero(state.joining.secret);
  state.joining = null;
  clearInterval(rekeyTimer);
  // The beacon holds its own key and its own sender; locking drops keys, so
  // it goes too rather than outliving the screen that can switch it off.
  beacon?.end().catch(() => {});
  beacon = null;
  sosViewer = null;
  zero(state.vaultKey);
  // destroy() zeroes every retained chain key inside the ratchet, which is the
  // whole of what this device can decrypt with.
  state.gen?.ratchet.destroy();
  for (const c of state.circles) zero(c.secret);
  if (state.invite) zero(state.invite.secret);
  state.circles = [];
  state.vaultKey = null;
  state.gen = null;
  state.pinned = new Map();
  state.genRoster = new Set();
  state.rosterPending = null;
  state.joinedVia = null;
  state.joinIncomplete = null;
  state.chainDestroyed = false;
  state.chainWipeFailed = null;
  state.invite = null;
  state.joinRequests = [];
  state.keyChanges.clear();
  // The card explaining that a circle expired is state about a circle, and the
  // lock screen exists so that none of that is readable. It comes back on the
  // next unlock, because the mark that raises it is still on disk: only a
  // person dismissing the card spends that, and locking the screen is not a
  // person reading anything.
  state.chainWiped = null;
  storedCkEpoch = -1;
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
    // A sealed record that will not authenticate is a damaged or tampered
    // install, not a mistyped passcode. Telling someone their passcode is
    // wrong when it is not sends them looking for the wrong problem, and the
    // one thing that must never happen here is erasing a circle over it.
    damagedAtRest = false;
    try {
      ok = await unlockWith(() => openPasscodeRecord(state.lock.pass, pc));
    } catch (e) {
      ok = false;
      damagedAtRest = isSealedRecordError(e);
    }
    unlockBtn.disabled = false;
    unlockBtn.textContent = "Unlock";
    input.disabled = false;
    if (!ok) {
      showLockError(
        damagedAtRest
          ? "That passcode is right, but this install's stored data will not open. Nothing was erased."
          : "Wrong passcode. Try again.",
      );
    }
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
    title: state.gen ? "New circle" : "Create your circle",
    intro: "How you appear to the people you invite. This never leaves your circle.",
    cta: "Create circle",
    profile: state.profile,
    circleName: { value: state.gen ? "" : state.circleName },
    onSave: (p) =>
      withCircleGuard(async () => {
        // Whether this ADDS a circle is decided now, not when the sheet
        // opened: overlays stack, and a join that committed underneath this
        // sheet must not be silently overwritten.
        const addMode = !!state.gen;
        if (state.demo) exitDemo();
        // Snapshot the outgoing circle BEFORE the new profile is saved, so
        // a per-circle pseudonym stays with its circle instead of bleeding
        // into the one being left.
        const outgoing = addMode ? await activeRecord() : null;
        await saveProfile(p);
        if (state.sharing) await awaitBye(await setSharing(false));
        const prev = {
          gen: state.gen,
          pinned: state.pinned,
          genRoster: state.genRoster,
          invite: state.invite,
          identity: state.identity,
          circleName: state.circleName,
          circles: state.circles,
        };
        let opened = null;
        try {
          if (addMode) {
            // The current circle goes into the inactive array before anything
            // touches the active slots, so no failure below can lose it.
            state.circles = [...state.circles, outgoing];
            await persistCirclesAtRest();
          }
          const now = Date.now();
          opened = await openGeneration({
            seed: newSeed(),
            g: 0,
            e0: epochAt(now),
            historyEpochs: historyEpochs(),
          });
          state.gen = opened;
          state.gen.at = now;
          state.pinned = new Map();
          state.genRoster = new Set();
          state.rosterPending = null;
          state.rosterMismatch = null;
          state.joinedVia = null;
          state.joinIncomplete = null;
          state.chainDestroyed = false;
          state.chainWipeFailed = null;
          state.invite = null;
          state.identity = await generateIdentity();
          state.circleName = p.circleName || (addMode ? "New circle" : prev.circleName);
          await dbSet("circleName", state.circleName);
          await persistCircle();
        } catch (e) {
          // Undo the in-memory swap AND put the disk array back in step with
          // it, so a later mutation cannot resurrect a stale entry the boot
          // reconcile no longer recognizes. Only the generation this attempt
          // opened is destroyed: the one being rolled back to is still live.
          opened?.ratchet.destroy();
          state.gen = prev.gen;
          state.pinned = prev.pinned;
          state.genRoster = prev.genRoster;
          state.invite = prev.invite;
          state.identity = prev.identity;
          state.circleName = prev.circleName;
          state.circles = prev.circles;
          await persistCirclesAtRest().catch(() => {});
          throw e;
        }
        // The outgoing circle's chain key is in the array now; the live copy
        // in its ratchet is not needed and does not get to linger.
        if (addMode) prev.gen?.ratchet.destroy();
        stopInviteWatch();
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

// Joining is a request now, not a fait accompli. The link is a one-time
// credential that bootstraps a pairwise channel; the circle's own keys are
// replaced at the moment somebody accepts, which is what stops a joiner
// reading the epoch they joined during.
function promptJoin(invite) {
  if (!shareCapable() || state.locked) return;
  const verdict = joinPromptVerdict({ joining: state.joining, invite: state.invite, candidate: invite });
  if (verdict === "already-asked") {
    ui.toast("You already asked to join. They still have to let you in.");
    return;
  }
  if (verdict === "own-link") {
    ui.toast("That is your own invite link.");
    return;
  }
  ui.openJoinSheet({
    profile: state.profile,
    hasCircle: !!state.gen,
    circleName: { value: "" },
    onJoin: (p) =>
      withCircleGuard(async () => {
        // Joining from inside the demo ends the demo first, so the real
        // circle and its poller take over instead of the demo walkers.
        if (state.demo) exitDemo();
        await saveProfile(p);
        await joinWithInvite(invite, p);
        ui.toast("Request sent. Someone in the circle has to accept it from their phone.");
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
    const invite = parseInviteFragment(frag);
    if (!invite) {
      err.hidden = false;
      return;
    }
    ov.close();
    promptJoin(invite);
  });
  ov.body.append(field, err, go);
  input.focus();
}

// ------------------------------------------------------------ invitations
//
// A v1 invite was a bearer token: the link carried the circle secret, so
// whoever saw it held every past and future key. A v2 invitation is a one-time
// credential that bootstraps a pairwise channel, and the circle's own key
// material is replaced at the moment somebody is let in. The cost is honest:
// an invitation now needs a human on the other side to come back and accept it.

const INVITE_POLL_MS = 15000;

// The invite channel carries one handshake under one symmetric key. There is
// no chain to advance and nothing to re-key, so the ratchet the sender expects
// is that key handed back for whatever epoch it asks about; the epoch still
// travels in the AAD and inside the signature.
function fixedKeyRatchet(key) {
  return {
    keyFor: async () => key,
    currentEpoch: async (now = Date.now()) => epochAt(now),
    retainedEpochs: () => [],
  };
}

function inviteSender(identity, chanId, key) {
  let lastTs = 0;
  return createSender({
    identity,
    channelId: chanId,
    ratchet: fixedKeyRatchet(key),
    getLastTs: () => lastTs,
    setLastTs: (ts) => {
      lastTs = ts;
    },
  });
}

// A poll loop for an invite channel. Deliberately not the circle's poller:
// there is no ratchet here, no trail, and no roster to merge into, so the
// checks a receiver owes are spelled out rather than inherited. Nothing the
// relay says is taken on trust: the member id has to commit to the keys
// presented, the signature has to verify against them, and the sealed ts has
// to be the one the header committed to.
function pollInviteChannel({ chanId, key, selfId, onMessage, onBatch }) {
  let stopped = false;
  let timer = 0;
  let since = 0;
  const seen = new Set();

  async function tick() {
    if (stopped) return;
    try {
      const res = await fetch(apiUrl(`/api/v2/f/${chanId}?since=${since}`), { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        for (const entry of data.members || []) {
          if (!entry || typeof entry.m !== "string" || entry.m === selfId) continue;
          let pk, epk;
          try {
            pk = b64uDecode(entry.pk);
            epk = b64uDecode(entry.epk);
          } catch {
            continue;
          }
          if ((await memberIdFromKeys(pk, epk)) !== entry.m) continue;
          for (const p of entry.points || []) {
            if (Number.isFinite(p.srv) && p.srv > since) since = p.srv;
            const tag = `${entry.m}|${p.e}|${p.ts}`;
            if (seen.has(tag)) continue;
            seen.add(tag);
            let n, c, sig;
            try {
              n = b64uDecode(p.n);
              c = b64uDecode(p.c);
              sig = b64uDecode(p.sig);
            } catch {
              continue;
            }
            // Derived from the key, never taken off the wire. This is the last
            // path that read the relay's `alg`, and while a flipped field here
            // only makes verification fail rather than corrupting anything
            // durable, "the relay can silently stop anyone joining" is not a
            // property worth keeping for the sake of one field.
            const entryAlg = algFromPk(pk);
            if (!entryAlg) continue;
            if (!(await verifySig(entryAlg, pk, sig, sigBase(chanId, entry.m, p.e, p.ts, p.n, p.c)))) continue;
            // The epoch is signed and it is what a welcome's opening epoch is
            // bounded against, so it has to mean something before it is used
            // as a bound. The relay refuses an implausible one on the way in;
            // this is the receiver making the same check for itself, because
            // an untrusted party's verdict is worth nothing and a welcome is
            // read by a device with no chain of its own to sanity-check it.
            if (!epochPlausible(p.e, Date.now())) continue;
            const obj = await openMessage(key, chanId, entry.m, p.e, p.ts, n, c);
            if (!obj || obj.ts !== p.ts) continue;
            await onMessage(obj, { memberId: entry.m, alg: entryAlg, pk: entry.pk, epk: entry.epk }, p.e);
          }
        }
        await onBatch?.();
      }
    } catch {
      // The link is valid until it expires; a failed poll is just a longer wait.
    }
    if (!stopped) timer = setTimeout(tick, INVITE_POLL_MS);
  }
  tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

const inviteLinkFor = (inv) => `${shareUrlBase()}${inviteFragment(inv.secret, inv.commit)}`;

// Mint an invitation. One at a time, and a fresh one replaces the last: two
// live credentials for one circle is two chances for the wrong person to be
// holding one.
async function createInvite() {
  const now = Date.now();
  const plan = mintDecision({ invite: state.invite, ready: !!state.gen && !state.demo && !state.locked, now });
  if (plan.action === "refuse") return null;
  if (plan.action === "reuse") return inviteLinkFor(state.invite);
  if (plan.replaces) zero(state.invite.secret);
  // The link commits to this circle's identity, and the record names it. The
  // commitment is what lets the joiner tell the person who sent the link from
  // anyone else who saw it; the name is what stops another circle on this
  // device answering the link on its behalf.
  state.invite = {
    secret: newInviteSecret(),
    commit: await inviterCommitment(state.identity.pk, state.identity.epk),
    by: state.identity.memberId,
    createdAt: now,
    expiresAt: now + INVITE_TTL_MS,
  };
  state.joinRequests = [];
  await writeRecordAtRest(kv, lockCtx(), INVITE_SLOT, packInvite(state.invite));
  startInviteWatch();
  render();
  return inviteLinkFor(state.invite);
}

// Burn: the credential is gone from memory and from disk, and a second join
// request on that channel is ignored because nothing is listening any more.
async function burnInvite() {
  stopInviteWatch();
  if (state.invite) zero(state.invite.secret);
  state.invite = null;
  state.joinRequests = [];
  await writeRecordAtRest(kv, lockCtx(), INVITE_SLOT, null).catch(() => {});
  render();
}

function stopInviteWatch() {
  invitePoll?.();
  invitePoll = null;
}

function startInviteWatch() {
  stopInviteWatch();
  const inv = state.invite;
  // Answering a link this circle did not mint is how a stranger gets admitted
  // to the wrong circle: one invite slot, several circles, and whoever is
  // active picks up whatever is in it. That rule and the expiry both live in
  // inviteWatchDecision; burning is the effect, so it stays here.
  const { action } = inviteWatchDecision({
    invite: inv,
    ready: !!state.gen && !state.demo && !state.locked,
    selfId: state.identity?.memberId,
    now: Date.now(),
  });
  if (action === "idle") return;
  if (action === "burn") {
    burnInvite().catch(() => {});
    return;
  }
  (async () => {
    const chanId = await deriveInviteChannelId(inv.secret);
    const key = await deriveInviteKey(inv.secret);
    if (state.invite !== inv) return; // burned while the keys were deriving
    invitePoll = pollInviteChannel({
      chanId,
      key,
      selfId: state.identity.memberId,
      onMessage: (obj, from) => onJoinRequest(inv, obj, from),
    });
  })().catch((e) => window.__starlingErrors.push(`invite: ${String(e)}`));
}

// A join request. It is never acted on automatically: the whole point of a v2
// invitation is that a person compares a safety number and says yes, so this
// only puts the request where stage 2 can draw it.
async function onJoinRequest(inv, obj, from) {
  if (state.invite !== inv) return;
  // The keys in the request must be the keys the post was signed with, or the
  // safety number a person compares is not the one that will be pinned. The
  // same key spelled two ways is the same key: comparing the spellings made a
  // request the inviter simply never saw, with nothing on screen to say why.
  const seen = await screenJoinRequest({
    obj,
    from,
    invite: inv,
    now: Date.now(),
    keysMatch: sameKey(obj.pk, from.pk) && sameKey(obj.epk, from.epk),
    known: state.pinned.has(from.memberId),
    listed: state.joinRequests.some((r) => r.memberId === from.memberId),
  });
  if (!seen.ok) {
    if (seen.reason === "expired") await burnInvite();
    if (seen.reason === "bad-key") window.__starlingErrors.push("join request with a malformed agreement key: dropped");
    return;
  }
  state.joinRequests.push({
    memberId: from.memberId,
    alg: from.alg,
    pk: canonKey(from.pk),
    epk: canonKey(from.epk),
    name: seen.name,
    safety: seen.safety,
    at: Date.now(),
  });
  ui.toast(`${obj.name ? String(obj.name).slice(0, 24) : "Someone"} wants to join. Check their safety number.`);
  render();
}

// Let someone in. Admitting is a re-key that includes them, so they are handed
// a generation that did not exist a moment ago and there is no backlog for
// them to read.
async function acceptJoin(req) {
  return withCircleGuard(async () => {
    const inv = state.invite;
    // Whether this request may be let in at all, and on what record, is
    // admissionCheck's: the cap, the key that has to be a real point, the id
    // and algorithm re-derived from the key rather than read off the wire.
    // What is left here is what a refusal costs a person: a burned link, a
    // sentence on screen, or neither.
    const check = await admissionCheck({
      req,
      invite: inv,
      pinned: state.pinned,
      ready: !!state.gen,
      now: Date.now(),
    });
    if (!check.ok) {
      if (check.reason === "expired") {
        await burnInvite();
        ui.toast("That invitation expired. Make a new link.", "warn");
      } else if (check.reason === "full") {
        ui.toast(`A circle holds ${MEMBER_CAP} people and yours is full. Remove somebody before letting anyone else in.`, "warn");
      } else if (check.reason === "bad-keys") {
        ui.toast("That request's keys are malformed. Nobody was let in.", "warn");
      }
      return false;
    }
    const { rec, epk } = check;
    // Step one of admissionPlan(): the rendezvous channel gets claimed BEFORE
    // the re-key, because nothing outside that channel has happened yet and a
    // refusal here therefore costs nothing. See the plan for what the cap on
    // that channel does to a delivery that is attempted the other way round.
    const inviteSecret = new Uint8Array(inv.secret);
    let channel = null;
    try {
      channel = await openWelcomeChannel(inviteSecret, req);
    } catch (e) {
      zero(inviteSecret);
      window.__starlingErrors.push(`welcome slot: ${String(e)}`);
      // Nothing irreversible has happened, so the circle is exactly as it was
      // and the person is told that in those words. A cap that refused us a
      // slot is permanent for this channel, so that link is finished and it is
      // burned rather than left looking usable; anything else is a bad moment
      // on the network and the link still works.
      if (slotFailure(e).burn) {
        await burnInvite();
        ui.toast("Somebody else is jamming that invite link, so it cannot be used any more. Nobody was let in. Make a new link and send it again.", "warn");
      } else {
        ui.toast("Could not reach them to send the keys, so nobody was let in. Try again in a moment.", "warn");
      }
      return false;
    }
    let out;
    try {
      out = await doRekey({ admit: { memberId: req.memberId, epk, rec }, reason: "join" });
    } catch (e) {
      // The slot we claimed and the copy of the invitation are ours to clean
      // up however the re-key ends.
      channel.post.cancel();
      zero(inviteSecret);
      throw e;
    }
    if (!out) {
      channel.post.cancel();
      zero(inviteSecret);
      return false;
    }
    let delivered = false;
    try {
      await sendWelcome(channel, req, out.seed, out.members);
      delivered = true;
    } catch (e) {
      window.__starlingErrors.push(`welcome: ${String(e)}`);
    } finally {
      zero(out.seed);
      zero(inviteSecret);
    }
    // A welcome that did not go out takes the admission back out with it: the
    // plan's "undo-admission", which is itself a re-key, and undoAdmission
    // names exactly what it removes. The circle goes back to what it was at
    // the cost of one more re-key, the link is still live and the request is
    // still on the list below, so the person retries from a circle that is
    // whole.
    //
    // The undo can fail in turn. If it does, say so in the words that name the
    // only way out, because a member this device cannot talk to is still a
    // member it can remove.
    if (!delivered) {
      let back = null;
      try {
        back = await doRekey(undoAdmission(req.memberId));
      } catch (e) {
        window.__starlingErrors.push(`welcome rollback: ${String(e)}`);
      }
      if (back) {
        ui.toast("Could not send them the keys, so nobody was let in. Your link still works, so try again.", "warn");
      } else {
        ui.toast(
          `Could not send ${req.name || "them"} the keys, and could not undo letting them in. Remove them from the circle before you try again.`,
          "warn",
        );
      }
      render();
      return false;
    }
    await burnInvite();
    ui.toast(`${req.name || "They"} joined. Everyone got new keys.`);
    render();
    return true;
  });
}

// Turning someone away costs nothing: the invitation stays live for whoever it
// was actually meant for, and this request is not shown again.
function rejectJoin(req) {
  state.joinRequests = state.joinRequests.filter((r) => r.memberId !== req.memberId);
  render();
  return true;
}

// Take a member slot on the rendezvous channel and keep the sender that holds
// it. Every later post from this device passes the cap on the strength of the
// row this one creates, so once it succeeds the welcome can be delivered.
//
// One sender for the whole exchange, deliberately: two senders on one channel
// pick their timestamps independently, and the relay refuses a post whose ts
// does not beat the last one it stored for that member.
async function openWelcomeChannel(inviteSecret, req) {
  const chanId = await deriveInviteChannelId(inviteSecret);
  const key = await deriveInviteKey(inviteSecret);
  const post = inviteSender(state.identity, chanId, key);
  try {
    // The joiner ignores anything that is not a welcome or a member record, so
    // this says nothing and only exists to claim the slot. It is padded to the
    // same length as every other message, so the relay cannot tell it apart
    // from the welcome that follows.
    await post.send({ t: "ack", to: req.memberId });
  } catch (e) {
    post.cancel();
    throw e;
  }
  return { chanId, post };
}

// The welcome goes to the invite channel, sealed to the joiner's agreement key
// so only the device that made the request can open it, signed by the circle
// identity the invite link commits to, and bound to that identity inside the
// wrap.
//
// It used to be signed by a throwaway identity and sealed under the default
// empty context, to keep one key off both the rendezvous channel and the
// circle channel. That cost is real, and it bought nothing: with nobody named,
// a welcome was whoever posted one first. Anyone who saw the link could derive
// the rendezvous channel, read the joiner's agreement key out of their request,
// seal a seed of their own, and win the race easily, because the real inviter
// has to be online and tap accept. The joining device would then stream live
// position to a channel the attacker owns while the app said "You joined". So
// the welcome is authenticated, the linkage is accepted, and the relay learning
// that one key posted on both channels is the smaller harm by a long way.
//
// It goes out on the channel, and through the sender, that openWelcomeChannel
// already claimed a member slot with.
async function sendWelcome({ chanId, post }, req, seed, members) {
  const joinerEpk = b64uDecode(req.epk);
  const g = state.gen.g;
  const e0 = state.gen.e0;
  // The same idea as a re-key's wrap context: everything the message asserts,
  // inside the AEAD's associated data, so a wrap only opens under the exact
  // claims it was made for and cannot be lifted into anybody else's welcome.
  const context = welcomeContext({ by: state.identity.memberId, g, e0 });

  const sealFor = async (bytes) => {
    const eph = await generateEphemeral();
    const w = await sealTo(eph.privateKey, joinerEpk, chanId, req.memberId, bytes, context);
    return { eph: b64uEncode(eph.pub), w: b64uEncode(w) };
  };

  // One record per existing member, including ourselves: this is what lets a
  // joiner pin the circle from the invitation rather than from whatever the
  // relay serves first.
  const roster = welcomeRoster({
    self: {
      memberId: state.identity.memberId,
      alg: state.identity.alg,
      pk: b64uEncode(state.identity.pk),
      epk: b64uEncode(state.identity.epk),
      name: state.profile?.name || "",
    },
    members,
    joinerId: req.memberId,
  });

  // The member records go out FIRST and the welcome goes out LAST, and that
  // order is the whole of what makes a half-sent delivery harmless. It is the
  // plan that says so, not this loop: welcomePlan returns the posts in the
  // order they have to leave, and this walks them and seals each one. Why that
  // order, and what a delivery run the other way round leaves behind, is in
  // admissionPlan.
  try {
    for (const item of welcomePlan({ roster, g, e0 })) {
      if (item.t === "welcome") {
        await post.send({ t: "welcome", ...item.head, ...(await sealFor(seed)) });
        continue;
      }
      const body = item.body;
      let sealed = await sealFor(te.encode(JSON.stringify(body)));
      if (recordOverflows(sealed)) {
        delete body.name;
        sealed = await sealFor(te.encode(JSON.stringify(body)));
      }
      await post.send({ t: "member", ...sealed });
    }
  } finally {
    post.cancel();
  }
}

// ------------------------------------------------------------------ joining

function stopJoinWatch() {
  joinPoll?.();
  joinPoll = null;
}

// Ask to be let in. The keypairs are generated here and live in memory only
// until the welcome lands: if the app is closed before somebody accepts, the
// request is dead and the link has to be used again.
async function joinWithInvite(invite, profile) {
  // A new join replaces whatever join was in flight, and the poll and the
  // record of it go together. Stopping only the poll left state.joining naming
  // the old request if the post below then failed: the screen sat on "waiting
  // to be let in" for a channel nothing was listening to, for as long as the
  // app stayed open, and cancelling was the only way out of it.
  cancelJoin();
  const { secret, commit } = invite;
  const identity = await generateIdentity();
  const chanId = await deriveInviteChannelId(secret);
  const key = await deriveInviteKey(secret);
  const post = inviteSender(identity, chanId, key);
  // The number the inviter is about to compare, so the joiner can read it out
  // instead of taking it on faith that the right request arrived.
  let safety = null;
  try {
    safety = await safetyNumber(identity.pk, identity.epk);
  } catch {
    safety = null;
  }
  try {
    await post.send({
      t: "join",
      pk: b64uEncode(identity.pk),
      epk: b64uEncode(identity.epk),
      name: profile?.name || "",
    });
  } finally {
    post.cancel();
  }
  state.joining = {
    status: "waiting",
    since: Date.now(),
    safety,
    secret: new Uint8Array(secret),
    // The link's commitment to the inviter's identity. Nothing that arrives on
    // this channel is used for anything until it matches.
    commit: new Uint8Array(commit),
    imposters: 0,
    identity,
    chanId,
    key,
    circleName: profile?.circleName || "New circle",
  };
  startJoinWatch();
  render();
  return true;
}

function cancelJoin() {
  stopJoinWatch();
  if (state.joining) zero(state.joining.secret);
  state.joining = null;
  render();
}

// The welcome and the member records are posted in one burst, so one feed
// response normally carries all of them. They are collected across the
// response and applied together at the end of it, so the joiner pins the
// circle from the invitation rather than trusting whoever posts first.
function startJoinWatch() {
  stopJoinWatch();
  const j = state.joining;
  if (!j) return;
  const pending = [];
  // Counted at the door rather than found later: assembleWelcome only ever
  // looked at t:"welcome", so a stranger posting t:"member" was invisible to
  // it, and the buffer it filled was the only place the jam showed.
  let strangers = 0;
  joinPoll = pollInviteChannel({
    chanId: j.chanId,
    key: j.key,
    selfId: j.identity.memberId,
    onMessage: async (obj, from, epoch) => {
      if (state.joining !== j) return;
      const { action } = await screenWelcomeMessage({ obj, from, commit: j.commit, buffered: pending.length });
      if (action === "stranger") {
        strangers += 1;
        return;
      }
      if (action !== "keep") return;
      // The epoch travels with the message: the welcome's opening epoch is
      // bounded against it, and it cannot be recovered once the message is off
      // the wire.
      pending.push({ obj, from, epoch });
    },
    onBatch: async () => {
      // Strangers are reported even when nothing was buffered, because
      // somebody answering this link who is not the person who sent it is the
      // one thing the joiner has to hear about, and in the jam it is the only
      // thing that ever happens.
      if (state.joining !== j) return;
      let assembled = { welcome: null, imposters: 0 };
      if (pending.length) {
        assembled = await assembleWelcome({
          identity: j.identity,
          chanId: j.chanId,
          commit: j.commit,
          messages: pending,
        });
      }
      const { welcome } = assembled;
      const imposters = strangers + assembled.imposters;
      if (imposters !== j.imposters) {
        j.imposters = imposters;
        render();
      }
      if (!welcome) return;
      j.welcomeAt = j.welcomeAt || Date.now();
      const verdict = welcomeVerdict({ welcome, since: j.welcomeAt, now: Date.now() });
      if (verdict.action !== "join") {
        // The seed opened, so this device could join and be unable to
        // attribute a single re-key afterwards: every one would be dropped for
        // coming from a member it was never told about, and nothing would say
        // so. Wait for the rest, then refuse and say why.
        zero(welcome.seed);
        if (verdict.action === "wait") return;
        stopJoinWatch();
        zero(j.secret);
        state.joining = null;
        state.joinIncomplete = { got: verdict.got, want: verdict.want, at: Date.now() };
        render();
        return;
      }
      // The buffer is the only copy of the welcome there is: the poll loop
      // will not serve the same message twice, and the inviter has already
      // re-keyed the circle and burned the invitation by the time it arrives.
      // It used to be emptied here, BEFORE the await, so a guard that timed
      // out or a persist that threw lost the join for good and left the device
      // waiting on a welcome that could never be sent again. It is cleared
      // only once it has actually been spent, and the next round re-opens it
      // from the raw messages otherwise.
      let joined = false;
      try {
        joined = await withCircleGuardWaiting(() => completeJoin(j, welcome));
      } catch (e) {
        // The poll loop swallows whatever onBatch throws, which is part of why
        // a lost join was invisible. The messages stay in the buffer and the
        // next round opens a fresh seed out of them, so this one is zeroed
        // rather than left in memory, and the failure is written down.
        window.__starlingErrors.push(`join: ${String(e)}`);
      } finally {
        zero(welcome.seed);
      }
      if (joined) pending.length = 0;
    },
  });
}

// The circle lands here, at accept time, not when the sheet was filled in:
// overlays stack and another circle may have been created underneath this one
// while it was waiting.
async function completeJoin(j, welcome) {
  if (state.joining !== j) return false;
  const addMode = !!state.gen;
  const outgoing = addMode ? await activeRecord() : null;
  if (state.sharing) await awaitBye(await setSharing(false));
  const prev = {
    gen: state.gen,
    pinned: state.pinned,
    genRoster: state.genRoster,
    invite: state.invite,
    identity: state.identity,
    circleName: state.circleName,
    circles: state.circles,
  };
  let opened = null;
  try {
    if (addMode) {
      state.circles = [...state.circles, outgoing];
      await persistCirclesAtRest();
    }
    const now = Date.now();
    opened = await openGeneration({
      seed: welcome.seed,
      g: welcome.g,
      e0: welcome.e0,
      historyEpochs: historyEpochs(),
    });
    state.gen = opened;
    state.gen.at = now;
    state.identity = j.identity;
    state.pinned = new Map();
    state.invite = null;
    // The welcome names the generation's members, so these are the keys that
    // may re-key it; anyone this device meets later has to be admitted by one
    // of them first.
    for (const m of welcome.members) await addPinned(m);
    // The welcome named these people and the inviter signed for it, so this is
    // the generation's membership, not a set of first sightings.
    state.genRoster = new Set(state.pinned.keys());
    state.rosterPending = null;
    state.rosterMismatch = null;
    state.joinIncomplete = null;
    state.chainDestroyed = false;
    state.chainWipeFailed = null;
    state.circleName = j.circleName || prev.circleName;
    await dbSet("circleName", state.circleName);
    await persistCircle();
  } catch (e) {
    opened?.ratchet.destroy();
    state.gen = prev.gen;
    state.pinned = prev.pinned;
    state.genRoster = prev.genRoster;
    state.invite = prev.invite;
    state.identity = prev.identity;
    state.circleName = prev.circleName;
    state.circles = prev.circles;
    await persistCirclesAtRest().catch(() => {});
    throw e;
  }
  if (addMode) prev.gen?.ratchet.destroy();
  stopJoinWatch();
  zero(j.secret);
  state.joining = null;
  state.me = null;
  focusedId = null;
  prevStatus.clear();
  sheetAutoOpened = false;
  mapView?.clearAll();
  // Whoever let you in is the one identity in this circle you have any way to
  // check, and the link committed to them before any of this. Their number is
  // put in front of the joiner rather than left in a sheet nobody opens.
  state.joinedVia = {
    memberId: welcome.inviter.memberId,
    safety: await safetyNumberFor(welcome.inviter.memberId),
    mine: await safetyNumberFor(state.identity.memberId),
    at: Date.now(),
  };
  if (state.locked) return true;
  await enterCircle();
  ui.toast("You joined the circle.");
  // Say hello on the circle channel. Everyone else was told a new member
  // exists by the re-key that admitted this device, but only its own posts
  // carry its keys, and until they land nobody can attribute anything it
  // signs, including a re-key. A check-in carries no position.
  sendMsg("checkin").catch((e) => window.__starlingErrors.push(`hello: ${String(e)}`));
  return true;
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

// The same guard, for the two callers that must not bail when it is held: an
// arriving re-key and an arriving welcome are consumed the moment they are
// decrypted. The poller will not hand either of them over a second time, so
// dropping one would leave this device on a generation nobody else is on. It
// waits instead, and gives up loudly rather than waiting forever.
async function withCircleGuardWaiting(fn, ms = 15000) {
  const until = Date.now() + ms;
  while (circleBusy) {
    if (Date.now() > until) {
      window.__starlingErrors.push("circle guard held too long: change dropped");
      return false;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  circleBusy = true;
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
  stopInviteWatch();
}

function applyActive(c) {
  state.gen?.ratchet.destroy();
  state.identity = c.identity;
  state.gen = restoreGeneration(c, c.secret);
  state.pinned = pinnedMap(c.pinned);
  state.genRoster = adoptGenRoster(c);
  // Invitations never travel with a switch; circles.js burns the slot in the
  // same breath, so memory and disk agree that this circle has none.
  if (state.invite) zero(state.invite.secret);
  state.invite = null;
  state.joinRequests = [];
  state.keyChanges.clear();
  state.rosterMismatch = null;
  state.rosterPending = null;
  state.joinedVia = null;
  state.joinIncomplete = null;
  state.missedRekey = false;
  state.chainDestroyed = false;
  state.chainWipeFailed = null;
  state.lastRekey = null;
  storedCkEpoch = c.ckEpoch;
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
  if (!shareCapable() || state.demo || state.locked) return false;
  // No active circle to stash: the chain destroyed itself and took it, so
  // there is nothing to write into the array and this is a promotion, not a
  // swap. Going through activeRecord() here threw on the dead generation,
  // which is how a self-destruct also took away the circles it had not
  // touched.
  if (!state.gen) return promoteCircle(i);
  // Sharing never carries across circles: stop it, give the bye a moment to
  // actually land on the old channel, and let the user turn sharing back on
  // where they arrive.
  if (state.sharing) await awaitBye(await setSharing(false));
  const prev = {
    gen: state.gen,
    pinned: state.pinned,
    genRoster: state.genRoster,
    invite: state.invite,
    identity: state.identity,
    circleName: state.circleName,
    circles: state.circles,
  };
  const outgoing = await activeRecord();
  teardownNet();
  try {
    const res = await switchActive(kv, lockCtx(), {
      outgoing,
      circles: state.circles,
      toIndex: i,
    });
    state.circles = res.circles;
    applyActive(res.active);
  } catch (e) {
    // Both chain keys are on disk whatever happened; put memory back on the
    // circle we were in and keep it live. Autolock is deferred while the
    // guard is held, so state.locked cannot flip mid-switch; the check is
    // belt and braces against any future path that locks synchronously.
    state.gen = prev.gen;
    state.pinned = prev.pinned;
    state.genRoster = prev.genRoster;
    state.invite = prev.invite;
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

// Make one of the inactive circles active when nothing holds the active slots.
// leaveActive is exactly this move: it hands the slots to the circle at
// toIndex and shrinks the array, and boot uses it for the same shape after a
// crash mid-leave.
async function promoteCircle(i) {
  if (!state.circles[i]) return false;
  const res = await leaveActive(kv, lockCtx(), { circles: state.circles, toIndex: i });
  if (!res.active) return false;
  state.circles = res.circles;
  applyActive(res.active);
  await enterCircle();
  ui.toast(`Switched to ${state.circleName}.`);
  return true;
}

const switchCircle = (i) => withCircleGuard(() => doSwitchCircle(i));

const leaveCircle = () =>
  withCircleGuard(async () => {
    if (!shareCapable() || state.demo || state.locked || !state.gen) return false;
    if (state.sharing) await awaitBye(await setSharing(false));
    teardownNet();
    stopJoinWatch();
    clearInterval(rekeyTimer);
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
    state.gen?.ratchet.destroy();
    state.gen = null;
    state.identity = null;
    state.pinned = new Map();
    state.genRoster = new Set();
    if (state.invite) zero(state.invite.secret);
    state.invite = null;
    state.joinRequests = [];
    state.keyChanges.clear();
    storedCkEpoch = -1;
    state.circleName = "My circle";
    state.circles = [];
    state.me = null;
    mapView?.clearAll();
    showScreen("onboarding");
    // A leave whose deletes did not all take is not a leave that finished, and
    // saying so is the whole point of `pending`: the roster, the channel id
    // and a live invitation are still on the disk until boot replays the
    // journal. Telling the person it is gone would be the one lie this screen
    // must never tell.
    ui.toast(
      res.pending
        ? "You left, but this device could not erase everything. Open Starling again to finish clearing it."
        : "You left the circle.",
      res.pending ? "warn" : "info",
    );
    return true;
  });

function openCircles() {
  if (!shareCapable()) return;
  if (state.demo) {
    ui.toast("Exit the demo first.");
    return;
  }
  if (state.locked) return;
  if (!state.gen && !state.circles.length) return;
  ui.openCircleSheet({
    api,
    // With no active circle the sheet is a list of circles to go to, so the
    // current row says there is nothing here rather than naming the circle
    // that was just erased.
    current: { name: state.gen ? state.circleName : "No circle" },
    others: state.circles.map((c) => ({ name: c.name })),
    onSwitch: switchCircle,
    onCreate: promptCreate,
    onJoin: promptPasteInvite,
  });
}

// In the wrapper the page lives on an asset origin that means nothing off this
// device, so invite links always name the canonical web origin instead.
const inviteLink = () => (state.invite ? inviteLinkFor(state.invite) : "");

function qrColors() {
  return resolvedTheme() === "light"
    ? { dark: "#101522", light: "#ffffff" }
    : { dark: "#0a0d14", light: "#ffffff" };
}

// The screen that turns trust on first use into a checked identity. It is
// reachable from the map and from settings, and it follows live state while it
// is open: keys can change under it.
function openMembers() {
  if (state.demo) {
    ui.toast("Exit the demo to see your circle's keys.");
    return;
  }
  if (!state.gen || state.locked) return;
  keepLive((done) => ui.openMembersSheet({ api, onClose: done }));
}

async function openInvite() {
  if (state.demo) {
    ui.toast("Exit the demo to invite your people.");
    return;
  }
  if (!state.gen) return;
  // There is nothing to show until an invitation exists: a v2 link is its own
  // one-time credential, not a rendering of the circle's key.
  let link = null;
  try {
    link = await createInvite();
  } catch (e) {
    window.__starlingErrors.push(`invite: ${String(e)}`);
  }
  if (!link) {
    ui.toast("Could not make an invite link. Try again.", "warn");
    return;
  }
  keepLive((done) =>
    ui.openInviteSheet({
      api,
      getLink: inviteLink,
      qrSvgFor: (l) => qrSvg(l, qrColors()),
      onClose: done,
    }),
  );
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
  keepLive((done) =>
    ui.openSettingsSheet({
      api,
      onClose: done,
      onMembers: openMembers,
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
    }),
  );
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
    if (key === "history") {
      state.gen?.ratchet.setHistoryEpochs(historyEpochs(value));
      // The window just moved, and what is written down has to be what
      // survived it: an old chain key still on disk is one a seized phone has.
      await persistRatchet();
      if (value === "high-risk" && !state.settings.steady) {
        state.settings = { ...state.settings, steady: true };
        await dbSet("settings", state.settings);
        ui.toast("Steady sending is on too, so the relay cannot read your movement from the timing.");
      }
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

// The fixed cadence every share posts on, movement or no movement.
const SHARE_INTERVAL_MS = 15000;

// How far the clocks may disagree before the relay refuses a post outright.
const CLOCK_TOLERANCE_MS = MAX_SKEW_EPOCHS * EPOCH_MS;

// The relay refuses a post whose epoch is more than MAX_SKEW_EPOCHS from its
// own clock, and net.js tags that one rejection with code "clock" rather than
// letting it read as a network blip. So this is not a guess: the relay said
// the epoch was outside its tolerance. It has to be loud, because a phone
// whose clock is wrong is invisible to its circle, and the failure this app
// can least afford is somebody believing they are being seen when they are
// not.
async function noteSendFailure(err) {
  if (err?.code !== "clock") return;
  const skewMs = await measureClockSkew();
  state.clockError = { skewMs, at: Date.now() };
  const off =
    skewMs === null || Math.abs(skewMs) < CLOCK_TOLERANCE_MS
      ? ""
      : ` It is about ${Math.round(Math.abs(skewMs) / 60000)} minutes ${skewMs > 0 ? "behind" : "ahead"}.`;
  ui.toast(`This phone's clock is wrong, so your circle cannot see you.${off} Turn on automatic date and time.`, "warn");
  render();
}

// Server time from the response Date header, corrected for half the round
// trip so a slow link does not read as a wrong clock. Returns null when there
// is nothing to measure against.
async function measureClockSkew() {
  const chan = channelId();
  if (!chan) return null;
  try {
    const sent = Date.now();
    const res = await fetch(apiUrl(`/api/v2/f/${chan}?since=${sent}`), { cache: "no-store" });
    const header = res.headers.get("date");
    if (!header) return null;
    const server = Date.parse(header);
    if (!Number.isFinite(server)) return null;
    const back = Date.now();
    return server + (back - sent) / 2 - back;
  } catch {
    return null;
  }
}

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
    if (state.sharing) {
      shareTimer = setInterval(() => sendLoc(true), SHARE_INTERVAL_MS);
      // Where the platform gives a web app no background execution at all,
      // sharing only runs while the screen is on and the app is in front.
      // Say so and hold the screen, rather than let someone walk away from a
      // phone they believe is still sharing.
      if (!canShareInBackground()) startForeground();
    }
  } else {
    state.sharing = false;
    state.sosActive = false;
    state.geoFailed = false;
    clearInterval(shareTimer);
    stopGeo?.();
    stopGeo = null;
    stopForeground();
    lastSentPos = null;
    // Stopping the share stops every audience, helpers included.
    endBeacon().catch(() => {});
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
  // Steady sending posts on the interval alone. Posting again because you
  // moved is what tells the relay you moved: it cannot read a position, but a
  // burst of writes when you are walking and silence when you are still is a
  // movement trace made of timing. With this on the traffic looks the same
  // either way, and the last known position is simply re-sent.
  if (
    state.sharing &&
    !state.settings.steady &&
    (!lastSentPos || haversineMeters(lastSentPos.lat, lastSentPos.lon, fix.lat, fix.lon) > 25)
  ) {
    sendLoc();
  }
  render();
}

// ------------------------------------------------------- foreground session

// iOS gives a web app zero background execution: geolocation is
// [Exposed=Window], so not even a push-woken service worker can read a
// position. Sharing there only ever runs with the app in front and the screen
// on. This holds a wake lock and a running timer so the UI can say that
// plainly instead of pretending otherwise.
function startForeground() {
  if (foreground) return;
  state.foreground = { active: true, elapsedMs: 0, wakeLock: false, since: Date.now() };
  foreground = createForegroundSession({
    onTick: (ms) => {
      if (!state.foreground) return;
      state.foreground.elapsedMs = ms;
      // The running clock is the whole point of the card: it is the evidence
      // that sharing is still alive on a platform where it dies when you leave.
      if (state.screen === "map") {
        renderYou();
        renderAlerts();
      }
    },
    onWakeLockChange: (on) => {
      if (state.foreground) state.foreground.wakeLock = on;
    },
  });
  foreground.start();
  render();
}

function stopForeground() {
  if (!foreground) return;
  const session = foreground;
  foreground = null;
  state.foreground = null;
  session.stop().catch(() => {});
}

function stopSharingInternals() {
  state.sharing = false;
  state.sosActive = false;
  endBeacon().catch(() => {});
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
    if (state.clockError) {
      state.clockError = null;
      render();
    }
  } catch (e) {
    // The poll loop surfaces ordinary connectivity trouble; a refused epoch is
    // not ordinary and gets said out loud.
    await noteSendFailure(e);
  }
  // Helpers watching the beacon get the same fixes as the circle.
  if (beacon) await pushBeacon();
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
    // Checking in safe is exactly the moment helpers should stop seeing you.
    await endBeacon();
    ui.toast(okMsg);
  } catch (e) {
    // The circle still sees the SOS, so keep showing it here too.
    state.sosActive = wasSos;
    await noteSendFailure(e);
    if (!state.clockError) ui.toast("Check-in failed. Reconnecting...", "warn");
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
  } catch (e) {
    await noteSendFailure(e);
    if (!state.clockError) ui.toast("SOS failed to send. Reconnecting...", "warn");
  }
  // Your circle is who you chose in advance. An emergency is often the
  // moment that turns out to be the wrong list: the people who can reach you
  // are a neighbour, a colleague, whoever is nearby, and none of them are
  // going to install anything right now. The beacon is a second, separate
  // share they can open in a browser.
  //
  // Re-checked after the await: a location failure can land while the SOS
  // post is in flight and switch sharing back off, and starting a beacon
  // then would leave one running with no SOS on screen to end it.
  if (state.sosActive) startBeaconForSos().catch(() => {});
  render();
}

// The beacon runs alongside the circle share on its own channel with its own
// key and its own signing identity, so handing out a help link never hands
// out circle history and never links the two channels for the relay.
async function startBeaconForSos() {
  if (beacon) return;
  let started;
  try {
    started = await startBeacon();
  } catch {
    return;
  }
  // Minting is asynchronous, so the SOS can be cancelled while it runs. A
  // beacon nobody is looking at must not be left posting: end it here, where
  // the UI that would have switched it off no longer exists.
  if (!state.sosActive) {
    started.end().catch(() => {});
    return;
  }
  beacon = started;
  // One viewer by default, so an SOS still produces a link to hand somebody
  // without any further tapping. Every extra person gets their own link, their
  // own channel, and their own revoke.
  try {
    sosViewer = await started.addViewer({ label: "Help link", ttlMs: BEACON_TTL_MS });
    beaconLinks.set(sosViewer.id, sosViewer.link);
  } catch {
    sosViewer = null;
  }
  await pushBeacon();
  render();
}

// A beacon link that outlives the relay's retention is a link to nothing, and
// an emergency is not a subscription. Six hours, and the viewer page says when
// it expires.
const BEACON_TTL_MS = 6 * 60 * 60 * 1000;

// Per-viewer control, for stage 2 to draw: one link each, revocable one at a
// time, and the rest never notice.
async function addBeaconViewer(label) {
  if (!beacon) return null;
  const viewer = await beacon.addViewer({ label, ttlMs: BEACON_TTL_MS });
  beaconLinks.set(viewer.id, viewer.link);
  if (!sosViewer) sosViewer = viewer;
  await pushBeacon();
  render();
  return viewer;
}

async function revokeBeaconViewer(id) {
  if (!beacon) return false;
  await beacon.revokeViewer(id);
  // The link goes with the channel it named: a revoked viewer's link shows the
  // session ended, and there is no reason to keep it around to be copied.
  beaconLinks.delete(id);
  if (sosViewer?.id === id) sosViewer = null;
  render();
  return true;
}

const beaconViewers = () =>
  beacon ? beacon.list().map((v) => ({ ...v, link: beaconLinks.get(v.id) || "" })) : [];

async function pushBeacon() {
  if (!beacon || !state.me) return;
  const { lat, lon } = state.me;
  try {
    await beacon.send({
      t: "sos",
      name: state.profile?.name || "Someone",
      emoji: state.profile?.emoji || "\u{1F6A8}",
      hue: myHue(),
      lat,
      lon,
      ...(Number.isFinite(state.me.acc) ? { acc: state.me.acc } : {}),
    });
  } catch {
    // the viewer shows the trail going stale rather than a lie
  }
}

async function endBeacon() {
  if (!beacon) return;
  const b = beacon;
  beacon = null;
  sosViewer = null;
  beaconLinks.clear();
  await b.end();
  render();
}

function openHelpLink() {
  if (!beacon) return;
  keepLive((done) =>
    ui.openHelpSheet({
      api,
      onAdd: addBeaconViewer,
      onRevoke: revokeBeaconViewer,
      onEnd: endBeacon,
      onClose: done,
    }),
  );
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
  if (state.gen) {
    poller?.start();
    showMap();
  } else {
    showScreen("onboarding");
  }
  render();
}

// -------------------------------------------------------------- wake lock

async function ensureWakeLock() {
  // A running foreground session already owns a screen lock and re-acquires it
  // on every resume; two requests for the same thing is one of them leaking.
  const want =
    state.settings.wakeLock &&
    !foreground &&
    state.screen === "map" &&
    document.visibilityState === "visible";
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

// ------------------------------------------------------------------- api
//
// The surface the screens are drawn against. Everything here is safe to call
// from a sheet: each one takes the circle guard where it needs to, and each
// returns something honest about whether the thing happened. Extra fields on
// the sheet arguments below carry it in; the debug handle is for the automated
// checks.
const api = {
  state,
  members,
  // invitations
  createInvite,
  burnInvite,
  inviteLink,
  invite: () => state.invite,
  joinRequests: () => state.joinRequests,
  acceptJoin,
  rejectJoin,
  joining: () => state.joining,
  cancelJoin,
  // membership
  pinnedList: () => [...state.pinned.values()],
  keyChanges: () => [...state.keyChanges.entries()].map(([memberId, c]) => ({ memberId, ...c })),
  acceptKeyChange,
  markVerified,
  safetyNumberFor,
  rekeyCircle,
  removeMember,
  rosterMismatch: () => state.rosterMismatch,
  missedRekey: () => state.missedRekey,
  // settings and status
  setSetting: onSettingChange,
  historyChoices: HISTORY_CHOICES,
  clockError: () => state.clockError,
  foreground: () => state.foreground,
  retired: () => state.retired,
  // beacon
  beaconViewers,
  addBeaconViewer,
  revokeBeaconViewer,
};
if (debugHooks()) window.__starlingApi = api;

// The internals the automated checks drive directly, because the alternative
// is a check that exercises a copy of the rule instead of the rule. The last
// round of defects shipped exactly that way: a member cap verified against a
// bare Map while the app passed a duck-typed store with no size on it. Nothing
// here is a new exposure, since __starlingApi already hands out the live state
// object, and script running in this page is inside the circle already.
if (debugHooks()) window.__starlingInternals = {
  state,
  pinnedStore,
  addPinned,
  acceptKeyChange,
  onKeyChange,
  adoptRekey,
  enterCircle,
  onControl,
  unlockWith,
  syncRatchet,
  persistRatchet,
  startJoinWatch,
  alertItems,
  lockNow,
  switchCircle,
  writeChainKey,
  joinWithInvite,
  boot,
  DESTROYED_KEY,
};

// ----------------------------------------------------------------- boot

window.addEventListener("online", () => {
  state.offline = false;
  syncRatchet().catch(() => {});
  poller?.pollNow();
  render();
});

// Coming back to the app is exactly when expired keys have to go: a phone that
// has been off for a week is holding a week of chain keys until something walks
// them forward, and nothing else does.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || state.locked) return;
  syncRatchet().catch(() => {});
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
  // The install nudge only becomes offerable when Chromium fires its event,
  // which lands after boot; platform.js captures it, this repaints for it.
  window.addEventListener("beforeinstallprompt", () => setTimeout(render, 0));
  if (shareCapable()) {
    byTestid("onboarding-create").addEventListener("click", promptCreate);
    byTestid("onboarding-join").addEventListener("click", promptPasteInvite);
    byTestid("join-cancel").addEventListener("click", cancelJoin);
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

  // A last-circle leave that a crash cut short left its journal behind. Finish
  // the purge before a single slot is read: the leftovers are a generation
  // record and a roster for a circle the user has already been told is gone,
  // and read first they look enough like a circle to be entered.
  await finishPendingLeave(kv);

  // Persistence is optional. If the store cannot be read, boot with defaults
  // to onboarding instead of a dead page.
  let secret = null;
  let identity = null;
  let lock = null;
  let storedCircles = null;
  // Why this device is empty, when it is empty. Read on BOTH paths: the locked
  // one used it to keep a lock record alive, and the unlocked one, which is
  // what the app ships with, did not read it at all.
  let destroyed = false;
  try {
    const [sec, id, profile, settings, circleName, lk, relay, circs, noInstall, mark] = await Promise.all([
      dbGet("secret"),
      dbGet("identity"),
      dbGet("profile"),
      dbGet("settings"),
      dbGet("circleName"),
      dbGet("lock"),
      dbGet("relay"),
      dbGet("circles"),
      dbGet("installDismissed"),
      dbGet(DESTROYED_KEY),
    ]);
    secret = sec;
    identity = id;
    lock = lk;
    destroyed = !!mark;
    storedCircles = Array.isArray(circs) ? circs : null;
    if (profile) state.profile = profile;
    if (settings) state.settings = { ...state.settings, ...settings };
    if (circleName) state.circleName = circleName;
    if (typeof relay === "string") state.relay = relay;
    state.installDismissed = !!noInstall;
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
      // What this launch is looking at, on the evidence of the slots, the lock
      // record and the mark. The reads and the purges are here; which of the
      // seven shapes this is belongs to bootVerdict.
      let sealedSecret = null;
      let sealedCircles = null;
      let sealedGen = null;
      let sealedStaged = null;
      if (lock?.enabled) {
        // A locked circle starts locked on every launch. Nothing is decrypted
        // until the passcode or a biometric recovers the vault key. Plaintext
        // slots a crash mid-lock-enable left behind are purged ONLY when
        // their sealed twin actually exists: before that point the plaintext
        // is the only copy there is.
        [sealedSecret, sealedCircles, sealedGen, sealedStaged] = await Promise.all([
          dbGet("vaultSecret"),
          dbGet("vaultCircles"),
          dbGet(GEN_SLOT.sealed),
          dbGet(STAGED_SLOT.sealed),
        ]);
        if (sealedSecret) await dbDel("secret");
        if (sealedCircles) await dbDel("circles");
        if (sealedGen) await dbDel(GEN_SLOT.plain);
        if (sealedStaged) await dbDel(STAGED_SLOT.plain);
        if (await dbGet(PINNED_SLOT.sealed)) await dbDel(PINNED_SLOT.plain);
        if (await dbGet(INVITE_SLOT.sealed)) await dbDel(INVITE_SLOT.plain);
      } else {
        // No lock record means any sealed copies are strays from an
        // interrupted lock transition; the plaintext is authoritative.
        for (const k of SEALED_KEYS) await dbDel(k);
      }
      const found = bootVerdict({
        lockEnabled: !!lock?.enabled,
        sealedSecret,
        sealedGen,
        sealedStaged,
        sealedCircles,
        secret,
        identity,
        circles: storedCircles,
        destroyed,
      });
      if (found.kind === "stale-lock") {
        // Nothing to protect in either form: a crash mid last-circle leave
        // left a stale lock record. Clear it rather than present a lock no
        // passcode can satisfy.
        await dbDel("lock");
        showScreen("onboarding");
      } else if (found.kind === "v1") {
        // v1 wrote a circle root and no generation record. It is not a chain
        // key, it names no channel a v2 relay serves, and a v1 client could
        // not talk to that relay anyway.
        showV1Notice();
      } else if (found.kind === "locked") {
        state.lock = lock;
        state.locked = true;
        ensureLockUI();
        paintLockScreen();
        showScreen("lock");
      } else if (found.kind === "active") {
        const slots = await readActiveSlots(null, secret);
        if (slotsVerdict({ identity, meta: slots.meta }).kind === "v1") {
          showV1Notice();
        } else {
          adoptActive(slots);
          if (storedCircles?.length) {
            // A torn writeActive can pair this chain key with another circle's
            // identity or another circle's generation; the array still holds
            // the properly paired record, so adopt it before anything
            // announces the wrong pseudonym or posts under a key that channel
            // cannot read.
            const paired = adoptPairedCircle({
              activeSecret: slots.ck,
              activeMemberId: state.identity.memberId,
              activeGen: state.gen,
              circles: storedCircles,
            });
            if (paired) {
              applyActive(paired);
              await dbSet("identity", paired.identity);
              await dbSet("circleName", paired.name);
              if (paired.profile) await dbSet("profile", paired.profile);
              await writeGenAtRest();
            }
            // A crash mid-switch can leave the active circle duplicated in the
            // inactive array; reconcile drops the copy.
            state.circles = reconcileCircles({
              activeSecret: state.gen.ratchet.snapshot().ck0,
              activeMemberId: state.identity.memberId,
              circles: storedCircles,
            });
            if (state.circles.length !== storedCircles.length) await persistCirclesAtRest();
          }
          await enterCircle();
        }
      } else if (found.kind === "promote") {
        // A crash mid-leave can clear the active slots with circles still
        // waiting; promote the first instead of pretending this is a fresh
        // install.
        if (slotsVerdict({ identity: storedCircles[0], meta: readGenMeta(storedCircles[0]) }).kind === "v1") {
          showV1Notice();
        } else {
          const res = await leaveActive(kv, lockCtx(), { circles: storedCircles, toIndex: 0 });
          state.circles = res.circles;
          applyActive(res.active);
          await enterCircle();
        }
      } else {
        // No circle in any slot. A staged generation from a create that never
        // reached its chain-key write belongs to nothing, and it is key
        // material, so it does not get to sit here.
        await writeRecordAtRest(kv, null, STAGED_SLOT, null);
        // An empty device with a reason. The mark is left where it is: nothing
        // has taken the slots yet, so this is still the true thing to say, and
        // spending it on a screen rather than on a circle is what turned the
        // next launch into an abandoned install twice running.
        if (found.kind === "destroyed") showDestroyedNotice();
        else showScreen("onboarding");
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

  render();

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
