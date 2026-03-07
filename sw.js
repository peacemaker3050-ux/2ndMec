// ============================================================
// === UNIFIED SERVICE WORKER (FCM + OFFLINE + POLLING) ===
// === v10 — Added SET_TOGGLE handler ===
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

const FIREBASE_DB_URL = "https://libirary-b2424-default-rtdb.firebaseio.com";

// ── Cache ──
const CACHE_VERSION = 'v11';
const CACHE_STATIC  = `uni-static-${CACHE_VERSION}`;
const CACHE_API     = `uni-api-${CACHE_VERSION}`;

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
// INSTALL
// ============================================================
self.addEventListener('install', event => {
  console.log('[SW] Installing', CACHE_VERSION);
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      await initDB();
      const cache = await caches.open(CACHE_STATIC);
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
// ACTIVATE
// ============================================================
self.addEventListener('activate', event => {
  console.log('[SW] Activating', CACHE_VERSION);
  event.waitUntil(
    (async () => {
      await self.clients.claim();

      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(k => k !== CACHE_STATIC && k !== CACHE_API)
          .map(k => { console.log('[SW] Deleting old cache:', k); return caches.delete(k); })
      );

      if (!dbReady) await initDB();

      if ('periodicSync' in self.registration) {
        try {
          await self.registration.periodicSync.register('check-notif', { minInterval: 15 * 60 * 1000 });
          console.log('[SW] Periodic Sync registered');
        } catch(e) { console.log('[SW] Periodic Sync not available'); }
      }

      await checkNotifications();
      startPolling();
    })()
  );
});

// ============================================================
// FETCH
// ============================================================
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  if (url.hostname.includes('firebaseio.com')) {
    event.respondWith(
      fetch(event.request.clone())
        .then(response => {
          if (response && response.status === 200 && event.request.method === 'GET') {
            const clone = response.clone();
            caches.open(CACHE_API).then(c => c.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          console.log('[SW] Offline: serving Firebase from cache');
          return caches.match(event.request);
        })
    );
    return;
  }

  if (url.hostname.includes('googleapis.com') ||
      url.hostname.includes('gstatic.com')
      ) {
    event.respondWith(
      fetch(event.request).catch(() => new Response('', { status: 503 }))
    );
    return;
  }

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
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html') || caches.match('./');
          }
          return new Response('', { status: 503 });
        });
    })
  );
});

// ============================================================
// FCM BACKGROUND MESSAGE
// ============================================================
messaging.onBackgroundMessage(payload => {
  console.log('[SW] FCM Background Message:', payload);
  const title = payload.notification?.title || 'New Message';
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

  // بدء الـ Polling
  if (data.type === 'INIT_POLLING') {
    console.log('[SW] INIT_POLLING received');
    if (!dbReady) initDB().then(() => { startPolling(); checkNotifications(); });
    else { startPolling(); checkNotifications(); }
  }

  // Test Notification
  if (data.type === 'TEST_NOTIF') {
    self.registration.showNotification('Test Successful', {
      body: 'Push notifications are working correctly!',
      icon: data.icon || 'https://cdn-icons-png.flaticon.com/512/2991/2991148.png',
      vibrate: [200, 100, 200]
    });
  }

  // اشعار فوري من الصفحة عند اكتشاف ملف جديد
  if (data.type === 'SHOW_NOTIFICATION') {
    self.registration.showNotification(data.title || 'New File', {
      body: data.body || '',
      icon: data.icon || 'https://cdn-icons-png.flaticon.com/512/2991/2991148.png',
      vibrate: [200, 100, 200],
      tag: 'new-file-notif',
      data: { click_action: self.location.origin }
    });
  }

  // حفظ حالة التوجل من الصفحة في IndexedDB
  // الصفحة بتبعت SET_TOGGLE عند كل تغيير وعند التحميل
  if (data.type === 'SET_TOGGLE') {
    if (!dbReady) {
      initDB().then(() => {
        dbSet('newFilesToggle', data.value);
        console.log('[SW] Toggle saved after DB init:', data.value);
      });
    } else {
      dbSet('newFilesToggle', data.value);
      console.log('[SW] Toggle saved:', data.value);
    }
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
// POLLING
// ============================================================
function startPolling() {
  if (pollingTimer) return;
  console.log('[SW] Polling started (60s interval)');
  pollingTimer = setInterval(() => checkNotifications(), 60 * 1000);
}

// ============================================================
// دالة تجيب احدث ملف في الـ database
// ============================================================
function findNewestFile(database) {
  if (!database) return null;
  let newest = null;

  function scan(list) {
    for (const item of list || []) {
      if (item.type === 'file' && item.ts) {
        if (!newest || item.ts > newest.ts) newest = item;
      }
      if (item.type === 'folder' && item.children) scan(item.children);
    }
  }

  for (const subject of Object.values(database)) {
    for (const key of Object.keys(subject)) {
      if (key === 'doctors') continue;
      const doctor = subject[key];
      if (doctor && doctor.root) scan(doctor.root);
    }
  }

  return newest;
}

// ============================================================
// CHECK NOTIFICATIONS — اشعارات الاطباء + ملفات جديدة
// ============================================================
async function checkNotifications() {
  if (!dbReady) {
    try { await initDB(); } catch(e) { return; }
  }

  try {
    const lastNotifTime = (await dbGet('lastNotifTime')) || 0;
    const lastFileTime  = (await dbGet('lastFileTime'))  || 0;

    const response = await fetch(
      `${FIREBASE_DB_URL}/db.json?nc=${Date.now()}`,
      { cache: 'no-store' }
    );

    if (!response.ok) return;
    const raw = await response.json();
    const data = (raw && typeof raw.data === 'string') ? JSON.parse(raw.data) : raw;

    // 1. اشعارات الاطباء النصية — FCM يتولى العرض
    if (data?.recentUpdates?.length) {
      const newest  = data.recentUpdates[0];
      const newTime = newest.timestamp || 0;
      if (newTime > lastNotifTime) {
        await dbSet('lastNotifTime', newTime);
        console.log('[SW] New text notification detected, FCM handles display');
      }
    }

    // 2. ملفات جديدة
    const toggleState = await dbGet('newFilesToggle');
    if (toggleState !== true && toggleState !== 'true') return;

    const newestFile = findNewestFile(data?.database);
    if (!newestFile) return;

    const fileTs   = newestFile.ts || 0;
    const oneDayMs = 24 * 60 * 60 * 1000;

    if (fileTs > lastFileTime && (Date.now() - fileTs) < oneDayMs) {
      await dbSet('lastFileTime', fileTs);
      console.log('[SW] New file detected:', newestFile.name);

      self.registration.showNotification('New File Added', {
        body: newestFile.name,
        icon: 'https://cdn-icons-png.flaticon.com/512/2991/2991148.png',
        badge: 'https://cdn-icons-png.flaticon.com/512/2991/2991148.png',
        vibrate: [200, 100, 200],
        requireInteraction: false,
        tag: 'new-file-notif',
        data: { click_action: self.location.origin }
      });
    }

  } catch(err) {
    console.error('[SW] Polling error:', err);
  }
}