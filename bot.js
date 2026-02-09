// ==========================================
// 1. استيراد المكتبات
// ==========================================
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const express = require('express');
const bodyParser = require('body-parser');
const { pipeline } = require('stream/promises');

// ==========================================
// 2. الإعدادات والتهيئة
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
const lastFileUploads = {}; 
let dbCache = null;
let lastCacheTime = 0;
const CACHE_DURATION = 60000; 

const PORT = process.env.PORT || 3000;

// ==========================================
// 3. دوال Google Drive
// ==========================================

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
        } else {
            const folder = await drive.files.create({
                resource: { 'name': DRIVE_ROOT_FOLDER_NAME, 'mimeType': 'application/vnd.google-apps.folder' },
                fields: 'id'
            });
            ROOT_FOLDER_ID = folder.data.id;
        }
        return ROOT_FOLDER_ID;
    } catch (error) {
        console.error('[Drive] Root Folder Error:', error.message);
        throw error;
    }
}

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
    } catch (error) {
        console.error('[Drive] Delete Error:', error.message);
    }
}

// ==========================================
// 4. دوال قاعدة البيانات
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
// 5. وظيفة الرفع الرئيسية
// ==========================================

async function executeUpload(chatId) {
    const state = userStates[chatId];
    
    if (!state) {
        console.error(`[Critical] State missing for chatId: ${chatId}`);
        return;
    }

    if (!state.file) {
        console.error(`[Critical] File data missing for chatId: ${chatId}`);
        return;
    }

    let tempFilePath = null;
    let statusMsg = null;

    try {
        console.log(`[Upload] Starting upload for file: ${state.file.name}`);
        console.log(`[Upload] Using File ID: ${state.file.id}`);

        statusMsg = await bot.sendMessage(chatId, "⏳ Initializing...");
        const statusMsgId = statusMsg.message_id;

        const updateText = async (text) => {
            try {
                await bot.editMessageText(text, { 
                    chat_id: chatId, 
                    message_id: statusMsgId,
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true 
                });
            } catch (e) {}
        };

        // 1. تحميل الملف
        updateText("⏳ Downloading From Telegram...");
        
        let fileIdToUse = state.file.id;

        try {
            if (!fileIdToUse || typeof fileIdToUse !== 'string') {
                throw new Error("Invalid File ID in state");
            }

            const fileLink = await bot.getFileLink(fileIdToUse);
            tempFilePath = path.join('/tmp', `upload_${Date.now()}_${state.file.name}`);
            
            const writer = fs.createWriteStream(tempFilePath);
            const tgStream = await axios({ 
                url: fileLink, 
                responseType: 'stream',
                timeout: 60000 
            });
            
            await pipeline(tgStream.data, writer);
        } catch (downloadError) {
            console.error('[Download Error]', downloadError.message);
            throw new Error("Failed to download file. Please try again.");
        }

        // 2. تجهيز البيانات والمجلدات
        updateText("⏳ Preparing Drive Structure...");
        
        const [rootId, db] = await Promise.all([
            getRootFolderId(),
            getDatabase()
        ]);

        if (!db.database[state.subject]) db.database[state.subject] = {};
        if (!db.database[state.subject][state.doctor]) db.database[state.subject][state.doctor] = {};
        if (!db.database[state.subject][state.doctor][state.section]) {
            db.database[state.subject][state.doctor][state.section] = [];
        }

        // 3. إنشاء المجلدات
        updateText("⏳ Uploading To Drive...");
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

        const finalText = `✅ Upload Completed \n📂 ${state.subject} / ${state.doctor} / ${state.section}\n📝 Name: *${state.file.name}*\n🔗 ${driveResult.link}`;
        await updateText(finalText);

    } catch (error) {
        console.error('[Upload Fatal Error]', error);
        bot.sendMessage(chatId, `❌ Upload Failed: ${error.message}\n\nPlease try sending the file again.`);
    } finally {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
        }
        delete userStates[chatId];
        console.log(`[Upload] Cleaned up state for ${chatId}`);
    }
}

