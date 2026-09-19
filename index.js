// ==========================================================
// MS Haydarov Bot — Majburiy obuna + Referal tizimi
// Bot API 9.4: tugma rangi (style) va custom emoji (icon_custom_emoji_id)
// Ma'lumotlar bazasi: MongoDB Atlas (doimiy saqlash, Render uxlab/qayta
// tirilganda yoki qayta deploy bo'lganda ham ma'lumotlar yo'qolmaydi)
// ==========================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const { Telegraf } = require('telegraf');
const express = require('express');
const { MongoClient } = require('mongodb');

// Ba'zi hostinglarda (Render, Railway va h.k.) IPv6 orqali chiquvchi
// ulanishlar tez-tez "osilib qoladi" (ayniqsa rasm kabi katta so'rovlarda),
// natijada bir necha o'nlab soniyadan keyin "socket hang up" bilan
// uziladi. IPv4'ni ustuvor qilish bu muammoni deyarli bartaraf etadi.
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

// MUHIM: Telegraf (Node 18+) tashqi so'rovlar uchun o'rnatilgan `fetch`
// (undici) dan foydalanadi — pastdagi https.Agent sozlamalari faqat eski
// `https` moduli ishlatilganda kuchga ega bo'ladi, undici uni butunlay
// e'tiborsiz qoldiradi. Shuning uchun IPv4'ni va timeout'larni bevosita
// undici'ning o'ziga berish kerak — aks holda "socket hang up" muammosi
// hal bo'lmay qoladi.
try {
  const { Agent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(new Agent({
    connect: { family: 4 },   // IPv6 orqali osilib qolishning oldini oladi
    headersTimeout: 25_000,   // javob boshlanishini 25s dan ortiq kutmaydi
    bodyTimeout: 25_000,      // javob tanasini 25s dan ortiq kutmaydi
  }));
  console.log('✅ undici global dispatcher sozlandi (IPv4 + timeout)');
} catch (e) {
  console.error("⚠️ undici sozlanmadi (paket topilmadi bo'lishi mumkin):", e.message);
}


const https = require('https');

// Rasmlar shu papkadan olinadi: /rasmlar/<fayl_nomi>
// (loyihaning index.js bilan bir joyida "rasmlar" nomli papka yarating va
// rasmlarni shu nomlar bilan joylashtiring)
const IMAGES_DIR = path.join(__dirname, 'rasmlar');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// MUHIM: sendPhoto so'rovlari Telegraf/undici orqali osilib qolayotgani
// aniqlandi (hech qanday xato ham, javob ham qaytmaydi). Shuning uchun
// FAQAT rasm yuborish uchun klassik Node `https` moduli orqali
// to'g'ridan-to'g'ri Telegram Bot API'ga so'rov yuboramiz — bu Telegraf'ning
// muammoli fetch/undici transportini butunlay chetlab o'tadi (xuddi
// node-telegram-bot-api kabi klassik http(s) ishlatadi).
function sendPhotoRaw({ chatId, filePath, fileId, caption, replyMarkup, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const token = process.env.BOT_TOKEN;
    const boundary = '----MSHBoundary' + Date.now() + Math.random().toString(16).slice(2);
    const textFields = { chat_id: String(chatId) };
    if (caption) textFields.caption = caption;
    textFields.parse_mode = 'HTML';
    if (replyMarkup) textFields.reply_markup = JSON.stringify(replyMarkup);

    const parts = [];
    for (const [key, value] of Object.entries(textFields)) {
      parts.push(Buffer.from(
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="' + key + '"\r\n\r\n' +
        value + '\r\n'
      ));
    }

    if (fileId) {
      parts.push(Buffer.from(
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="photo"\r\n\r\n' +
        fileId + '\r\n'
      ));
    } else if (filePath) {
      const fileBuffer = fs.readFileSync(filePath);
      const filename = path.basename(filePath);
      parts.push(Buffer.from(
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="photo"; filename="' + filename + '"\r\n' +
        'Content-Type: image/jpeg\r\n\r\n'
      ));
      parts.push(fileBuffer);
      parts.push(Buffer.from('\r\n'));
    } else {
      reject(new Error('sendPhotoRaw: filePath yoki fileId berilishi shart'));
      return;
    }
    parts.push(Buffer.from('--' + boundary + '--\r\n'));

    const body = Buffer.concat(parts);

    const req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + token + '/sendPhoto',
      method: 'POST',
      family: 4, // IPv6 orqali osilib qolishning oldini olish uchun IPv4 majburlanadi
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok) {
            resolve(parsed.result);
          } else {
            reject(new Error('Telegram API xatosi: ' + (parsed.description || data)));
          }
        } catch (e) {
          reject(new Error("Javobni o'qib bo'lmadi: " + e.message));
        }
      });
    });

    if (timeoutMs) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('So\'rov ' + timeoutMs + 'ms ichida javob bermadi (timeout)'));
      });
    }

    req.on('error', (err) => reject(err));
    req.write(body);
    req.end();
  });
}

