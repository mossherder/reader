// Offline support with fast updates.
// App files: network first (revalidated, so a new deploy shows up on the next open), cached copy if offline/slow.
// pdf.js (big, rarely changes): cache first.
// Bump CACHE on every deploy: the page checks for a new sw.js when it comes back to the foreground
// and reloads itself once the new version takes over.
const CACHE = 'reader-v8';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs'];
const TIMEOUT = 2500; // ms to wait for the network before falling back to the cached copy

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache so we never store a stale copy
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(url.pathname.includes('/vendor/') ? cacheFirst(e.request) : networkFirst(e.request));
});

async function cacheFirst(req) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok) c.put(req, r.clone());
  return r;
}

async function networkFirst(req) {
  const c = await caches.open(CACHE);
  const net = fetch(req, { cache: 'no-cache' }).then((r) => {
    if (r.ok) c.put(req, r.clone());
    return r;
  });
  const timeout = new Promise((res) => setTimeout(res, TIMEOUT));
  const first = await Promise.race([net.catch(() => null), timeout]);
  if (first) return first;
  const hit = await c.match(req, { ignoreSearch: true });
  return hit || net;
}
