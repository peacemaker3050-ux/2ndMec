// ============================================================
// === UNIFIED SERVICE WORKER (FCM + OFFLINE + POLLING) ===
// ============================================================

importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-messaging-compat.js');

// ── Config ──
const firebaseConfig = {
  apiKey: "AIzaSyBUzcbZDAFS3rhjcp2-maEiSTmuBmUlGPQ",
  authDomain: "libirary-b2424.firebaseapp.com",
  projectId: "libirary-b2424",
  storageBucket: "libirary-b2424.firebasestorage.app",
  messagingSenderId: "371129360013",
  appId: "1:371129360013:web:377ef70759204018a60cc4"
};

const BIN_ID  = "696e77bfae596e708fe71e9d";
const BIN_KEY = "$2a$10$TunKuA35QdJp478eIMXxRunQfqgmhDY3YAxBXUXuV/JrgIFhU0Lf2";

// ── Cache ──
const CACHE_VERSION = 'v8';
const CACHE_STATIC  = `uni-static-${CACHE_VERSION}`;   // ملفات التطبيق
const CACHE_API     = `uni-api-${CACHE_VERSION}`;       // ردود JSONBin

// كل الملفات اللازمة لتشغيل التطبيق Offline
const STATIC_FILES = [
  './',
  './index.html',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&family=Inter:wght@400;500;600;700&display=swap',
  'https://cdn.jsdelivr.net/npm/fuse.js@6.6.2',
  'https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.22.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/9.22.0/firebase-messaging-compat.js'
];

// ── Firebase + FCM ──
firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

// ── IndexedDB ──
let idb = null;
let dbReady = false;
let pollingTimer = null;

function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('UniBotSW', 2);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'k' });
    };
    req.onsuccess = e => { idb = e.target.result; dbReady = true; resolve(); };
    req.onerror  = e => { console.warn('[SW] DB error', e); reject(e); };
  });
}

async function dbGet(key) {
  if (!idb) return null;
  return new Promise(resolve => {
    const tx = idb.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result ? req.result.v : null);
    req.onerror   = () => resolve(null);
  });
}

async function dbSet(key, value) {
  if (!idb) return;
  const tx = idb.transaction('kv', 'readwrite');
  tx.objectStore('kv').put({ k: key, v: value });
}

// ============================================================
// INSTALL — تخزين كل ملفات التطبيق
// ============================================================
self.addEventListener('install', event => {
  console.log('[SW] Installing', CACHE_VERSION);
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      await initDB();
      const cache = await caches.open(CACHE_STATIC);
      // تخزين الملفات واحداً واحداً لتجنب فشل الكل بسبب خطأ واحد
      await Promise.allSettled(
        STATIC_FILES.map(url =>
          cache.add(url).catch(e => console.warn('[SW] Cache skip:', url, e.message))
        )
      );
      console.log('[SW] Static files cached');
    })()
  );
});

// ============================================================
// ACTIVATE — حذف الكاش القديم
// ============================================================
self.addEventListener('activate', event => {
  console.log('[SW] Activating', CACHE_VERSION);
  event.waitUntil(
    (async () => {
      await self.clients.claim();

      // حذف كاشات الإصدارات القديمة
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(k => k !== CACHE_STATIC && k !== CACHE_API)
          .map(k => { console.log('[SW] Deleting old cache:', k); return caches.delete(k); })
      );

      if (!dbReady) await initDB();

      // Periodic Sync (Android Chrome فقط)
      if ('periodicSync' in self.registration) {
        try {
          await self.registration.periodicSync.register('check-notif', { minInterval: 15 * 60 * 1000 });
          console.log('[SW] Periodic Sync registered');
        } catch(e) { console.log('[SW] Periodic Sync not available'); }
      }

      // فحص فوري عند التفعيل
      await checkNotifications();

      // بدء الـ Polling كل 60 ثانية
      startPolling();
    })()
  );
});

// ============================================================
// FETCH — استراتيجية ذكية حسب نوع الطلب
// ============================================================
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // ── 1. JSONBin API: Network First → Cache Fallback ──
  if (url.hostname.includes('jsonbin.io')) {
    event.respondWith(
      fetch(event.request.clone())
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_API).then(c => c.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          console.log('[SW] Offline: serving JSONBin from cache');
          return caches.match(event.request);
        })
    );
    return;
  }

  // ── 2. Firebase/Google APIs: Network Only (لا تُخزَّن) ──
  if (url.hostname.includes('googleapis.com') ||
      url.hostname.includes('gstatic.com') ||
      url.hostname.includes('firebaseio.com')) {
    event.respondWith(
      fetch(event.request).catch(() => new Response('', { status: 503 }))
    );
    return;
  }

  // ── 3. باقي الموارد: Cache First → Network Fallback ──
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request)
        .then(response => {
          if (response && response.status === 200 && event.request.method === 'GET') {
            const clone = response.clone();
            caches.open(CACHE_STATIC).then(c => c.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          // إذا فشل التحميل وكان طلب تنقل → أرجع index.html
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html') || caches.match('./');
          }
          return new Response('', { status: 503 });
        });
    })
  );
});

