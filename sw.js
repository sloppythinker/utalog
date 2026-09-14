const CACHE_PREFIX = "utalog-";
const CACHE = "utalog-v18";
const ASSETS = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/vendor/qrcode.min.js",
  "./js/db.js",
  "./js/itunes.js",
  "./js/data.js",
  "./js/backup-worker.js",
  "./js/app.js",
  "./manifest.json",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // iTunes API等はキャッシュしない
  if (e.request.mode === "navigate") {
    e.respondWith(Promise.race([
      fetch(e.request),
      new Promise((_, reject) => setTimeout(() => reject(new Error("network timeout")), 3000)),
    ]).then(res => {
      if (res.ok) caches.open(CACHE).then(c => c.put("./index.html", res.clone())).catch(() => {});
      return res;
    }).catch(() => caches.match("./index.html")));
    return;
  }
  e.respondWith(caches.match(e.request).then(cached => {
    if (cached) {
      fetch(e.request).then(res => {
        if (res.ok) return caches.open(CACHE).then(c => c.put(e.request, res));
      }).catch(() => {});
      return cached;
    }
    return fetch(e.request).then(res => {
      if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone())).catch(() => {});
      return res;
    });
  }));
});
