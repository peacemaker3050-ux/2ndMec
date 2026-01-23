// استدعاء مكتبات فايربيس (يجب أن تكون نفس النسخة المستخدمة في ملف HTML)
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-messaging-compat.js');

// 1. إعدادات فايربيس (مهم جداً أن تكون مطابقة تماماً للإعدادات في ملف HTML)
const firebaseConfig = {
  apiKey: "AIzaSyBUzcbZDAFS3rhjcp2-maEiSTmuBmUlGPQ",
  authDomain: "libirary-b2424.firebaseapp.com",
  databaseURL: "https://libirary-b2424-default-rtdb.firebaseio.com",
  projectId: "libirary-b2424",
  storageBucket: "libirary-b2424.firebasestorage.app",
  messagingSenderId: "371129360013",
  appId: "1:371129360013:web:377ef70759204018a60cc4"
};

// 2. تهيئة التطبيق
firebase.initializeApp(firebaseConfig);

// 3. تهيئة خدمة الرسائل
const messaging = firebase.messaging();

// 4. الاستماع للإشعارات (هذا الجزء يظهر النافذة المنبثقة على جهاز الطالب)
messaging.onBackgroundMessage(function(payload) {
  console.log('[firebase-messaging-sw.js] Received background message ', payload);
  
  // تعيين عنوان الإشعار (سيأتي من لوحة التحكم)
  const notificationTitle = payload.data.title || "رسالة جديدة من البوت";
  
  // تعيين محتوى الإشعار
  const notificationOptions = {
    body: payload.data.body,
    icon: 'https://cdn-icons-png.flaticon.com/512/3081/3081479.png', // يمكنك وضع رابط لوجو البوت هنا إذا أردت
    click_action: '/' // عند الضغط على الإشعار يفتح الموقع
  };

  // إظهار الإشعار على الشاشة
  return self.registration.showNotification(notificationTitle, notificationOptions);
});