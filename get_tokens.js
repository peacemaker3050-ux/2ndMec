const fs = require('fs');
const path = require('path'); 
const { google } = require('googleapis');

// 1. تحميل ملف السر (تأكد أن الملف موجود في نفس المجلد)
const CREDENTIALS_PATH = path.join(__dirname, 'client_secret.json');

// 2. قراءة الملف
const content = fs.readFileSync(CREDENTIALS_PATH);
const credentials = JSON.parse(content);

// 3. استخراج البيانات (يدعم نوع Desktop أو Web)
// التصحيح هنا: نحدد redirect_uris بدقة
let client_secret, client_id, redirect_uri;

if (credentials.installed) {
    // حالة Desktop App
    client_secret = credentials.installed.client_secret;
    client_id = credentials.installed.client_id;
    redirect_uri = credentials.installed.redirect_uris[0];
} else if (credentials.web) {
    // حالة Web App
    client_secret = credentials.web.client_secret;
    client_id = credentials.web.client_id;
    redirect_uri = credentials.web.redirect_uris[0];
} else {
    console.error('❌ تنسيق ملف client_secret.json غير معروف.');
    process.exit(1);
}

const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uri);

// 4. توليد رابط التفويض
const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline', // ضروري للحصول على refresh_token دائم
    scope: ['https://www.googleapis.com/auth/drive'],
    prompt: 'consent', // ضروري لإجبار Google بإصدار refresh_token جديد
});

console.log('------------------------------------------------');
console.log('👉 الخطوة 1: انسخ هذا الرابط وافتحه في المتصفح:');
console.log(authUrl);
console.log('------------------------------------------------');
console.log('👉 الخطوة 2: سجل الدخول ووافق على الصلاحيات.');
console.log('👉 الخطوة 3: سيتم تحويلك إلى رابط (مثل http://localhost/?code=...).');
console.log('👉 الخطوة 4: انسخ الكود الذي يأتي بعد كلمة "code=" فقط.');
console.log('------------------------------------------------');

// التحقق من وجود الملف الذي يحتوي على الكود
if (fs.existsSync('code.txt')) {
    console.log('⏳ جاري قراءة الكود من code.txt...');
    const code = fs.readFileSync('code.txt', 'utf-8').trim();
    
    oAuth2Client.getToken(code, (err, token) => {
        if (err) {
            console.error('❌ Error retrieving access token:', err.message);
            return;
        }
        
        // هنا النتيجة التي نحتاجها
        console.log('✅ تم الحصول على التوكن بنجاح!');
        console.log('------------------------------------------------');
        console.log('🔑 انسخ السطر التالي وضعه في متغير DRIVE_REFRESH_TOKEN في الكود الرئيسي:');
        console.log(token.refresh_token);
        console.log('------------------------------------------------');
        
        // حفظ الكامل في ملف (اختياري للمراجعة)
        fs.writeFileSync('token.json', JSON.stringify(token));
        console.log('💾 تم حفظ التوكنات بالكامل في ملف token.json');
    });
} else {
    console.log('⚠️ لم يتم العثور على ملف code.txt.');
    console.log('قم بإنشاء ملف اسمه code.txt وضع الكود بداخله، ثم أعد تشغيل هذا السكربت.');
}