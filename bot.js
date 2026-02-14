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

// REPLACE WITH YOUR ENVIRONMENT VARIABLES
const token = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_TELEGRAM_TOKEN';

const AUTHORIZED_USERS = [
    5605597142,
    5797320196,
    6732616473,
];

const JSONBIN_BIN_ID = process.env.JSONBIN_ID || "696e77bfae596e708fe71e9d";
const JSONBIN_ACCESS_KEY = process.env.JSONBIN_KEY || "YOUR_JSONBIN_KEY";

// إعدادات Google Drive
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'YOUR_CLIENT_ID';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'YOUR_CLIENT_SECRET';
const DRIVE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || 'YOUR_REFRESH_TOKEN';
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
            spaces: 'drive',
            supportsAllDrives: true
        });

        if (res.data.files.length > 0) {
            ROOT_FOLDER_ID = res.data.files[0].id;
        } else {
            const folder = await drive.files.create({
                resource: { 'name': DRIVE_ROOT_FOLDER_NAME, 'mimeType': 'application/vnd.google-apps.folder' },
                fields: 'id',
                supportsAllDrives: true
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
            spaces: 'drive',
            supportsAllDrives: true
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
            fields: 'id',
            supportsAllDrives: true
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

        console.log(`[Drive] Uploading ${fileName}...`);

        const file = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id, webViewLink',
            supportsAllDrives: true,
            supportsTeamDrives: true
        });

        console.log(`[Drive] Upload successful. ID: ${file.data.id}`);

        await drive.permissions.create({
            fileId: file.data.id,
            requestBody: {
                role: 'reader',
                type: 'anyone'
            },
            supportsAllDrives: true
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
        await drive.files.delete({ 
            fileId: fileId,
            supportsAllDrives: true
        });
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
// 5. دوال مساعدة للتنقل
// ==========================================

function getCurrentFolderContent(db, subject, doctor, pathIds) {
    if (!db.database[subject] || !db.database[subject][doctor]) return [];
    let doctorData = db.database[subject][doctor];
    if (!doctorData.root) doctorData.root = []; 
    let currentList = doctorData.root;
    for (let folderId of pathIds) {
        const folder = currentList.find(item => item.id === folderId && item.type === 'folder');
        if (folder && folder.children) currentList = folder.children;
        else return [];
    }
    return currentList;
}

// ==========================================
// 6. وظيفة الرفع الرئيسية
// ==========================================

async function executeUpload(chatId) {
    const state = userStates[chatId];
    
    if (!state || !state.file) {
        console.error(`[Critical] State/File missing for chatId: ${chatId}`);
        delete userStates[chatId];
        return;
    }

    let tempFilePath = null;
    let statusMsg = null;

    try {
        console.log(`[Upload] Starting upload for file: ${state.file.name}`);
        console.log(`[Path] Subject: ${state.subject}, Doctor: ${state.doctor}, Folders: ${state.folderPathNames.join(' > ')}`);

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
            } catch (e) { console.log("Edit msg error (user might have deleted it):", e.message); }
        };

        // 1. تحميل الملف
        updateText("⏳ Downloading From Telegram...");
        
        try {
            const rawFileLink = await bot.getFileLink(state.file.id);
            const encodedFileLink = encodeURI(rawFileLink);
            const safeFileName = state.file.name.replace(/[^a-zA-Z0-9.\-__\u0600-\u06FF]/g, "_");
            tempFilePath = path.join('/tmp', `upload_${Date.now()}_${safeFileName}`);
            
            const writer = fs.createWriteStream(tempFilePath);
            
            const tgStream = await axios({ 
                url: encodedFileLink, 
                responseType: 'stream',
                timeout: 900000 
            });
            
            await pipeline(tgStream.data, writer);
            console.log(`[Download] File saved to: ${tempFilePath}`);

            const stats = fs.statSync(tempFilePath);
            if (stats.size === 0) {
                 throw new Error("Downloaded file is empty (0 bytes). Telegram file might be corrupted or download failed silently.");
            }
            console.log(`[Download] File size verified: ${stats.size} bytes`);
            
        } catch (downloadError) {
            console.error('[Download Error]', downloadError.message);
            let errorMsg = "Failed to download file. Connection timeout or invalid file.";
            if (downloadError.code === 'ECONNABORTED') {
                errorMsg = "⏱️ **Download Aborted:** The file download was cancelled or connection was reset.";
            } else if (downloadError.code === 'ETIMEDOUT') {
                errorMsg = "⏱️ **Download Timeout:** The file is too large or internet is too slow (waited 15 mins). Please try again later.";
            }
            throw new Error(errorMsg);
        }

        await new Promise(resolve => setTimeout(resolve, 1000)); 

        // 2. تجهيز البيانات
        updateText("⏳ Preparing Drive Structure...");
        const [rootId, db] = await Promise.all([
            getRootFolderId(),
            getDatabase()
        ]);

        // 3. بناء هيكل المجلدات في Drive (Recursive)
        let folderNames = [state.subject, state.doctor, ...state.folderPathNames];
        let currentDriveId = rootId;

        updateText(`⏳ Creating Folders & Uploading to: ${state.folderPathNames.length > 0 ? state.folderPathNames[state.folderPathNames.length-1] : 'Root'}`);
        
        for (let name of folderNames) {
            currentDriveId = await findOrCreateFolder(name, currentDriveId);
        }

        // 4. رفع الملف
        console.log(`[Upload] Initiating Drive upload...`);
        const uploadPromise = uploadFileToDrive(tempFilePath, state.file.name, currentDriveId);
        
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error("Upload Timeout (10 mins)")), 600000) 
        );

        let driveResult;
        try {
            driveResult = await Promise.race([uploadPromise, timeoutPromise]);
        } catch (err) {
            console.error('[Upload] Drive upload failed/timed out:', err.message);
            throw new Error(`Google Drive Upload Failed: ${err.message}`);
        }

        // 5. الحفظ في قاعدة البيانات
        let currentList = db.database[state.subject][state.doctor].root;
        for (let folderId of state.folderPathIds) {
            const folder = currentList.find(i => i.id === folderId && i.type === 'folder');
            if (folder) currentList = folder.children;
        }

        currentList.push({
            id: Date.now().toString(36),
            name: state.file.name,
            type: 'file',
            link: driveResult.link,
            driveId: driveResult.id
        });

        try {
            await saveDatabase(db);
            const displayName = decodeURI(state.file.name).replace(/\+/g, ' ');
            const folderPathStr = state.folderPathNames.join(' / ');
            const finalText = `✅ Upload Completed \n📂 ${state.subject} / ${state.doctor}${folderPathStr ? ' / ' + folderPathStr : ''}\n📝 Name: *${displayName}*\n🔗 ${driveResult.link}`;
            await updateText(finalText);
        } catch (dbError) {
            console.error('[DB Save Error]', dbError.message);
            await updateText(`⚠️ **Upload Partially Failed**\n\n✅ Uploaded to Drive successfully.\n❌ Failed to update Site Database.\n\n🔗 Drive Link: ${driveResult.link}\n\n*Please try saving again or contact admin.*`);
        }

    } catch (error) {
        console.error('[Upload Fatal Error]', error);
        await bot.sendMessage(chatId, `❌ Upload Failed: ${error.message}\n\nPlease try sending the file again.`);
    } finally {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
        }
        delete userStates[chatId];
        console.log(`[Upload] Cleaned up state for ${chatId}`);
    }
}

