// firebase-messaging-sw.js
// ملاحظة: هذا الملف مطلوب من Firebase SDK لكن كل المنطق موجود في sw.js
// نُبقيه خفيفاً لتجنب التعارض

importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBUzcbZDAFS3rhjcp2-maEiSTmuBmUlGPQ",
  authDomain: "libirary-b2424.firebaseapp.com",
  projectId: "libirary-b2424",
  storageBucket: "libirary-b2424.firebasestorage.app",
  messagingSenderId: "371129360013",
  appId: "1:371129360013:web:377ef70759204018a60cc4"
});

const messaging = firebase.messaging();

// معالجة الإشعارات الواصلة عبر FCM عندما يكون التطبيق مغلقاً
messaging.onBackgroundMessage(payload => {
  const title = payload.notification?.title || '📢 New Message';
  const body  = payload.notification?.body  || 'New update available';
  const icon  = 'https://peacemaker3050-ux.github.io/2ndMec/icon-512.png';
  const link  = payload.fcmOptions?.link || payload.data?.link || '/';

  return self.registration.showNotification(title, {
    body,
    icon,
    badge: 'https://peacemaker3050-ux.github.io/2ndMec/icon-512.png',
    vibrate: [200, 100, 200],
    requireInteraction: false,
    tag: 'fcm-bg',
    data: { click_action: link }
  });
});