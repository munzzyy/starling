// Beacon viewer: the page behind an emergency help link. Read-only by
// construction. It knows one beacon secret (from the URL fragment, which
// never reaches a server), derives that beacon's channel and key, polls the
// feed, decrypts, and draws. It holds no storage, registers nothing, and
// imports none of the circle machinery: a help link can show you one
// person's emergency trail and can never become circle access.
//
// Read-only in the other direction too: the link names the one signing
// identity this page will believe, and points from anyone else are dropped
// before they reach the roster. See onlyFrom below.

import { parseBeaconFragment, deriveHelpChannelId, deriveHelpEncKey } from "./crypto.js";
import { createRoster, createPoller, statusOf, STALE_MS, epochAt } from "./net.js";
import { createMapView } from "./map.js";
import { fmtRelTime } from "./fmt.js";

const $ = (s) => document.querySelector(s);

// Same shape as beacon.js's ratchet stand-in, and for the same reason: a
// beacon is one generation for one emergency, so there is nothing here for a
// ratchet to buy. The epoch is still carried on every point (it is inside the
// AAD and the signature), it just never changes which key answers for it.
function fixedKeyRatchet(key) {
  return {
    keyFor: async () => key,
    currentEpoch: async (now) => epochAt(now),
    retainedEpochs: () => [],
  };
}

function isExpired(expiresAt, now = Date.now()) {
  return Number.isFinite(expiresAt) && now >= expiresAt;
}

// The whole of a viewer's trust in "this is the person who sent me the link".
//
// A beacon link is a shared secret: it names the channel and it derives the
// content key, so everyone it was ever forwarded to can produce ciphertext
// that opens cleanly on this page. Sender authenticity therefore rests on the
// signature alone, exactly as it does in a circle, and the id the link commits
// to is what says which signing key that must be. member ids commit to the
// signing key and the agreement key together, and the roster refuses any entry
// whose id does not hash out of the keys it presents, so pinning the id here
// pins the key.
//
// Trust on first use is not an option in an emergency. The attacker holding a
// forwarded link can post before the person in trouble does, and a first-sight
// pin would then believe a false position, or a "bye" that tells every helper
// the session ended while somebody is still in trouble. Filtering before
// ingest rather than after it means nothing the wrong sender wrote ever
// reaches the roster, the map, or the status line.
export function onlyFrom(roster, ownerId) {
  return {
    ingest: (entries, now) =>
      roster.ingest((entries || []).filter((e) => e && e.m === ownerId), now),
  };
}

const STATUS_LINE = {
  sos: "SOS active",
  live: "Sharing live",
  checkin: "Checked in",
  stale: "Signal lost",
  stopped: "Session ended",
};

function showPanel(title, body) {
  $("#hv-panel-title").textContent = title;
  $("#hv-panel-body").textContent = body;
  $("#hv-panel").hidden = false;
  $("#hv-banner").hidden = true;
}

// The secret arrives in the fragment, which no browser sends to a server, but
// it would otherwise sit in the address bar and in this browser's history,
// where it can outlive the emergency and sync to the helper's other devices.
// So it moves into sessionStorage, which belongs to this tab and dies with
// it, and the URL is rewritten without it. A reload still works; a new tab
// needs the original link, which is still in whatever message carried it.
const STASH = "starling-beacon";

function takeSecret() {
  const fromHash = parseBeaconFragment(location.hash);
  if (fromHash) {
    try {
      sessionStorage.setItem(STASH, location.hash.slice(3));
    } catch {
      // private mode or storage denied: the page still works for this view
    }
    history.replaceState(null, "", location.pathname + location.search);
    return fromHash;
  }
  try {
    const stashed = sessionStorage.getItem(STASH);
    return stashed ? parseBeaconFragment(`#b=${stashed}`) : null;
  } catch {
    return null;
  }
}