// ==========================================
// 6. API للحذف
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
// 7. معالجة الرسائل والأوامر (منطق مبسط ومصحح)
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

    // حفظ الملف الأخير للاستعادة عند الحاجة (احتياطي)
    lastFileUploads[chatId] = {
        fileId: fileId,
        fileName: fileName,
        timestamp: Date.now()
    };

    // تعيين الحالة الجديدة (مسح أي حالة سابقة)
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
    
    // فلترة الرسائل غير النصية والأوامر
    if (!text || text.startsWith('/')) return;
    if (msg.document || msg.photo) return;
    if (!AUTHORIZED_USERS.includes(chatId)) return;

    const state = userStates[chatId];

    // ==========================================
    // الحالة 1: المستخدم يرسل اسم الملف الجديد
    // ==========================================
    if (state && state.step === 'waiting_for_new_name') {
        console.log(`[Action] User sent new name: ${text}`);
        state.file.name = text.trim();
        state.step = 'ready_to_upload'; 
        executeUpload(chatId);
        return; // وقف التنفيذ
    }

    // ==========================================
    // الحالة 2: لا توجد حالة نشطة (State Null)
    // ==========================================
    if (!state) {
        // إذا لم تكن هناك حالة، فهذا يعني إما أن المستخدم بدأ محادثة جديدة
        // أو تم عمل reset للبوت. نعتبرها رسالة نصية (إشعار).
        console.log(`[Action] New Notification started`);
        
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
        return;
    }

    // ==========================================
    // الحالة 3: يوجد حالة نشطة ولكن ليست "انتظار اسم"
    // (مثلاً المستخدم يرسل نصاً أثناء اختيار المادة)
    // في هذه الحالة نتجاهل الرسالة أو نعتبرها خطأ
    // ==========================================
    console.log(`[Ignored] User sent text while in step: ${state.step}`);
});

// ==========================================
// 8. معالجة الأزرار (Callback Query)
// ==========================================

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const state = userStates[chatId];

    if (!AUTHORIZED_USERS.includes(chatId)) return;
    // ملاحظة: لا نتحقق من وجود state هنا لأن بعض العمليات قد تحتاج لبدء جديد
    // ولكن في هذا الكود نعتمد على وجود state

    try {
        if (state && state.step === 'select_subject' && data.startsWith('sub_')) {
            const subjectName = data.replace('sub_', '');
            state.subject = subjectName; 
            state.step = 'select_doctor';
            
            const db = await getDatabase();
            const doctors = Object.keys(db.database[subjectName] || {});
            const keyboard = doctors.map(doc => [{ text: doc, callback_data: `doc_${doc}` }]);
            
            await bot.editMessageText(`Subject : *${subjectName}*\n\ Select Doctor :`, {
                chat_id: chatId, message_id: query.message.message_id,
                reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
            });
        }
        else if (state && state.step === 'select_doctor' && data.startsWith('doc_')) {
            const doctorName = data.replace('doc_', '');
            state.doctor = doctorName;

            if (state.type === 'text') {
                await processTextNotification(chatId, state, query.message.message_id);
            } else {
                state.step = 'select_section';
                const db = await getDatabase();
                const sections = Object.keys(db.database[state.subject][state.doctor] || {});
                const keyboard = sections.map(sec => [{ text: sec, callback_data: `sec_${sec}` }]);
                
                await bot.editMessageText(`Doctor : *${doctorName}*\n\ Select Section :`, {
                    chat_id: chatId, message_id: query.message.message_id,
                    reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
                });
            }
        }
        else if (state && state.step === 'select_section' && data.startsWith('sec_')) {
            const sectionName = data.replace('sec_', '');
            state.section = sectionName;
            state.step = 'confirm_name'; 

            const nameKeyboard = [
                [{ text: "✅ Same Name", callback_data: 'act_same' }],
                [{ text: "✏️ Rename", callback_data: 'act_rename' }]
            ];

            await bot.editMessageText(`📂 Section: *${sectionName}*\n\n📝  Current File Name :\n\`${state.file.name}\`\n\ Choose An Action :`, {
                chat_id: chatId, 
                message_id: query.message.message_id,
                reply_markup: { inline_keyboard: nameKeyboard }, 
                parse_mode: 'Markdown'
            });
        }
        else if (state && state.step === 'confirm_name') {
            if (data === 'act_same') {
                executeUpload(chatId);
            } else if (data === 'act_rename') {
                // تغيير الحالة إلى انتظار اسم جديد
                state.step = 'waiting_for_new_name';
                await bot.sendMessage(chatId, "✏️ Send the *new file name* now.", { parse_mode: 'Markdown' });
            }
        }
    } catch (error) {
        console.error('[Callback Error]', error);
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
        await bot.editMessageText(`✅ Notification Send Succefully`, { chat_id: chatId, message_id: messageId });
        delete userStates[chatId];
    } catch (err) {
        console.error("Save Notif Error:", err);
        await bot.sendMessage(chatId, "❌ Failed To Save Notification");
    }
}

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    getRootFolderId().then(() => console.log("Drive Connected (Free Mode)"));
});