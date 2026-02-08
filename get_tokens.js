const fs = require('fs');
const path = require('path'); // <--- هذا السطر كان مفقوداً
const { google } = require('googleapis');

// 1. تحميل ملف السر
const CREDENTIALS_PATH = path.join(__dirname, 'client_secret.json');

// 2. قراءة الملف
const content = fs.readFileSync(CREDENTIALS_PATH);
const credentials = JSON.parse(content);

const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
);

// 3. هذا هو الرابط الذي ستفتحه في المتصفح
const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline', // مهم جداً للحصول على Refresh Token
    scope: ['https://www.googleapis.com/auth/drive'],
});

console.log('------------------------------------------------');
console.log('Authorize this app by visiting this url:');
console.log(authUrl);
console.log('------------------------------------------------');
console.log('بعد الدخول والموافقة، سيعطيك Google كود (code).');
console.log('قم بإنشاء ملف اسمه code.txt وضع الكود بداخله ثم شغل السكربت مرة أخرى.');
console.log('------------------------------------------------');

// التحقق هل لدينا كود سابق
if (fs.existsSync('code.txt')) {
    const code = fs.readFileSync('code.txt', 'utf-8').trim();
    oAuth2Client.getToken(code, (err, token) => {
        if (err) return console.error('Error retrieving access token', err);
        
        // هنا الـ Token الذي نحتاجه
        console.log('✅ تم الحصول على الصلاحية بنجاح!');
        console.log('------------------------------------------------');
        console.log('انسخ الـ refresh_token التالي وضعه في متغير DRIVE_REFRESH_TOKEN في ملف bot.js');
        console.log(token.refresh_token);
        console.log('------------------------------------------------');
        
        // حفظه في ملف للاستخدام (اختياري)
        fs.writeFileSync('token.json', JSON.stringify(token));
    });
}