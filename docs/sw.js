// Tombstone service worker for the documentation site root (/<repo>/sw.js).
//
// Before v0.2.0 the control app was served at the Pages root and registered a
// service worker here with scope "/<repo>/". The app then moved under "/app/",
// but that legacy worker stays registered in returning visitors' browsers and
// keeps serving the cached *app shell* (including its "serial + storage"
// capability gate) over the new docs site.
//
// This file replaces that worker with one that simply removes itself: on the
// browser's next update check it installs, unregisters, and reloads any open
// tab so the real documentation is served from the network. It deliberately
// does NOT clear CacheStorage — caches are origin-scoped (shared across all of
// the owner's github.io projects), and orphaned caches are harmless once no
// worker controls this scope.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        client.navigate(client.url);
      }
    })(),
  );
});