// ============================================================
// FCM BACKGROUND MESSAGE — عند وصول إشعار والتطبيق مغلق
// ============================================================
messaging.onBackgroundMessage(payload => {
  console.log('[SW] FCM Background Message:', payload);
  const title = payload.notification?.title || '📢 New Message';
  const body  = payload.notification?.body  || 'New update available';
  const icon  = payload.notification?.icon  || 'https://cdn-icons-png.flaticon.com/512/2991/2991148.png';
  const link  = payload.fcmOptions?.link || payload.data?.link || '/';

  return self.registration.showNotification(title, {
    body,
    icon,
    badge: 'https://cdn-icons-png.flaticon.com/512/2991/2991148.png',
    vibrate: [200, 100, 200],
    requireInteraction: true,
    tag: 'fcm-notif',
    data: { click_action: link }
  });
});

// ============================================================
// NOTIFICATION CLICK
// ============================================================
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.click_action || self.location.origin;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});

// ============================================================
// MESSAGES من الصفحة
// ============================================================
self.addEventListener('message', event => {
  const data = event.data;
  if (!data) return;

  if (data.type === 'INIT_POLLING') {
    console.log('[SW] INIT_POLLING received');
    startPolling();
    checkNotifications();
  }

  if (data.type === 'TEST_NOTIF') {
    self.registration.showNotification('🧪 Test Successful', {
      body: 'Push notifications are working correctly!',
      icon: data.icon || 'https://cdn-icons-png.flaticon.com/512/2991/2991148.png',
      vibrate: [200, 100, 200]
    });
  }

  // إشعار فوري من الصفحة (عند إرسال رسالة من البوت)
  if (data.type === 'SHOW_NOTIFICATION') {
    self.registration.showNotification(data.title || '📢 New Message', {
      body: data.body || '',
      icon: data.icon || 'https://cdn-icons-png.flaticon.com/512/2991/2991148.png',
      badge: 'https://cdn-icons-png.flaticon.com/512/2991/2991148.png',
      vibrate: [200, 100, 200],
      requireInteraction: true,
      tag: 'doctor-notif-' + Date.now(),
      data: { click_action: self.location.origin }
    });
  }
});

// ============================================================
// PERIODIC SYNC
// ============================================================
self.addEventListener('periodicsync', event => {
  if (event.tag === 'check-notif') event.waitUntil(checkNotifications());
});

self.addEventListener('sync', event => {
  if (event.tag === 'check-notif') event.waitUntil(checkNotifications());
});

// ============================================================
// POLLING LOGIC
// ============================================================
function startPolling() {
  if (pollingTimer) return; // لا تبدأ مرتين
  console.log('[SW] Polling started (60s interval)');
  pollingTimer = setInterval(() => checkNotifications(), 60 * 1000);
}

async function checkNotifications() {
  if (!dbReady) {
    try { await initDB(); } catch(e) { return; }
  }

  try {
    const lastTime = (await dbGet('lastNotifTime')) || 0;

    const response = await fetch(
      `https://api.jsonbin.io/v3/b/${BIN_ID}/latest?nc=${Date.now()}`,
      { headers: { 'X-Master-Key': BIN_KEY, 'X-Bin-Meta': 'false' }, cache: 'no-store' }
    );

    if (!response.ok) return;
    const data = await response.json();

    if (!data?.recentUpdates?.length) return;

    const newest    = data.recentUpdates[0];
    const newTime   = newest.timestamp || 0;

    if (newTime <= lastTime) return; // لا يوجد جديد

    console.log('[SW] New notification detected!', newest);
    await dbSet('lastNotifTime', newTime);

    if (Notification.permission !== 'granted') return;

    // ── إشعار شريط الهاتف ──
    await self.registration.showNotification('📢 ' + (newest.doctor || 'New Message'), {
      body: newest.message || 'New update available',
      icon: data.appIcon || data.botImage || 'https://cdn-icons-png.flaticon.com/512/2991/2991148.png',
      badge: 'https://cdn-icons-png.flaticon.com/512/2991/2991148.png',
      vibrate: [200, 100, 200],
      requireInteraction: true,
      tag: 'poll-notif',
      silent: false,
      data: {
        click_action: `${self.location.origin}/?subject=${encodeURIComponent(newest.subject || '')}&doctor=${encodeURIComponent(newest.doctor || '')}`
      }
    });

  } catch(err) {
    console.error('[SW] Polling error:', err);
  }
}