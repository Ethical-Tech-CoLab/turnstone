/**
 * sw.js — offline support.
 *
 * ---------------------------------------------------------------------------
 * Field sites lack connectivity. A capture client that needs the network to
 * start is a capture client that does not work where it is most needed — a
 * basement store room, a site with no signal, a phone in airplane mode to save
 * battery. So the whole client is cached on first visit and served from cache
 * thereafter.
 *
 * CACHE-FIRST FOR THE APP SHELL, and the cache name carries the build id, so a
 * deploy produces a new cache rather than a stale one that must expire. The
 * previous caches are deleted on activate. Plumb lost a round of field testing
 * to a stale asset; a service worker makes that failure permanent rather than
 * ten minutes long, so the versioning has to be right.
 * ---------------------------------------------------------------------------
 */

const BUILD = '__TURNSTONE_BUILD__';
const CACHE = `turnstone-${BUILD}`;

const SHELL = [
  './',
  './index.html',
  './capture.html',
  './demo.js',
  './capture.js',
  './manifest.webmanifest',
  './css/demo.css',
  './css/capture.css',
  './rubric/heritage-v1.json',
  './lib/rubric.js',
  './lib/metrics.js',
  './lib/overlap.js',
  './lib/guidance.js',
  './lib/session.js',
  './lib/frame.js',
  './lib/camera.js',
  './lib/store.js',
  './lib/steady.js',
  './lib/synthetic.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Individually, so one 404 cannot fail the whole install and leave the
    // client with no offline support at all.
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => null)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith((async () => {
    // Ignore the cache-busting query when matching: the deploy stamps every
    // asset URL, and the cache was populated with the unstamped shell paths.
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;

    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (err) {
      // Offline and not cached. An HTML navigation should still land on the
      // client rather than a browser error page.
      if (req.mode === 'navigate') {
        const shell = await cache.match('./capture.html', { ignoreSearch: true });
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