// ==========================================
// 7. Scheduler Logic (NEW)
// ==========================================

async function checkScheduledNotifications() {
    try {
        const db = await getDatabase();
        if (!db.scheduledNotifications || db.scheduledNotifications.length === 0) return;

        const now = Date.now();
        const dueNotifications = db.scheduledNotifications.filter(n => n.timestamp <= now && !n.sent);

        if (dueNotifications.length > 0) {
            console.log(`[Scheduler] Found ${dueNotifications.length} due notifications.`);
            
            for (const notif of dueNotifications) {
                // 1. Add to Doctor's Notification Folder
                const { subject, doctor, messageBody, id } = notif;
                
                if (db.database[subject] && db.database[subject][doctor]) {
                    const docRoot = db.database[subject][doctor].root || [];
                    let notifFolder = docRoot.find(f => f.name === "🔔 Notifications" && f.type === 'folder');
                    
                    if (!notifFolder) {
                        notifFolder = { id: 'def_notif_' + Date.now(), name: "🔔 Notifications", type: "folder", children: [] };
                        docRoot.push(notifFolder);
                    }

                    notifFolder.children.unshift({
                        id: id,
                        name: messageBody,
                        date: new Date().toLocaleString(),
                        type: "notif",
                        fullDate: now
                    });
                }

                // 2. Add to Recent Updates (Triggers SW/Popup)
                if (!db.recentUpdates) db.recentUpdates = [];
                
                db.recentUpdates.unshift({
                    id: id,
                    doctor: doctor,
                    subject: subject,
                    timestamp: now,
                    messageBody: messageBody // Critical for popup
                });
                
                // Keep recent updates limited to 5
                if (db.recentUpdates.length > 5) db.recentUpdates = db.recentUpdates.slice(0, 5);
                db.latestNotificationUpdate = now;

                // 3. Mark as sent in scheduled list so we don't process it again
                const scheduledIndex = db.scheduledNotifications.findIndex(n => n.id === id);
                if (scheduledIndex !== -1) {
                    db.scheduledNotifications[scheduledIndex].sent = true;
                }
            }

            // Clean up sent scheduled notifications (optional, keeps DB clean)
            db.scheduledNotifications = db.scheduledNotifications.filter(n => !n.sent);

            await saveDatabase(db);
            console.log("[Scheduler] Processed and saved notifications.");
        }
    } catch (error) {
        console.error("[Scheduler] Error:", error.message);
    }
}

