// The site's service worker (a classic script; register it from the site's base path).
//
// One job: add the cross-origin isolation headers to the same-origin responses it passes
// through, for hosts that cannot send them. The page needs that state for shared memory and
// threads. Requests to other origins are left alone, and nothing is stored or answered here:
// game data is read in the page (lib/gamedata-sync.js).

const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // An earlier version of this worker kept a name index of the game files; it is not used now.
    try {
      await caches.delete('electrode-gamefiles-index-v1');
    } catch (e) {
      /* nothing kept */
    }
    await self.clients.claim();
  })());
});

async function passThrough(request) {
  const response = await fetch(request);
  if (response.status === 0) return response; // opaque, or a redirect the browser follows itself
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(ISOLATION)) headers.set(k, v);
  const bodiless = response.status === 101 || response.status === 204 || response.status === 205 || response.status === 304;
  return new Response(bodiless ? null : response.body, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  event.respondWith(passThrough(request));
});
