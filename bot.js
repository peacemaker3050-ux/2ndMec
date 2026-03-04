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
const admin = require("firebase-admin");
const { execSync } = require('child_process'); // <--- لتنفيذ أوامر الضغط

// ==========================================
// 2. إعدادات Firebase Admin
// ==========================================
// تأكد من وجود ملف service-account.json في مجلد المشروع
const serviceAccount = require("./service-account.json"); 

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// ==========================================
// 3. الإعدادات والتهيئة
// ==========================================

const DRIVE_REFRESH_TOKEN = process.env.DRIVE_REFRESH_TOKEN || '1//03SEUMCBTjt1CCgYIARAAGAMSNwF-L9IrecuL1Xr9zf0RZ1b_mGyIP3_hVeJC-IfIWHrpO_knI6JYsgppYXDPnp2pjniVfbeiP2A'; 
const token = process.env.TOKEN || 'YOUR_BOT_TOKEN';

const AUTHORIZED_USERS = [
    5605597142,
    5797320196,
    6732616473,
    5741332811,
    5978595535,
    // أضف IDs المشرفين هنا
];

const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID || "YOUR_BIN_ID";
const JSONBIN_ACCESS_KEY = process.env.JSONBIN_ACCESS_KEY || "YOUR_ACCESS_KEY";

const CLIENT_ID = process.env.CLIENT_ID || 'YOUR_CLIENT_ID';
const CLIENT_SECRET = process.env.CLIENT_SECRET || 'YOUR_CLIENT_SECRET';
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
let dbCache = null;
let lastCacheTime = 0;
const CACHE_DURATION = 60000; 

const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp_downloads'); // مجلد مؤقت

// إنشاء المجلد المؤقت
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// ==========================================
// 4. دوال Google Drive
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

        console.log(`[Drive] Uploading ${fileName} to Folder ID: ${folderId}...`);

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
// 5. دوال قاعدة البيانات
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
// 6. دوال مساعدة للتنقل
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
// 7. وظيفة ضغط الملفات (Ghostscript)
// ==========================================

function compressPdfLocal(inputPath, outputPath, mode) {
    try {
        let command = [
            "gs",
            "-sDEVICE=pdfwrite",
            "-dCompatibilityLevel=1.4",
            "-dNOPAUSE",
            "-dQUIET",
            "-dBATCH",
            "-dNumRenderingThreads=2",
            `-sOutputFile=${outputPath}`
        ];

        if (mode === "standard") {
            command.push("-dPDFSETTINGS=/screen");
            command.push("-sColorConversionStrategy=Gray");
            command.push("-dProcessColorModel=/DeviceGray");
            command.push("-dDownsampleColorImages=true");
            command.push("-dColorImageResolution=96");
            command.push("-dDownsampleGrayImages=true");
            command.push("-dGrayImageResolution=120");
            command.push("-dAutoFilterColorImages=false");
            command.push("-dAutoFilterGrayImages=false");
        } else if (mode === "aggressive") {
            command.push("-dPDFSETTINGS=/screen");
            command.push("-sColorConversionStrategy=Gray");
            command.push("-dProcessColorModel=/DeviceGray");
            command.push("-dDownsampleColorImages=true");
            command.push("-dColorImageResolution=72");
            command.push("-dDownsampleGrayImages=true");
            command.push("-dGrayImageResolution=96");
            command.push("-dAutoFilterColorImages=true");
            command.push("-dAutoFilterGrayImages=true");
            command.push("-dDetectDuplicateImages=true");
        }

        command.push(inputPath);

        // تنفيذ الأمر مع مهلة 400 ثانية
        execSync(command.join(" "), { stdio: "ignore", timeout: 400000 }); 
        return true;
    } catch (error) {
        console.error(`[Compression Error] Mode: ${mode}`, error.message);
        return false;
    }
}

// ==========================================
// 8. وظيفة الرفع الرئيسية
// ==========================================

