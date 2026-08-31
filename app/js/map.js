// Leaflet wrapper. Leaflet is loaded as a classic script; this module only
// ever touches globalThis.L. All marker DOM is built with createElement and
// textContent, never markup strings: member names are not trusted.

// One tile source: OpenStreetMap. Dark mode is a CSS filter on the tile pane
// only, so data colors (markers, trails, rings) stay untouched.
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

const ATTRIB = '<a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const RING_RADII = [250, 500, 1000, 2000];
const MOVE_MS = 400;
const easeOut = (t) => 1 - (1 - t) ** 3;

export function createMapView(container, { onMarkerTap } = {}) {
  const L = globalThis.L;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");

  const map = L.map(container, {
    zoomControl: false,
    attributionControl: false,
    minZoom: 3,
    maxZoom: 19,
    worldCopyJump: true,
  });
  const attribution = L.control.attribution({ position: "bottomleft", prefix: false });
  attribution.addTo(map);
  map.setView([20, 0], 3);

  let tiles = null;
  let rings = [];
  let ringCenter = null;
  let basemap = "dark";

  const markers = new Map(); // id -> {marker, parts, cur, from, to, t0}
  const trails = new Map(); // id -> [polylines]
  let ticking = false;

  function drawRings() {
    for (const r of rings) r.remove();
    rings = [];
    if (basemap !== "none" || !ringCenter) return;
    for (const radius of RING_RADII) {
      rings.push(
        L.circle(ringCenter, {
          radius,
          className: "offgrid-ring",
          fill: false,
          weight: 1,
          interactive: false,
        }).addTo(map),
      );
    }
  }

  function setBasemap(kind) {
    basemap = kind;
    if (tiles) {
      tiles.remove();
      tiles = null;
    }
    container.classList.toggle("offgrid", kind === "none");
    container.classList.toggle("tiles-dark", kind === "dark");
    if (kind === "dark" || kind === "light") {
      tiles = L.tileLayer(TILE_URL, {
        maxZoom: 19,
        attribution: ATTRIB,
        // The app itself is no-referrer everywhere. OSM's tile policy requires
        // a Referer, so tile images alone send the bare origin, nothing more.
        referrerPolicy: "origin",
      }).addTo(map);
    }
    drawRings();
  }

  function setRingCenter(lat, lon) {
    if (ringCenter && map.distance(ringCenter, [lat, lon]) < 25) return;
    ringCenter = [lat, lon];
    drawRings();
  }

  function buildMarkerEl() {
    const root = document.createElement("div");
    root.className = "mk";
    const halo = document.createElement("div");
    halo.className = "mk-halo";
    const ava = document.createElement("div");
    ava.className = "mk-ava";
    const emoji = document.createElement("span");
    ava.appendChild(emoji);
    const name = document.createElement("div");
    name.className = "mk-name";
    root.append(halo, ava, name);
    return { root, emoji, name };
  }

  function tick(now) {
    let active = false;
    for (const m of markers.values()) {
      if (!m.to) continue;
      const t = Math.min(1, (now - m.t0) / MOVE_MS);
      const k = easeOut(t);
      const lat = m.from[0] + (m.to[0] - m.from[0]) * k;
      const lon = m.from[1] + (m.to[1] - m.from[1]) * k;
      m.cur = [lat, lon];
      m.marker.setLatLng(m.cur);
      if (t >= 1) m.to = null;
      else active = true;
    }
    if (active) requestAnimationFrame(tick);
    else ticking = false;
  }

  function moveMarker(m, lat, lon) {
    const dest = [lat, lon];
    if (reduced.matches || !m.cur || map.distance(m.cur, dest) < 0.5) {
      m.cur = dest;
      m.to = null;
      m.marker.setLatLng(dest);
      return;
    }
    m.from = m.cur;
    m.to = dest;
    m.t0 = performance.now();
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(tick);
    }
  }

  // data: {lat, lon, name, emoji, hue, status, self, sharing}
  function upsert(id, data) {
    let m = markers.get(id);
    if (!m) {
      const parts = buildMarkerEl();
      const icon = L.divIcon({ className: "mk-wrap", html: parts.root, iconSize: [0, 0] });
      const marker = L.marker([data.lat, data.lon], { icon, keyboard: false });
      marker.on("click", () => onMarkerTap?.(id));
      marker.addTo(map);
      m = { marker, parts, cur: [data.lat, data.lon], to: null };
      markers.set(id, m);
    }
    const { root, emoji, name } = m.parts;
    emoji.textContent = data.emoji || "";
    name.textContent = data.name || "";
    root.style.setProperty("--m-hue", String(data.hue ?? 0));
    root.classList.toggle("mk-self", !!data.self);
    root.classList.toggle("mk-sharing", !!data.self && !!data.sharing);
    root.classList.toggle("mk-sos", data.status === "sos");
    root.classList.toggle("mk-stale", data.status === "stale" || data.status === "stopped");
    m.marker.setZIndexOffset(data.status === "sos" ? 900 : data.self ? 500 : 0);
    moveMarker(m, data.lat, data.lon);
    if (data.self) setRingCenter(data.lat, data.lon);
  }

  function removeMarker(id) {
    const m = markers.get(id);
    if (!m) return;
    m.marker.remove();
    markers.delete(id);
    clearTrail(id);
  }

  function clearTrail(id) {
    for (const line of trails.get(id) || []) line.remove();
    trails.delete(id);
  }

  // Fading trail: three opacity tiers, oldest faintest.
  function setTrail(id, points, hue) {
    clearTrail(id);
    if (!points || points.length < 2) return;
    const color = `hsl(${hue ?? 0} 70% 55%)`;
    const third = Math.max(2, Math.ceil(points.length / 3));
    const tiers = [
      { pts: points.slice(0, third + 1), op: 0.14 },
      { pts: points.slice(third, third * 2 + 1), op: 0.28 },
      { pts: points.slice(third * 2), op: 0.5 },
    ];
    const lines = [];
    for (const tier of tiers) {
      if (tier.pts.length < 2) continue;
      lines.push(
        L.polyline(
          tier.pts.map((p) => [p.lat, p.lon]),
          { color, weight: 3, opacity: tier.op, interactive: false, lineJoin: "round" },
        ).addTo(map),
      );
    }
    trails.set(id, lines);
  }

  // Fly so the target sits above the bottom sheet, not centered under it.
  function focusOn(lat, lon, zoom = 16, yOffset = 110) {
    const z = Math.max(map.getZoom(), zoom);
    const p = map.project([lat, lon], z);
    p.y += yOffset;
    const c = map.unproject(p, z);
    map.flyTo(c, z, { duration: reduced.matches ? 0 : 0.7 });
  }

  function fitAll(positions) {
    if (!positions.length) return;
    const bounds = L.latLngBounds(positions.map((p) => [p.lat, p.lon]));
    map.fitBounds(bounds, {
      paddingTopLeft: [48, 120],
      paddingBottomRight: [48, 280],
      maxZoom: 16,
      animate: false,
    });
  }

  return {
    map,
    setBasemap,
    upsert,
    removeMarker,
    markerIds: () => [...markers.keys()],
    setTrail,
    clearTrail,
    focusOn,
    fitAll,
    invalidate: () => map.invalidateSize(),
  };
}
