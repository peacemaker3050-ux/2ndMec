const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');
const fs = require('fs'); 

// ==========================================
// 1. التهيئة
// ==========================================

const token = '8273814930:AAEdxVzhYjnNZqdJKvpGJC9k1bVf2hcGUV4'; 

const AUTHORIZED_USERS = [
    5605597142, 
];

const JSONBIN_BIN_ID = "696e77bfae596e708fe71e9d";
const JSONBIN_ACCESS_KEY = "$2a$10$TunKuA35QdJp478eIMXxRunQfqgmhDY3YAxBXUXuV/JrgIFhU0Lf2";

const bot = new TelegramBot(token, { polling: true });
const app = express();
const userStates = {}; 
const PORT = process.env.PORT || 3000;

// ==========================================
// 2. دوال قاعدة البيانات
// ==========================================

async function getDatabase() {
    try {
        const response = await axios.get(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
            headers: { 'X-Master-Key': JSONBIN_ACCESS_KEY, 'X-Bin-Meta': 'false' }
        });
        return response.data;
    } catch (error) {
        console.error("خطأ في جلب البيانات:", error.message);
        return null;
    }
}

async function saveDatabase(data) {
    try {
        await axios.put(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`, data, {
            headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_ACCESS_KEY }
        });
    } catch (error) {
        console.error("خطأ في حفظ البيانات:", error.message);
        throw error;
    }
}

// ==========================================
// 3. وسيط الملفات (الجزء السحري) 👇
// ==========================================
// هذا الرابط سيستخدمه الموقع لتحميل الملفات
// يخفي توكن البوت ويستخدم تليجرام كخادم
app.get('/get-file/:fileId', async (req, res) => {
    const fileId = req.params.fileId;
    try {
        // 1. جلب رابط الملف من تليجرام (هذا الرابط يحتوي على التوكن لذا يجب أن يكون مخفياً في الباك اند)
        const fileLink = await bot.getFileLink(fileId);
        
        // 2. جلب الملف من تليجرام وإرساله للمستخدم
        const response = await axios({ url: fileLink, responseType: 'stream' });
        
        // تحديد نوع الملف (مهم ليفتح الملف الصحيح)
        res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
        // اسم الملف (اختياري)
        // res.setHeader('Content-Disposition', 'attachment');
        
        response.data.pipe(res);
    } catch (error) {
        console.error("Error proxying file:", error.message);
        res.status(500).send("Error loading file");
    }
});

// ==========================================
// 4. أوامر تليجرام
// ==========================================

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    if (!AUTHORIZED_USERS.includes(chatId)) return;
    bot.sendMessage(chatId, "👋 أهلاً بك في نظام MecWeb (Telegram Storage).\n\n📄 *لرفع ملف:* أرسل الملف مباشرة.\n📝 *لرسالة للطلاب:* اكتب النص وسأقوم بنشره كإشعار.\n\n✨ الآن الملفات محفوظة على تليجرام ومتاحة أونلاين وأوفلاين بسرعة فائقة.", { parse_mode: 'Markdown' });
});

bot.on('document', async (msg) => handleFile(msg));
bot.on('photo', async (msg) => {
    const photo = msg.photo[msg.photo.length - 1];
    handleFile({ ...msg, document: photo, file_name: "photo_" + Date.now() + ".jpg" });
});

async function handleFile(msg) {
    const chatId = msg.chat.id;
    if (!AUTHORIZED_USERS.includes(chatId)) return;

    const fileId = msg.document ? msg.document.file_id : msg.file_id;
    const fileName = msg.document ? (msg.document.file_name || "file_" + Date.now()) : msg.file_name;

    userStates[chatId] = {
        step: 'select_subject',
        type: 'file',
        file: { id: fileId, name: fileName }
    };

    const data = await getDatabase();
    const subjects = Object.keys(data.database);
    const keyboard = subjects.map(sub => [{ text: sub, callback_data: `sub_${sub}` }]);
    bot.sendMessage(chatId, `📂 الملف: *${fileName}*\n\nاختر المادة:`, {
        reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
    });
}

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (!AUTHORIZED_USERS.includes(chatId)) return;
    
    if (msg.text && !msg.text.startsWith('/') && !msg.document && !msg.photo) {
        userStates[chatId] = {
            step: 'select_subject',
            type: 'text',
            content: msg.text
        };

        const data = await getDatabase();
        const subjects = Object.keys(data.database);
        const keyboard = subjects.map(sub => [{ text: sub, callback_data: `sub_${sub}` }]);
        bot.sendMessage(chatId, `📝 رسالة جديدة: "${msg.text}"\n\nاختر المادة:`, {
            reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
        });
    }
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const state = userStates[chatId];

    if (!AUTHORIZED_USERS.includes(chatId)) return;
    if (!state) return;

    if (state.step === 'select_subject' && data.startsWith('sub_')) {
        const subjectName = data.replace('sub_', '');
        state.subject = subjectName; state.step = 'select_doctor';
        const db = await getDatabase();
        const doctors = db.database[subjectName]?.doctors || [];
        const keyboard = doctors.map(doc => [{ text: doc, callback_data: `doc_${doc}` }]);
        bot.editMessageText(`المادة: *${subjectName}*\n\nاختر الدكتور:`, {
            chat_id: chatId, message_id: query.message.message_id,
            reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
        });
    }
    else if (state.step === 'select_doctor' && data.startsWith('doc_')) {
        const doctorName = data.replace('doc_', '');
        state.doctor = doctorName;

        if (state.type === 'text') {
            await processTextNotification(chatId, state, query.message.message_id);
        } else {
            state.step = 'select_section';
            const db = await getDatabase();
            const sections = db.database[state.subject][state.doctor]?.sections || [];
            const keyboard = sections.map(sec => [{ text: sec, callback_data: `sec_${sec}` }]);
            bot.editMessageText(`الدكتور: *${doctorName}*\n\nاختر القسم:`, {
                chat_id: chatId, message_id: query.message.message_id,
                reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
            });
        }
    }
    else if (state.step === 'select_section' && data.startsWith('sec_')) {
        const sectionName = data.replace('sec_', '');
        bot.answerCallbackQuery(query.id, { text: "⏳ جاري الحفظ..." });

        try {
            // ==========================================
            // المنطق الجديد: حفظ fileId فقط
            // ==========================================
            const db = await getDatabase();
            
            // رابط وهمي سيستخدمه الموقع للوصول للملف عبر البوت
            // استبدل الرابط أدناه برابط موقعك الفعلي
            const BOT_BASE_URL = 'https://2ndmec-production.up.railway.app'; // تأكد من تعديله لرابطك الصحيح
            const proxyLink = `${BOT_BASE_URL}/get-file/${state.file.id}`;

            if (!db.database[state.subject][state.doctor][sectionName]) {
                db.database[state.subject][state.doctor][sectionName] = [];
            }

            db.database[state.subject][state.doctor][sectionName].push({ 
                name: state.file.name, 
                link: proxyLink, 
                fileId: state.file.id // نحفظ الـ ID كمرجع
            });
            
            await saveDatabase(db);
            bot.editMessageText(`✅ تم الحفظ بنجاح!\n📂 الملف محفوظ على تليجرام.\n🔗 ${proxyLink}`, { 
                chat_id: chatId, message_id: query.message.message_id,
                disable_web_page_preview: true
            });
            delete userStates[chatId];
        } catch (error) {
            console.error(error);
            bot.sendMessage(chatId, `❌ خطأ في الحفظ: ${error.message}`);
        }
    }
});

async function processTextNotification(chatId, state, messageId) {
    const db = await getDatabase();
    const docData = db.database[state.subject][state.doctor];
    
    if (!docData["🔔 Notifications"]) docData["🔔 Notifications"] = [];
    
    docData["🔔 Notifications"].unshift({
        name: state.content,
        date: new Date().toLocaleString(),
        type: "notif"
    });

    try {
        await saveDatabase(db);
        bot.editMessageText(`✅ تم إرسال الإشعار بنجاح!`, { chat_id: chatId, message_id: messageId });
        delete userStates[chatId];
    } catch (err) {
        bot.sendMessage(chatId, "❌ فشل حفظ الإشعار.");
    }
}

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});