// Run Scheduler every 60 seconds
setInterval(checkScheduledNotifications, 60000);

// ==========================================
// 8. API للحذف
// ==========================================

app.post('/delete-drive-file', async (req, res) => {
    // WARNING: No auth check on this endpoint. Fix this in production.
    const { fileId } = req.body;
    if (fileId) {
        await deleteFileFromDrive(fileId);
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false });
    }
});

// ==========================================
// 9. معالجة الرسائل والأوامر
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

    if (userStates[chatId]) {
        bot.sendMessage(chatId, "⚠️ **Busy!**\n\nيرجى الانتظار حتى انتهاء الرفع الحالي قبل إرسال ملف جديد.\n\nSending multiple files quickly will cause the bot to freeze.");
        return;
    }

    const fileId = msg.document ? msg.document.file_id : msg.file_id;
    const fileName = msg.document ? (msg.document.file_name || "file_" + Date.now()) : msg.file_name;

    lastFileUploads[chatId] = {
        fileId: fileId,
        fileName: fileName,
        timestamp: Date.now()
    };

    userStates[chatId] = {
        step: 'select_subject',
        type: 'file',
        file: { id: fileId, name: fileName },
        folderPathIds: [],
        folderPathNames: []
    };

    try {
        const API = await getDatabase();
        const subjects = Object.keys(API.database);
        const keyboard = subjects.map(sub => [{ text: sub, callback_data: `sub_${sub}` }]);
        
        bot.sendMessage(chatId, `📂 File: *${fileName}*\n\ Select Subject :`, {
            reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
        });
    } catch (e) {
        delete userStates[chatId];
        bot.sendMessage(chatId, "❌ Failed to load database. Please try again.");
    }
}

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    if (!text || text.startsWith('/')) return;
    if (msg.document || msg.photo) return;
    if (!AUTHORIZED_USERS.includes(chatId)) return;

    const state = userStates[chatId];

    if (state) {
        if (state.step === 'waiting_for_new_name') {
            console.log(`[Action] User sent new name: "${text}"`);
            state.file.name = text.trim();
            state.step = 'uploading'; 
            executeUpload(chatId);
        } else {
            console.log(`[Ignored] User sent text while busy in step: ${state.step}`);
        }
        return; 
    }

    if (!state) {
        console.log(`[Action] New Notification started`);
        
        userStates[chatId] = {
            step: 'select_subject',
            type: 'text',
            content: text,
            folderPathIds: [], 
            folderPathNames: []
        };

        try {
            const data = await getDatabase();
            const subjects = Object.keys(data.database);
            const keyboard = subjects.map(sub => [{ text: sub, callback_data: `sub_${sub}` }]);
            
            bot.sendMessage(chatId, `📝  New Message: "${text}"\n\Select Subject :`, {
                reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
            });
        } catch (e) {
             delete userStates[chatId];
             bot.sendMessage(chatId, "❌ Failed to load database.");
        }
    }
});

