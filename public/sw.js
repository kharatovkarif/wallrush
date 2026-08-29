// WallRush service worker: caches the app shell so the game opens instantly
// and the AI mode keeps working offline. Pages go network-first (fresh
// deploys land right away), versioned assets go cache-first.
const V = '136';
const CACHE = 'wr-' + V;
const SHELL = [
  '/',
  `/css/style.css?v=${V}`,
  `/js/app.js?v=${V}`,
  `/js/engine.js?v=${V}`,
  `/js/ai.js?v=${V}`,
  `/js/i18n.js?v=${V}`,
  `/js/ranks.js?v=${V}`,
  `/js/streak.js?v=${V}`,
  `/js/nick.js?v=${V}`,
  `/js/portal.js?v=${V}`,
  `/js/ai-worker.js?v=${V}`,
  // Persian, Turkish, French and Spanish load on demand, so with no signal
  // they fell back to English — the app changed language the moment the train
  // went into a tunnel. A few kilobytes each; cache them with the rest.
  `/js/lang/fa.js?v=${V}`,
  `/js/lang/tr.js?v=${V}`,
  `/js/lang/fr.js?v=${V}`,
  `/js/lang/es.js?v=${V}`,
  `/vendor/supabase.js?v=${V}`,
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws') || url.pathname.startsWith('/admin')) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put('/', copy));
        return r;
      }).catch(() => caches.match('/'))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((r) => {
      if (r.ok) {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return r;
    }))
  );
});

/* ---------- push ---------- */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { /* malformed payload */ }
  e.waitUntil(self.registration.showNotification(d.title || 'WallRush', {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: 'wr-daily',              // a second one replaces the first, never stacks
    data: { url: d.url || '/' },
  }));
});

// Tapping it should land the player in a game, not on a home screen they then
// have to navigate. An already-open tab is focused rather than duplicated.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes(location.origin)) return c.focus().then(() => c.navigate(url)).catch(() => c.focus());
      }
      return self.clients.openWindow(url);
    })
  );
});