const photoFileIdCache = {};

async function sendStyled(ctx, imageFileName, htmlCaption, extraOptions) {
  const imgPath = path.join(IMAGES_DIR, imageFileName);
  const opts = extraOptions || {};
  const replyMarkup = opts.reply_markup;
  const chatId = ctx.chat && ctx.chat.id ? ctx.chat.id : ctx.from.id;
  const cachedFileId = photoFileIdCache[imageFileName];
  const ATTEMPT_TIMEOUT_MS = 20000;

  if (cachedFileId) {
    try {
      await sendPhotoRaw({
        chatId, fileId: cachedFileId, caption: htmlCaption, replyMarkup,
        timeoutMs: ATTEMPT_TIMEOUT_MS,
      });
      return;
    } catch (e) {
      delete photoFileIdCache[imageFileName];
    }
  }

  if (fs.existsSync(imgPath)) {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const sent = await sendPhotoRaw({
          chatId, filePath: imgPath, caption: htmlCaption, replyMarkup,
          timeoutMs: ATTEMPT_TIMEOUT_MS,
        });
        try {
          const photos = sent && sent.photo;
          if (photos && photos.length) {
            photoFileIdCache[imageFileName] = photos[photos.length - 1].file_id;
          }
        } catch (cacheErr) {}
        return;
      } catch (e) {
        if (attempt < MAX_ATTEMPTS) {
          await delay(1500);
        }
      }
    }
  }
  await ctx.replyWithHTML(htmlCaption, opts);
}

// ---------------------- SOZLAMALAR ----------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN .env faylida topilmadi!');
  process.exit(1);
}

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI .env faylida topilmadi! MongoDB Atlas connection string kerak.');
  process.exit(1);
}
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'ms_haydarov_bot';

// BARCHA XABARNI YUBORA OLADIGAN ADMINLAR RO'YXATI
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim());

// Majburiy obuna kanallari
const CHANNELS = [
  {
    label: '1-kanal: Matematika Milliy Sertifikatim',
    url: process.env.CHANNEL_1_LINK || 'https://t.me/Matematika_milliysertifikatim',
    chatId: process.env.CHANNEL_1 || '@Matematika_milliysertifikatim',
    style: 'success',
    emojiId: process.env.EMOJI_GREEN_ID || '5451880684945708278',
  },
  {
    label: '2-kanal: Talim Talaba',
    url: process.env.CHANNEL_2_LINK || 'https://t.me/talimtalaba',
    chatId: process.env.CHANNEL_2 || '@talimtalaba',
    style: 'success', 
    emojiId: process.env.EMOJI_GREEN_ID || '5451880684945708278',
  },
];

const CONFIRM_STYLE = 'danger'; 
const CONFIRM_EMOJI_ID = process.env.EMOJI_RED_ID || '5273805757396031980';