// ==========================================
// 10. معالجة الأزرار (Callback Query)
// ==========================================

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const state = userStates[chatId];

    if (!AUTHORIZED_USERS.includes(chatId)) {
        await bot.answerCallbackQuery(query.id, "Unauthorized");
        return;
    }

    try {
        if (state && state.step === 'select_subject' && data.startsWith('sub_')) {
            const subjectName = data.replace('sub_', '');
            state.subject = subjectName; 
            state.step = 'select_doctor';
            
            const db = await getDatabase();
            const doctors = db.database[subjectName] ? db.database[subjectName].doctors : [];
            const keyboard = doctors.map(doc => [{ text: doc, callback_data: `doc_${doc}` }]);
            
            await bot.editMessageText(`Subject : *${subjectName}*\n\ Select Doctor :`, {
                chat_id: chatId, message_id: query.message.message_id,
                reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
            });
        }
        
        else if (state && state.step === 'select_doctor' && data.startsWith('doc_')) {
            const doctorName = data.replace('doc_', '');
            state.doctor = doctorName;
            state.step = 'navigate_folder';

            if (state.type === 'text') {
                await processTextNotification(chatId, state, query.message.message_id);
                return;
            }

            await renderFolderContents(chatId, query.message.message_id, state);
        }

        else if (state && state.step === 'navigate_folder') {
            
            if (data === 'back') {
                if (state.folderPathIds.length > 0) {
                    state.folderPathIds.pop();
                    state.folderPathNames.pop();
                    await renderFolderContents(chatId, query.message.message_id, state);
                } else {
                    state.step = 'select_doctor';
                    state.doctor = null;
                    const db = await getDatabase();
                    const doctors = db.database[state.subject] ? db.database[state.subject].doctors : [];
                    const keyboard = doctors.map(doc => [{ text: doc, callback_data: `doc_${doc}` }]);
                    
                    await bot.editMessageText(`Subject : *${state.subject}*\n\ Select Doctor :`, {
                        chat_id: chatId, message_id: query.message.message_id,
                        reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
                    });
                }
            }
            
            else if (data.startsWith('folder_')) {
                const folderId = data.replace('folder_', '');
                const db = await getDatabase();
                const currentList = getCurrentFolderContent(db, state.subject, state.doctor, state.folderPathIds);
                const folder = currentList.find(f => f.id === folderId);
                
                if (folder) {
                    state.folderPathIds.push(folderId);
                    state.folderPathNames.push(folder.name);
                    await renderFolderContents(chatId, query.message.message_id, state);
                }
            }
            
            else if (data === 'upload_here') {
                state.step = 'confirm_name';
                const nameKeyboard = [
                    [{ text: "✅ Same Name", callback_data: 'act_same' }],
                    [{ text: "✏️ Rename", callback_data: 'act_rename' }]
                ];

                let pathText = state.folderPathNames.join(' / ');
                if(pathText) pathText = " / " + pathText;

                await bot.editMessageText(`📂 Location: *${state.subject} / ${state.doctor}${pathText}*\n\n📝  Current File Name :\n\`${state.file.name}\`\n\ Choose An Action :`, {
                    chat_id: chatId, 
                    message_id: query.message.message_id,
                    reply_markup: { inline_keyboard: nameKeyboard }, 
                    parse_mode: 'Markdown'
                });
            }
        }

        else if (state && state.step === 'confirm_name') {
            if (data === 'act_same') {
                executeUpload(chatId);
            } else if (data === 'act_rename') {
                state.step = 'waiting_for_new_name';
                await bot.sendMessage(chatId, "✏️ Send the *new file name* now.", { parse_mode: 'Markdown' });
            }
        }

    } catch (error) {
        console.error('[Callback Error]', error);
    }
});

