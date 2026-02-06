// ============================================================
// === HYBRID SERVICE WORKER (OFFLINE + FCM + POLLING + WORKBOX) ===
// ============================================================

// 1. WORKBOX SETUP
importScripts('https://storage.googleapis.com/workbox-cdn/releases/6.4.1/workbox-sw.js');
workbox.setConfig({
  modulePathPrefix: 'https://storage.googleapis.com/workbox-cdn/releases/6.4.1/',
});

// 2. FIREBASE IMPORTS & CONFIG
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-messaging-compat.js');

const firebaseConfig = {
  apiKey: "AIzaSyBUzcbZDAFS3rhjcp2-maEiSTmuBmUlGPQ",
  authDomain: "libirary-b2424.firebaseapp.com",
  projectId: "libirary-b2424",
  storageBucket: "libirary-b2424.firebasestorage.app",
  messagingSenderId: "371129360013",
  appId: "1:371129360013:web:377ef70759204018a60cc4"
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

// CONSTANTS
const BIN_ID = "696e77bfae596e708fe71e9d";
const BIN_KEY = "$2a$10$TunKuA35QdJp478eIMXxRunQfqgmhDY3YAxBXUXuV/JrgIFhU0Lf2";
const CACHE_NAME = 'uni-bot-cache-v7'; 
const FILE_CACHE_NAME = 'uni-files-cache';

// 3. INDEXEDDB SETUP
let db; let dbReady = false; let isPolling = false;

const initDB = () => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('UniBotSWDB', 1);
    request.onupgradeneeded = (e) => {
        db = e.target.result;
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'id' });
    };
    request.onsuccess = (e) => { db = e.target.result; dbReady = true; resolve(db); };
    request.onerror = (e) => { console.error("[SW] DB Error", e); reject(e); };
  });
};

async function getLastTime() {
    if (!db) return 0;
    return new Promise((resolve) => {
        const tx = db.transaction('settings', 'readonly');
        const req = tx.objectStore('settings').get('lastNotifTime');
        req.onsuccess = () => resolve(req.result ? req.result.value : 0);
        req.onerror = () => resolve(0);
    });
}

async function setLastTime(time) {
    if (!db) return;
    const tx = db.transaction('settings', 'readwrite');
    tx.objectStore('settings').put({ id: 'lastNotifTime', value: time });
}

// 4. INSTALL & PRE-CACHING
self.addEventListener('install', (event) => { 
    console.log("[SW] Installing & Caching Libraries...");
    self.skipWaiting(); 
    
    event.waitUntil(
        Promise.all([
            initDB(),
            caches.open(CACHE_NAME).then(cache => {
                return cache.addAll([
                    './', 
                    'index.html',
                    'https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js',
                    'https://www.gstatic.com/firebasejs/9.22.0/firebase-auth-compat.js',
                    'https://cdn-icons-png.flaticon.com/512/2991/2991148.png'
                ]);
            })
        ])
    );
});

// 5. ACTIVATE
self.addEventListener('activate', (event) => { 
    console.log("[SW] Activated");
    event.waitUntil(
        Promise.all([
            self.clients.claim(),
            caches.keys().then(keys => Promise.all(keys.map(key => key !== CACHE_NAME && key !== FILE_CACHE_NAME ? caches.delete(key) : Promise.resolve()))),
            (async () => {
                if ('periodicSync' in self.registration) {
                    try { await self.registration.periodicSync.register('check-doctor-msg', { minInterval: 15 * 60 * 1000 }); } catch (err) {}
                }
                // Start Polling
                if (!isPolling) { isPolling = true; setInterval(checkNotifications, 60 * 1000); }
            })()
        ])
    ); 
});

// 6. WORKBOX ROUTING STRATEGIES

// A. Network First for JSONBin API
workbox.routing.registerRoute(
    ({ url }) => url.hostname.includes('jsonbin.io'),
    new workbox.strategies.NetworkFirst({
        cacheName: 'api-cache',
        plugins: [
            new workbox.expiration.ExpirationPlugin({
                maxEntries: 10,
                maxAgeSeconds: 60 * 5 // 5 minutes
            })
        ]
    })
);

