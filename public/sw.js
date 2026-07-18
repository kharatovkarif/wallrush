// WallRush service worker: caches the app shell so the game opens instantly
// and the AI mode keeps working offline. Pages go network-first (fresh
// deploys land right away), versioned assets go cache-first.
const V = '34';
const CACHE = 'wr-' + V;
const SHELL = [
  '/',
  `/css/style.css?v=${V}`,
  `/js/app.js?v=${V}`,
  `/js/engine.js?v=${V}`,
  `/js/ai.js?v=${V}`,
  `/js/i18n.js?v=${V}`,
  `/js/ai-worker.js?v=${V}`,
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
