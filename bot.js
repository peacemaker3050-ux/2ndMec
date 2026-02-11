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
// 5. وظيفة الرفع الرئيسية (Recursive Support)
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
        
        try {
            const rawFileLink = await bot.getFileLink(state.file.id);
            console.log(`[Download] Link: ${rawFileLink}`);
            
            const safeLocalName = state.file.name.replace(/[^a-zA-Z0-9.\-_\u0600-\u06FF]/g, "_");
            tempFilePath = path.join('/tmp', `upload_${Date.now()}_${safeLocalName}`);
            
            const writer = fs.createWriteStream(tempFilePath);
            
            const tgStream = await axios({ 
                url: rawFileLink, 
                responseType: 'stream',
                timeout: 60000 
            });
            
            await pipeline(tgStream.data, writer);
            console.log(`[Download] File saved to: ${tempFilePath}`);
        } catch (downloadError) {
            console.error('[Download Error]', downloadError.message);
            throw new Error("Failed to download file. Please check the file name and try again.");
        }

        await new Promise(resolve => setTimeout(resolve, 1000)); 

        // 2. تجهيز البيانات
        updateText("⏳ Preparing Drive Structure...");
        
        const [rootId, db] = await Promise.all([
            getRootFolderId(),
            getDatabase()
        ]);

        // 3. حساب مسار المجلدات في الدرايف
        let currentFolderId = rootId;
        currentFolderId = await findOrCreateFolder(state.subject, currentFolderId);
        currentFolderId = await findOrCreateFolder(state.doctor, currentFolderId);

        // تنفيذ الحلقة عبر الأقسام الفرعية (state.path)
        if (state.path && Array.isArray(state.path)) {
            for (const sectionName of state.path) {
                currentFolderId = await findOrCreateFolder(sectionName, currentFolderId);
            }
        }

        // 4. رفع الملف
        console.log(`[Upload] Initiating Drive upload to folder: ${currentFolderId}...`);
        
        const uploadPromise = uploadFileToDrive(tempFilePath, state.file.name, currentFolderId);
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error("Upload Timeout (5 mins)")), 300000)
        );

        let driveResult;
        try {
            driveResult = await Promise.race([uploadPromise, timeoutPromise]);
        } catch (err) {
            console.error('[Upload] Drive upload failed/timed out:', err.message);
            throw new Error(`Google Drive Upload Failed: ${err.message}`);
        }

        // 5. الحفظ في قاعدة البيانات
        const dbRef = db.database[state.subject][state.doctor];
        let targetArray = null;

        if (!state.path || state.path.length === 0) {
             targetArray = dbRef[state.currentSection] || [];
        } else {
            targetArray = dbRef;
            for (const key of state.path) {
                const sectionObj = targetArray.find(item => item.name === key);
                if (sectionObj && sectionObj.content) {
                    targetArray = sectionObj.content;
                } else {
                    targetArray = dbRef[state.currentSection];
                    break;
                }
            }
        }

        if (!targetArray || !Array.isArray(targetArray)) {
             targetArray = dbRef[state.currentSection];
        }

        if (targetArray) {
            targetArray.push({
                name: state.file.name,
                link: driveResult.link,
                driveId: driveResult.id
            });
        } else {
            throw new Error("Database path error: Could not locate target array.");
        }

        await saveDatabase(db);

        // 6. رسالة النجاح
        const pathString = state.path ? state.path.join(' / ') : state.currentSection;
        const finalText = `✅ Upload Completed \n📂 ${state.subject} / ${state.doctor} / ${pathString}\n📝 Name: *${state.file.name}*\n🔗 ${driveResult.link}`;
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
// 7. معالجة الرسائل والأوامر
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

    lastFileUploads[chatId] = {
        fileId: fileId,
        fileName: fileName,
        timestamp: Date.now()
    };

    userStates[chatId] = {
        step: 'select_subject',
        type: 'file',
        file: { id: fileId, name: fileName },
        path: [],
        currentSection: null
    };

    const API = await getDatabase();
    const subjects = Object.keys(API.database);
    const keyboard = subjects.map(sub => [{ text: sub, callback_data: `sub_${sub}` }]);
    
    bot.sendMessage(chatId, `📂 File: *${fileName}*\n\n Select Subject :`, {
        reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
    });
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
            path: [],
            currentSection: null
        };

        const data = await getDatabase();
        const subjects = Object.keys(data.database);
        const keyboard = subjects.map(sub => [{ text: sub, callback_data: `sub_${sub}` }]);
        
        bot.sendMessage(chatId, `📝  New Message: "${text}"\n\nSelect Subject :`, {
            reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
        });
    }
});

