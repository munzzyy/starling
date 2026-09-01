// Starling service worker. App shell only; location data never touches a cache.

const VERSION = "starling-v6";

const PRECACHE = [
  "/",
  "/index.html",
  "/css/tokens.css",
  "/css/app.css",
  "/js/main.js",
  "/js/env.js",
  "/js/ui.js",
  "/js/map.js",
  "/js/net.js",
  "/js/store.js",
  "/js/geo.js",
  "/js/fmt.js",
  "/js/demo.js",
  "/js/wire.js",
  "/js/crypto.js",
  "/js/qr.js",
  "/js/lock.js",
  "/vendor/leaflet/leaflet.js",
  "/vendor/leaflet/leaflet.css",
  "/icons/starling.svg",
  "/icons/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/manifest.webmanifest"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(VERSION);
        await cache.addAll(PRECACHE);
      } catch (err) {
        // A missing shell file fails this install; the previous cache stays whole.
        console.error("starling sw: precache failed, install aborted", err);
        throw err;
      }
    })()
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== VERSION).map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  if (req.method !== "GET") {
    return;
  }

  const url = new URL(req.url);

  // Live data is network only. Never cached, never answered from cache.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(req));
    return;
  }

  // Cross-origin (map tiles): the browser HTTP cache handles these.
  if (url.origin !== self.location.origin) {
    return;
  }

  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cached = await caches.match("/index.html");
        return cached || fetch(req);
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) {
        return cached;
      }
      const res = await fetch(req);
      if (res && res.ok && PRECACHE.includes(url.pathname)) {
        const cache = await caches.open(VERSION);
        cache.put(req, res.clone());
      }
      return res;
    })()
  );
});
