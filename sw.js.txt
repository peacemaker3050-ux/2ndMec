// ============================================================
// === SERVICE WORKER CODE (PERSISTENT VERSION) ===
// ============================================================

const CACHE_VERSION = 'v18'; 
const BIN_ID = "696e77bfae596e708fe71e9d";
const BIN_KEY = "$2a$10$TunKuA35QdJp478eIMXxRunQfqgmhDY3YAxBXUXuV/JrgIFhU0Lf2";

// IndexedDB Setup to store 'lastNotifTime' permanently
let db;
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
    initDB().then(() => checkNotifications());
});

// Handle Messages from Main Page
self.addEventListener('message', event => {
    const data = event.data;
    if (data.type === 'SYNCED_NOTIF_DOCTOR') {
        if (Notification.permission === 'granted') {
            self.registration.showNotification('📢 Messages from Doctors', { 
                body: data.body, 
                icon: data.icon, 
                requireInteraction: true, 
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
                vibrate: [200, 100, 200] 
            });
        }
    }
});

// Main Notification Loop (Using IndexedDB for persistence)
function checkNotifications() {
    getLastTime().then(lastNotifTime => {
        const url = 'https://api.jsonbin.io/v3/b/'+BIN_ID+'/latest?nocache=' + Date.now();
        
        fetch(url, { cache: 'no-store', method: 'GET', headers: { 'X-Master-Key': BIN_KEY, 'X-Bin-Meta': 'false' } })
        .then(res => {
            if (!res.ok) throw new Error("Network response was not ok");
            return res.json();
        })
        .then(data => {
            console.log("[SW] Fetched Data. Server Time:", data.latestNotificationUpdate, "Local Time:", lastNotifTime);
            
            // Check if we have a NEW notification
            if (data && data.latestNotificationUpdate && data.latestNotificationUpdate > lastNotifTime) {
                console.log("[SW] New Notification Detected!");
                
                // Update Local Time so we don't notify again
                setLastTime(data.latestNotificationUpdate);

                if (Notification.permission === 'granted') {
                    self.registration.showNotification('📢 Messages from Doctors', { 
                        body: 'Tap to open app and read details.', 
                        icon: 'https://cdn-icons-png.flaticon.com/512/2991/2991148.png', 
                        requireInteraction: true, 
                        tag: 'doctor-notification', 
                        silent: false, 
                        vibrate: [200, 100, 200] 
                    });
                }
            }
        })
        .catch(err => {
            console.error("[SW] Fetch Error:", err);
            // Don't stop loop on error
        })
        .finally(() => {
            // Recursive timeout to ensure continuous polling
            // Check every 20 seconds
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