const REQUIRED_REFERRALS = parseInt(process.env.REQUIRED_REFERRALS || '10', 10);
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

// ---------------------- MA'LUMOTLAR BAZASI ----------------------
let usersCollection = null;

async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB_NAME);
  usersCollection = db.collection('users');
  await usersCollection.createIndex({ userId: 1 }, { unique: true });
  console.log('✅ MongoDB Atlas ulandi (' + MONGODB_DB_NAME + ')');
}

async function getUser(userId) {
  const id = String(userId);
  let user = await usersCollection.findOne({ userId: id });
  if (!user) {
    user = {
      userId: id,
      invitedBy: null,
      invitedCount: 0,
      verified: false,
      groupLinkSent: false,
      joinedAt: new Date().toISOString(),
    };
    await usersCollection.insertOne(user);
  }
  return user;
}

async function saveUser(user) {
  const { _id, ...rest } = user; 
  await usersCollection.updateOne(
    { userId: user.userId },
    { $set: rest },
    { upsert: true }
  );
}

async function createOneTimeGroupLink(ctx, userId) {
  if (!GROUP_CHAT_ID) {
    return null;
  }
  try {
    const invite = await ctx.telegram.createChatInviteLink(GROUP_CHAT_ID, {
      member_limit: 1,
      name: 'referral-' + userId,
    });
    return invite.invite_link;
  } catch (e) {
    return null;
  }
}

// ---------------------- BOT ----------------------
const telegramAgent = new https.Agent({ keepAlive: true, timeout: 60000, family: 4 });

const bot = new Telegraf(BOT_TOKEN, {
  telegram: { agent: telegramAgent },
  handlerTimeout: 90_000,
});

async function isMemberOfChannel(ctx, chatId, userId) {
  try {
    const member = await ctx.telegram.getChatMember(chatId, userId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (e) {
    return false;
  }
}

async function isSubscribedToAll(ctx, userId) {
  for (const ch of CHANNELS) {
    const ok = await isMemberOfChannel(ctx, ch.chatId, userId);
    if (!ok) return false;
  }
  return true;
}

function buildSubscribeKeyboard() {
  const rows = CHANNELS.map((ch) => [
    {
      text: ch.label,
      url: ch.url,
      style: ch.style,
      icon_custom_emoji_id: ch.emojiId,
    },
  ]);
  rows.push([
    {
      text: 'Tasdiqlash',
      callback_data: 'check_sub',
      style: CONFIRM_STYLE,
      icon_custom_emoji_id: CONFIRM_EMOJI_ID,
    },
  ]);
  return { inline_keyboard: rows };
}

function subscribeMessageText() {
  return (
    "Assalomu alaykum! 👋\n\n" +
    "Botdan foydalanish uchun quyidagi kanallarga " +
    "obuna bo'ling, so'ng \"Tasdiqlash\" tugmasini bosing:"
  );
}

const REF_EMOJI = {
  party: '5461151367559141950',   
  check: '5206607081334906820',   
  star: '5247133031235329609',    
  rocket: '5145427681680032825',  
  boom: '5406683434124859552',    
  target: '5364040533498932357',  
  fire: '5224607267797606837',    
  sparkles: '5325547803936572038',
  exclaim: '5447644880824181073', 
  down: '5406745015365943482',    
  paperclip: '5271604874419647061', 
  people: '5319106456799158575',  
};

function tgEmoji(key, emoji) {
  const id = REF_EMOJI[key];
  return id ? '<tg-emoji emoji-id="' + id + '">' + emoji + '</tg-emoji>' : emoji;
}

const GET_LINK_BUTTON_TEXT = 'Havolani olish';
const GET_LINK_CALLBACK = 'get_ref_link';
const GET_LINK_EMOJI_ID = '5271604874419647061';

function buildGetLinkKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: GET_LINK_BUTTON_TEXT,
          callback_data: GET_LINK_CALLBACK,
          style: 'success',
          icon_custom_emoji_id: GET_LINK_EMOJI_ID,
        },
      ],
    ],
  };
}

