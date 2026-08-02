import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { decryptPollVote, getKeyAuthor, jidNormalizedUser, transferDevice } from '@whiskeysockets/baileys';
import { config } from '../config/index.js';
import { dbService } from '../services/dbService.js';
import { sessionService } from '../services/sessionService.js';
import { recentPollSent } from '../services/pollTracker.js';
import { userCommands } from '../commands/userCommands/index.js';
import { adminCommands } from '../commands/adminCommands/index.js';
import { searchService } from '../services/searchService.js';
import logger, { dbLog } from '../utils/logger.js';
import { msgStore } from './client.js';

const lastWarningTimes = new Map();

/**
 * Convert Arabic/Indic numerals to Western Arabic numerals
 */
function convertArabicNumerals(str) {
  if (!str) return str;
  const arabicNumbers = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
  let result = str;
  for (let i = 0; i < 10; i++) {
    result = result.replace(new RegExp(arabicNumbers[i], 'g'), i.toString());
  }
  return result;
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function suppressPollEcho(phone, body, isPollVote) {
  if (!body || isPollVote) return false;
  const recentSent = recentPollSent.get(phone);
  if (recentSent && Date.now() - recentSent.ts < 5000) {
    if (recentSent.values.includes(body)) {
      logger.info(`Suppressing poll echo for ${phone}: "${body}"`);
      recentPollSent.clear(phone);
      return true;
    }
  }
  return false;
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'base64');
  return value;
}