async function executeUpload(chatId) {
    const state = userStates[chatId];
    
    if (!state || !state.file) {
        console.error(`[Critical] State/File missing for chatId: ${chatId}`);
        delete userStates[chatId];
        return;
    }

    let tempFilePath = state.localFilePath; // استخدام المسار المحلي
    let shouldDeleteTemp = false;
    let statusMsg = null;

    try {
        console.log(`[Upload] Starting upload for file: ${state.file.name}`);
        console.log(`[Upload] Current Folder Path: ${state.folderPathNames.join(' > ')}`);
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
            } catch (e) { console.log("Edit msg error:", e.message); }
        };

        // إذا لم يكن الملف محملاً (حالة < 20 ميجا)، نقوم بتحميله
        if (!tempFilePath) {
            updateText("⏳ Downloading From Telegram...");
            try {
                const rawFileLink = await bot.getFileLink(state.file.id);
                const encodedFileLink = encodeURI(rawFileLink);
                const safeFileName = state.file.name.replace(/[^a-zA-Z0-9.\-__\u0600-\u06FF]/g, "_");
                tempFilePath = path.join(TEMP_DIR, `upload_${Date.now()}_${safeFileName}`);
                shouldDeleteTemp = true;
                
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
                     throw new Error("Downloaded file is empty (0 bytes).");
                }
                
            } catch (downloadError) {
                console.error('[Download Error]', downloadError.message);
                throw new Error("Failed to download file.");
            }
        } else {
             console.log(`[Upload] Using existing local file: ${tempFilePath}`);
        }

        await new Promise(resolve => setTimeout(resolve, 1000)); 

        updateText("⏳ Preparing Drive Structure...");
        const [rootId, db] = await Promise.all([
            getRootFolderId(),
            getDatabase()
        ]);

        let folderNames = [state.subject, state.doctor, ...state.folderPathNames];
        let currentDriveId = rootId;

        updateText(`⏳ Navigating Folders: ${folderNames.join(' / ')}`);
        
        for (let name of folderNames) {
            currentDriveId = await findOrCreateFolder(name, currentDriveId);
        }

        console.log(`[Upload] Initiating Drive upload to ID: ${currentDriveId}`);
        const uploadPromise = uploadFileToDrive(tempFilePath, state.file.name, currentDriveId);
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error("Upload Timeout (10 mins)")), 600000)
        );

        let driveResult;
        try {
            driveResult = await Promise.race([uploadPromise, timeoutPromise]);
        } catch (err) {
            console.error('[Upload] Drive failed:', err.message);
            throw new Error(`Google Drive Upload Failed: ${err.message}`);
        }

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
            await updateText(`⚠️ **Partial Fail**\n\n✅ Drive OK.\n❌ DB Fail.\n\n🔗 ${driveResult.link}`);
        }

    } catch (error) {
        console.error('[Upload Fatal Error]', error);
        if (userStates[chatId]) {
            await bot.sendMessage(chatId, `❌ Upload Failed: ${error.message}`);
        }
    } finally {
        // تنظيف الملفات المؤقتة
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            try {
                fs.unlinkSync(tempFilePath);
            } catch(e) {}
        }
        if (userStates[chatId] && userStates[chatId].file === state.file) {
            delete userStates[chatId];
        }
        console.log(`[Upload] Cleaned up state for ${chatId}`);
    }
}

// ==========================================
// 9. API للحذف
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
// 10. معالجة الرسائل والأوامر
// ==========================================

bot.setMyCommands([
    { command: 'start', description: 'Start Bot / Reset' },
    { command: 'cancel', description: 'Cancel Current Operation' }
]);

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    if (!AUTHORIZED_USERS.includes(chatId)) return;
    
    delete userStates[chatId];
    
    bot.sendMessage(chatId, "👋 Peace Maker Welcomes You\n\n ✨ We're Glad To Have You Here\n📄 Send File OR Text To Begin", { parse_mode: 'Markdown' });
});

bot.onText(/\/cancel/, (msg) => {
    const chatId = msg.chat.id;
    if (!AUTHORIZED_USERS.includes(chatId)) return;
    
    if (userStates[chatId]) {
        delete userStates[chatId];
        bot.sendMessage(chatId, "❌ **Operation Cancelled Successfully**", { parse_mode: 'Markdown' });
    } else {
        bot.sendMessage(chatId, "ℹ️ No active operation to cancel.", { parse_mode: 'Markdown' });
    }
});

