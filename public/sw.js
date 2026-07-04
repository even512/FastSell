// Service Worker: App offline-fähig, Updates trotzdem sofort sichtbar.
// Navigationen (App-Shell) laufen network-first – cache-first ließ nach einem Container-Update
// dauerhaft die alte UI auf dem Handy hängen. Statische Assets cache-first, API nie cachen.
const CACHE = "fastsell-v2";
const SHELL = ["/", "/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // API und Uploads nie cachen
  if (url.pathname.startsWith("/api/") || event.request.method !== "GET") return;

  // App-Shell/Navigation: network-first, Cache nur als Offline-Fallback.
  if (event.request.mode === "navigate" || url.pathname === "/") {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match(event.request).then((cached) => cached || caches.match("/")),
        ),
    );
    return;
  }

  // Statische Assets: cache-first mit Netz-Fallback + Nachcachen (Next-Assets sind gehasht).
  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
          return res;
        }),
    ),
  );
});
