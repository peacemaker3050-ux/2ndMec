// ============================================================
// === HYBRID SERVICE WORKER (FCM + POLLING) ===
// ============================================================

// 1. IMPORT FIREBASE LIBRARIES (To enable FCM capability)
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-messaging-compat.js');

// 2. CONFIGURATION (Firebase + JSONBin)
const firebaseConfig = {
  apiKey: "AIzaSyBUzcbZDAFS3rhjcp2-maEiSTmuBmUlGPQ",
  authDomain: "libirary-b2424.firebaseapp.com",
  projectId: "libirary-b2424",
  storageBucket: "libirary-b2424.firebasestorage.app",
  messagingSenderId: "371129360013",
  appId: "1:371129360013:web:377ef70759204018a60cc4"
};

// Initialize Firebase immediately
firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

// JSONBin Settings
const BIN_ID = "696e77bfae596e708fe71e9d";
const BIN_KEY = "$2a$10$TunKuA35QdJp478eIMXxRunQfqgmhDY3YAxBXUXuV/JrgIFhU0Lf2";

// 3. INDEXEDDB SETUP (Important for preventing duplicate notifications)
let db;
let dbReady = false;

const initDB = () => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('UniBotSWDB', 1);
    request.onupgradeneeded = (e) => {
        db = e.target.result;
        if (!db.objectStoreNames.contains('settings')) {
            db.createObjectStore('settings', { keyPath: 'id' });
        }
        // We keep auth store if you plan to use FCM tokens later
        if (!db.objectStoreNames.contains('auth')) {
            db.createObjectStore('auth', { keyPath: 'id' });
        }
    };
    request.onsuccess = (e) => {
        db = e.target.result;
        dbReady = true;
        console.log("[SW] IndexedDB Initialized");
        resolve(db);
    };
    request.onerror = (e) => {
        console.error("[SW] DB Error", e);
        reject(e);
    };
  });
};

// Helper functions to get/set data from IndexedDB
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

// 4. SW INSTALL EVENT
self.addEventListener('install', (event) => { 
    self.skipWaiting(); 
    console.log("[SW] Installed");
    // Initialize DB immediately
    event.waitUntil(initDB());
});

// 5. SW ACTIVATE EVENT
self.addEventListener('activate', (event) => { 
    event.waitUntil(
        Promise.all([
            self.clients.claim(), 
            // Register Periodic Background Sync (Android Only)
            (async () => {
                if ('periodicSync' in self.registration) {
                    try {
                        // Register to check every 15 minutes
                        await self.registration.periodicSync.register('check-doctor-msg', {
                            minInterval: 15 * 60 * 1000 
                        });
                        console.log("[SW] Periodic Sync Registered (15 min interval)");
                    } catch (err) {
                        console.log("[SW] Periodic Sync not supported/allowed:", err);
                    }
                }
            })()
        ])
    ); 
});

// 6. FCM: HANDLE MESSAGES SENT FROM SERVER (Background)
// Note: This only triggers if a SERVER sends a message via FCM.
// Since we are polling JSONBin, this event usually won't fire unless you add a backend.
messaging.onBackgroundMessage((payload) => {
  console.log('[SW] FCM Message received:', payload);

  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    body: payload.notification.body,
    icon: payload.notification.icon || 'https://cdn-icons-png.flaticon.com/512/2991/2991148.png',
    badge: 'https://cdn-icons-png.flaticon.com/512/2991/2991148.png',
    vibrate: [200, 100, 200],
    data: {
        click_action: payload.fcmOptions?.link || '/'
    }
  };

  return self.registration.showNotification(notificationTitle, notificationOptions);
});

// 7. HANDLE NOTIFICATION CLICKS (Focus or Open App)
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({
            type: 'window',
            includeUncontrolled: true
        }).then((clientList) => {
            // If app is open, focus it
            for (const client of clientList) {
                if (client.url === '.' && 'focus' in client) {
                    return client.focus();
                }
            }
            // If app is closed, open it
            if (clients.openWindow) {
                return clients.openWindow('.');
            }
        })
    );
});

// 8. HANDLE MESSAGES FROM APP (Foreground/Testing)
self.addEventListener('message', (event) => {
    const data = event.data;
    // Test Messages triggered by user from HTML
    if (data.type === 'SYNCED_NOTIF_DOCTOR' || data.type === 'TEST_NOTIF') {
        if (Notification.permission === 'granted') {
            self.registration.showNotification(data.type === 'TEST_NOTIF' ? '🧪 Test Successful' : '📢 Messages from Doctors', { 
                body: data.body || 'Tap to read details.', 
                icon: data.icon || 'https://cdn-icons-png.flaticon.com/512/2991/2991148.png', 
                requireInteraction: false, 
                tag: 'doctor-notification', 
                silent: false, 
                vibrate: [200, 100, 200] 
            });
        }
    }
});

// 9. POLLING LOGIC (This runs via Periodic Sync when app is CLOSED)
async function checkNotifications() {
    if (!dbReady) {
        console.log("[SW] DB not ready, initializing...");
        await initDB();
        if(!dbReady) return;
    }

    try {
        const lastNotifTime = await getLastTime();
        
        // Add timestamp to URL to prevent browser caching
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

        // Compare latest timestamp from DB with stored timestamp
        if (data && data.latestNotificationUpdate && data.latestNotificationUpdate > lastNotifTime) {
            console.log("[SW] New Update detected via Polling!");
            
            // Save new timestamp so we don't show this notification again
            setLastTime(data.latestNotificationUpdate);

            if (Notification.permission === 'granted') {
                self.registration.showNotification('📢 Messages from Doctors', { 
                    body: 'Tap to open app and read details.', 
                    icon: data.appIcon || 'https://cdn-icons-png.flaticon.com/512/2991/2991148.png', 
                    requireInteraction: false,
                    tag: 'doctor-notification', 
                    silent: false, 
                    vibrate: [200, 100, 200] 
                });
            }
        }
    } catch (err) {
        console.error("[SW] Polling Error:", err);
    }
}

// 10. PERIODIC BACKGROUND SYNC EVENT (Triggered by Browser periodically)
self.addEventListener('sync', event => {
    console.log("[SW] Periodic Sync Triggered:", event.tag);
    if (event.tag === 'check-doctor-msg') {
        event.waitUntil(checkNotifications());
    }
});