// ==========================================
// 8. معالجة الأزرار (Callback Query) - نسخة مصححة بالكامل
// ==========================================

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const state = userStates[chatId];

    if (!AUTHORIZED_USERS.includes(chatId)) return;

    try {
        // --- اختيار المادة ---
        if (state && state.step === 'select_subject' && data.startsWith('sub_')) {
            const subjectName = data.replace('sub_', '');
            state.subject = subjectName; 
            state.step = 'select_doctor';
            
            const db = await getDatabase();
            const docList = db.database[subjectName]?.doctors || [];
            const keyboard = docList.map(doc => [{ text: doc, callback_data: `doc_${doc}` }]);
            
            await bot.editMessageText(`Subject : *${subjectName}*\n\n Select Doctor :`, {
                chat_id: chatId, message_id: query.message.message_id,
                reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
            });
        }
        // --- اختيار الدكتور ---
        else if (state && state.step === 'select_doctor' && data.startsWith('doc_')) {
            const doctorName = data.replace('doc_', '');
            state.doctor = doctorName;

            if (state.type === 'text') {
                await processTextNotification(chatId, state, query.message.message_id);
            } else {
                state.step = 'browse_section'; 
                const db = await getDatabase();
                const docData = db.database[state.subject][state.doctor];
                const keyboard = [];
                
                // عرض الأقسام الرئيسية
                if (docData && docData.sections) {
                    docData.sections.forEach(secName => {
                        keyboard.push([{ text: `📂 ${secName}`, callback_data: `nav_${secName}` }]);
                    });
                }

                await bot.editMessageText(`Doctor : *${doctorName}*\n\n Select Section to Upload In:`, {
                    chat_id: chatId, message_id: query.message.message_id,
                    reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
                });
            }
        }
        // --- التنقل داخل الأقسام ---
        else if (state && state.step === 'browse_section' && data.startsWith('nav_')) {
            const targetName = data.replace('nav_', '');
            
            const db = await getDatabase();
            let currentLevelData = db.database[state.subject][state.doctor];

            // إعادة بناء المسار
            if (state.path && state.path.length > 0) {
                for (const p of state.path) {
                    const found = currentLevelData.find(item => item.name === p);
                    if (found && found.content && Array.isArray(found.content)) {
                        currentLevelData = found.content;
                    } 
                    else if (currentLevelData[p]) {
                        currentLevelData = currentLevelData[p];
                    }
                }
            }

            // البحث عن الهدف
            let targetItem = null;
            
            // الحالة أ: الهدف مفتاح رئيسي
            if (currentLevelData[targetName] && Array.isArray(currentLevelData[targetName])) {
                targetItem = { name: targetName, content: currentLevelData[targetName], isMainKey: true };
            } 
            // الحالة ب: الهدف عنصر داخل مصفوفة
            else {
                const dataArray = Array.isArray(currentLevelData) ? currentLevelData : [];
                targetItem = dataArray.find(item => item.name === targetName);
            }

            if (targetItem) {
                // التحقق هل هو مجلد؟
                const isFolder = (targetItem.content && Array.isArray(targetItem.content)) || (Array.isArray(targetItem) && targetItem.length > 0 && targetItem[0].content);

                if (isFolder) {
                    // --- الدخول داخل المجلد ---
                    state.path.push(targetName);
                    state.currentSection = targetName;
                    
                    let nextLevelData = targetItem.content;
                    const keyboard = [];
                    
                    nextLevelData.forEach(item => {
                        const isSubFolder = (item.content && Array.isArray(item.content));
                        const icon = isSubFolder ? '📁 ' : '📄 ';
                        keyboard.push([{ text: `${icon}${item.name}`, callback_data: `nav_${item.name}` }]);
                    });

                    keyboard.push([{ text: "🔙 Back", callback_data: 'act_back' }]);

                    await bot.editMessageText(`📂 *${targetName}*\n\nSelect Sub-Section or Upload Here:`, {
                        chat_id: chatId, 
                        message_id: query.message.message_id,
                        reply_markup: { inline_keyboard: keyboard }, 
                        parse_mode: 'Markdown'
                    });

                } else {
                    // --- الهدف ليس مجلد -> تأكيد الرفع ---
                    if (!targetItem.isMainKey) {
                        state.path.push(targetName);
                    }
                    state.currentSection = targetName;
                    state.step = 'confirm_name';
                    
                    const nameKeyboard = [
                        [{ text: "✅ Same Name", callback_data: 'act_same' }],
                        [{ text: "✏️ Rename", callback_data: 'act_rename' }]
                    ];
                    
                    const pathString = state.path.join(' / ');
                    await bot.editMessageText(`📂 Location: *${pathString}*\n\n📝 File Name:\n\`${state.file.name}\`\n\nChoose Action:`, {
                        chat_id: chatId, 
                        message_id: query.message.message_id,
                        reply_markup: { inline_keyboard: nameKeyboard }, 
                        parse_mode: 'Markdown'
                    });
                }
            } else {
                await bot.answerCallbackQuery(query.id, { text: "Error: Section not found.", show_alert: true });
            }
        }
        // --- زر الرجوع ---
        else if (state && state.step === 'browse_section' && data === 'act_back') {
            if (state.path && state.path.length > 0) {
                state.path.pop();
                
                const db = await getDatabase();
                let currentLevelData = db.database[state.subject][state.doctor];

                if (state.path.length > 0) {
                    for (const p of state.path) {
                        const found = currentLevelData.find(item => item.name === p);
                        if (found && found.content) currentLevelData = found.content;
                        else if (currentLevelData[p]) currentLevelData = currentLevelData[p];
                    }
                }

                const keyboard = [];
                
                // العودة للجذر
                if (state.path.length === 0) {
                     if (currentLevelData.sections) {
                        currentLevelData.sections.forEach(secName => {
                            keyboard.push([{ text: `📂 ${secName}`, callback_data: `nav_${secName}` }]);
                        });
                     }
                     await bot.editMessageText(`Doctor : *${state.doctor}*\n\n Select Section:`, {
                        chat_id: chatId, message_id: query.message.message_id,
                        reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
                    });
                    return;
                }

                // عرض المحتويات الحالية
                currentLevelData.forEach(item => {
                    const isSubFolder = (item.content && Array.isArray(item.content));
                    const icon = isSubFolder ? '📁 ' : '📄 ';
                    keyboard.push([{ text: `${icon}${item.name}`, callback_data: `nav_${item.name}` }]);
                });

                keyboard.push([{ text: "🔙 Back", callback_data: 'act_back' }]);

                const currentTitle = state.path[state.path.length - 1] || state.doctor;
                await bot.editMessageText(`📂 *${currentTitle}*`, {
                    chat_id: chatId, 
                    message_id: query.message.message_id,
                    reply_markup: { inline_keyboard: keyboard }, 
                    parse_mode: 'Markdown'
                });
            } else {
                await bot.answerCallbackQuery(query.id, { text: "Already at root.", show_alert: true });
            }
        }
        // --- تأكيد الاسم ---
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
        bot.sendMessage(chatId, "⚠️ An error occurred. Please try /start.").catch(e => {});
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