// Mac Course Archive service worker.
//
// Network-first for EVERYTHING (app shell and data alike): always try the
// network first so a normal reload (F5/Ctrl-R) shows the latest deployed
// version and the latest scraped data, falling back to the cache only when
// the network request fails (i.e. offline). This is intentionally NOT
// cache-first - for a course archive where seat counts change during
// registration, "instant load" is not worth the risk of silently showing
// stale seat counts or an old app version after a reload.
const CACHE_NAME = "mac-course-archive-v2"; // bump this whenever the caching strategy changes
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
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