async function sendReferralIntro(ctx, userId) {
  const introText =
    tgEmoji('party', '🎉') + ' Tabriklaymiz, obuna tasdiqlandi!\n\n' +
    tgEmoji('check', '✅') + " Matematikadan A+ olish uchun bepul tayyorlanish imkoniyati sizda!\n" +
    tgEmoji('star', '🌟') + " Har bir yangi do'st taklif qilsangiz — bonus ball beriladi!\n" +
    tgEmoji('rocket', '🚀') + ' Har bir taklif sizni sertifikatga yaqinlashtiradi!\n' +
    tgEmoji('boom', '💥') + " Do'stingiz botga kirib, kanallarga a'zo bo'lsa — +1 ball avto qo'shiladi!\n" +
    tgEmoji('target', '🎯') + ' ' + REQUIRED_REFERRALS + " ta matematik do'st taklif qilsangiz:\n" +
    tgEmoji('fire', '🔥') + " Bot sizga avtomatik tarzda Yopiq guruh havolasini beradi!\n" +
    tgEmoji('sparkles', '✨') + " Imkoniyatni qo'ldan boy bermang!";

  await sendStyled(ctx, 'referral-intro.jpg', introText, {
    reply_markup: buildGetLinkKeyboard(),
  });
}

async function sendReferralLinkInfo(ctx, userId) {
  const user = await getUser(userId);
  const me = await ctx.telegram.getMe();
  const refLink = 'https://t.me/' + me.username + '?start=' + userId;

  const linkText =
    tgEmoji('paperclip', '📎') + ' Sizning referal havolangiz:\n' +
    '<blockquote><b><i>' + refLink + '</i></b></blockquote>';

  const statsText =
    tgEmoji('people', '👥') + ' Taklif qilingan do\'stlar: ' + user.invitedCount + '/' + REQUIRED_REFERRALS;

  const warnText =
    tgEmoji('exclaim', '⚠️') + ' Muhim:\n' +
    '<blockquote><b><i>' +
    "Ball olish uchun do'stingiz botga kirib, majburiy kanallarga a'zo bo'lishi kerak." +
    '</i></b></blockquote>';

  const ctaText =
    tgEmoji('down', '👇') + " Havolani do'stlaringizga hozir yuboring!";

  const infoText =
    linkText + '\n\n' +
    statsText + '\n\n' +
    warnText + '\n' +
    ctaText;

  await sendStyled(ctx, 'referal-havolangiz.jpg', infoText);
}

async function sendReferralInfo(ctx, userId) {
  await sendReferralIntro(ctx, userId);
}

async function creditReferrerIfNeeded(ctx, user, userId) {
  if (!user.invitedBy) return;
  const referrer = await getUser(user.invitedBy);
  referrer.invitedCount += 1;
  await saveUser(referrer);

  try {
    await ctx.telegram.sendMessage(
      user.invitedBy,
      "🎉 Sizning havolangiz orqali yangi foydalanuvchi qo'shildi!\n" +
      'Jami taklif qilinganlar: ' + referrer.invitedCount + '/' + REQUIRED_REFERRALS
    );

    if (referrer.invitedCount >= REQUIRED_REFERRALS && !referrer.groupLinkSent) {
      const link = await createOneTimeGroupLink(ctx, user.invitedBy);
      if (link) {
        referrer.groupLinkSent = true;
        await saveUser(referrer);
        await ctx.telegram.sendMessage(
          user.invitedBy,
          '🎉 Tabriklaymiz! Siz ' + REQUIRED_REFERRALS + " ta do'stingizni taklif qildingiz.\n\n" +
          "👉 Maxsus yopiq guruhga qo'shilish uchun shaxsan sizga mo'ljallangan " +
          "bir martalik havola:\n" +
          '<blockquote><b><i>' + link + '</i></b></blockquote>\n' +
          '<blockquote><b><i>' +
          "⚠️ Bu havola faqat 1 marta va faqat siz uchun ishlaydi." +
          '</i></b></blockquote>',
          { parse_mode: 'HTML' }
        );
      } 
    }
  } catch (e) {}
}

// ---------------------- HANDLERLAR ----------------------

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const user = await getUser(userId);

  const payload = ctx.startPayload;
  if (payload && /^\d+$/.test(payload)) {
    const referrerId = payload;
    if (referrerId !== String(userId) && !user.invitedBy) {
      user.invitedBy = referrerId;
    }
  }
  await saveUser(user);

  const subscribed = await isSubscribedToAll(ctx, userId);
  if (!subscribed) {
    await ctx.reply(subscribeMessageText(), {
      reply_markup: buildSubscribeKeyboard(),
    });
    return;
  }

  const firstTime = !user.verified;
  user.verified = true;
  await saveUser(user);

  if (firstTime) {
    await creditReferrerIfNeeded(ctx, user, userId);
  }
  await sendReferralInfo(ctx, userId);
});


// ==========================================
// YANGI: BARCHA A'ZOLARGA XABAR YUBORISH (NOYOB FILTR BILAN)
// ==========================================

const broadcastState = {
  isActive: false,
  shouldStop: false,
};

bot.command('sendall', async (ctx) => {
  const userId = String(ctx.from.id);
  
  if (!ADMIN_IDS.includes(userId)) {
    return;
  }

  if (broadcastState.isActive) {
    return ctx.reply("⚠️ Ayni paytda boshqa xabar tarqatish jarayoni ketmoqda. Iltimos, u tugashini kuting yoki uni to'xtating.");
  }

  const replyTo = ctx.message.reply_to_message;
  if (!replyTo) {
    return ctx.reply("⚠️ Xatolik: Iltimos, tarqatmoqchi bo'lgan xabaringizga reply (javob) qilib /sendall komandasini yuboring.");
  }

  // 1. Bazadagi barcha odamlarni olamiz
  const allUsers = await usersCollection.find({}).toArray();
  
  // 2. Takrorlanishlarning oldini olish uchun faqat noyob (unique) ID larni ajratib olamiz
  const uniqueUsers = [];
  const processedIds = new Set();
  
  for (const u of allUsers) {
    const idString = String(u.userId);
    if (!processedIds.has(idString)) {
      uniqueUsers.push(u);
      processedIds.add(idString);
    }
  }

  const totalUsers = uniqueUsers.length;

  broadcastState.isActive = true;
  broadcastState.shouldStop = false;

  const statusMsg = await ctx.reply(
    `🚀 Barcha ${totalUsers} ta takrorlanmas foydalanuvchiga xabar yuborish boshlandi...\n\nBu jarayon orqa fonda ishlaydi. Istalgan vaqtda to'xtatishingiz mumkin.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🛑 To\'xtatish', callback_data: 'stop_broadcast' }]
        ]
      }
    }
  );

  (async () => {
    let successCount = 0;
    let failCount = 0;
    let isStoppedByUser = false;

    // 3. Faqat noyob qilingan ro'yxat bo'yicha aylanamiz
    for (const user of uniqueUsers) {
      if (broadcastState.shouldStop) {
        isStoppedByUser = true;
        break;
      }

      try {
        await ctx.telegram.copyMessage(user.userId, ctx.chat.id, replyTo.message_id);
        successCount++;
      } catch (error) {
        failCount++;
      }
      
      await delay(50);
    }

    broadcastState.isActive = false;
    broadcastState.shouldStop = false;

    try {
      await ctx.telegram.editMessageReplyMarkup(ctx.chat.id, statusMsg.message_id, undefined, { inline_keyboard: [] });

      const finalStatusText = isStoppedByUser 
        ? "🛑 Xabar tarqatish jarayoni TO'XTATILDI!\n\n" 
        : "✅ Xabar tarqatish to'liq YAKUNLANDI!\n\n";

      await ctx.telegram.sendMessage(
        ctx.chat.id,
        finalStatusText + `📈 Statistika:\n👥 Jami urinishlar: ${isStoppedByUser ? (successCount+failCount) : totalUsers} ta\n✅ Yetib bordi: ${successCount} ta\n❌ Bloklagan yoki o'chirilgan: ${failCount} ta`
      );
    } catch (e) {
      console.error("Adminga hisobot yuborib bo'lmadi:", e.message);
    }
  })();
});

bot.action('stop_broadcast', async (ctx) => {
  const userId = String(ctx.from.id);
  
  if (!ADMIN_IDS.includes(userId)) {
    return;
  }

  if (!broadcastState.isActive) {
    return ctx.answerCbQuery("Tizimda hech qanday xabar tarqatish jarayoni ketmayapti.", { show_alert: true });
  }

  broadcastState.shouldStop = true;
  await ctx.answerCbQuery("To'xtatilmoqda...", { show_alert: false });
  
  try {
    await ctx.editMessageText("🛑 Xabar tarqatish to'xtatilmoqda, iltimos hisobot kelishini kuting...");
  } catch(e) {}
});
// ==========================================


bot.action('check_sub', async (ctx) => {
  const userId = ctx.from.id;
  const user = await getUser(userId);

  const subscribed = await isSubscribedToAll(ctx, userId);
  if (!subscribed) {
    await ctx.answerCbQuery("❌ Siz hali barcha kanallarga obuna bo'lmadingiz!", {
      show_alert: true,
    });
    return;
  }

  await ctx.answerCbQuery('✅ Obuna tasdiqlandi!');

  const firstTimeConfirm = !user.verified;
  user.verified = true;
  await saveUser(user);

  if (firstTimeConfirm) {
    await creditReferrerIfNeeded(ctx, user, userId);
  }

  try {
    await ctx.editMessageReplyMarkup(undefined);
  } catch (e) {}

  await sendReferralInfo(ctx, userId);
});

bot.action(GET_LINK_CALLBACK, async (ctx) => {
  const userId = ctx.from.id;
  await ctx.answerCbQuery();

  try {
    await ctx.deleteMessage();
  } catch (e) {}

  await sendReferralLinkInfo(ctx, userId);
});

bot.command('mystats', async (ctx) => {
  const user = await getUser(ctx.from.id);
  await ctx.reply(
    '📊 Statistikangiz:\n' +
    "Taklif qilinganlar: " + user.invitedCount + '/' + REQUIRED_REFERRALS
  );
});

bot.catch((err, ctx) => {
  console.error('Xatolik yuz berdi (update ' + ctx.updateType + '):', err);
});

// ---------------------- ISHGA TUSHIRISH ----------------------
async function main() {
  await connectDB();

  if (WEBHOOK_URL) {
    const app = express();
    app.use(express.json());

    const secretPath = '/webhook/' + BOT_TOKEN;
    app.use(bot.webhookCallback(secretPath));

    app.get('/', (req, res) => res.send('MS Haydarov Bot ishlayapti ✅'));

    app.listen(PORT, async () => {
      await bot.telegram.setWebhook(WEBHOOK_URL + secretPath);
      console.log('✅ Server ' + PORT + '-portda ishga tushdi');
      console.log('✅ Webhook o\'rnatildi: ' + WEBHOOK_URL + secretPath);
    });
  } else {
    await bot.launch();
    console.log('✅ MS Haydarov bot polling rejimida ishga tushdi (lokal)');
  }
}

main().catch((e) => {
  console.error('❌ Botni ishga tushirishda xatolik:', e.message);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
