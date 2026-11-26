/* Smot Tasks service worker: keeps the app shell available offline.
   Firestore traffic is NOT touched here; Firestore's own offline cache handles the data. */
const CACHE = 'smot-v2';   // bumped so every device drops the old cache and updates immediately
const CORE = ['./', './index.html', './manifest.json'];                     // must be cached for the worker to install
const EXTRA = ['./icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png'];
const CDN = [
  'https://cdn.tailwindcss.com/3.4.17',
  'https://cdnjs.cloudflare.com/ajax/libs/firebase/9.23.0/firebase-app-compat.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/firebase/9.23.0/firebase-firestore-compat.min.js',
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap'
];
const STATIC_HOSTS = ['cdnjs.cloudflare.com', 'cdn.tailwindcss.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const NAV_TIMEOUT = 4000;  // a connection that hangs (common on mobile "lie-fi") falls back to the cached page after 4 s
const OFFLINE_HTML = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Smot Tasks</title><body style="font-family:sans-serif;background:#14072b;color:#fff;padding:32px"><h2>Smot Tasks</h2><p>The app is not saved on this device yet. Open it once while online, then it will work offline.</p>';

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(CORE);                                                    // fails the install if the shell cannot be saved
    await Promise.allSettled([                                               // nice-to-haves, never block the install
      ...EXTRA.map(u => c.add(u)),
      ...CDN.map(async u => c.put(u, await fetch(u, { mode: 'no-cors' })))
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// A redirected response cannot be used to answer a navigation, so store a clean copy
async function clean(res) {
  if (!res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

// Every navigation (including ?source=pwa and any other query string) resolves to a real page, never the browser's offline screen
async function handleNavigate(e) {
  const cached = async () =>
    (await caches.match('./index.html', { ignoreSearch: true })) ||
    (await caches.match('./', { ignoreSearch: true })) ||
    new Response(OFFLINE_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  try {
    const res = await Promise.race([
      fetch(e.request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NAV_TIMEOUT))
    ]);
    if (res && res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
      e.waitUntil(clean(res.clone()).then(c => caches.open(CACHE).then(k => k.put('./index.html', c))).catch(() => {}));
      return res;
    }
    return await cached();          // error status from the server: still show the app
  } catch (err) {
    return await cached();          // offline or too slow
  }
}

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  if (r.mode === 'navigate') { e.respondWith(handleNavigate(e)); return; }
  const u = new URL(r.url);
  // Own files and trusted CDNs: serve from cache instantly, refresh in the background
  if (u.origin === location.origin || STATIC_HOSTS.includes(u.hostname)) {
    e.respondWith(
      caches.match(r).then(hit => {
        const net = fetch(r).then(res => {
          if (res && (res.ok || res.type === 'opaque')) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(r, cp)); }
          return res;
        }).catch(() => hit || Response.error());
        return hit || net;
      })
    );
  }
  // everything else (Firestore, Google APIs) goes straight to the network untouched
});
