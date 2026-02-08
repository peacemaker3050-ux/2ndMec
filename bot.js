const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs'); 
const path = require('path');
const FormData = require('form-data'); 

// ==========================================
// 1. بيانات البوت وقائمة المستخدمين المسموح لهم
// ==========================================

const token = '8273814930:AAEdxVzhYjnNZqdJKvpGJC9k1bVf2hcGUV4'; 

const AUTHORIZED_USERS = [
    5605597142, // أنت (المالك)
];

const JSONBIN_BIN_ID = "696e77bfae596e708fe71e9d";
const JSONBIN_ACCESS_KEY = "$2a$10$TunKuA35QdJp478eIMXxRunQfqgmhDY3YAxBXUXuV/JrgIFhU0Lf2";

const GITHUB_TOKEN = "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"; 
const GITHUB_REPO_OWNER = "peacemaker3050-ux";      
const GITHUB_REPO_NAME = "2ndMec";             

const bot = new TelegramBot(token, { polling: true });

const userStates = {}; 

// ==========================================
// دالة رفع الملف على GitHub (تعديل بسيط لضمان الرفع المباشر)
// ==========================================
async function uploadToGithub(filePath, fileName) {
    try {
        const content = fs.readFileSync(filePath, { encoding: 'base64' });
        const cleanFileName = fileName.replace(/\s+/g, '_');
        const uploadPath = `uploads/${Date.now()}_${cleanFileName}`;

        const url = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/${uploadPath}`;

        await axios.put(url, {
            message: `Upload file: ${cleanFileName}`,
            content: content
        }, {
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        return `https://raw.githubusercontent.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/main/${uploadPath}`;
    } catch (error) {
        console.error("GitHub Error:", error.response ? error.response.data : error.message);
        throw error;
    }
}

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
    } catch (error) {
        console.error("خطأ في حفظ البيانات:", error.message);
        throw error;
    }
}

// ==========================================
// 3. استقبال الرسائل والملفات (تم تعديل هذا الجزء لحل مشكلتك)
// ==========================================

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    if (!AUTHORIZED_USERS.includes(chatId)) return;
    bot.sendMessage(chatId, "👋 أهلاً بك في نظام MecWeb.\n\n📄 *لرفع ملف:* أرسل الملف مباشرة.\n📝 *لرسالة للطلاب:* اكتب النص وسأقوم بنشره كإشعار.", { parse_mode: 'Markdown' });
});

// التعامل مع الملفات والصور
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

// التعامل مع النصوص (تم تعديل الفلتر هنا ليشتغل صح)
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (!AUTHORIZED_USERS.includes(chatId)) return;
    
    // التأكد أنها رسالة نصية وليست ملفاً أو أمراً
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

// ==========================================
// 4. التعامل مع اختيار الأزرار
// ==========================================

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
        bot.answerCallbackQuery(query.id, { text: "⏳ جاري الرفع..." });

        try {
            const fileLink = await bot.getFileLink(state.file.id);
            const tempFilePath = path.join('/tmp', state.file.name);
            
            const response = await axios({ url: fileLink, responseType: 'stream' });
            const writer = fs.createWriteStream(tempFilePath);
            response.data.pipe(writer);

            await new Promise((resolve) => writer.on('finish', resolve));

            const githubLink = await uploadToGithub(tempFilePath, state.file.name);
            fs.unlinkSync(tempFilePath);

            const db = await getDatabase();
            db.database[state.subject][state.doctor][sectionName].push({ name: state.file.name, link: githubLink });
            
            await saveDatabase(db);
            bot.editMessageText(`✅ تم الرفع بنجاح للقسم!\n🔗 الرابط: ${githubLink}`, { chat_id: chatId, message_id: query.message.message_id });
            delete userStates[chatId];
        } catch (error) {
            bot.sendMessage(chatId, `❌ خطأ: ${error.message}`);
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