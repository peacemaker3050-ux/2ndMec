const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// قراءة البيانات من المتغيرات البيئية (Render) أو استخدام القيم الافتراضية
const token = process.env.TELEGRAM_TOKEN || '8273814930:AAEdxVzhYjnNZqdJKvpGJC9k1bVf2hcGUV4'; 
const OWNER_ID = process.env.OWNER_ID || 5605597142; 
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID || "696e77bfae596e708fe71e9d";
const JSONBIN_ACCESS_KEY = process.env.JSONBIN_ACCESS_KEY || "$2a$10$TunKuA35QdJp478eIMXxRunQfqgmhDY3YAxBXUXuV/JrgIFhU0Lf2";

const bot = new TelegramBot(token, { polling: true });
const userStates = {}; 

// --- دوال قاعدة البيانات ---
async function getDatabase() {
    try {
        const response = await axios.get(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
            headers: { 'X-Master-Key': JSONBIN_ACCESS_KEY, 'X-Bin-Meta': 'false' }
        });
        return response.data;
    } catch (error) {
        console.error("Error fetching DB:", error.message);
        return null;
    }
}

async function saveDatabase(data) {
    try {
        await axios.put(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`, data, {
            headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_ACCESS_KEY }
        });
        console.log("Database updated!");
    } catch (error) {
        console.error("Error saving DB:", error.message);
        throw error;
    }
}

async function getTelegramFileLink(fileId) {
    try {
        const file = await bot.getFile(fileId);
        return `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    } catch (error) {
        console.error("Error getting file link:", error);
        return null;
    }
}

// --- منطق البوت ---
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    if (chatId !== OWNER_ID) {
        bot.sendMessage(chatId, "⛔ عذراً، هذا البوت للإدارة فقط.");
        return;
    }
    bot.sendMessage(chatId, "👋 أهلاً بك في نظام MecWeb.\nأرسل أي ملف وسأقوم بإضافته للموقع.");
});

bot.on('document', async (msg) => handleFile(msg));
bot.on('photo', async (msg) => {
    const photo = msg.photo[msg.photo.length - 1];
    handleFile({ ...msg, document: photo, caption: msg.caption || "صورة" });
});

async function handleFile(msg) {
    const chatId = msg.chat.id;
    if (chatId !== OWNER_ID) return;
    const fileId = msg.document.file_id;
    const fileName = msg.document.file_name || "ملف_" + Date.now();
    
    userStates[chatId] = { step: 'select_subject', file: { id: fileId, name: fileName } };

    const data = await getDatabase();
    if (!data || !data.database) { return bot.sendMessage(chatId, "❌ خطأ في قاعدة البيانات."); }

    const subjects = Object.keys(data.database);
    const keyboard = subjects.map(sub => [{ text: sub, callback_data: `sub_${sub}` }]);
    bot.sendMessage(chatId, `📂 الملف: *${fileName}*\n\nاختر المادة:`, {
        reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
    });
}

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const state = userStates[chatId];

    if (!state) return bot.answerCallbackQuery(query.id, { text: "أرسل الملف مرة أخرى.", show_alert: true });

    // اختيار المادة
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
    // اختيار الدكتور
    else if (state.step === 'select_doctor' && data.startsWith('doc_')) {
        const doctorName = data.replace('doc_', '');
        state.doctor = doctorName; state.step = 'select_section';
        const db = await getDatabase();
        const sections = db.database[state.subject][state.doctor]?.sections || [];
        const keyboard = sections.map(sec => [{ text: sec, callback_data: `sec_${sec}` }]);
        bot.editMessageText(`الدكتور: *${doctorName}*\n\nاختر القسم:`, {
            chat_id: chatId, message_id: query.message.message_id,
            reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
        });
    }
    // اختيار القسم والرفع
    else if (state.step === 'select_section' && data.startsWith('sec_')) {
        const sectionName = data.replace('sec_', '');
        bot.answerCallbackQuery(query.id, { text: "جاري الرفع..." });
        const fileLink = await getTelegramFileLink(state.file.id);
        if (!fileLink) return bot.sendMessage(chatId, "❌ فشل رابط الملف.");

        const db = await getDatabase();
        if (db.database[state.subject]?.[state.doctor]?.[sectionName]) {
            db.database[state.subject][state.doctor][sectionName].push({ name: state.file.name, link: fileLink });
            try {
                await saveDatabase(db);
                bot.editMessageText(`✅ تم الرفع!\n\n📂 ${state.subject}\n👨‍🏫 ${state.doctor}\n📁 ${sectionName}`, {
                    chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown'
                });
                delete userStates[chatId];
            } catch (err) { bot.sendMessage(chatId, "❌ فشل الحفظ."); }
        }
    }
});