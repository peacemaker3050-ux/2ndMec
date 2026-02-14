// ============================================================
// === HYBRID SERVICE WORKER (FCM + POLLING + CACHING) ===
// ============================================================

// 1. FIREBASE IMPORTS & CONFIG
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
const CACHE_NAME = 'uni-bot-cache-v7'; // Updated to force refresh

// 2. INDEXEDDB SETUP
let db;
let dbReady = false;
let isPolling = false;

const initDB = () => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('UniBotSWDB', 1);
    request.onupgradeneeded = (e) => {
        db = e.target.result;
        if (!db.objectStoreNames.contains('settings')) {
            db.createObjectStore('settings', { keyPath: 'id' });
        }
    };
    request.onsuccess = (e) => {
        db = e.target.result;
        dbReady = true;
        console.log("[SW] DB Initialized");
        resolve(db);
    };
    request.onerror = (e) => {
        console.error("[SW] DB Error", e);
        reject(e);
    };
  });
};

async function getLastTime() {
    if (!db) return 0;
    return new Promise((resolve) => {
        const tx = db.transaction('settings', 'readonly');
        const store = tx.objectStore('settings');
        const req = store.get('lastNotifTime');
        req.onsuccess = () => resolve(req.result ? req.result.value : 0);
        req.onerror = () => resolve(0);
    });
}

async function setLastTime(time) {
    if (!db) return;
    const tx = db.transaction('settings', 'readwrite');
    tx.objectStore('settings').put({ id: 'lastNotifTime', value: time });
}

// 3. SW INSTALL
self.addEventListener('install', (event) => { 
    console.log("[SW] Installing...");
    self.skipWaiting();
    
    event.waitUntil(
        Promise.all([
            initDB(),
            caches.open(CACHE_NAME).then(cache => {
                return cache.addAll(['./', 'index.html']);
            })
        ])
    );
});

// 4. SW ACTIVATE
self.addEventListener('activate', (event) => { 
    console.log("[SW] Activated");
    
    event.waitUntil(
        Promise.all([
            self.clients.claim(),
            caches.keys().then(keys => {
                return Promise.all(
                    keys.map(key => {
                        if (key !== CACHE_NAME) {
                            console.log("[SW] Deleting old cache:", key);
                            return caches.delete(key);
                        }
                    })
                );
            }),
            (async () => {
                if ('periodicSync' in self.registration) {
                    try {
                        await self.registration.periodicSync.register('check-doctor-msg', {
                            minInterval: 15 * 60 * 1000 
                        });
                        console.log("[SW] Periodic Sync Registered");
                    } catch (err) {
                        console.log("[SW] Periodic Sync not supported/allowed:", err);
                    }
                }
            })()
        ])
    ); 

    if (!isPolling) {
        isPolling = true;
        setInterval(() => {
            checkNotifications();
        }, 60 * 1000); 
    }
});

// 5. FETCH HANDLER (Network First for JSON, Cache First for Assets)
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Network First for API
    if (url.hostname.includes('jsonbin.io')) {
        event.respondWith(fetch(event.request));
        return;
    }

    // Cache First for Assets
    event.respondWith(
        caches.match(event.request).then(cached => {
            return cached || fetch(event.request).then(response => {
                if (response.status === 200) {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
                }
                return response;
            }).catch(() => {
                if (event.request.mode === 'navigate') {
                    return caches.match('./');
                }
            });
        })
    );
});

// 6. FCM BACKGROUND HANDLER
messaging.onBackgroundMessage((payload) => {
  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    body: payload.notification.body,
    icon: payload.notification.icon || 'https://cdn-icons-png.flaticon.com/512/2991/2991148.png',
    badge: 'https://cdn-icons-png.flaticon.com/512/2991/2991148.png',
    vibrate: [200, 100, 200],
    data: { click_action: payload.fcmOptions?.link || '/' }
  };
  return self.registration.showNotification(notificationTitle, notificationOptions);
});

// 7. NOTIFICATION CLICKS
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification.data.click_action || '/';
    
    event.waitUntil(
        clients.matchAll({
            type: 'window',
            includeUncontrolled: true
        }).then((clientList) => {
            for (const client of clientList) {
                if (client.url.includes(window.location.origin) && 'focus' in client) { 
                     // Fixed typo: finish -> focus
                     return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow(url);
            }
        })
    );
});

// 8. APP MESSAGES
self.addEventListener('message', (event) => {
    const data = event.data;
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

// 9. POLLING LOGIC
async function checkNotifications() {
    if (!dbReady) {
        console.log("[SW] DB not ready, initializing...");
        await initDB();
        if(!dbReady) return;
    }

    try {
        const lastNotifTime = await getLastTime();
        const url = 'https://api.jsonbin.io/v3/b/'+BIN_ID+'/latest?nocache=' + Date.now();
        
        const response = await fetch(url, { 
            method: 'GET', 
            headers: { 
                'X-Master-Key': BIN_KEY, 
                'X-Bin-Meta': 'false'
            }
        });

        if (!response.ok) throw new Error("Network response was not ok");
        const data = await response.json();

        if (data && data.recentUpdates && data.recentUpdates.length > 0) {
            const newestUpdate = data.recentUpdates[0];
            const updateTimestamp = newestUpdate.timestamp || Date.now();

            if (updateTimestamp > lastNotifTime) {
                console.log("[SW] New Update detected!");
                
                setLastTime(updateTimestamp);

                if (Notification.permission === 'granted') {
                    // FIX: Use messageBody if available (for scheduled/standard notifs)
                    const notificationBody = newestUpdate.messageBody || `From ${newestUpdate.doctor} (${newestUpdate.subject})`;
                    
                    const deepLink = `/?subject=${encodeURIComponent(newestUpdate.subject)}&doctor=${encodeURIComponent(newestUpdate.doctor)}&action=open_notification`;

                    self.registration.showNotification('📢 New Message', { 
                        body: notificationBody, 
                        icon: data.appIcon || 'https://cdn-icons-png.flaticon.com/512/2991/2991148.png', 
                        requireInteraction: true, 
                        tag: 'latest-update', 
                        silent: false, 
                        vibrate: [200, 100, 200],
                        data: {
                            click_action: deepLink
                        }
                    });
                }
            }
        }
    } catch (err) {
        console.error("[SW] Polling Error:", err);
    }
}

// 10. PERIODIC SYNC EVENT
self.addEventListener('sync', (event) => {
    if (event.tag === 'check-doctor-msg') {
        event.waitUntil(checkNotifications());
    }
});