const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const path = require('path');

// ==========================================
// 1. بيانات البوت والمستخدمين
// ==========================================
const token = '8273814930:AAEdxVzhYjnNZqdJKvpGJC9k1bVf2hcGUV4'; 

const AUTHORIZED_USERS = [
    5605597142
];

const JSONBIN_BIN_ID = "696e77bfae596e708fe71e9d";
const JSONBIN_ACCESS_KEY = "$2a$10$TunKuA35QdJp478eIMXxRunQfqgmhDY3YAxBXUXuV/JrgIFhU0Lf2";

// ==========================================
// إعدادات GitHub
// ==========================================
const GITHUB_TOKEN = "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"; 
const GITHUB_REPO_OWNER = "peacemaker3050-ux";     
const GITHUB_REPO_NAME = "2ndM  mec";  

const bot = new TelegramBot(token, { polling: true });
const userStates = {}; 

// ==========================================
// دالة رفع الملف إلى GitHub Releases
// ==========================================
async function uploadToGithubRelease(filePath, fileName) {
    try {
        const owner = GITHUB_REPO_OWNER;
        const repo = GITHUB_REPO_NAME;
        const token = GITHUB_TOKEN;

        const tag = `v_${fileName.replace(/\./g, '_')}_${Date.now()}`;
        const releaseName = `Upload: ${fileName}`;
        const releaseUrl = `https://api.github.com/repos/${owner}/${repo}/releases`;
        
        let releaseId;
        
        // محاولة إنشاء Release جديد
        try {
            const createResp = await axios.post(releaseUrl, {
                tag_name: tag,
                name: releaseName,
                body: `Uploaded via UniBot: ${fileName}`,
                draft: false,
                prerelease: false
            }, { headers: { 'Authorization': `token ${token}` } });
            releaseId = createResp.data.id;
        } catch (error) {
            // إذا فشل، حاول استخدام آخر Release موجود
            try {
                const listResp = await axios.get(releaseUrl, { headers: { 'Authorization': `token ${token}` } });
                if (listResp.data && listResp.data.length > 0) {
                    releaseId = listResp.data[0].id;
                } else {
                    throw new Error("Could not create or find a release.");
                }
            } catch (listErr) {
                 throw new Error("Critical error accessing GitHub releases.");
            }
        }

        const uploadUrlResp = await axios.get(`${releaseUrl}/${releaseId}`, { headers: { 'Authorization': `token ${token}` } });
        const uploadUrl = uploadUrlResp.data.upload_url;

        const fileStream = fs.createReadStream(filePath);
        const formData = new FormData();
        formData.append('file', fileStream);

        const uploadResp = await axios.post(uploadUrl, formData, {
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            headers: {
                ...formData.getHeaders(),
                'Authorization': `token ${token}`
            }
        });

        if (uploadResp.status === 201 || uploadResp.status === 200) {
            const publicLink = `https://github.com/${owner}/${repo}/releases/download/${tag}/${fileName}`;
            return publicLink;
        } else {
            throw new Error(`Upload failed with status ${uploadResp.status}`);
        }

    } catch (error) {
        console.error("GitHub Upload Error:", error.response ? error.response.data : error.message);
        throw error;
    }
}

// ==========================================
// دوال قاعدة البيانات
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
// استقبال الأوامر والرسائل
// ==========================================

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    if (!AUTHORIZED_USERS.includes(chatId)) {
        bot.sendMessage(chatId, "⛔ عذراً، هذا البوت للإدارة فقط ولست مخولاً باستخدامه.");
        return;
    }

    bot.sendMessage(chatId, "👋 أهلاً بك في نظام MecWeb.\n\n📄 *لرفع ملف:* أرسل الملف مباشرة.\n📝 *لرسالة للطلاب:* اكتب النص وسأقوم بنشره كإشعار.", { parse_mode: 'Markdown' });
});

// ----------------------------------------------------
// أ) استقبال النصوص (إشعارات)
// ----------------------------------------------------
bot.on('text', (msg) => {
    if (msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    if (!AUTHORIZED_USERS.includes(chatId)) return;

    // حالة الطالب/الأدمن لإرسال إشعار
    userStates[chatId] = {
        step: 'send_text_notification',
        type: 'text',
        content: msg.text
    };

    bot.sendMessage(chatId, "⏳ جاري معالجة الرسالة...");
    processTextNotification(chatId, msg.text, msg.message_id);
});

// ----------------------------------------------------
// ب) استقبال الملفات والصور
// ----------------------------------------------------
bot.on('document', async (msg) => handleFile(msg));

bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    if (!AUTHORIZED_USERS.includes(chatId)) return;

    const photo = msg.photo[msg.photo.length - 1];
    const fakeDocument = {
        file_id: photo.file_id,
        file_name: `image_${Date.now()}.jpg`
    };
    
    // عرض خيارات الرفع
    bot.sendMessage(chatId, "👨‍💻 Panel: Upload file to:", { 
        reply_markup: { 
            inline_keyboard: [
                [{ text: "➕ Upload to General", callback_data: 'to_general' }],
                [{ text: "➕ Upload to Subject/Doctor", callback_data: 'to_path_select' }]
            ] 
        } 
    });

    // حفظ الحالة مؤقتاً
    userStates[chatId] = {
        step: 'select_action',
        type: 'file',
        file: { id: photo.file_id, name: `image_${Date.now()}.jpg` }
    };
});

