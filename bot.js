const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs'); 
const path = require('path');
const { google } = require('googleapis');
const express = require('express');
const bodyParser = require('body-parser');

// ==========================================
// 1. التهيئة
// ==========================================

const token = '8273814930:AAEdxVzhYjnNZqdJKvpGJC9k1bVf2hcGUV4'; 

const AUTHORIZED_USERS = [
    5605597142, 
];

const JSONBIN_BIN_ID = "696e77bfae596e708fe71e9d";
const JSONBIN_ACCESS_KEY = "$2a$10$TunKuA35QdJp478eIMXxRunQfqgmhDY3YAxBXUXuV/JrgIFhU0Lf2";

// ==========================================
// إعدادات Google Drive (بدون Service Account)
// ==========================================

// ضع هنا الـ refresh_token الذي حصلت عليه من الخطوة السابقة
const DRIVE_REFRESH_TOKEN = '1//03QItIOwcTAOUCgYIARAAGAMSNwF-L9Ir2w0GCrRxk65kRG9pTXDspB--Njlyl3ubMFn3yVjSDuF07fLdOYWjB9_jSbR-ybkzh9U'; 

const CLIENT_ID = 'your_client_id_from_json';         // من ملف client_secret.json
const CLIENT_SECRET = 'your_client_secret_from_json'; // من ملف client_secret.json
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

const oAuth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
);

oAuth2Client.setCredentials({
    refresh_token: DRIVE_REFRESH_TOKEN
});

// هذا الحدث سيقوم بتجديد التوكن تلقائياً إذا انتهت صلاحيته
oAuth2Client.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
        // حفظ التوكن الجديد لو حاب (بس الرفريش معمول مش يتغير غالباً)
        console.log('Refresh Token updated.');
    }
});

const drive = google.drive({ version: 'v3', auth: oAuth2Client });

const bot = new TelegramBot(token, { polling: true });
const app = express();
app.use(bodyParser.json());

const userStates = {}; 
const PORT = process.env.PORT || 3000;

// ==========================================
// 2. دوال Google Drive
// ==========================================