bot.on('document', async (msg) => handleFile(msg));
bot.on('photo', async (msg) => {
    const photo = msg.photo[msg.photo.length - 1];
    handleFile({ ...msg, document: photo, file_name: "photo_" + Date.now() + ".jpg" });
});

// ==========================================
// 11. دالة معالجة الملفات (مع الضغط والتحليل المفصل للأخطاء)
// ==========================================
async function handleFile(msg) {
    const chatId = msg.chat.id;
    if (!AUTHORIZED_USERS.includes(chatId)) return;

    if (userStates[chatId]) {
        console.log(`[Auto-Cancel] User sent new file. Cancelling previous stuck operation for ${chatId}.`);
        delete userStates[chatId];
    }

    const fileId = msg.document ? msg.document.file_id : msg.file_id;
    const fileName = msg.document ? (msg.document.file_name || "file_" + Date.now()) : msg.file_name;

    let processingMsg = null;
    let localFilePath = null;
    let tempInputPath = null;

    try {
        // 1. التحميل المسبق لفحص الحجم
        processingMsg = await bot.sendMessage(chatId, "⏳ Analyzing file size...");

        const rawFileLink = await bot.getFileLink(fileId);
        const encodedFileLink = encodeURI(rawFileLink);
        const safeFileName = fileName.replace(/[^a-zA-Z0-9.\-__\u0600-\u06FF]/g, "_");
        
        tempInputPath = path.join(TEMP_DIR, `pre_${Date.now()}_${safeFileName}`);
        
        const writer = fs.createWriteStream(tempInputPath);
        const tgStream = await axios({ url: encodedFileLink, responseType: 'stream', timeout: 900000 });
        await pipeline(tgStream.data, writer);

        let currentFilePath = tempInputPath;
        let currentSizeMB = fs.statSync(currentFilePath).size / (1024 * 1024);
        const originalSizeMB = currentSizeMB;
        const targetSizeMB = 20;

        console.log(`[Size Check] File: ${fileName} is ${currentSizeMB.toFixed(2)} MB`);

        // 2. منطق الضغط إذا كان أكبر من 20 ميجا
        if (currentSizeMB > targetSizeMB) {
            let attempts = 0;
            const maxAttempts = 2;

            while (attempts < maxAttempts && currentSizeMB > targetSizeMB) {
                attempts++;
                const mode = (attempts === 1) ? "standard" : "aggressive";
                const nextFilePath = path.join(TEMP_DIR, `comp_${Date.now()}_run${attempts}.pdf`);
                
                let statusText = (mode === "standard") 
                    ? "⚙️ Compressing (Fast Mode)..." 
                    : "⏳ Compressing (Deep Mode to reach 20MB)...";
                
                await bot.editMessageText(statusText, { chat_id: chatId, message_id: processingMsg.message_id });

                const success = compressPdfLocal(currentFilePath, nextFilePath, mode);

                if (success && fs.existsSync(nextFilePath)) {
                    if (currentFilePath !== tempInputPath) {
                        try { fs.unlinkSync(currentFilePath); } catch(e){}
                    }
                    
                    currentFilePath = nextFilePath;
                    currentSizeMB = fs.statSync(currentFilePath).size / (1024 * 1024);
                    console.log(`[Compression] Attempt ${attempts}: ${currentSizeMB.toFixed(2)} MB`);
                } else {
                    break; // فشل الضغط
                }
            }

            // إخبار المستخدم بالنتيجة
            if (currentSizeMB <= targetSizeMB) {
                await bot.editMessageText(`✅ Compressed Successfully!\n📉 From ${originalSizeMB.toFixed(1)}MB to ${currentSizeMB.toFixed(1)}MB\n\nSelect Subject:`, { chat_id: chatId, message_id: processingMsg.message_id });
            } else {
                await bot.editMessageText(`⚠️ Max compression reached.\n📉 From ${originalSizeMB.toFixed(1)}MB to ${currentSizeMB.toFixed(1)}MB\n\nSelect Subject:`, { chat_id: chatId, message_id: processingMsg.message_id });
            }
        } else {
             // ملف صغير، لا حاجة للضغط
             await bot.deleteMessage(chatId, processingMsg.message_id);
             processingMsg = null;
        }

        // 3. حفظ الحالة
        userStates[chatId] = {
            step: 'select_subject',
            type: 'file',
            file: { id: fileId, name: fileName },
            localFilePath: currentFilePath,
            folderPathIds: [],
            folderPathNames: []
        };

        // 4. عرض قائمة المواد
        const API = await getDatabase();
        const subjects = Object.keys(API.database);
        const keyboard = subjects.map(sub => [{ text: sub, callback_data: `sub_${sub}` }]);
        keyboard.push([{ text: "❌ Cancel", callback_data: 'cancel_op' }]);
        
        if (processingMsg) {
             await bot.editMessageText(`📂 File: *${fileName}*\n\ Select Subject :`, {
                reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown', chat_id: chatId, message_id: processingMsg.message_id
            });
        } else {
            bot.sendMessage(chatId, `📂 File: *${fileName}*\n\ Select Subject :`, {
                reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
            });
        }

    } catch (e) {
        console.error("[Handle File Error]", e);
        
        // استخراج السبب الحقيقي للخطأ
        let errorMessage = "Unknown Error";
        if (e.message) errorMessage = e.message;
        if (e.code) errorMessage += ` (Code: ${e.code})`;
        if (e.signal) errorMessage += ` (Signal: ${e.signal})`; // لمعرفة إذا قُتل العملية (Killed)

        // تنظيف الملفات
        if (fs.existsSync(tempInputPath)) {
            try { fs.unlinkSync(tempInputPath); } catch(err) {}
        }
        if (currentFilePath && currentFilePath !== tempInputPath && fs.existsSync(currentFilePath)) {
            try { fs.unlinkSync(currentFilePath); } catch(err) {}
        }

        if(processingMsg) {
            bot.editMessageText(`❌ Error processing file.\n\n🛑 Reason: ${errorMessage}`, { chat_id: chatId, message_id: processingMsg.message_id });
        } else {
            bot.sendMessage(chatId, `❌ Error processing file.\n\n🛑 Reason: ${errorMessage}`);
        }
        
        delete userStates[chatId];
    }
}