async function handleFile(msg) {
    const chatId = msg.chat.id;
    if (!AUTHORIZED_USERS.includes(chatId)) return;

    const fileId = msg.document.file_id;
    const fileName = msg.document.file_name || `file_${Date.now()}`;

    bot.sendMessage(chatId, "👨‍💻 Panel: Upload file to:", { 
        reply_markup: { 
            inline_keyboard: [
                [{ text: "➕ Upload to General", callback_data: 'to_general' }],
                [{ text: "➕ Upload to Subject/Doctor", callback_data: 'to_path_select' }]
            ] 
        } 
    });

    userStates[chatId] = {
        step: 'select_action',
        type: 'file',
        file: { id: fileId, name: fileName }
    };
}

// ============================================================
// 4. التعامل مع اختيار الأزرار (Callback Queries) - موحد
// ============================================================

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const state = userStates[chatId];

    if (!AUTHORIZED_USERS.includes(chatId)) {
        return bot.answerCallbackQuery(query.id, { text: "⛔ غير مصرح لك", show_alert: true });
    }

    // 1. اختيار المسار (عام أو محدد)
    if (data === 'to_general') {
        state.step = 'uploading_general';
        bot.answerCallbackQuery(query.id, { text: "⏳ جاري الرفع للقسم العام..." });
        // رفع مباشرة إلى General -> General -> General
        state.subject = "General";
        state.doctor = "General";
        state.sectionName = "General";
        handleFileUploadToGithub(chatId, state, query.message.message_id);
    }
    else if (data === 'to_path_select') {
        state.step = 'select_subject';
        showSubjects(chatId, query.message.message_id);
    }

    // 2. اختيار المادة
    else if (state.step === 'select_subject' && data.startsWith('sub_')) {
        const subjectName = data.replace('sub_', '');
        state.subject = subjectName;
        state.step = 'select_doctor';
        showDoctors(chatId, subjectName, query.message.message_id);
    }

    // 3. اختيار الدكتور
    else if (state.step === 'select_doctor' && data.startsWith('doc_')) {
        const doctorName = data.replace('doc_', '');
        state.doctor = doctorName;
        
        if (state.type === 'text') {
            bot.answerCallbackQuery(query.id, { text: "جاري إرسال الإشعار..." });
            await processTextNotificationInternal(chatId, state.content, query.message.message_id, state.subject, state.doctor);
        } else {
            state.step = 'select_section';
            showSections(chatId, state.subject, state.doctor, query.message.message_id);
        }
    }

    // 4. اختيار القسم
    else if (state.step === 'select_section' && data.startsWith('sec_')) {
        const sectionName = data.replace('sec_', '');
        state.sectionName = sectionName;
        bot.answerCallbackQuery(query.id, { text: "⏳ جاري الرفع..." });
        handleFileUploadToGithub(chatId, state, query.message.message_id);
    }
});

// دوال مساعدة لعرض القوائم
async function showSubjects(chatId, messageId) {
    const data = await getDatabase();
    if (!data || !data.database) { 
        return bot.sendMessage(chatId, "❌ خطأ في قاعدة البيانات.");
    }
    const subjects = Object.keys(data.database);
    const keyboard = subjects.map(sub => [{ text: sub, callback_data: `sub_${sub}` }]);
    bot.editMessageText(`اختر المادة:`, {
        chat_id: chatId, message_id: messageId,
        reply_markup: { inline_keyboard: keyboard }
    });
}

async function showDoctors(chatId, subjectName, messageId) {
    const db = await getDatabase();
    const doctors = db.database[subjectName]?.doctors || [];
    const keyboard = doctors.map(doc => [{ text: doc, callback_data: `doc_${doc}` }]);
    bot.editMessageText(`المادة: *${subjectName}*\n\nاختر الدكتور:`, {
        chat_id: chatId, message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    });
}

async function showSections(chatId, subjectName, doctorName, messageId) {
    const db = await getDatabase();
    const sections = db.database[subjectName][doctorName]?.sections || [];
    const keyboard = sections.map(sec => [{ text: sec, callback_data: `sec_${sec}` }]);
    bot.editMessageText(`الدكتور: *${doctorName}*\n\nاختر القسم:`, {
        chat_id: chatId, message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    });
}

