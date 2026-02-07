const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

// ================= CONFIG =================
const BOT_TOKEN = 'PUT_YOUR_BOT_TOKEN';
const GITHUB_TOKEN = 'PUT_GITHUB_TOKEN';

const OWNER = 'peacemaker3050-ux';
const REPO = '2ndM-mec'; // بدون مسافات

const JSONBIN_ID = '696e77bfae596e708fe71e9d';
const JSONBIN_KEY = 'PUT_JSONBIN_KEY';

const ADMINS = [5605597142];

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const userState = {};

// ================= JSONBIN =================
async function getDB() {
  const res = await axios.get(
    `https://api.jsonbin.io/v3/b/${JSONBIN_ID}/latest`,
    { headers: { 'X-Master-Key': JSONBIN_KEY, 'X-Bin-Meta': false } }
  );
  return res.data;
}

async function saveDB(data) {
  await axios.put(
    `https://api.jsonbin.io/v3/b/${JSONBIN_ID}`,
    data,
    { headers: { 'X-Master-Key': JSONBIN_KEY } }
  );
}

// ================= GITHUB =================
async function uploadToGitHub(filePath, fileName) {
  const tag = `upload-${Date.now()}`;

  const release = await axios.post(
    `https://api.github.com/repos/${OWNER}/${REPO}/releases`,
    {
      tag_name: tag,
      name: fileName
    },
    { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
  );

  const uploadUrl = release.data.upload_url.replace('{?name,label}', `?name=${fileName}`);

  const stream = fs.createReadStream(filePath);
  await axios.post(uploadUrl, stream, {
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      'Content-Type': 'application/octet-stream'
    }
  });

  return `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${fileName}`;
}

// ================= START =================
bot.onText(/\/start/, msg => {
  if (!ADMINS.includes(msg.chat.id)) {
    return bot.sendMessage(msg.chat.id, '⛔ غير مصرح');
  }
  bot.sendMessage(msg.chat.id, '📤 ابعت ملف أو رسالة نصية');
});

// ================= FILE =================
bot.on('document', async msg => {
  const chatId = msg.chat.id;
  if (!ADMINS.includes(chatId)) return;

  const fileId = msg.document.file_id;
  const fileName = msg.document.file_name;

  const file = await bot.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

  const tempPath = `/tmp/${fileName}`;
  const writer = fs.createWriteStream(tempPath);

  const res = await axios.get(url, { responseType: 'stream' });
  res.data.pipe(writer);

  writer.on('finish', async () => {
    const link = await uploadToGitHub(tempPath, fileName);
    fs.unlinkSync(tempPath);

    bot.sendMessage(chatId, `✅ تم الرفع\n🔗 ${link}`);
  });
});

// ================= TEXT =================
bot.on('text', async msg => {
  if (msg.text.startsWith('/')) return;
  if (!ADMINS.includes(msg.chat.id)) return;

  const db = await getDB();
  if (!db.notifications) db.notifications = [];

  db.notifications.unshift({
    text: msg.text,
    date: new Date().toLocaleString()
  });

  await saveDB(db);
  bot.sendMessage(msg.chat.id, '✅ تم حفظ الإشعار');
});