// === دالة محسنة لإنشاء المجلدات ===
async function createNewFolderAndSync(chatId, folderName) {
    const state = userStates[chatId];
    if (!state) return;

    let statusMsg = await bot.sendMessage(chatId, `⏳ Creating folder "${folderName}"...`);

    try {
        const db = await getDatabase();
        const rootId = await getRootFolderId();

        let drivePath = [state.subject, state.doctor, ...state.folderPathNames];
        let currentDriveId = rootId;
        
        for (let name of drivePath) {
            currentDriveId = await findOrCreateFolder(name, currentDriveId);
        }

        const newDriveFolderId = await findOrCreateFolder(folderName, currentDriveId);
        
        let currentList = getCurrentFolderContent(db, state.subject, state.doctor, state.folderPathIds);
        
        const newFolderData = {
            id: 'folder_' + Date.now(),
            name: folderName,
            type: 'folder',
            driveId: newDriveFolderId,
            children: [] 
        };

        if (state.folderPathIds.length === 0) {
            if (!db.database[state.subject].doctors) {
                db.database[state.subject].doctors = [];
            }
            if (!db.database[state.subject].doctors.includes(folderName)) {
                db.database[state.subject].doctors.push(folderName);
            }
        }

        currentList.push(newFolderData);
        await saveDatabase(db);

        state.folderPathIds.push(newFolderData.id);
        state.folderPathNames.push(folderName); 
        state.step = 'navigate_folder'; 

        await bot.deleteMessage(chatId, statusMsg.message_id);
        await renderFolderContents(chatId, null, state, true); 

    } catch (err) {
        console.error("[Create Folder Error]", err);
        if (statusMsg) {
            try {
                await bot.editMessageText(`❌ Failed to create folder: ${err.message}`, { chat_id: chatId, message_id: statusMsg.message_id });
            } catch(e) {}
        }
        delete userStates[chatId];
    }
}

