const CACHE_NAME = 'kindleish-v16';
const APP_SHELL = [
  '/',
  '/index.html',
  '/reader.html',
  '/css/base.css',
  '/css/library.css',
  '/css/reader.css',
  '/js/app.js',
  '/js/reader.js',
  '/js/modules/storage.js',
  '/js/modules/pdf-extract.js',
  '/js/modules/paginator.js',
  '/js/modules/gestures.js',
  '/js/modules/themes.js',
  '/js/modules/typography.js',
  '/js/modules/bookmarks.js',
  '/js/modules/progress.js',
  '/js/modules/sync.js',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // Never cache API calls.
  if (url.pathname.startsWith('/api/')) return;

  // Network-first to avoid stale JS/UI logic getting stuck in cache.
  event.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      fetch(event.request).then(response => {
        if (response.ok) {
          if (event.request.url.startsWith(self.location.origin) ||
              event.request.url.includes('unpkg.com') ||
              event.request.url.includes('fonts.googleapis.com') ||
              event.request.url.includes('fonts.gstatic.com')) {
            cache.put(event.request, response.clone());
          }
        }
        return response;
      }).catch(async () => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          return cache.match('/index.html');
        }
        throw new Error('Network and cache miss');
      })
    )
  );
});
