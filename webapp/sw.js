// This service worker has been retired.
//
// Offline/installable support kept causing real staleness problems for a
// project where showing CURRENT data - especially seat counts during
// registration - matters far more than instant load or offline browsing.
// Even after switching to a network-first strategy, some visitors still
// needed a private window to see updates, which isn't an acceptable
// trade-off here. Rather than keep chasing service-worker update-timing
// edge cases, this script's only job now is to clean up any previously
// installed version of itself so existing visitors self-heal automatically
// - no manual cache-clearing required.
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.registration.unregister();
      const clientsList = await self.clients.matchAll({ type: "window" });
      // Force any already-open tabs to reload once the old SW is gone, so
      // they immediately get real network requests instead of whatever
      // that tab's in-memory JS was still doing.
      clientsList.forEach((client) => client.navigate(client.url));
    })()
  );
});