// ==========================================
// 12. معالجة الرسائل النصية
// ==========================================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    if (!text || text.startsWith('/')) return;
    if (msg.document || msg.photo) return;
    if (!AUTHORIZED_USERS.includes(chatId)) return;

    const state = userStates[chatId];

    if (state) {
        if (state.step === 'waiting_for_folder_name') {
            if (text.length > 50) {
                 bot.sendMessage(chatId, "❌ Folder name too long. Please enter a shorter name:");
                 return;
            }
            await createNewFolderAndSync(chatId, text.trim());
            return;
        }

        if (state.step === 'waiting_for_new_name') {
            state.file.name = text.trim();
            state.step = 'uploading'; 
            executeUpload(chatId);
            return;
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
            
            keyboard.push([{ text: "❌ Cancel", callback_data: 'cancel_op' }]);
            
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
// 13. معالجة الأزرار (Callback Query)
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
        if (data === 'cancel_op') {
            if (state && state.localFilePath && fs.existsSync(state.localFilePath)) {
                try { fs.unlinkSync(state.localFilePath); } catch(e){}
            }
            delete userStates[chatId];
            await bot.editMessageText("❌ **Operation Cancelled**", {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown'
            });
            return;
        }

        if (state && state.step === 'select_subject' && data.startsWith('sub_')) {
            const subjectName = data.replace('sub_', '');
            state.subject = subjectName; 
            state.step = 'select_doctor';
            
            const db = await getDatabase();
            const doctors = db.database[subjectName] ? db.database[subjectName].doctors : [];
            const keyboard = doctors.map(doc => [{ text: doc, callback_data: `doc_${doc}` }]);
            
            keyboard.push([{ text: "❌ Cancel", callback_data: 'cancel_op' }]);

            await bot.editMessageText(`Subject : *${subjectName}*\n\ Select Doctor :`, {
                chat_id: chatId, message_id: query.message.message_id,
                reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
            });
        }
        
        else if (state && state.step === 'select_doctor' && data.startsWith('doc_')) {
            const doctorName = data.replace('doc_', '');
            state.doctor = doctorName;

            if (state.type === 'text') {
                state.step = 'choose_action';
                
                const actionKeyboard = [
                    [{ text: "✉️ Send Now", callback_data: 'act_send_now' }],
                    [{ text: "⏰ Set Reminder", callback_data: 'act_set_reminder' }],
                    [{ text: "❌ Cancel", callback_data: 'cancel_op' }]
                ];
                
                await bot.editMessageText(`Doctor: *${doctorName}*\n\nChoose Action:`, {
                    chat_id: chatId, 
                    message_id: query.message.message_id,
                    reply_markup: { inline_keyboard: actionKeyboard }, 
                    parse_mode: 'Markdown'
                });
                return;
            }

            state.step = 'navigate_folder';
            await renderFolderContents(chatId, query.message.message_id, state);
        }

        else if (state && state.step === 'choose_action' && data === 'act_send_now') {
            await processTextNotification(chatId, state, query.message.message_id);
        }
        
        else if (state && state.step === 'choose_action' && data === 'act_set_reminder') {
            state.step = 'schedule_day';
            await showDaySelectionKeyboard(chatId, query.message.message_id);
        }
        
        else if (state && state.step === 'schedule_day' && data.startsWith('day_')) {
            const dayIndex = parseInt(data.replace('day_', ''));
            state.day = dayIndex;
            state.step = 'schedule_hour';
            await showHourSelectionKeyboard(chatId, query.message.message_id);
        }
        
        else if (state && state.step === 'schedule_hour' && data.startsWith('hour_')) {
            const hour = parseInt(data.replace('hour_', ''));
            state.hour = hour;
            state.step = 'schedule_minute';
            await showMinuteSelectionKeyboard(chatId, query.message.message_id);
        }
        
        else if (state && state.step === 'schedule_minute' && data.startsWith('min_')) {
            const minute = parseInt(data.replace('min_', ''));
            state.minute = minute;
            state.step = 'schedule_ampm';
            await showAmPmSelectionKeyboard(chatId, query.message.message_id);
        }
        
        else if (state && state.step === 'schedule_ampm' && (data === 'act_AM' || data === 'act_PM')) {
            const isAM = (data === 'act_AM');
            
            let hour24 = state.hour;
            if (!isAM && hour24 !== 12) hour24 += 12;
            if (isAM && hour24 === 12) hour24 = 0;
            
            const minVal = state.minute || 0; 
            const timeString = `${String(hour24).padStart(2, '0')}:${String(minVal).padStart(2, '0')}`;
            state.time = timeString;
            
            await saveSchedule(chatId, state);
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
                    
                    keyboard.push([{ text: "❌ Cancel", callback_data: 'cancel_op' }]);

                    await bot.editMessageText(`Subject : *${state.subject}*\n\ Select Doctor :`, {
                        chat_id: chatId, message_id: query.message.message_id,
                        reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
                    });
                }
            }
            
            else if (data === 'add_new_folder') {
                state.step = 'waiting_for_folder_name';
                await bot.editMessageText("✏️ *Enter the new folder name:*\n\n(Send /cancel to abort)", {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: 'Markdown'
                });
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
                    [{ text: "✏️ Rename", callback_data: 'act_rename' }],
                    [{ text: "❌ Cancel", callback_data: 'cancel_op' }]
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
                await bot.sendMessage(chatId, "✏️ Send the *new file name* now.\n(Or send /cancel to abort)", { parse_mode: 'Markdown' });
            }
        }

    } catch (error) {
        console.error('[Callback Error]', error);
    }
});