function extractMessageBody(rawMsg, botUser = {}, resolvedPhone = '') {
  if (!rawMsg || !rawMsg.message) return '';

  const m = rawMsg.message;

  if (m.conversation) return m.conversation.trim();
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text.trim();
  if (m.documentMessage?.caption) return m.documentMessage.caption.trim();
  if (m.imageMessage?.caption) return m.imageMessage.caption.trim();
  if (m.audioMessage?.caption) return m.audioMessage.caption?.trim() || '';

  if (m.buttonsResponseMessage?.selectedButtonId) return m.buttonsResponseMessage.selectedButtonId.trim();
  if (m.buttonsResponseMessage?.selectedDisplayText) return m.buttonsResponseMessage.selectedDisplayText.trim();
  if (m.listResponseMessage?.singleSelectReply?.selectedRowId) return m.listResponseMessage.singleSelectReply.selectedRowId.trim();
  if (m.templateButtonReplyMessage?.selectedId) return m.templateButtonReplyMessage.selectedId.trim();

  if (m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
    try {
      const params = JSON.parse(m.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
      if (params.id) return String(params.id).trim();
    } catch (e) {}
  }

  if (m.pollUpdateMessage) {
    const creationKey = m.pollUpdateMessage.pollCreationMessageKey;
    const pollCreation = creationKey?.id ? msgStore.get(creationKey.id) : null;

    if (pollCreation?.messageContextInfo?.messageSecret && m.pollUpdateMessage.vote?.encPayload) {
      try {
        const vote = {
          encPayload: asBuffer(m.pollUpdateMessage.vote.encPayload),
          encIv: asBuffer(m.pollUpdateMessage.vote.encIv)
        };

        const botId = botUser?.id ? jidNormalizedUser(botUser.id) : '';
        const botLid = botUser?.lid
          ? jidNormalizedUser(String(botUser.lid).includes('@') ? String(botUser.lid) : `${botUser.lid}@lid`)
          : '';
        const remoteJid = rawMsg.key?.remoteJid || '';
        const phoneJid = resolvedPhone ? `${resolvedPhone}@s.whatsapp.net` : '';

        const creatorCandidates = uniqueValues([
          botLid, botId, creationKey?.remoteJid, getKeyAuthor(creationKey, botLid || botId || 'me')
        ]);
        const voterCandidates = uniqueValues([
          remoteJid, phoneJid, rawMsg.key?.participant, getKeyAuthor(rawMsg.key, botLid || botId || 'me')
        ]);

        let voteMsg = null;
        for (const pollCreatorJid of creatorCandidates) {
          for (const voterJid of voterCandidates) {
            try {
              voteMsg = decryptPollVote(vote, {
                pollEncKey: asBuffer(pollCreation.messageContextInfo.messageSecret),
                pollCreatorJid,
                pollMsgId: creationKey.id,
                voterJid
              });
              break;
            } catch (err) {}
          }
          if (voteMsg) break;
        }

        if (voteMsg) {
          const selectedHash = voteMsg.selectedOptions?.[0]?.toString();
          const options = pollCreation.pollCreationMessage?.options ||
            pollCreation.pollCreationMessageV2?.options ||
            pollCreation.pollCreationMessageV3?.options || [];

          for (const option of options) {
            const optionName = option.optionName || '';
            const optionHash = crypto.createHash('sha256').update(Buffer.from(optionName, 'utf8')).digest().toString();
            if (selectedHash === optionHash) {
              return optionName.trim();
            }
          }
        }
      } catch (err) {}
    }

    const vote = m.pollUpdateMessage.vote || m.pollUpdateMessage.pollUpdates?.[0]?.vote;
    if (vote?.selectedOptions && vote.selectedOptions.length > 0) {
      const opt = vote.selectedOptions[0];
      let hexHash = '';
      if (Buffer.isBuffer(opt) || opt instanceof Uint8Array) {
        hexHash = Buffer.from(opt).toString('hex');
      } else if (typeof opt === 'string' && opt.length === 64) {
        hexHash = opt.toLowerCase();
      } else if (typeof opt === 'string') {
        return opt.trim();
      }

      if (hexHash) {
        const candidates = [
          "🔍 بحث عن محتوى", "📂 التصنيفات", "🎧 جميع الصوتيات", "🎬 جميع الفيديوهات", "📚 جميع الكتب",
          "🆕 صوتية الأسبوع", "🎬 فيديو الأسبوع", "📖 كتاب الأسبوع", "➕ إضافة محتوى", "🔔 الاشتراك",
          "📢 الإعلانات", "📊 إحصائيات المكتبة", "🎧 صوتيات", "🎬 فيديوهات", "📚 كتب",
          "⬅️ السابق", "➡️ التالي", "↩️ رجوع", "↩️ رجوع للتصنيفات", "🔙 القائمة الرئيسية",
          "🔍 بحث جديد", "📥 تحميل رقم آخر", "➕ إضافة محتوى آخر", "❌ إلغاء"
        ];

        for (const cand of candidates) {
          const h1 = crypto.createHash('sha256').update(cand, 'utf8').digest('hex');
          if (hexHash === h1) {
            return cand;
          }
        }
      }
    }
  }

  return '';
}

function resolveLidToPhone(lidNumber) {
  try {
    const authDir = process.env.AUTH_DIR || path.join(process.cwd(), '.baileys_auth');
    const mappingFile = path.join(authDir, `lid-mapping-${lidNumber}_reverse.json`);
    if (fs.existsSync(mappingFile)) {
      const raw = fs.readFileSync(mappingFile, 'utf-8');
      const data = JSON.parse(raw);
      if (data) return String(data);
    }
  } catch (err) {}
  return null;
}

export async function handleMessage(sock, rawMsg) {
  const remoteJid = rawMsg.key.remoteJid;
  if (!remoteJid || remoteJid === 'status@broadcast') return;

  let phone = remoteJid.split('@')[0];
  if (remoteJid.endsWith('@lid')) {
    const resolved = resolveLidToPhone(phone);
    if (resolved) phone = resolved;
  }

  const msgTimestamp = Number(rawMsg.messageTimestamp) || 0;
  const currentTimestamp = Math.floor(Date.now() / 1000);
  if (msgTimestamp > 0 && currentTimestamp - msgTimestamp > 60) return;

  if (!rawMsg.isPollSelection && sessionService.isRateLimited(phone)) {
    const now = Date.now();
    const lastWarn = lastWarningTimes.get(phone) || 0;
    if (now - lastWarn > 5000) {
      lastWarningTimes.set(phone, now);
      await sock.sendMessage(remoteJid, { text: '⚠️ الرجاء إرسال الرسائل ببطء.' }, { quoted: rawMsg });
    }
    return;
  }

  try {
    const name = rawMsg.pushName || 'مستخدم واتساب';
    const isAdmin = phone === config.adminNumber;
    await dbService.upsertUser(phone, name, isAdmin ? 'admin' : 'user');

    let body = extractMessageBody(rawMsg, sock.user || {}, phone);
    body = body.replace(/`/g, '').trim();
    body = convertArabicNumerals(body);

    const isPollVote = rawMsg.isPollSelection || rawMsg.message?.pollUpdateMessage;
    if (suppressPollEcho(phone, body, isPollVote)) return;

    // Poll options mapping
    const pollMap = {
      '🔍 بحث عن محتوى': 'بحث',
      '📂 التصنيفات': 'تصنيفات',
      '🎧 جميع الصوتيات': 'جميع_صوتيات',
      '🎬 جميع الفيديوهات': 'جميع_فيديوهات',
      '📚 جميع الكتب': 'جميع_كتب',
      '🆕 صوتية الأسبوع': 'صوتية_الاسبوع',
      '🎬 فيديو الأسبوع': 'فيديو_الاسبوع',
      '📖 كتاب الأسبوع': 'كتاب_الاسبوع',
      '➕ إضافة محتوى': 'اضافة',
      '🔔 الاشتراك': 'اشتراك',
      '📢 الإعلانات': 'إعلانات',
      '📊 إحصائيات المكتبة': 'احصائيات',
      '🎧 صوتيات': 'نوع_صوتيات',
      '🎬 فيديوهات': 'نوع_فيديوهات',
      '📚 كتب': 'نوع_كتب',
      '↩️ رجوع': 'رجوع',
      '↩️ رجوع للتصنيفات': 'رجوع',
      '🔙 القائمة الرئيسية': 'قائمة',
      '🔍 بحث جديد': 'بحث_جديد',
      '📥 تحميل رقم آخر': 'تحميل_رقم_اخر',
      '➕ إضافة محتوى آخر': 'اضافة',
      '❌ إلغاء': 'إلغاء'
    };

    if (pollMap[body]) body = pollMap[body];

    const msg = {
      from: phone,
      remoteJid,
      body,
      pushname: name,
      raw: rawMsg,
      reply: async (text) => await sock.sendMessage(remoteJid, { text }, { quoted: rawMsg })
    };

    const session = sessionService.getSession(phone);
    const cleanBody = body.toLowerCase().trim();

    // Global Shortcuts
    if (['/start', 'ابدأ', 'البداية', 'القائمة', 'قائمة', 'الرئيسية'].includes(cleanBody)) {
      sessionService.clearSession(phone);
      return await userCommands.handleStart(sock, msg);
    }

    if (['إلغاء', 'الغاء', 'cancel'].includes(cleanBody)) {
      sessionService.clearSession(phone);
      await msg.reply('✅ تم إلغاء العملية والعودة للقائمة الرئيسية.');
      return await userCommands.handleStart(sock, msg);
    }

    // Smart Back Handler
    if (cleanBody === 'رجوع') {
      if (!session || !session.data?.backTo) {
        sessionService.clearSession(phone);
        return await userCommands.handleStart(sock, msg);
      }

      const backTo = session.data.backTo;
      if (backTo === 'SELECTING_CONTENT_TYPE') {
        return await userCommands.promptContentType(sock, msg, session.data.context || 'browse');
      }
      if (backTo === 'SELECTING_CATEGORY') {
        return await userCommands.displayCategoriesForType(sock, msg, session.data.contentType || 'audio', session.data.context || 'browse');
      }
      if (backTo === 'AWAITING_SEARCH') {
        return await userCommands.promptSearchInput(sock, msg, session.data.contentType || 'audio', session.data.categoryName);
      }
      
      sessionService.clearSession(phone);
      return await userCommands.handleStart(sock, msg);
    }

    // Active State Routing
    if (session.state !== 'IDLE') {
      switch (session.state) {
        case 'SELECTING_CONTENT_TYPE': {
          const ctx = session.data?.context || 'search';
          let cType = 'audio';
          if (body === 'نوع_فيديوهات' || body.includes('فيديو')) cType = 'video';
          else if (body === 'نوع_كتب' || body.includes('كتب')) cType = 'book';

          if (ctx === 'search') return await userCommands.displayCategoriesForType(sock, msg, cType, 'search');
          if (ctx === 'browse') return await userCommands.displayCategoriesForType(sock, msg, cType, 'browse');
          if (ctx === 'add') return await userCommands.handleAddMediaTypeSelection(sock, msg, body);
          break;
        }

        case 'SELECTING_CATEGORY': {
          const cType = session.data?.contentType || 'audio';
          const ctx = session.data?.context || 'browse';

          if (body.includes('بحث في كل')) {
            return await userCommands.promptSearchInput(sock, msg, cType, null);
          }

          let catName = body.replace(/^📋\s*/, '').trim();
          if (catName) {
            if (ctx === 'search') {
              return await userCommands.promptSearchInput(sock, msg, cType, catName);
            }
            if (ctx === 'add') {
              return await userCommands.handleAddCategorySelect(sock, msg, catName);
            }
            return await userCommands.listContent(sock, msg, cType, catName, 0);
          }
          break;
        }

        case 'AWAITING_SEARCH':
          return await userCommands.executeSearch(sock, msg, body, session.data?.contentType || 'audio', session.data?.categoryName);

        case 'CONTENT_LIST':
          return await userCommands.handleContentListInput(sock, msg, body);

        case 'AWAITING_UPLOAD_FILE':
          return await userCommands.handleFileUpload(sock, msg);

        case 'AWAITING_ADD_TITLE':
          return await userCommands.handleAddTitle(sock, msg);

        case 'AWAITING_ADD_AUTHOR':
          return await userCommands.handleAddAuthor(sock, msg);

        case 'AWAITING_ADD_CATEGORY': {
          const catName = body.replace(/^📋\s*/, '').trim();
          return await userCommands.handleAddCategorySelect(sock, msg, catName);
        }

        case 'AWAITING_ADD_LOCATION':
          return await userCommands.handleAddLocation(sock, msg);

        case 'AWAITING_ADD_DATE_HIJRI':
          return await userCommands.handleAddDateHijri(sock, msg);

        case 'AWAITING_ADD_DESC':
          return await userCommands.handleAddDescription(sock, msg);

        case 'AWAITING_DELETE_CONFIRM': {
          if (body.startsWith('تأكيد حذف ')) {
            const uuid = body.substring(9).trim();
            sessionService.clearSession(phone);
            return await adminCommands.confirmDelete(sock, msg, uuid);
          }
          break;
        }

        case 'AWAITING_REJECT_REASON': {
          const reqId = session.data?.rejectRequestId;
          sessionService.clearSession(phone);
          return await adminCommands.rejectRequest(sock, msg, reqId, body);
        }
      }
    }

    // Admin Commands
    if (isAdmin) {
      if (['أوامر', 'الاوامر', 'الديد', 'help', 'admin'].includes(cleanBody)) return await adminCommands.showAdminHelp(sock, msg);
      if (body === 'تصنيفات الأدمن' || body === 'تصنيفات الادمن') return await adminCommands.listAdminCategories(sock, msg);
      if (body === 'طلبات') return await adminCommands.listRequests(sock, msg);
      if (body === 'قبول' || body.startsWith('قبول ')) return await adminCommands.approveRequest(sock, msg, body.substring(4).trim());
      if (body === 'رفض' || body.startsWith('رفض ')) {
        const paramStr = body.substring(3).trim();
        const spaceIdx = paramStr.indexOf(' ');
        let reqId = paramStr, reason = 'غير محدد';
        if (spaceIdx !== -1) { reqId = paramStr.substring(0, spaceIdx).trim(); reason = paramStr.substring(spaceIdx).trim(); }
        return await adminCommands.rejectRequest(sock, msg, reqId, reason);
      }
      if (body.startsWith('حذف ')) return await adminCommands.deleteAudio(sock, msg, body.substring(4).trim());
      if (body === 'إحصائيات' || body === 'تقرير') return await adminCommands.displayAdminStats(sock, msg);
      if (body.startsWith('رسالة جماعية ')) return await adminCommands.broadcastMessage(sock, msg, body.substring(13).trim());
      if (body === 'نسخة احتياطية' || body === 'نسخة') return await adminCommands.sendBackup(sock, msg);
      if (body === 'تحديث الفهرس') return await adminCommands.rebuildCache(sock, msg);
      if (body === 'تنظيف المؤقت') return await adminCommands.cleanTempFiles(sock, msg);
      if (body.startsWith('إضافة تصنيف ')) return await adminCommands.addCategory(sock, msg, body.substring(12).trim());
      if (body.startsWith('حذف تصنيف ')) return await adminCommands.removeCategory(sock, msg, body.substring(10).trim());
      if (body.startsWith('إضافة إعلان ')) return await adminCommands.addAdvertisement(sock, msg, body.substring(12).trim());
    }

    // User Commands
    if (body === 'بحث') return await userCommands.promptContentType(sock, msg, 'search');
    if (body === 'تصنيفات') return await userCommands.promptContentType(sock, msg, 'browse');
    if (body === 'جميع_صوتيات') return await userCommands.listContent(sock, msg, 'audio', null, 0);
    if (body === 'جميع_فيديوهات') return await userCommands.listContent(sock, msg, 'video', null, 0);
    if (body === 'جميع_كتب') return await userCommands.listContent(sock, msg, 'book', null, 0);
    if (body === 'صوتية_الاسبوع') return await userCommands.displayNewThisWeek(sock, msg, 'audio');
    if (body === 'فيديو_الاسبوع') return await userCommands.displayNewThisWeek(sock, msg, 'video');
    if (body === 'كتاب_الاسبوع') return await userCommands.displayNewThisWeek(sock, msg, 'book');
    if (body === 'اضافة') return await userCommands.promptAddContent(sock, msg);
    if (body === 'اشتراك') return await userCommands.handleSubscribe(sock, msg);
    if (body === 'إعلانات') return await userCommands.displayAdvertisements(sock, msg);
    if (body === 'احصائيات') return await userCommands.displayLibraryStats(sock, msg);

    if (!body || body.trim().length === 0) return;

    // Default Fallback
    return await userCommands.handleStart(sock, msg);

  } catch (err) {
    logger.error(`Error in message routing for ${phone}: ${err.stack}`);
  }
}

export function cleanupHandlerMaps() {
  const now = Date.now();
  const MAX_AGE_MS = 10 * 60 * 1000;
  for (const [phone, time] of lastWarningTimes.entries()) {
    if (now - time > MAX_AGE_MS) {
      lastWarningTimes.delete(phone);
    }
  }
}
