// Tenner service worker — Phase 1: install + basic offline shell.
// Push notifications will be added in Phase 2.
//
// Cache strategy:
//   - Static shell (index, icons, logo) → cache-first with background refresh
//   - Everything else (API, dynamic assets) → network-first, no cache
// Bump CACHE_VERSION whenever the shell files change so old caches get cleared.

const CACHE_VERSION = 'tenner-v29';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/logo-horizontal.png',
  '/icon-app.png',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle GET requests — POST/PUT/DELETE etc. always go straight to the network.
  if (req.method !== 'GET') return;

  // Skip caching for Supabase API + other cross-origin requests — those should
  // always hit the network so users see fresh data.
  if (url.origin !== self.location.origin) return;

  // HTML pages (index.html / navigation requests) → network-first so users
  // always see the latest code when online. Falls back to cache when offline.
  // Everything else (images, css, fonts) → cache-first with background refresh.
  const isHTML = req.mode === 'navigate' ||
                 (req.headers.get('accept') || '').includes('text/html') ||
                 url.pathname === '/' || url.pathname.endsWith('.html');
  if (isHTML) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});

// Placeholder — will be wired in Phase 2 (push notifications).
self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'Tenner', {
      body: data.body || '',
      icon: '/icon-app.png',
      badge: '/icon-app.png',
      data: { url: data.url || '/' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      // If there's already a Tenner tab open, focus it. Otherwise open a new one.
      for (const client of wins) {
        if (client.url.includes(self.location.origin)) return client.focus();
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