async function renderFolderContents(chatId, messageId, state) {
    try {
        const db = await getDatabase();
        const currentList = getCurrentFolderContent(db, state.subject, state.doctor, state.folderPathIds);
        
        const keyboard = [];

        currentList.forEach(item => {
            if (item.type === 'folder') {
                keyboard.push([{ text: `📂 ${item.name}`, callback_data: `folder_${item.id}` }]);
            } else {
                keyboard.push([{ text: `📄 ${item.name}`, callback_data: 'ignore_file' }]);
            }
        });

        keyboard.push([{ text: `📤 Upload Here`, callback_data: 'upload_here' }]);

        if (state.folderPathIds.length > 0 || state.step === 'navigate_folder') {
             keyboard.push([{ text: `🔙 Back`, callback_data: 'back' }]);
        }

        let pathText = state.folderPathNames.join(' / ');
        let headerText = `Doctor : *${state.doctor}*`;
        if (pathText) headerText += `\n📂 Folder: *${pathText}*`;

        await bot.editMessageText(`${headerText}\n\nSelect a folder or Upload Here:`, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: keyboard },
            parse_mode: 'Markdown'
        });
    } catch (e) {
        console.error("Render Folder Error:", e);
        bot.sendMessage(chatId, "Error loading folder contents.");
    }
}

async function processTextNotification(chatId, state, messageId) {
    try {
        const db = await getDatabase();
        
        if (!db.database[state.subject]) db.database[state.subject] = {};
        if (!db.database[state.subject][state.doctor]) db.database[state.subject][state.doctor] = {};
        
        const docData = db.database[state.subject][state.doctor];
        if (!docData.root) docData.root = [];
        
        let notifFolder = docData.root.find(f => f.name === "🔔 Notifications" && f.type === 'folder');
        
        if (!notifFolder) {
            notifFolder = { id: 'def_notif_' + Date.now(), name: "🔔 Notifications", type: "folder", children: [] };
            docData.root.push(notifFolder);
        }

        notifFolder.children.unshift({
            id: Date.now().toString(36),
            name: state.content,
            date: new Date().toLocaleString(),
            type: "notif"
        });

        // Also add to Recent Updates for SW/Popup
        if (!db.recentUpdates) db.recentUpdates = [];
        db.recentUpdates.unshift({
            id: Date.now().toString(36),
            doctor: state.doctor,
            subject: state.subject,
            timestamp: Date.now(),
            messageBody: state.content
        });
        db.latestNotificationUpdate = Date.now();

        await saveDatabase(db);
        await bot.editMessageText(`✅ Notification Send Successfully`, { chat_id: chatId, message_id: messageId });
        delete userStates[chatId];
    } catch (err) {
        console.error("Save Notif Error:", err);
        await bot.sendMessage(chatId, "❌ Failed To Save Notification");
        delete userStates[chatId];
    }
}

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    getRootFolderId().then(() => console.log("Drive Connected (Free Mode)"));
});