async function findOrCreateFolder(folderName, parentId) {
    try {
        const res = await drive.files.list({
            q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false and '${parentId}' in parents`,
            fields: 'files(id, name)',
            spaces: 'drive'
        });

        if (res.data.files.length > 0) {
            return res.data.files[0].id;
        }

        const fileMetadata = {
            'name': folderName,
            'mimeType': 'application/vnd.google-apps.folder',
            'parents': [parentId]
        };
        const folder = await drive.files.create({
            resource: fileMetadata,
            fields: 'id'
        });
        return folder.data.id;
    } catch (error) {
        console.error('[Drive] Error:', error.message);
        // إذا فشل الرفع بسبب الصلاحية، حاول إعادة التوثيق
        if (error.message.includes('invalid')) {
            console.log("Attempting to refresh token...");
            const { credentials } = await oAuth2Client.refreshAccessToken();
            oAuth2Client.setCredentials(credentials);
            // إعادة المحاولة (يمكن تكرار الدالة هنا للاكتمال)
        }
        throw error;
    }
}

async function uploadFileToDrive(filePath, fileName, folderId) {
    try {
        const fileMetadata = {
            'name': fileName,
            'parents': [folderId]
        };
        const media = {
            mimeType: 'application/pdf', 
            body: fs.createReadStream(filePath)
        };

        const file = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id, webViewLink'
        });

        // جعل الملف عاماً (Public) لضمان عمله في الموقع
        await drive.permissions.create({
            fileId: file.data.id,
            requestBody: {
                role: 'reader',
                type: 'anyone'
            }
        });

        return {
            link: file.data.webViewLink,
            id: file.data.id
        };
    } catch (error) {
        console.error('[Drive] Upload Error:', error.message);
        throw error;
    }
}

async function deleteFileFromDrive(fileId) {
    try {
        if (!fileId) return;
        await drive.files.delete({ fileId: fileId });
        console.log(`[Drive] Deleted file ID: ${fileId}`);
    } catch (error) {
        console.error('[Drive] Delete Error:', error.message);
    }
}

let ROOT_FOLDER_ID = null;

async function getRootFolderId() {
    if (ROOT_FOLDER_ID) return ROOT_FOLDER_ID;
    
    const res = await drive.files.list({
        q: "mimeType='application/vnd.google-apps.folder' and name='UniBot Files' and trashed=false",
        fields: 'files(id, name)',
        spaces: 'drive'
    });

    if (res.data.files.length > 0) {
        ROOT_FOLDER_ID = res.data.files[0].id;
    } else {
        console.warn("[Drive] Creating Root Folder...");
        const folder = await drive.files.create({
            resource: { 'name': 'UniBot Files', 'mimeType': 'application/vnd.google-apps.folder' },
            fields: 'id'
        });
        ROOT_FOLDER_ID = folder.data.id;
    }
    return ROOT_FOLDER_ID;
}

// ==========================================
// 3. دوال قاعدة البيانات
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
// 4. API للحذف
// ==========================================

app.post('/delete-drive-file', async (req, res) => {
    const { fileId } = req.body;
    if (fileId) {
        await deleteFileFromDrive(fileId);
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false });
    }
});

// ==========================================
// 5. أوامر تليجرام
// ==========================================

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    if (!AUTHORIZED_USERS.includes(chatId)) return;
    bot.sendMessage(chatId, "👋 أهلاً بك في نظام MecWeb (Drive Free Mode).\n\n✨ تم ربط البوت بـ Google Drive بدون رسوم.\n📄 أرسل ملفاً للبدء.", { parse_mode: 'Markdown' });
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

    const API = await getDatabase();
    const subjects = Object.keys(API.database);
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

// ==========================================
// 6. منطق الرفع (Upload)
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
        bot.answerCallbackQuery(query.id, { text: "⏳ جاري الرفع على Drive..." });

        try {
            // 1. تحميل الملف مؤقتاً
            const fileLink = await bot.getFileLink(state.file.id);
            const tempFilePath = path.join('/tmp', state.file.name);
            
            const response = await axios({ url: fileLink, responseType: 'stream' });
            const writer = fs.createWriteStream(tempFilePath);
            response.data.pipe(writer);

            await new Promise((resolve) => writer.on('finish', resolve));

            // 2. التحضير للرفع على Drive
            const rootId = await getRootFolderId();
            const subjectFolderId = await findOrCreateFolder(state.subject, rootId);
            const doctorFolderId = await findOrCreateFolder(state.doctor, subjectFolderId);
            const sectionFolderId = await findOrCreateFolder(sectionName, doctorFolderId);

            // 3. الرفع
            const driveResult = await uploadFileToDrive(tempFilePath, state.file.name, sectionFolderId);
            
            // تنظيف
            fs.unlink(tempFilePath, (err) => { if(err) console.error(err); });

            // 4. الحفظ في قاعدة البيانات
            const db = await getDatabase();
            if (!db.database[state.subject][state.doctor][sectionName]) {
                db.database[state.subject][state.doctor][sectionName] = [];
            }

            db.database[state.subject][state.doctor][sectionName].push({ 
                name: state.file.name, 
                link: driveResult.link, 
                driveId: driveResult.id 
            });
            
            await saveDatabase(db);
            bot.editMessageText(`✅ تم الرفع بنجاح!\n🔗 ${driveResult.link}`, { 
                chat_id: chatId, message_id: query.message.message_id,
                disable_web_page_preview: true
            });
            delete userStates[chatId];
        } catch (error) {
            console.error(error);
            bot.sendMessage(chatId, `❌ خطأ في الرفع: ${error.message}`);
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
    // التأكد من المجلد الرئيسي
    getRootFolderId().then(() => console.log("Drive Connected (Free Mode)"));
});