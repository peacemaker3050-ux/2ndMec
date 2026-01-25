// ============================================================
// === SERVICE WORKER CODE (FIXED VERSION) ===
// ============================================================

const CACHE_VERSION = 'v19'; 
const BIN_ID = "696e77bfae596e708fe71e9d";
const BIN_KEY = "$2a$10$TunKuA35QdJp478eIMXxRunQfqgmhDY3YAxBXUXuV/JrgIFhU0Lf2";

// IndexedDB Setup to store 'lastNotifTime' permanently
let db;
let dbReady = false; // Flag to ensure DB is ready before checks

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
        resolve(db);
    };
    request.onerror = (e) => reject(e);
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

// Installation & Activation
self.addEventListener('install', event => { 
    self.skipWaiting(); 
    console.log("[SW] Installed");
});

self.addEventListener('activate', event => { 
    event.waitUntil(self.clients.claim()); 
    console.log("[SW] Activated");
    initDB().then(() => {
        console.log("[SW] DB Initialized");
        checkNotifications();
    });
});

// Handle Messages from Main Page
self.addEventListener('message', event => {
    const data = event.data;
    if (data.type === 'SYNCED_NOTIF_DOCTOR') {
        if (Notification.permission === 'granted') {
            // FIX 1: Set requireInteraction to FALSE for Heads-up on Android
            self.registration.showNotification('📢 Messages from Doctors', { 
                body: data.body, 
                icon: data.icon, 
                requireInteraction: false, // <--- CRITICAL FIX: Allows heads-up notification
                tag: 'doctor-notification', 
                silent: false, 
                vibrate: [200, 100, 200] 
            });
        }
    }
    if (data.type === 'TEST_NOTIF') {
        if (Notification.permission === 'granted') {
            self.registration.showNotification('🧪 Test Successful', { 
                body: 'Notifications are working.', 
                icon: data.icon, 
                requireInteraction: false,
                vibrate: [200, 100, 200] 
            });
        }
    }
});

// Main Notification Loop
function checkNotifications() {
    if (!dbReady) {
        console.log("[SW] DB not ready, retrying in 1s...");
        setTimeout(checkNotifications, 1000);
        return;
    }

    getLastTime().then(lastNotifTime => {
        const url = 'https://api.jsonbin.io/v3/b/'+BIN_ID+'/latest?nocache=' + Date.now();
        
        // FIX 2: Removed 'cache: no-store' to avoid potential fetch errors
        fetch(url, { method: 'GET', headers: { 'X-Master-Key': BIN_KEY, 'X-Bin-Meta': 'false' } })
        .then(res => {
            if (!res.ok) throw new Error("Network response was not ok");
            return res.json();
        })
        .then(data => {
            console.log("[SW] Fetched Data. Server Time:", data.latestNotificationUpdate, "Local Time:", lastNotifTime);
            
            if (data && data.latestNotificationUpdate && data.latestNotificationUpdate > lastNotifTime) {
                console.log("[SW] New Notification Detected!");
                
                // Update Local Time
                setLastTime(data.latestNotificationUpdate);

                if (Notification.permission === 'granted') {
                    self.registration.showNotification('📢 Messages from Doctors', { 
                        body: 'Tap to open app and read details.', 
                        icon: 'https://cdn-icons-png.flaticon.com/512/2991/2991148.png', 
                        requireInteraction: false, // <--- CRITICAL FIX
                        tag: 'doctor-notification', 
                        silent: false, 
                        vibrate: [200, 100, 200] 
                    });
                }
            }
        })
        .catch(err => {
            console.error("[SW] Fetch Error:", err);
        })
        .finally(() => {
            // Recursive timeout
            setTimeout(checkNotifications, 20000); 
        });
    });
}

// Handle Notification Click
self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
        for (const client of clientList) { 
            if (client.url === self.location.href && 'focus' in client) return client.focus(); 
        }
        if (clients.openWindow) return clients.openWindow(self.location.href);
    }));
});