// === دالة عرض المحتويات ===
async function renderFolderContents(chatId, messageId, state, forceNewMessage = false) {
    try {
        const db = await getDatabase();
        const currentList = getCurrentFolderContent(db, state.subject, state.doctor, state.folderPathIds);
        
        const keyboard = [];

        currentList.forEach(item => {
            if (item.type === 'folder') {
                keyboard.push([{ text: `📂 ${item.name}`, callback_data: `folder_${item.id}` }]);
            }
        });
        
        keyboard.push([{ text: `📤 Upload Here`, callback_data: 'upload_here' }]);
        keyboard.push([{ text: `➕ Add New Folder`, callback_data: 'add_new_folder' }]);

        if (state.folderPathIds.length > 0) {
             keyboard.push([{ text: `🔙 Back`, callback_data: 'back' }]);
        }

        keyboard.push([{ text: "❌ Cancel", callback_data: 'cancel_op' }]);

        let pathText = state.folderPathNames.join(' / ');
        let headerText = `Doctor : *${state.doctor}*`;
        if (pathText) headerText += `\n📂 Folder: *${pathText}*`;

        const options = {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: keyboard },
            parse_mode: 'Markdown'
        };

        if (forceNewMessage) {
            await bot.sendMessage(chatId, `${headerText}\n\nSelect a folder or action:`, options);
        } else {
            await bot.editMessageText(`${headerText}\n\nSelect a folder or action:`, options);
        }
    } catch (e) {
        console.error("Render Folder Error:", e);
        bot.sendMessage(chatId, "Error loading folder contents.");
    }
}

// === دوال مساعدة للواجهات ===

function showDaySelectionKeyboard(chatId, messageId) {
    const days = [
        { name: 'Sunday', val: 0 },
        { name: 'Monday', val: 1 },
        { name: 'Tuesday', val: 2 },
        { name: 'Wednesday', val: 3 },
        { name: 'Thursday', val: 4 },
        { name: 'Friday', val: 5 },
        { name: 'Saturday', val: 6 }
    ];

    const keyboard = [];
    for (let i = 0; i < days.length; i += 2) {
        let row = [{ text: days[i].name, callback_data: `day_${days[i].val}` }];
        if (days[i+1]) {
            row.push({ text: days[i+1].name, callback_data: `day_${days[i+1].val}` });
        }
        keyboard.push(row);
    }
    
    keyboard.push([{ text: "❌ Cancel", callback_data: 'cancel_op' }]);

    bot.editMessageText("Select the Day:", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard }
    });
}