// B. Cache First for FILES (PDFs, Docs, Images)
workbox.routing.registerRoute(
    ({ request, url }) => {
        // Match common file extensions OR Telegram domains
        return (request.destination === 'document' || 
                /\.(?:pdf|docx?|pptx?|txt|jpg|png|jpeg|gif)$/i.test(url.pathname) ||
                url.hostname.includes('api.telegram.org'));
    },
    new workbox.strategies.CacheFirst({
        cacheName: FILE_CACHE_NAME,
        plugins: [
            new workbox.expiration.ExpirationPlugin({
                maxEntries: 50, // Max 50 files cached
                maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
                purgeOnQuotaError: true
            })
        ]
    })
);

// C. StaleWhileRevalidate for HTML and Assets (Default Workbox behavior)
workbox.routing.registerRoute(
    ({ request }) => request.mode === 'navigate',
    new workbox.strategies.StaleWhileRevalidate({
        cacheName: CACHE_NAME
    })
);

// 7. PRE-CACHE MESSAGE LISTENER
self.addEventListener('message', (event) => {
    const data = event.data;
    
    // Handle Pre-Caching PDFs
    if (data && data.type === 'PRE_CACHE_PDFS' && Array.isArray(data.urls)) {
        console.log(`[SW] Pre-caching ${data.urls.length} files...`);
        event.waitUntil(
            caches.open(FILE_CACHE_NAME).then((cache) => {
                return cache.addAll(data.urls.map(url => {
                    // Clean Google Viewer links before caching if necessary, 
                    // though usually better to do this in JS to cache the actual file, not the viewer page.
                    // We assume JS sends Direct Links here.
                    return url; 
                })).catch(err => {
                    console.warn("[SW] Some files failed to cache (Network or CORS):", err);
                    // Don't fail entire process if one file fails
                });
            })
        );
    }

    // Existing Message Handlers (Test/Notification)
    if (data.type === 'SYNCED_NOTIF_DOCTOR' || data.type === 'TEST_NOTIF') {
        if (Notification.permission === 'granted') {
            self.registration.showNotification(data.type === 'TEST_NOTIF' ? '🧪 Test Successful' : '📢 Update Available', { 
                body: data.body || 'Tap to read details.', 
                icon: data.icon || 'https://cdn-icons-png.flaticon.com/512/2991/2991148.png', 
                tag: 'doctor-notification', 
                vibrate: [200, 100, 200] 
            });
        }
    }
});

// 8. FCM & POLLING LOGIC (Kept from original)
messaging.onBackgroundMessage((payload) => {
    self.registration.showNotification(payload.notification.title, {
        body: payload.notification.body,
        icon: payload.notification.icon || 'https://cdn-icons-png.flaticon.com/512/2991/2991148.png',
        badge: 'https://cdn-icons-png.flaticon.com/512/2991/2991148.png',
        vibrate: [200, 100, 200],
        data: { click_action: payload.fcmOptions?.link || '/' }
    });
});

async function checkNotifications() {
    if (!dbReady) { await initDB(); if(!dbReady) return; }
    try {
        const lastNotifTime = await getLastTime();
        const url = 'https://api.jsonbin.io/v3/b/'+BIN_ID+'/latest?nocache=' + Date.now();
        const response = await fetch(url, { method: 'GET', headers: { 'X-Master-Key': BIN_KEY, 'X-Bin-Meta': 'false' } });
        if (!response.ok) throw new Error("Network response was not ok");
        const data = await response.json();
        if (data && data.recentUpdates && data.recentUpdates.length > 0) {
            const newestUpdate = data.recentUpdates[0];
            if ((newestUpdate.timestamp || 0) > lastNotifTime) {
                setLastTime(newestUpdate.timestamp);
                if (Notification.permission === 'granted') {
                    const deepLink = `/?subject=${encodeURIComponent(newestUpdate.subject)}&doctor=${encodeURIComponent(newestUpdate.doctor)}&action=open_notification`;
                    self.registration.showNotification('📢 New Message', { 
                        body: `From ${newestUpdate.doctor} (${newestUpdate.subject})`, 
                        icon: data.appIcon || 'https://cdn-icons-png.flaticon.com/512/2991/2991148.png', 
                        tag: 'latest-update', 
                        vibrate: [200, 100, 200],
                        data: { click_action: deepLink }
                    });
                }
            }
        }
    } catch (err) { console.error("[SW] Polling Error:", err); }
}

self.addEventListener('sync', event => {
    if (event.tag === 'check-doctor-msg') event.waitUntil(checkNotifications());
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification.data.click_action || '/';
    event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
        for (const client of clientList) if (client.url.includes(self.location.origin) && 'focus' in client) return client.focus();
        if (clients.openWindow) return clients.openWindow(url);
    }));
});