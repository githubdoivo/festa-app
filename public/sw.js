// Service worker: receives push and shows notifications; opens the app on click.
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Android will only mint a proper, Google-signed app wrapper for a site
// whose service worker handles fetch. Without one, some browsers fall back
// to a legacy wrapper built against an old Android SDK - which is what
// Play Protect refuses to install with "built for an older version of
// Android". So this handler has to exist.
//
// It is network-first and caches only the page shell, deliberately. The
// rest of the app is served no-cache on purpose (see the note by
// express.static in app.js) because a stale bundle masking an already
// shipped fix has cost real debugging time here before. Network-first
// keeps that: online, every request goes to the network exactly as it did
// before this handler existed, and nothing stale is ever served. The cache
// is only reached for when the network is not there at all.
const SHELL_CACHE = 'shell-v1';

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Navigations only. Assets, API calls and everything else are left
  // completely alone - passing them through untouched is the whole point.
  if (request.method !== 'GET' || request.mode !== 'navigate') return;

  event.respondWith((async () => {
    try {
      const fresh = await fetch(request);
      // Keep the last good page so a cold start with no signal opens
      // something rather than the browser's dinosaur.
      if (fresh && fresh.ok) {
        const cache = await caches.open(SHELL_CACHE);
        cache.put('/', fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch {
      const cached = await caches.match('/', { cacheName: SHELL_CACHE });
      // No cached shell either - let the browser show its own error, which
      // is more honest than a blank page we invented.
      if (cached) return cached;
      throw new Error('offline and nothing cached');
    }
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Notificacao', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'lodge';
  const options = {
    body: data.body || '',
    tag: data.tag || 'app',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Where a deep link waits when there's no page to hand it to yet.
// On iOS, tapping a notification for an installed PWA that isn't already
// running launches it at the manifest's start_url ("/") and throws the
// notification's own URL away, so ?tab=... never reaches the page and the
// app just opens on its landing tab. Parking the destination here lets the
// page ask for it once it boots (see consumePendingDeepLink() in app.js).
// Cache Storage rather than a variable because the service worker can be
// killed and restarted between the tap and the page loading.
const DEEP_LINK_CACHE = 'deep-link';
const DEEP_LINK_KEY = '/__pending-deep-link';

async function setPendingDeepLink(url) {
  const cache = await caches.open(DEEP_LINK_CACHE);
  await cache.put(new Request(DEEP_LINK_KEY), new Response(url));
}

async function takePendingDeepLink() {
  const cache = await caches.open(DEEP_LINK_CACHE);
  const hit = await cache.match(new Request(DEEP_LINK_KEY));
  if (!hit) return null;
  await cache.delete(new Request(DEEP_LINK_KEY));
  return hit.text();
}

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'take-pending-deep-link') return;
  const port = event.ports?.[0];
  if (!port) return;
  event.waitUntil(
    takePendingDeepLink()
      .then((url) => port.postMessage({ url }))
      .catch(() => port.postMessage({ url: null }))
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      const client = clients[0];
      if (!client) {
        // Stored before opening, not after: openWindow may never carry the
        // query string through on iOS, and the new page needs to find the
        // destination already waiting for it.
        await setPendingDeepLink(url);
        return self.clients.openWindow(url);
      }
      // Take the user straight to the result being announced, not just
      // whatever page the app happened to be left open on. navigate() is
      // the "real" way to do this, but iOS Safari often silently refuses
      // it when the PWA is already open in the foreground - postMessage
      // is the reliable fallback (the page applies the deep link itself,
      // see the message listener in app.js), so it's sent regardless of
      // whether navigate() below appears to succeed.
      client.postMessage({ type: 'deep-link', url });
      if ('navigate' in client) {
        try {
          await client.navigate(url);
        } catch {
          // Navigate can be refused in some states; postMessage above
          // already covers it, and focusing is still better than nothing.
        }
      }
      return 'focus' in client ? client.focus() : undefined;
    })
  );
});