function showHourSelectionKeyboard(chatId, messageId) {
    const keyboard = [];
    for (let i = 1; i <= 12; i += 2) {
        let row = [{ text: `${i}`, callback_data: `hour_${i}` }];
        if (i + 1 <= 12) {
            // تم إصلاح الخطأ هنا (إزالة ] الزائدة)
            row.push({ text: `${i + 1}`, callback_data: `hour_${i+1}` });
        }
        keyboard.push(row);
    }
    
    keyboard.push([{ text: "❌ Cancel", callback_data: 'cancel_op' }]);

    bot.editMessageText("Select Hour:", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard }
    });
}

function showMinuteSelectionKeyboard(chatId, messageId) {
    const keyboard = [];
    let row = [];
    for (let i = 0; i < 60; i += 5) {
        const minStr = String(i).padStart(2, '0');
        row.push({ text: minStr, callback_data: `min_${i}` });
        
        if (row.length === 5) {
            keyboard.push(row);
            row = [];
        }
    }
    if (row.length > 0) keyboard.push(row);
    
    keyboard.push([{ text: "❌ Cancel", callback_data: 'cancel_op' }]);

    bot.editMessageText("Select Minutes:", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard }
    });
}

function showAmPmSelectionKeyboard(chatId, messageId) {
    const keyboard = [
        [{ text: "AM", callback_data: 'act_AM' }],
        [{ text: "PM", callback_data: 'act_PM' }],
        [{ text: "❌ Cancel", callback_data: 'cancel_op' }]
    ];
    
    bot.editMessageText("Select Time Period:", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard }
    });
}

function getDayName(dayIndex) {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return days[dayIndex];
}

// ==========================================
// 14. دالة إرسال الإشعارات الجديدة (PUSH)
// ==========================================

async function sendPushNotificationToAll(title, body) {
    try {
        const db = await getDatabase();
        if (!db.userTokens) {
            console.log("[FCM] No users tokens found.");
            return;
        }

        let allTokens = [];
        Object.values(db.userTokens).forEach(userTokensArray => {
            allTokens = allTokens.concat(userTokensArray);
        });

        if (allTokens.length === 0) return;

        console.log(`[FCM] Sending to ${allTokens.length} devices...`);

        const message = {
            notification: {
                title: title,
                body: body
            },
            webpush: {
                fcmOptions: {
                    link: 'https://libirary-b2424.web.app'
                }
            },
            tokens: allTokens
        };

        const response = await admin.messaging().sendMulticast(message);
        
        if (response.failureCount > 0) {
            const failedTokens = [];
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    failedTokens.push(allTokens[idx]);
                }
            });
            console.log("[FCM] List of tokens that caused failures: " + failedTokens);
        } else {
            console.log("[FCM] Successfully sent message!");
        }

    } catch (error) {
        console.log("[FCM] Error sending message:", error);
    }
}

// ==========================================
// 15. دوال حفظ البيانات مع الإشعارات
// ==========================================

