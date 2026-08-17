// ============================================
// Cykel PWA — Service Worker
// Caches everything on install, serves offline forever.
// Zero network calls after first load — enforced here as defense-in-depth.
// ============================================

const CACHE_NAME = 'cykel-v33';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './crypto.js',
  './storage.js',
  './prediction.js',
  './panda-kb.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

// Install: cache all assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

// Fetch: serve ONLY precached, same-origin GET requests. Fail closed otherwise.
//
// The app is designed to make zero network calls after install, so we never
// relay a request to the network. This means:
//   - a same-origin asset that isn't precached returns a 504 instead of being
//     fetched (no chance to pull unaudited/poisoned code), and
//   - any cross-origin or non-GET request (e.g. an injected exfiltration
//     attempt) is blocked outright rather than proxied through the SW.
// This complements the page CSP (connect-src 'self') as a second layer.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET' || url.origin !== self.location.origin) {
    event.respondWith(Response.error());
    return;
  }

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      // Offline SPA fallback: any in-app navigation resolves to the app shell.
      if (req.mode === 'navigate') {
        return caches.match('./index.html').then((shell) => shell || Response.error());
      }
      // Browsers probe /favicon.ico even though we declare PNG icons — serve one.
      if (url.pathname.endsWith('/favicon.ico')) {
        return caches.match('./icon-192.png').then((icon) => icon || new Response('', { status: 404 }));
      }
      // Unknown same-origin asset — do not hit the network.
      return new Response('', { status: 504, statusText: 'Offline — not cached' });
    })
  );
});
