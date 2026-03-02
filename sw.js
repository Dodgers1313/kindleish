const CACHE_NAME = 'kindleish-v6';
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
  // Use stale-while-revalidate for app shell files
  // This serves cached content immediately but updates the cache in the background
  event.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(event.request).then(cached => {
        const fetchPromise = fetch(event.request).then(response => {
          if (response.ok) {
            // Update cache with fresh copy
            if (event.request.url.startsWith(self.location.origin) ||
                event.request.url.includes('unpkg.com') ||
                event.request.url.includes('fonts.googleapis.com') ||
                event.request.url.includes('fonts.gstatic.com')) {
              cache.put(event.request, response.clone());
            }
          }
          return response;
        }).catch(() => {
          // Offline fallback
          if (event.request.mode === 'navigate') {
            return cache.match('/index.html');
          }
        });

        // Return cached version immediately, update in background
        return cached || fetchPromise;
      })
    )
  );
});