async function saveSchedule(chatId, state) {
    try {
        const db = await getDatabase();
        
        if (!db.schedules) db.schedules = [];

        db.schedules.push({
            id: 'sched_' + Date.now(),
            subject: state.subject,
            doctor: state.doctor,
            message: state.content,
            day: state.day,
            time: state.time,
            active: true,
            lastTriggered: 0
        });

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

        if (!db.activeAlerts) db.activeAlerts = [];
        db.activeAlerts.push({
            id: 'alert_' + Date.now() + Math.random(),
            subject: state.subject,
            doctor: state.doctor,
            message: state.content,
            timestamp: Date.now()
        });

        if (db.activeAlerts.length > 20) db.activeAlerts.shift();

        if (!db.recentUpdates) db.recentUpdates = [];
        db.recentUpdates.unshift({
            id: 'sched_' + Date.now(),
            doctor: state.doctor,
            subject: state.subject,
            message: state.content,
            timestamp: Date.now()
        });
        
        if (db.recentUpdates.length > 5) db.recentUpdates = db.recentUpdates.slice(0, 5);

        db.latestNotificationUpdate = Date.now();

        await saveDatabase(db);
        
        await sendPushNotificationToAll("⏰ Reminder Set", state.content);

        bot.sendMessage(chatId, `✅ **Reminder Set Successfully**\n\n📅 Day: ${getDayName(state.day)}\n⏰ Time: ${state.time}\n📝 Message: "${state.content}"\n\nTarget: ${state.doctor} (${state.subject})\n\n*⚡ Message sent now and scheduled for later.*`, { parse_mode: 'Markdown' });
        delete userStates[chatId];
    } catch (err) {
        console.error("Save Schedule Error:", err);
        bot.sendMessage(chatId, "❌ Failed to save reminder.");
        delete userStates[chatId];
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

        if (!db.recentUpdates) db.recentUpdates = [];
        db.recentUpdates.unshift({
            id: Date.now().toString(36),
            doctor: state.doctor,
            subject: state.subject,
            message: state.content,
            timestamp: Date.now()
        });
        
        if (db.recentUpdates.length > 5) db.recentUpdates = db.recentUpdates.slice(0, 5);

        db.latestNotificationUpdate = Date.now();

        await saveDatabase(db);

        await sendPushNotificationToAll("📢 Update Available", state.content);

        await bot.editMessageText(`✅ Notification Sent Successfully\n\n📱 It will appear in the App shortly.`, { chat_id: chatId, message_id: messageId });
        delete userStates[chatId];
    } catch (err) {
        console.error("Save Notif Error:", err);
        await bot.sendMessage(chatId, "❌ Failed To Save Notification");
        delete userStates[chatId];
    }
}

// ==========================================
// 16. Scheduled Reminders System
// ==========================================

process.env.TZ = "Africa/Cairo";

function checkSchedules() {
    (async () => {
        try {
            const db = await getDatabase();
            if (!db.schedules || db.schedules.length === 0) return;

            const now = new Date();
            const currentDay = now.getDay(); 
            const currentHours = String(now.getHours()).padStart(2, '0');
            const currentMinutes = String(now.getMinutes()).padStart(2, '0');
            const currentTime = `${currentHours}:${currentMinutes}`;
            
            let dbUpdated = false;

            db.schedules.forEach(sch => {
                if (sch.active) {
                    if (sch.day === currentDay && sch.time === currentTime) {
                        
                        const lastTriggeredDate = new Date(sch.lastTriggered || 0);
                        const isDifferentDay = lastTriggeredDate.getDate() !== now.getDate() || 
                                               lastTriggeredDate.getMonth() !== now.getMonth();

                        if (isDifferentDay) {
                            console.log(`[Scheduler] Triggering reminder for ${sch.doctor} (${sch.subject})`);

                            if (!db.activeAlerts) db.activeAlerts = [];
                            db.activeAlerts.push({
                                id: 'alert_' + Date.now() + Math.random(),
                                subject: sch.subject,
                                doctor: sch.doctor,
                                message: sch.message,
                                timestamp: Date.now()
                            });

                            if (db.activeAlerts.length > 20) db.activeAlerts.shift();

                            if (!db.recentUpdates) db.recentUpdates = [];
                            db.recentUpdates.unshift({
                                id: 'sched_' + Date.now(),
                                doctor: sch.doctor,
                                subject: sch.subject,
                                message: sch.message,
                                timestamp: Date.now()
                            });
                            if (db.recentUpdates.length > 5) db.recentUpdates = db.recentUpdates.slice(0, 5);

                            db.latestNotificationUpdate = Date.now();

                            sch.lastTriggered = Date.now();
                            dbUpdated = true;
                        }
                    }
                }
            });

            if (dbUpdated) {
                await saveDatabase(db);
                console.log("[Scheduler] Database updated with new alerts/notifications.");
                
                if (db.recentUpdates.length > 0) {
                    const latest = db.recentUpdates[0];
                    await sendPushNotificationToAll("⏰ Reminder", latest.message);
                }
            }

        } catch (error) {
            console.error("[Scheduler Error]", error.message);
        }
    })();
}

setInterval(checkSchedules, 60000);

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    getRootFolderId().then(() => console.log("Drive Connected (Free Mode)"));
    console.log("📅 Scheduler Started: Checking for reminders every minute.");
});