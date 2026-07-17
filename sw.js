const CACHE_PREFIX = "utalog-";
const CACHE = "utalog-v13";
const ASSETS = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/vendor/qrcode.min.js",
  "./js/db.js",
  "./js/itunes.js",
  "./js/data.js",
  "./js/app.js",
  "./manifest.json",
  "./icons/icon-180.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
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
  const isNavigation = e.request.mode === "navigate";
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(e.request);
        if (cached) return cached;
        if (isNavigation) return caches.match("./index.html");
        return Response.error();
      })
  );
});
