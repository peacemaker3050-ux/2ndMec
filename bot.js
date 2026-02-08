const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ==========================================
// 1. الإعدادات
// ==========================================
const token = '8273814930:AAEdxVzhYjnNZqdJKvpGJC9k1bVf2hcGUV4'; 
const AUTHORIZED_USERS = [
    5605597142, // ID الخاص بك
];

const JSONBIN_BIN_ID = "696e77bfae596e708fe71e9d";
const JSONBIN_ACCESS_KEY = "$2a$10$TunKuA35QdJp478eIMXxRunQfqgmhDY3YAxBXUXuV/JrgIFhU0Lf2";

const bot = new TelegramBot(token, { polling: true });
const userStates = {}; 

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
        console.error("❌ Database Fetch Error:", error.message);
        return null;
    }
}

async function saveDatabase(data) {
    try {
        await axios.put(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`, data, {
            headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_ACCESS_KEY }
        });
        console.log("✅ Database Saved Successfully!");
        return true;
    } catch (error) {
        console.error("❌ Database Save Error:", error.message);
        return false;
    }
}

// ==========================================
// 3. التعامل مع النصوص (هذا الجزء هو الأهم)
// ==========================================

// أولاً: سنستمع لأي نص (حتى لو لم يبدأ بـ /)
bot.on('text', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // 1. التحقق من الصلاحية
    if (!AUTHORIZED_USERS.includes(chatId)) {
        console.log(`Unauthorized access attempt by: ${chatId}`);
        return; 
    }

    // 2. تجاهل الأوامر التي تبدأ بـ / (مثل /start)
    if (text.startsWith('/')) {
        if(text === '/start') {
            bot.sendMessage(chatId, "البوت يعمل! جرب إرسال نص عادي الآن.");
        }
        return;
    }

    // 3. طباعة في الكونسول للتأكد أن البوت استقبل الرسالة (مهم جداً للديباغ)
    console.log(`📩 Received Text from ${chatId}: "${text}"`);

    // 4. تخزين الحالة
    userStates[chatId] = {
        step: 'select_subject_for_text',
        type: 'text',
        content: text
    };

    // 5. جلب المواد
    const data = await getDatabase();
    if (!data || !data.database) {
        return bot.sendMessage(chatId, "❌ تعذر الاتصال بقاعدة البيانات.");
    }

    const subjects = Object.keys(data.database);
    if (subjects.length === 0) return bot.sendMessage(chatId, "❌ لا توجد مواد في قاعدة البيانات.");

    // 6. إرسال لوحة اختيار المادة
    const keyboard = subjects.map(sub => [{ text: sub, callback_data: `sub_text_${sub}` }]);
    
    try {
        await bot.sendMessage(chatId, `📝 *رسالة جديدة*\n\n"${text}"\n\nاختر المادة لإرسالها:`, {
            reply_markup: { inline_keyboard: keyboard },
            parse_mode: 'Markdown'
        });
        console.log(`✅ Sent Subject Selection for text`);
    } catch (err) {
        console.error("Error sending keyboard:", err);
    }
});

// ==========================================
// 4. التعامل مع الأزرار (Callback Query)
// ==========================================

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const state = userStates[chatId];
    const msgId = query.message.message_id;

    // تحقق الصلاحية
    if (!AUTHORIZED_USERS.includes(chatId)) return bot.answerCallbackQuery(query.id, { text: "غير مصرح" });

    console.log(`🔘 Button Clicked: ${data}`);

    // --- أ. اختيار المادة للنص ---
    if (data.startsWith('sub_text_')) {
        const subjectName = data.replace('sub_text_', '');
        
        // تحديث الحالة
        state.subject = subjectName;
        state.step = 'select_doctor_for_text';

        const db = await getDatabase();
        const doctors = db.database[subjectName]?.doctors || [];

        if (doctors.length === 0) {
            return bot.answerCallbackQuery(query.id, { text: "لا يوجد دكاترة لهذه المادة!", show_alert: true });
        }

        const keyboard = doctors.map(doc => [{ text: doc, callback_data: `doc_text_${doc}` }]);
        
        await bot.editMessageText(`المادة: *${subjectName}*\n\nاختر الدكتور:`, {
            chat_id: chatId, message_id: msgId,
            reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
        });
    }

    // --- ب. اختيار الدكتور للنص ---
    else if (data.startsWith('doc_text_')) {
        const doctorName = data.replace('doc_text_', '');
        
        // هنا سنقوم بالرفع فوراً بدون اختيار قسم
        bot.answerCallbackQuery(query.id, { text: "جاري رفع الإشعار..." });
        
        await processTextNotification(chatId, state, doctorName, msgId);
    }

    // --- (الجزء الخاص بالملفات تم اختصاره هنا للتركيز على النص، لكنه موجود إذا احتجته) ---
});

// ==========================================
// 5. دالة رفع الإشعار (تم تحسينها)
// ==========================================

async function processTextNotification(chatId, state, doctorName, messageId) {
    const db = await getDatabase();
    const notifKey = "🔔 Notifications";
    const subjectName = state.subject;

    // تحقق من وجود المادة
    if (!db.database[subjectName]) {
        return bot.sendMessage(chatId, "❌ المادة غير موجودة.");
    }

    // تحقق من وجود الدكتور
    if (!db.database[subjectName][doctorName]) {
        // إذا لم يكن الدكتور موجوداً، قم بإنشاء هيكل بسيط له (حل طوارئ)
        db.database[subjectName][doctorName] = {};
        console.log(`Created new doctor structure for ${doctorName}`);
    }

    const doctorObj = db.database[subjectName][doctorName];

    // التأكد من وجود مصفوفة الإشعارات
    if (!Array.isArray(doctorObj[notifKey])) {
        doctorObj[notifKey] = [];
        console.log(`Created new Notifications array for ${doctorName}`);
    }

    // إضافة الإشعار
    const newNotif = {
        name: state.content,
        date: new Date().toLocaleString(),
        type: "notif",
        id: Date.now().toString()
    };

    // إضافة في البداية
    doctorObj[notifKey].unshift(newNotif);

    // تحديث قائمة الأقسام (لظهورها في التطبيق)
    if (!doctorObj.sections || !Array.isArray(doctorObj.sections)) {
        doctorObj.sections = [];
    }
    if (!doctorObj.sections.includes(notifKey)) {
        doctorObj.sections.unshift(notifKey);
    }

    // الحفظ
    const saved = await saveDatabase(db);

    if (saved) {
        try {
            await bot.editMessageText(`✅ تم إرسال الإشعار!\n\n📂 ${subjectName}\n👨‍🏫 ${doctorName}\n📁 ${notifKey}\n\n"${state.content}"`, {
                chat_id: chatId, 
                message_id: messageId, 
                parse_mode: 'Markdown'
            });
            delete userStates[chatId];
        } catch (err) {
            console.error("Error editing success message:", err);
            // إذا فشل تعديل الرسالة، أرسل رسالة جديدة
            bot.sendMessage(chatId, "✅ تم الحفظ بنجاح!");
            delete userStates[chatId];
        }
    } else {
        bot.sendMessage(chatId, "❌ فشل حفظ البيانات.");
    }
}

// التعامل مع الملفات (نفس الكود السابق مبسط لكي لا يتداخل)
bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    if (!AUTHORIZED_USERS.includes(chatId)) return;
    // يمكنك وضع كود رفع الملفات هنا إذا أردت الجمع بينهما
    bot.sendMessage(chatId, "تم استلام ملف. (خاصية الملفات غير مفعلة في نسخة الاختبار هذه، جرب النص فقط الآن)");
});