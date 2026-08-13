// Bump this value when you want clients to evict old cached assets and load a fresh build
const CACHE_NAME = 'frc-scout-v4';
// Use relative paths so the service worker works under a sub-path (e.g. GitHub Pages)
const urlsToCache = [
  './',
  './index.html',
  './manifest.json'
];

// Cache core files on install
self.addEventListener('install', event => {
  // Activate this service worker immediately once installed
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );
});

// Remove old caches and take control of uncontrolled clients
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    )).then(() => {
      return self.clients && self.clients.claim ? self.clients.claim() : undefined;
    })
  );
});

// Network-first: try the network, fall back to cache. This avoids serving
// stale/incorrect cached asset paths that don't match the deployed base path.
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Optionally update the cache for navigation requests
        try {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
        } catch (e) {
          // ignore cache update errors
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Listen for messages from the client (e.g. to skipWaiting and activate immediately)
self.addEventListener('message', (event) => {
  try {
    const data = event.data || {};
    if (data && data.type === 'SKIP_WAITING') {
      self.skipWaiting();
    }
  } catch (e) {
    // ignore
  }
});