// ==========================================
// 5. دالة رفع الملف الكاملة
// ==========================================

async function handleFileUploadToGithub(chatId, state, messageId) {
    try {
        const fileId = state.file.id;
        const fileName = state.file.name;

        // 1. تنزيل الملف من تليجرام
        const fileLink = await getTelegramFileLink(fileId);
        const tempFilePath = path.join(__dirname, `temp_${fileName}`);
        
        const response = await axios({
            method: 'get',
            url: fileLink,
            responseType: 'stream'
        });

        const writer = fs.createWriteStream(tempFilePath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        // 2. رفع الملف لجيت هوب
        const githubLink = await uploadToGithubRelease(tempFilePath, fileName);

        // 3. حذف الملف المؤقت
        fs.unlinkSync(tempFilePath);

        if (!githubLink) throw new Error("فشل الحصول على رابط GitHub");

        // 4. حفظ الرابط في قاعدة البيانات
        const db = await getDatabase();
        
        // تهيئة الهيكل إذا لم يكن موجوداً
        if (!db.database[state.subject]) db.database[state.subject] = {};
        if (!db.database[state.subject][state.doctor]) {
            db.database[state.subject][state.doctor] = { sections: [] };
        }
        if (!db.database[state.subject][state.doctor][state.sectionName]) {
            db.database[state.subject][state.doctor][state.sectionName] = [];
        }

        // إضافة الملف للقسم
        db.database[state.subject][state.doctor][state.sectionName].push({ 
            name: state.file.name, 
            link: githubLink,
            date: new Date().toLocaleString()
        });
        
        await saveDatabase(db);
        
        bot.editMessageText(
            chatId, 
            messageId, 
            `✅ تم الرفع بنجاح!\n\n📂 ${state.subject}\n👨‍🏫 ${state.doctor}\n📁 ${state.sectionName}\n\n🔗 [تحميل الملف](${githubLink})`, 
            { parse_mode: 'Markdown' }
        );
        delete userStates[chatId];

    } catch (error) {
        console.error("Error in file handling:", error);
        bot.sendMessage(chatId, `❌ حدث خطأ أثناء الرفع: ${error.message}`);
    }
}

// ==========================================
// 6. دالة رفع النصوص (إشعارات)
// ==========================================

async function processTextNotification(chatId, content, messageId) {
    // البحث عن اسم الدكتور بعد علامة @
    const doctorNameMatch = content.match(/@(\w+)/);
    
    if (doctorNameMatch) {
        const doctorName = doctorNameMatch[1]; // الاسم بدون @
        const subjectName = "General"; // الإشعارات تذهب للمادة General افتراضياً
        await processTextNotificationInternal(chatId, content, messageId, subjectName, doctorName);
    } else {
        bot.sendMessage(chatId, `❌ لم يتم العثور على دكتور في الرسالة. تأكد من كتابة اسم الدكتور يسببه بعلامة @ (مثال: @DrName).`);
    }
}

async function processTextNotificationInternal(chatId, text, messageId, subjectName, doctorName) {
    const db = await getDatabase();
    
    // التأكد من وجود المسار في قاعدة البيانات
    if (!db.database[subjectName]) db.database[subjectName] = {};
    if (!db.database[subjectName][doctorName]) {
        db.database[subjectName][doctorName] = { sections: ["🔔 Notifications"] };
        db.database[subjectName][doctorName]["🔔 Notifications"] = [];
    }

    // التأكد من وجود قسم الإشعارات
    if (!db.database[subjectName][doctorName]["🔔 Notifications"]) {
        db.database[subjectName][doctorName]["🔔 Notifications"] = [];
    }

    // حفظ الإشعار
    db.database[subjectName][doctorName]["🔔 Notifications"].unshift({
        name: text,
        date: new Date().toLocaleString(),
        type: "notif",
        id: Date.now().toString()
    });

    try {
        await saveDatabase(db);
        if (messageId) {
            // نحاول تعديل الرسالة إذا كانت موجودة (في حالة الكالباك)
            try {
                bot.editMessageText(chatId, messageId, `✅ تم إرسال الإشعار بنجاح!`, { parse_mode: 'Markdown' });
            } catch(e) {
                // إذا فشل التعديل (رسالة قديمة جداً)، نرسل رسالة جديدة
                bot.sendMessage(chatId, `✅ تم إرسال الإشعار بنجاح!`);
            }
        } else {
            bot.sendMessage(chatId, `✅ تم إرسال الإشعار بنجاح!`);
        }
        delete userStates[chatId];
    } catch (err) {
        console.error("Error saving notification:", err);
        bot.sendMessage(chatId, "❌ فشل إرسال الإشعار. (Error saving to DB)");
    }
}

console.log("Bot is running...");