async function boot() {
  const parsed = takeSecret();
  if (!parsed) {
    showPanel(
      "Not a valid help link",
      "This page only works when opened from a complete Starling help link. Ask the person who sent it to share the link again.",
    );
    return;
  }
  const { secret, expiresAt, ownerId } = parsed;

  // A link opened after its own expiry never had anything on the map to
  // begin with, so this gets the same full-page treatment as a link that
  // does not parse rather than a live view that immediately flips to
  // expired.
  if (isExpired(expiresAt)) {
    showPanel(
      "This help link has expired",
      "This emergency link is no longer active. If the emergency is still going on, ask for a fresh link.",
    );
    return;
  }

  const channelId = await deriveHelpChannelId(secret);
  // Decrypt only. This page reads an emergency and never writes to it, and a
  // key that cannot encrypt is one fewer thing a bug on this page can be
  // turned into.
  const encKey = await deriveHelpEncKey(secret, ["decrypt"]);
  const ratchet = fixedKeyRatchet(encKey);

  const mapView = createMapView($("#hv-map"));
  mapView.setBasemap(matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");

  // A pinned map even though the link already names the only sender worth
  // hearing: it is what makes the roster surface a key change instead of
  // quietly accepting one, and it costs nothing to hand it a real Map.
  const roster = createRoster({ channelId, ratchet, selfId: null, pinned: new Map() });
  const bound = onlyFrom(roster, ownerId);
  let focusedOnce = false;
  let follow = true;
  let over = false;

  function render() {
    if (over) return;
    const now = Date.now();
    const recs = roster.list();
    if (!recs.length) return;
    // The roster only ever holds the one sender the link commits to, so this
    // is that member's record.
    const rec = recs.reduce((a, b) => (b.ts > a.ts ? b : a));
    const st = statusOf(rec, now);

    $("#hv-banner").hidden = false;
    $("#hv-waiting").hidden = true;
    $("#hv-name").textContent = `${rec.emoji || "\u{1F6A8}"} ${rec.name || "Someone"}`;
    $("#hv-status").textContent = STATUS_LINE[st] || "Sharing";
    $("#hv-status").dataset.state = st;
    $("#hv-ago").textContent = `Last update ${fmtRelTime(now - rec.ts)}`;

    if (Number.isFinite(rec.lat) && Number.isFinite(rec.lon)) {
      mapView.upsert(rec.id, rec);
      mapView.setTrail(rec.id, rec.trail || [], rec.hue);
      if (!focusedOnce || follow) {
        mapView.focusOn(rec.lat, rec.lon, focusedOnce ? undefined : 16);
        focusedOnce = true;
      }
    }
    if (st === "stopped") {
      $("#hv-ended").hidden = false;
      finish();
    }
  }

  // Panning by hand turns follow off; the recenter button turns it back on.
  mapView.map.on("dragstart", () => {
    follow = false;
    $("#hv-recenter").hidden = false;
  });
  $("#hv-recenter").addEventListener("click", () => {
    follow = true;
    $("#hv-recenter").hidden = true;
    render();
  });

  const poller = createPoller({
    channelId,
    roster: bound,
    onChange: render,
    onStatus: (s) => {
      $("#hv-net").hidden = s !== "reconnecting";
    },
  });
  poller.start();

  let expiryTimer = 0;
  let tickTimer = 0;

  // Shared by "bye" and expiry: past either one there is nothing left to
  // poll for, so the poller stops and both timers are cleared rather than
  // left to fire into a dead page.
  function finish() {
    if (over) return;
    over = true;
    poller.stop();
    clearTimeout(expiryTimer);
    clearInterval(tickTimer);
  }

  // Expiry is enforced, not just displayed: past expiresAt the page stops
  // polling and says so instead of leaving a stale position on screen
  // looking live. setTimeout fires it the moment it is due; the 15 s tick
  // below is the fallback for a tab that was backgrounded and had its timers
  // throttled.
  function expireNow() {
    if (over) return;
    finish();
    $("#hv-recenter").hidden = true;
    $("#hv-net").hidden = true;
    $("#hv-expired").hidden = false;
  }

  // setTimeout's delay is a 32 bit signed int under the hood; a ttlMs long
  // enough to overflow it fires immediately in most engines instead of never,
  // which would expire a long-lived link the instant it opens. Rescheduling
  // in MAX_TIMEOUT-sized hops avoids trusting a single delay bigger than that.
  const MAX_TIMEOUT = 0x7fffffff;
  function scheduleExpiry() {
    if (over) return;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      expireNow();
      return;
    }
    expiryTimer = setTimeout(scheduleExpiry, Math.min(remaining, MAX_TIMEOUT));
  }
  scheduleExpiry();

  // Re-render every 15 s so "last update" and staleness move without traffic,
  // and double-check the expiry each tick as the throttled-timer fallback.
  tickTimer = setInterval(() => {
    if (isExpired(expiresAt)) {
      expireNow();
      return;
    }
    render();
  }, 15000);
}

// Imported by tests as a module for onlyFrom, where there is no document to
// boot against and nothing to draw.
if (typeof document !== "undefined") boot();
