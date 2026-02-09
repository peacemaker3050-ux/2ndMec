const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const express = require('express');
const bodyParser = require('body-parser');
const { pipeline } = require('stream/promises');

// ==========================================
// 1. التهيئة والإعدادات
// ==========================================

const token = '8273814930:AAEdxVzhYjnNZqdJKvpGJC9k1bVf2hcGUV4';

const AUTHORIZED_USERS = [
    5605597142,
    5797320196,
    6732616473,
];

const JSONBIN_BIN_ID = "696e77bfae596e708fe71e9d";
const JSONBIN_ACCESS_KEY = "$2a$10$TunKuA35QdJp478eIMXxRunQfqgmhDY3YAxBXUXuV/JrgIFhU0Lf2";

// إعدادات Google Drive
const CLIENT_ID = '1006485502608-ok2u5i6nt6js64djqluithivsko4mnom.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const DRIVE_REFRESH_TOKEN = '1//03QItIOwcTAOUCgYIARAAGAMSNwF-L9Ir2w0GCrRxk65kRG9pTXDspB--Njlyl3ubMFn3yVjSDuF07fLdOYWjB9_jSbR-ybkzh9U';
const REDIRECT_URI = 'http://localhost';

const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
oAuth2Client.setCredentials({ refresh_token: DRIVE_REFRESH_TOKEN });

// تحديث التوكن تلقائياً عند الحاجة
oAuth2Client.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
        console.log('Google Refresh Token updated.');
    }
});

const drive = google.drive({ version: 'v3', auth: oAuth2Client });

const bot = new TelegramBot(token, { polling: true });
const app = express();
app.use(bodyParser.json());

const userStates = {};
// إضافة ذاكرة تخزين مؤقت (Cache) لتسريع القوائم
let dbCache = null;
let lastCacheTime = 0;
const CACHE_DURATION = 60000; // تحديث الذاكرة كل دقيقة

const PORT = process.env.PORT || 3000;

// ==========================================
// 2. دوال Google Drive (محسنة)
// ==========================================

// تم تغيير اسم المجلد هنا
const DRIVE_ROOT_FOLDER_NAME = '2nd MEC 2026';
let ROOT_FOLDER_ID = null;

async function getRootFolderId() {
    if (ROOT_FOLDER_ID) return ROOT_FOLDER_ID;

    try {
        const res = await drive.files.list({
            q: `mimeType='application/vnd.google-apps.folder' and name='${DRIVE_ROOT_FOLDER_NAME}' and trashed=false`,
            fields: 'files(id, name)',
            spaces: 'drive'
        });

        if (res.data.files.length > 0) {
            ROOT_FOLDER_ID = res.data.files[0].id;
            console.log(`[Drive] Found Root Folder: ${DRIVE_ROOT_FOLDER_NAME}`);
        } else {
            console.log(`[Drive] Creating Root Folder: ${DRIVE_ROOT_FOLDER_NAME}...`);
            const folder = await drive.files.create({
                resource: { 'name': DRIVE_ROOT_FOLDER_NAME, 'mimeType': 'application/vnd.google-apps.folder' },
                fields: 'id'
            });
            ROOT_FOLDER_ID = folder.data.id;
            console.log(`[Drive] Root Folder Created with ID: ${ROOT_FOLDER_ID}`);
        }
        return ROOT_FOLDER_ID;
    } catch (error) {
        console.error('[Drive] Root Folder Error:', error.message);
        throw error;
    }
}

// دالة مساعدة لضمان صلاحية التوكن
async function ensureValidToken() {
    try {
        await oAuth2Client.getAccessToken();
    } catch (e) {
        const { credentials } = await oAuth2Client.refreshAccessToken();
        oAuth2Client.setCredentials(credentials);
    }
}

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
        console.error('[Drive] Folder Error:', error.message);
        throw error;
    }
}

async function uploadFileToDrive(filePath, fileName, folderId) {
    try {
        await ensureValidToken();

        const fileMetadata = {
            'name': fileName,
            'parents': [folderId]
        };
        
        // محاولة كشف نوع الملف بشكل أفضل إذا أمكن، أو الافتراضي
        let mimeType = 'application/pdf';
        if (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) mimeType = 'image/jpeg';
        else if (fileName.endsWith('.png')) mimeType = 'image/png';
        else if (fileName.endsWith('.docx')) mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        
        const media = {
            mimeType: mimeType,
            body: fs.createReadStream(filePath)
        };

        const file = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id, webViewLink'
        });

        // جعل الملف عاماً
        await drive.permissions.create({
            fileId: file.data.id,
            requestBody: {
                role: 'reader',
                type: 'anyone'
            }
        });

        let finalLink = file.data.webViewLink;
        if (!finalLink.includes('usp=sharing')) {
            finalLink += '&usp=sharing';
        }

        return { link: finalLink, id: file.data.id };
    } catch (error) {
        console.error('[Drive] Upload Error:', error.message);
        throw error;
    }
}

