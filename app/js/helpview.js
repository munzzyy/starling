// Beacon viewer: the page behind an emergency help link. Read-only by
// construction. It knows one beacon secret (from the URL fragment, which
// never reaches a server), derives that beacon's channel and key, polls the
// feed, decrypts, and draws. It holds no storage, registers nothing, and
// imports none of the circle machinery: a help link can show you one
// person's emergency trail and can never become circle access.

import { parseBeaconFragment, deriveHelpChannelId, deriveHelpEncKey } from "./crypto.js";
import { createRoster, createPoller, statusOf, STALE_MS } from "./net.js";
import { createMapView } from "./map.js";
import { fmtRelTime } from "./fmt.js";

const $ = (s) => document.querySelector(s);

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

async function boot() {
  const secret = parseBeaconFragment(location.hash);
  if (!secret) {
    showPanel(
      "Not a valid help link",
      "This page only works when opened from a complete Starling help link. Ask the person who sent it to share the link again.",
    );
    return;
  }

  const channelId = await deriveHelpChannelId(secret);
  const encKey = await deriveHelpEncKey(secret);

  const mapView = createMapView($("#hv-map"));
  mapView.setBasemap(matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");

  const roster = createRoster({ channelId, encKey, selfId: null });
  let focusedOnce = false;
  let follow = true;

  function render() {
    const now = Date.now();
    const recs = roster.list();
    if (!recs.length) return;
    // A beacon has one sender; if junk ever lands, the freshest record wins.
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
    roster,
    onChange: render,
    onStatus: (s) => {
      $("#hv-net").hidden = s !== "reconnecting";
    },
  });
  poller.start();

  // Re-render every 15 s so "last update" and staleness move without traffic.
  setInterval(render, 15000);
}

boot();
