/**
 * Service worker for the QHT influencer app.
 *
 * Strategy is deliberately split:
 *   - the app shell (html/css/js/icons) is cached, so the app opens instantly
 *     and still opens with no signal;
 *   - the API and proof photos are NEVER cached — compliance data going stale
 *     would be worse than showing nothing, and a cached photo could be mistaken
 *     for today's proof.
 */
/* Stamped by scripts/stamp-sw.mjs on every deploy. The browser only installs a
   new service worker when this file's bytes change, and the cache is named
   after this value — so a deploy invalidates the old shell instead of leaving
   yesterday's JavaScript to be served one more time. */
const VERSION = '20260914091138';
const SHELL = `shell-${VERSION}`;

const SHELL_FILES = [
  '/',
  '/index.html',
  '/influencer.html',
  '/dashboard.html',
  '/agreement.html',
  '/set-password.html',
  '/offline.html',
  '/css/app.css',
  '/css/login.css',
  '/js/api.js',
  '/js/influencer.js',
  '/js/dashboard.js',
  '/js/uploader.js',
  '/js/mydetails.js',
  '/js/shrink.js',
  '/js/push.js',
  '/js/push-flag.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/qht-mark.png',
  '/icons/qht-logo.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL)
      // one bad URL must not fail the whole install
      .then(c => Promise.allSettled(SHELL_FILES.map(f => c.add(f))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // live data and private photos always go to the network
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) return;

  // the APK download: a few MB, and a cached copy would hand out an old version
  if (url.pathname.startsWith('/downloads/')) return;

  // navigations: network first, fall back to the cached page, then the offline note
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(res => {
          const copy = res.clone();
          caches.open(SHELL).then(c => c.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request).then(hit => hit || caches.match('/offline.html')))
    );
    return;
  }

  /* Code: the network first, the cache only if there is no signal.
     Serving these from the cache first meant every deploy was invisible until
     the app was opened a second time — the first open ran yesterday's code and
     quietly fetched the new copy for next time. For a fix to a camera or a
     compliance rule, "next time" is not good enough. They are a few KB. */
  if (/\.(?:js|css)$/.test(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then(c => c.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  /* Everything else — icons, the logo, fonts — is content that only changes
     with a new filename, so the cache can answer straight away. */
  event.respondWith(
    caches.match(request).then(hit => {
      const net = fetch(request).then(res => {
        if (res.ok) caches.open(SHELL).then(c => c.put(request, res.clone()));
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

// lets the page trigger an immediate update after a deploy
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });
