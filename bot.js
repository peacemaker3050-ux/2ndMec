const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ==========================================
// 1. بيانات البوت وقائمة المستخدمين المسموح لهم
// ==========================================

// توكن البوت الخاص بك
const token = '8273814930:AAEdxVzhYjnNZqdJKvpGJC9k1bVf2hcGUV4'; 

// ==========================================
// ⭐ قائمة الأشخاص المسموح لهم (أرقام الـ ID)
// ==========================================
const AUTHORIZED_USERS = [
    5605597142, // أنت (المالك)
    // أضف الأرقام الأخرى هنا...
];

// مفاتيح قاعدة البيانات (JSONBin)
const JSONBIN_BIN_ID = "696e77bfae596e708fe71e9d";
const JSONBIN_ACCESS_KEY = "$2a$10$TunKuA35QdJp478eIMXxRunQfqgmhDY3YAxBXUXuV/JrgIFhU0Lf2";

const bot = new TelegramBot(token, { polling: true });

// لتخزين حالة المحادثة
const userStates = {}; 

// ==========================================
// 2. دوال الاتصال بقاعدة البيانات
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
        console.log("تم تحديث قاعدة البيانات بنجاح!");
    } catch (error) {
        console.error("خطأ في حفظ البيانات:", error.message);
        throw error;
    }
}

