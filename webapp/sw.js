// Mac Course Archive service worker.
// - App shell (HTML/CSS/JS/manifest/icon): cache-first, so the app loads
//   instantly and works offline after the first visit.
// - data/*.json: network-first with a cache fallback, so online users
//   always get the latest scrape, but offline users still see the last
//   data that was successfully loaded.
const CACHE_NAME = "mac-course-archive-v1";
const APP_SHELL = ["./", "index.html", "app.js", "style.css", "manifest.json", "icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return; // don't intercept cross-origin (e.g. Google Fonts)

  const isData = url.pathname.includes("/data/");

  if (isData) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
