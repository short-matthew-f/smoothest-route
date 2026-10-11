// App-shell service worker. Relative paths: app is served from a GitHub Pages subpath.
const CACHE = 'smoothest-route-v2';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './src/app.js',
  './src/metric.js',
  './src/here.js',
  './src/storage.js',
  './src/maps.js',
  './src/defaults.js',
  './src/ui.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Add individually so one missing file does not abort installation.
      .then((cache) => Promise.all(SHELL.map((u) => cache.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // HERE API: network only, never cached. Not intercepted at all.
  if (url.hostname === 'router.hereapi.com' || url.hostname.endsWith('.hereapi.com')) return;

  // Same-origin only.
  if (url.origin !== self.location.origin) return;

  // Network-first (cache fallback) for the HTML shell and JS so a deploy is picked up on next load.
  const path = url.pathname;
  const networkFirst = req.mode === 'navigate' || path.endsWith('/') || path.endsWith('/index.html') ||
    (/\/src\/[^/]+\.js$/.test(path));
  if (networkFirst) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const key = req.mode === 'navigate' || path.endsWith('/') ? './index.html' : req;
        try {
          const res = await fetch(req);
          if (res && res.ok && res.type === 'basic') cache.put(key, res.clone()).catch(() => {});
          return res;
        } catch (e) {
          const cached = await cache.match(key, { ignoreSearch: true });
          if (cached) return cached;
          if (req.mode === 'navigate') {
            const shell = await cache.match('./');
            if (shell) return shell;
          }
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        }
      })
    );
    return;
  }

  // Everything else (icons, css, manifest, fixtures): cache-first with background revalidate.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const key = req.mode === 'navigate' ? './index.html' : req;
      const cached = await cache.match(key, { ignoreSearch: true });
      const refresh = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') cache.put(key, res.clone()).catch(() => {});
          return res;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil(refresh);
        return cached;
      }
      const res = await refresh;
      if (res) return res;
      if (req.mode === 'navigate') {
        const shell = await cache.match('./');
        if (shell) return shell;
      }
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    })
  );
});