async function getTelegramFileLink(fileId) {
    try {
        const file = await bot.getFile(fileId);
        return `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    } catch (error) {
        console.error("خطأ في رابط الملف:", error);
        return null;
    }
}

// ==========================================
// 3. استقبال الرسائل والملفات
// ==========================================

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    
    if (!AUTHORIZED_USERS.includes(chatId)) {
        bot.sendMessage(chatId, "⛔ عذراً، هذا البوت للإدارة فقط ولست مخولاً باستخدامه.");
        return;
    }

    bot.sendMessage(chatId, "👋 أهلاً بك في نظام MecWeb.\n\n📄 *لرفع ملف:* أرسل الملف مباشرة.\n📝 *لرسالة للطلاب:* اكتب النص وسأقوم بنشره كإشعار.", { parse_mode: 'Markdown' });
});

// --- أ) عند استلام ملف ---
bot.on('document', async (msg) => handleFile(msg, 'document'));
bot.on('photo', async (msg) => {
    const photo = msg.photo[msg.photo.length - 1];
    handleFile({ ...msg, document: photo, caption: msg.caption || "صورة" }, 'photo');
});

async function handleFile(msg, type) {
    const chatId = msg.chat.id;
    
    if (!AUTHORIZED_USERS.includes(chatId)) return;

    const fileId = msg.document.file_id;
    const fileName = msg.document.file_name || "ملف_" + Date.now();

    // حفظ الحالة: نوع العملية (ملف)
    userStates[chatId] = {
        step: 'select_subject',
        type: 'file', 
        file: { id: fileId, name: fileName, fileType: type }
    };

    const data = await getDatabase();
    if (!data || !data.database) { return bot.sendMessage(chatId, "❌ خطأ في قاعدة البيانات."); }

    const subjects = Object.keys(data.database);
    const keyboard = subjects.map(sub => [{ text: sub, callback_data: `sub_${sub}` }]);
    bot.sendMessage(chatId, `📂 الملف: *${fileName}*\n\nاختر المادة:`, {
        reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
    });
}

// --- ب) عند استلام نص ---
bot.on('text', (msg) => {
    // تجاهل الأوامر
    if (msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    if (!AUTHORIZED_USERS.includes(chatId)) return;

    // حفظ الحالة: نوع العملية (نص إشعار)
    userStates[chatId] = {
        step: 'select_subject',
        type: 'text', 
        content: msg.text 
    };

    getDatabase().then(data => {
        if (!data || !data.database) { return bot.sendMessage(chatId, "❌ خطأ في قاعدة البيانات."); }
        const subjects = Object.keys(data.database);
        const keyboard = subjects.map(sub => [{ text: sub, callback_data: `sub_${sub}` }]);
        bot.sendMessage(chatId, `📝 رسالة جديدة\n\nالنص: "${msg.text}"\n\nاختر المادة:`, {
            reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
        });
    });
});


// ==========================================
// 4. التعامل مع اختيار الأزرار (Callback Query)
// ==========================================

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const state = userStates[chatId];

    // تحقق من الصلاحية
    if (!AUTHORIZED_USERS.includes(chatId)) {
        return bot.answerCallbackQuery(query.id, { text: "⛔ غير مصرح لك", show_alert: true });
    }

    if (!state) return bot.answerCallbackQuery(query.id, { text: "انتهت الجلسة، أرسل الملف أو النص مرة أخرى.", show_alert: true });

    // 1. اختيار المادة
    if (state.step === 'select_subject' && data.startsWith('sub_')) {
        const subjectName = data.replace('sub_', '');
        state.subject = subjectName; 
        state.step = 'select_doctor';
        
        const db = await getDatabase();
        const doctors = db.database[subjectName]?.doctors || [];
        const keyboard = doctors.map(doc => [{ text: doc, callback_data: `doc_${doc}` }]);
        
        bot.editMessageText(`المادة: *${subjectName}*\n\nاختر الدكتور:`, {
            chat_id: chatId, message_id: query.message.message_id,
            reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
        });
    }
    
    // 2. اختيار الدكتور
    else if (state.step === 'select_doctor' && data.startsWith('doc_')) {
        const doctorName = data.replace('doc_', '');
        state.doctor = doctorName;

        // ✅ المنطق الجديد: التحقق مما إذا كان النص أم ملف
        if (state.type === 'text') {
            // إذا كان نص، نتجاهل الأقسام ونرفع مباشرة
            bot.answerCallbackQuery(query.id, { text: "جاري إرسال الإشعار... ⏳" });
            await processTextNotification(chatId, state, query.message.message_id);
        } 
        else {
            // إذا كان ملف، نطلب اختيار القسم
            state.step = 'select_section';
            const db = await getDatabase();
            // جلب الأقسام
            const sections = db.database[state.subject][state.doctor]?.sections || [];
            
            if (sections.length === 0) {
                 // حالة نادرة: لا يوجد أقسام للملفات
                 bot.answerCallbackQuery(query.id, { text: "لا يوجد أقسام لهذا الدكتور!", show_alert: true });
                 return;
            }

            const keyboard = sections.map(sec => [{ text: sec, callback_data: `sec_${sec}` }]);
            bot.editMessageText(`الدكتور: *${doctorName}*\n\nاختر القسم:`, {
                chat_id: chatId, message_id: query.message.message_id,
                reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
            });
        }
    }
    
    // 3. اختيار القسم (للملفات فقط)
    else if (state.step === 'select_section' && data.startsWith('sec_')) {
        const sectionName = data.replace('sec_', '');
        bot.answerCallbackQuery(query.id, { text: "جاري الرفع..." });
        
        const fileLink = await getTelegramFileLink(state.file.id);
        if (!fileLink) return bot.sendMessage(chatId, "❌ فشل الحصول على رابط الملف.");

        const db = await getDatabase();
        const targetPath = db.database[state.subject]?.[state.doctor]?.[sectionName];

        if (targetPath) {
            // التأكد من أن المسار مصفوفة
            if (!Array.isArray(targetPath)) {
                db.database[state.subject][state.doctor][sectionName] = [];
            }
            
            // إضافة الملف
            db.database[state.subject][state.doctor][sectionName].push({ 
                name: state.file.name, 
                link: fileLink,
                date: new Date().toLocaleString()
            });
            
            try {
                await saveDatabase(db);
                bot.editMessageText(`✅ تم الرفع!\n\n📂 ${state.subject}\n👨‍🏫 ${state.doctor}\n📁 ${sectionName}\n\n📄 ${state.file.name}`, {
                    chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown'
                });
                delete userStates[chatId];
            } catch (err) { 
                console.error(err);
                bot.sendMessage(chatId, "❌ فشل الحفظ في قاعدة البيانات."); 
            }
        } else {
            bot.sendMessage(chatId, "❌ القسم غير موجود في قاعدة البيانات.");
        }
    }
});

// ==========================================
// 5. دالة خاصة لرفع النصوص (تخطي القسم)
// ==========================================

async function processTextNotification(chatId, state, messageId) {
    const db = await getDatabase();
    
    // التأكد من وجود الهيكلية الصحيحة للمادة والدكتور
    if (!db.database[state.subject] || !db.database[state.subject][state.doctor]) {
        bot.sendMessage(chatId, "❌ خطأ: بيانات الدكتور غير موجودة.");
        return;
    }

    const doctorData = db.database[state.subject][state.doctor];
    const notifKey = "🔔 Notifications";

    // التأكد من وجود قسم الإشعارات
    if (!Array.isArray(doctorData[notifKey])) {
        doctorData[notifKey] = []; // إنشاؤه إذا لم يكن موجوداً
    }

    // إضافة النص كإشعار جديد
    doctorData[notifKey].unshift({
        name: state.content,
        date: new Date().toLocaleString(),
        type: "notif",
        id: Date.now().toString()
    });

    // (اختياري) تحديث قائمة الأقسام إذا لم تكن الإشعارات مضافة كقسم مرئي
    if (doctorData.sections && !doctorData.sections.includes(notifKey)) {
        doctorData.sections.unshift(notifKey);
    }

    try {
        await saveDatabase(db);
        bot.editMessageText(`✅ تم إرسال الإشعار!\n\n📂 ${state.subject}\n👨‍🏫 ${state.doctor}\n📁 ${notifKey}\n\n"${state.content}"`, {
            chat_id: chatId, 
            message_id: messageId, 
            parse_mode: 'Markdown'
        });
        delete userStates[chatId];
    } catch (err) {
        bot.sendMessage(chatId, "❌ فشل إرسال الإشعار.");
        console.error(err);
    }
}