async function deleteFileFromDrive(fileId) {
    if (!fileId) return;
    try {
        await drive.files.delete({ fileId: fileId });
        console.log(`[Drive] Deleted: ${fileId}`);
    } catch (error) {
        console.error('[Drive] Delete Error:', error.message);
    }
}

// ==========================================
// 3. دوال قاعدة البيانات (مع Caching)
// ==========================================

async function getDatabase() {
    const now = Date.now();
    if (dbCache && (now - lastCacheTime < CACHE_DURATION)) {
        return dbCache;
    }

    try {
        const response = await axios.get(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
            headers: { 'X-Master-Key': JSONBIN_ACCESS_KEY, 'X-Bin-Meta': 'false' }
        });
        dbCache = response.data;
        lastCacheTime = now;
        return dbCache;
    } catch (error) {
        console.error("DB Fetch Error:", error.message);
        if (dbCache) return dbCache;
        throw error;
    }
}

async function saveDatabase(data) {
    try {
        dbCache = data;
        lastCacheTime = Date.now();
        
        await axios.put(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`, data, {
            headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_ACCESS_KEY }
        });
    } catch (error) {
        console.error("DB Save Error:", error.message);
        throw error;
    }
}

// ==========================================
// 4. وظيفة الرفع الرئيسية
// ==========================================
async function performUpload(state, chatId, editMessageId = null) {
    let statusMsgId = editMessageId;
    let tempFilePath = null;

    try {
        const updateStatus = (text) => {
            if (statusMsgId) {
                bot.editMessageText(text, { chat_id: chatId, message_id: statusMsgId }).catch(e => {});
            } else {
                bot.sendMessage(chatId, text).then(msg => statusMsgId = msg.message_id).catch(e => {});
            }
        };

        updateStatus("⏳ Initializing...");

        // 1. تحميل الملف من تليجرام
        const fileLink = await bot.getFileLink(state.file.id);
        tempFilePath = path.join('/tmp', `upload_${Date.now()}_${state.file.name}`);
        
        const writer = fs.createWriteStream(tempFilePath);
        const tgStream = await axios({ url: fileLink, responseType: 'stream' });
        
        updateStatus("⏳ Downloading From Telegram...");
        await pipeline(tgStream.data, writer);

        // 2. تجهيز الهيكلية في Drive وجلب البيانات بشكل متوازي
        updateStatus("⏳ Preparing Drive Structure...");
        
        const [rootId, db] = await Promise.all([
            getRootFolderId(),
            getDatabase()
        ]);

        // التأكد من وجود المسار في الذاكرة قبل الحفظ
        if (!db.database[state.subject]) db.database[state.subject] = {};
        if (!db.database[state.subject][state.doctor]) db.database[state.subject][state.doctor] = {};
        if (!db.database[state.subject][state.doctor][state.section]) {
            db.database[state.subject][state.doctor][state.section] = [];
        }

        // 3. إنشاء المجلدات بالتتابع السريع
        updateStatus("⏳ Uploading To Drive...");
        const subjectFolderId = await findOrCreateFolder(state.subject, rootId);
        const doctorFolderId = await findOrCreateFolder(state.doctor, subjectFolderId);
        const sectionFolderId = await findOrCreateFolder(state.section, doctorFolderId);

        // 4. رفع الملف
        const driveResult = await uploadFileToDrive(tempFilePath, state.file.name, sectionFolderId);

        // 5. الحفظ في قاعدة البيانات
        db.database[state.subject][state.doctor][state.section].push({
            name: state.file.name,
            link: driveResult.link,
            driveId: driveResult.id
        });

        await saveDatabase(db);

        // النهاية
        const finalText = `✅ Upload Completed \n📂 ${state.subject} / ${state.doctor} / ${state.section}\n📝 Name: *${state.file.name}*\n🔗 ${driveResult.link}`;
        updateStatus(finalText);
        
        if (statusMsgId) {
            bot.editMessageText(finalText, {
                chat_id: chatId,
                message_id: statusMsgId,
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            }).catch(e => {});
        }

    } catch (error) {
        console.error('[Upload Error]', error);
        bot.sendMessage(chatId, `❌ Upload Failed: ${error.message}`);
    } finally {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
        }
        delete userStates[chatId];
    }
}

// ==========================================
// 5. API للحذف
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
// 6. أوامر تليجرام
// ==========================================

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    if (!AUTHORIZED_USERS.includes(chatId)) return;
    bot.sendMessage(chatId, "👋 Peace Maker Welcomes You\n\n ✨ We're Glad To Have You Here\n📄 Send File OR Text To Begin", { parse_mode: 'Markdown' });
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
    
    bot.sendMessage(chatId, `📂 File: *${fileName}*\n\ Select Subject :`, {
        reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
    });
}

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    if (!AUTHORIZED_USERS.includes(chatId)) return;

    const state = userStates[chatId];

    // 1. منطق تغيير اسم الملف
    if (state && state.step === 'waiting_for_new_name') {
        if (!text || text.startsWith('/')) return; 
        
        state.file.name = text.trim();
        state.step = 'ready_to_upload'; 
        performUpload(state, chatId);
        return;
    }

    // 2. منطق إرسال الإشعار النصي
    if (text && !text.startsWith('/') && !msg.document && !msg.photo) {
        userStates[chatId] = {
            step: 'select_subject',
            type: 'text',
            content: text
        };

        const data = await getDatabase();
        const subjects = Object.keys(data.database);
        const keyboard = subjects.map(sub => [{ text: sub, callback_data: `sub_${sub}` }]);
        bot.sendMessage(chatId, `📝  New Message: "${text}"\n\Select Subject :`, {
            reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
        });
    }
});

// ==========================================
// 7. معالجة الأزرار (Callback Query)
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
        const doctors = Object.keys(db.database[subjectName] || {});
        const keyboard = doctors.map(doc => [{ text: doc, callback_data: `doc_${doc}` }]);
        
        bot.editMessageText(`Subject : *${subjectName}*\n\ Select Doctor :`, {
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
            const sections = Object.keys(db.database[state.subject][state.doctor] || {});
            const keyboard = sections.map(sec => [{ text: sec, callback_data: `sec_${sec}` }]);
            
            bot.editMessageText(`Doctor : *${doctorName}*\n\ Select Section :`, {
                chat_id: chatId, message_id: query.message.message_id,
                reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
            });
        }
    }
    else if (state.step === 'select_section' && data.startsWith('sec_')) {
        const sectionName = data.replace('sec_', '');
        state.section = sectionName;
        state.step = 'confirm_name'; 

        const nameKeyboard = [
            [{ text: "✅ Same Name", callback_data: 'act_same' }],
            [{ text: "✏️ Rename", callback_data: 'act_rename' }]
        ];

        bot.editMessageText(`📂 Section: *${sectionName}*\n\n📝  Current File Name :\n\`${state.file.name}\`\n\ Choose An Action :`, {
            chat_id: chatId, 
            message_id: query.message.message_id,
            reply_markup: { inline_keyboard: nameKeyboard }, 
            parse_mode: 'Markdown'
        });
    }
    else if (state.step === 'confirm_name') {
        if (data === 'act_same') {
            performUpload(state, chatId, query.message.message_id);
        } else if (data === 'act_rename') {
            state.step = 'waiting_for_new_name';
            bot.sendMessage(chatId, "✏️ Enter The New File Name :");
        }
    }
});

async function processTextNotification(chatId, state, messageId) {
    const db = await getDatabase();
    
    if (!db.database[state.subject]) db.database[state.subject] = {};
    if (!db.database[state.subject][state.doctor]) db.database[state.subject][state.doctor] = {};
    
    const docData = db.database[state.subject][state.doctor];
    if (!docData["🔔 Notifications"]) docData["🔔 Notifications"] = [];
    
    docData["🔔 Notifications"].unshift({
        name: state.content,
        date: new Date().toLocaleString(),
        type: "notif"
    });

    try {
        await saveDatabase(db);
        bot.editMessageText(`✅ Notification Send Succefully`, { chat_id: chatId, message_id: messageId });
        delete userStates[chatId];
    } catch (err) {
        bot.sendMessage(chatId, "❌ Failed To Save Notification");
    }
}

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    getRootFolderId().then(() => console.log("Drive Connected (Free Mode)"));
});