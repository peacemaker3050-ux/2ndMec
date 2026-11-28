// ============================================================
// === UNIBOT PWA SERVICE WORKER (OFFLINE SHELL + RUNTIME) ===
// === v19-pwa (Push notifications intentionally deferred)  ===
// ============================================================

const CACHE_VERSION = 'v19-pwa';
const CACHE_STATIC = `unibot-static-${CACHE_VERSION}`;
const CACHE_API = `unibot-api-${CACHE_VERSION}`;
const CACHE_FILES = `unibot-files-${CACHE_VERSION}`;

const SHELL_FILES = [
  '/2ndMec/',
  '/2ndMec/index.html',
  '/2ndMec/manifest.json',
  '/2ndMec/header-logo.png',
  '/2ndMec/icon-192.png',
  '/2ndMec/icon-512.png',
  '/2ndMec/apple-touch-icon.png',
  '/2ndMec/110.jpeg',
  '/2ndMec/vendor/pdf.min.js',
  '/2ndMec/vendor/pdf.worker.min.js',
  '/2ndMec/vendor/mammoth.browser.min.js',
  '/2ndMec/vendor/jszip.min.js'
];

const OFFLINE_FALLBACK_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>UniBot — Offline</title>
  <style>
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1220;color:#f8fafc;font-family:system-ui,sans-serif;text-align:center;padding:24px;}
    .box{max-width:360px;background:#111a2e;border:1px solid rgba(148,163,184,0.2);border-radius:18px;padding:24px;}
    button{margin-top:14px;background:#3b82f6;color:#fff;border:none;border-radius:10px;padding:10px 18px;font-weight:700;cursor:pointer;}
  </style>
</head>
<body>
  <div class="box">
    <h2>You are offline</h2>
    <p>This page has not been cached yet. Reconnect to load new content.</p>
    <button onclick="location.reload()">Retry</button>
  </div>
</body>
</html>`;

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_STATIC).then((cache) =>
      Promise.allSettled(
        SHELL_FILES.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch((err) => {
            console.warn('[SW] Precache skip:', url, err?.message || err);
          })
        )
      )
    )
  );
});

self.addEventListener('activate', (event) => {
  const activeCaches = new Set([CACHE_STATIC, CACHE_API, CACHE_FILES]);
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !activeCaches.has(k)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

function isDynamicApiRequest(url) {
  return (
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('workers.dev')
  );
}

function isRuntimeMaterialRequest(url) {
  return (
    /\.(pdf|docx?|pptx?|xlsx?|txt|png|jpe?g|webp|mp3|mp4)(\?|$)/i.test(url.pathname) ||
    url.hostname.includes('drive.google.com') ||
    url.hostname.includes('googleusercontent.com')
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (!url.protocol.startsWith('http')) return;

  // 1. Dynamic RTDB & Worker API -> Network-first with Cache fallback
  if (isDynamicApiRequest(url)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_API).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          return cached || new Response(JSON.stringify({ offline: true }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        })
    );
    return;
  }

  // 2. Navigation (HTML shell) -> Network-first with cached shell / offline fallback
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_STATIC).then((c) => c.put('/2ndMec/index.html', copy));
          }
          return res;
        })
        .catch(async () => {
          return (
            (await caches.match('/2ndMec/index.html')) ||
            (await caches.match('/2ndMec/')) ||
            new Response(OFFLINE_FALLBACK_HTML, {
              status: 200,
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
            })
          );
        })
    );
    return;
  }

  // 3. Opened materials/PDFs -> Stale-while-revalidate / Cache-first in CACHE_FILES
  if (isRuntimeMaterialRequest(url) && url.origin !== self.location.origin) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_FILES);
        const cached = await cache.match(req);
        if (cached) {
          fetch(req).then((res) => { if (res && (res.status === 200 || res.type === 'opaque')) cache.put(req, res.clone()); }).catch(() => {});
          return cached;
        }
        try {
          const netRes = await fetch(req);
          if (netRes && (netRes.status === 200 || netRes.type === 'opaque')) {
            cache.put(req, netRes.clone());
          }
          return netRes;
        } catch {
          return new Response('', { status: 503 });
        }
      })()
    );
    return;
  }

  // 4. App shell, same-origin assets & CDN scripts -> Cache-first with background refresh
  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) {
        fetch(req)
          .then((res) => {
            if (res && (res.status === 200 || res.type === 'opaque')) {
              caches.open(CACHE_STATIC).then((c) => c.put(req, res.clone()));
            }
          })
          .catch(() => {});
        return cached;
      }
      try {
        const netRes = await fetch(req);
        if (netRes && (netRes.status === 200 || netRes.type === 'opaque')) {
          const targetCache = isRuntimeMaterialRequest(url) ? CACHE_FILES : CACHE_STATIC;
          caches.open(targetCache).then((c) => c.put(req, netRes.clone()));
        }
        return netRes;
      } catch {
        return new Response('', { status: 503 });
      }
    })()
  );
});

// Placeholder hook for future Web Push / VAPID notifications:
// self.addEventListener('push', (event) => { ... });
