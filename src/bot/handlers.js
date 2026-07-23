import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { decryptPollVote, getKeyAuthor, jidNormalizedUser, transferDevice } from '@whiskeysockets/baileys';
import { config } from '../config/index.js';
import { dbService } from '../services/dbService.js';
import { sessionService } from '../services/sessionService.js';
import { recentPollSent } from '../services/pollTracker.js';
import { userCommands } from '../commands/userCommands.js';
import { adminCommands } from '../commands/adminCommands.js';
import { searchService } from '../services/searchService.js';
import logger, { dbLog } from '../utils/logger.js';
import { msgStore } from './client.js';

/**
 * Extract text body or selected poll/button value from raw Baileys message object
 * @param {object} rawMsg 
 * @param {string} [meId]
 * @returns {string}
 */
function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
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

  // 1. Standard Text & Media Captions
  if (m.conversation) return m.conversation.trim();
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text.trim();
  if (m.documentMessage?.caption) return m.documentMessage.caption.trim();
  if (m.imageMessage?.caption) return m.imageMessage.caption.trim();
  if (m.audioMessage?.caption) return m.audioMessage.caption?.trim() || '';

  // 2. Buttons & List responses
  if (m.buttonsResponseMessage?.selectedButtonId) return m.buttonsResponseMessage.selectedButtonId.trim();
  if (m.buttonsResponseMessage?.selectedDisplayText) return m.buttonsResponseMessage.selectedDisplayText.trim();
  if (m.listResponseMessage?.singleSelectReply?.selectedRowId) return m.listResponseMessage.singleSelectReply.selectedRowId.trim();
  if (m.templateButtonReplyMessage?.selectedId) return m.templateButtonReplyMessage.selectedId.trim();

  // 3. Native Flow / Interactive Response Messages
  if (m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
    try {
      const params = JSON.parse(m.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
      if (params.id) return String(params.id).trim();
    } catch (e) {}
  }

  // 4. Poll Vote Updates
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
        const botIdWithDevice = botUser?.id || '';
        const botLidWithDevice = botUser?.lid
          ? (String(botUser.lid).includes('@') ? String(botUser.lid) : `${botUser.lid}@lid`)
          : '';

        const creatorCandidates = uniqueValues([
          botLid,
          botId,
          botLidWithDevice,
          botIdWithDevice,
          creationKey?.remoteJid,
          getKeyAuthor(creationKey, botLid || botId || 'me')
        ]);
        const voterCandidates = uniqueValues([
          remoteJid,
          phoneJid,
          botLid ? transferDevice(botLid, remoteJid) : '',
          botId ? transferDevice(botId, phoneJid || remoteJid) : '',
          rawMsg.key?.remoteJidAlt,
          rawMsg.key?.participant,
          rawMsg.key?.participantAlt,
          getKeyAuthor(rawMsg.key, botLid || botId || 'me')
        ]);

        let voteMsg = null;
        let lastDecryptError = null;
        for (const pollCreatorJid of creatorCandidates) {
          for (const voterJid of voterCandidates) {
            try {
              voteMsg = decryptPollVote(
                vote,
                {
                  pollEncKey: asBuffer(pollCreation.messageContextInfo.messageSecret),
                  pollCreatorJid,
                  pollMsgId: creationKey.id,
                  voterJid
                }
              );
              logger.info(`Poll vote decrypted using creator=${pollCreatorJid}, voter=${voterJid}`);
              break;
            } catch (err) {
              lastDecryptError = err;
            }
          }
          if (voteMsg) break;
        }

        if (!voteMsg) {
          logger.warn(`Poll decrypt failed for creators=${JSON.stringify(creatorCandidates)}, voters=${JSON.stringify(voterCandidates)}, botUser=${JSON.stringify(botUser)}`);
          throw lastDecryptError || new Error('No JID combination could decrypt poll vote');
        }

        const selectedHash = voteMsg.selectedOptions?.[0]?.toString();
        const options = pollCreation.pollCreationMessage?.options ||
          pollCreation.pollCreationMessageV2?.options ||
          pollCreation.pollCreationMessageV3?.options ||
          [];

        for (const option of options) {
          const optionName = option.optionName || '';
          const optionHash = crypto.createHash('sha256').update(Buffer.from(optionName, 'utf8')).digest().toString();
          if (selectedHash === optionHash) {
            logger.info(`Decrypted poll vote option: "${optionName}"`);
            return optionName.trim();
          }
        }

        logger.warn(`Poll vote decrypted but option hash was not matched: ${selectedHash}`);
      } catch (err) {
        logger.warn(`Could not decrypt poll vote: ${err.message}`);
      }
    }

    const vote = m.pollUpdateMessage.vote || m.pollUpdateMessage.pollUpdates?.[0]?.vote;
    if (vote?.selectedOptions && vote.selectedOptions.length > 0) {
      const opt = vote.selectedOptions[0];
      let hexHash = '';

      if (Buffer.isBuffer(opt) || opt instanceof Uint8Array) {
        hexHash = Buffer.from(opt).toString('hex');
      } else if (typeof opt === 'string') {
        if (opt.length === 64) {
          hexHash = opt.toLowerCase();
        } else {
          return opt.trim();
        }
      } else if (opt && typeof opt === 'object') {
        if (opt.name) return opt.name.trim();
        if (opt.optionName) return opt.optionName.trim();
        const sub = opt.optionHash || opt.hash;
        if (Buffer.isBuffer(sub) || sub instanceof Uint8Array) {
          hexHash = Buffer.from(sub).toString('hex');
        } else if (typeof sub === 'string') {
          hexHash = sub.toLowerCase();
        }
      }

      if (hexHash) {
        logger.info(`Received Poll vote with option SHA256 hash: ${hexHash}`);

        const candidates = [
          "🔍 البحث عن صوتية", "البحث عن صوتية",
          "📂 التصنيفات", "التصنيفات",
          "📋 جميع الصوتيات", "جميع الصوتيات",
          "✨ أحدث الصوتيات", "أحدث الصوتيات",
          "⭐ المفضلة", "المفضلة",
          "🔔 الاشتراك", "الاشتراك",
          "📤 إضافة صوتية", "إضافة صوتية",
          "📊 إحصائيات المكتبة", "إحصائيات المكتبة",
          "➡️ التالي", "⬅️ السابق", "🔙 القائمة الرئيسية"
        ];

        if (config.categories) {
          config.categories.forEach((cat, idx) => {
            candidates.push(`${idx + 1}. ${cat}`);
            candidates.push(cat);
          });
        }

        for (const cand of candidates) {
          const h1 = crypto.createHash('sha256').update(cand, 'utf8').digest('hex');
          if (hexHash === h1) {
            logger.info(`Matched poll vote option: "${cand}"`);
            return cand;
          }
        }
      }
    }
  }

  return '';
}

/**
 * Resolve a LID (Linked Identity) number to a phone number
 * by reading the Baileys auth store reverse mapping files.
 * @param {string} lidNumber - The LID number (without @lid suffix)
 * @returns {string|null} The phone number, or null if not found
 */
function resolveLidToPhone(lidNumber) {
  try {
    const mappingFile = path.join(process.cwd(), '.baileys_auth', `lid-mapping-${lidNumber}_reverse.json`);
    if (fs.existsSync(mappingFile)) {
      const raw = fs.readFileSync(mappingFile, 'utf-8');
      const data = JSON.parse(raw);
      if (data) return String(data);
    }
  } catch (err) {
    logger.warn(`Could not resolve LID ${lidNumber}: ${err.message}`);
  }
  return null;
}

/**
 * Check if incoming message contains an audio/document file
 * @param {object} rawMsg
 * @returns {{ hasAudio: boolean, mimetype: string, isDocument: boolean }}
 */
function detectAudioMessage(rawMsg) {
  const m = rawMsg.message;
  if (!m) return { hasAudio: false, mimetype: '', isDocument: false };

  // Direct audio message
  if (m.audioMessage) {
    return {
      hasAudio: true,
      mimetype: m.audioMessage.mimetype || 'audio/ogg',
      isDocument: false,
      filename: null
    };
  }

  // Document that might be an audio file
  if (m.documentMessage) {
    const mime = (m.documentMessage.mimetype || '').toLowerCase();
    const fname = (m.documentMessage.fileName || '').toLowerCase();
    const audioExtensions = ['.mp3', '.m4a', '.aac', '.ogg', '.wav', '.webm', '.flac', '.opus'];
    const audioMimes = ['audio/', 'application/octet-stream'];
    
    const isMimeAudio = audioMimes.some(am => mime.startsWith(am));
    const isExtAudio = audioExtensions.some(ext => fname.endsWith(ext));
    
    if (mime.startsWith('audio/') || (isMimeAudio && isExtAudio)) {
      return {
        hasAudio: true,
        mimetype: mime,
        isDocument: true,
        filename: m.documentMessage.fileName
      };
    }
  }

  return { hasAudio: false, mimetype: '', isDocument: false };
}

/**
 * Main message handler entry point.
 * @param {object} sock
 * @param {object} rawMsg
 */
export async function handleMessage(sock, rawMsg) {
  const remoteJid = rawMsg.key.remoteJid;
  if (!remoteJid || remoteJid === 'status@broadcast') return;

  const isLid = remoteJid.endsWith('@lid');
  const isGroup = remoteJid.endsWith('@g.us');
  let phone = remoteJid.split('@')[0];
  
  // Resolve LID to actual phone number if possible
  if (isLid) {
    const resolved = resolveLidToPhone(phone);
    if (resolved) {
      logger.info(`Resolved LID ${phone} -> phone ${resolved}`);
      phone = resolved;
    }
  }
  
  if (isGroup) return;

  // Ignore old messages (older than 60 seconds) to prevent startup spam loops
  const msgTimestamp = Number(rawMsg.messageTimestamp) || 0;
  const currentTimestamp = Math.floor(Date.now() / 1000);
  if (msgTimestamp > 0 && currentTimestamp - msgTimestamp > 60) {
    return;
  }

  if (!rawMsg.isPollSelection && sessionService.isRateLimited(phone)) {
    const now = Date.now();
    if (!global.lastWarningTimes) global.lastWarningTimes = new Map();
    const lastWarn = global.lastWarningTimes.get(phone) || 0;
    
    if (now - lastWarn > 5000) {
      global.lastWarningTimes.set(phone, now);
      await sock.sendMessage(remoteJid, { text: '⚠️ الرجاء إرسال الرسائل ببطء لتجنب الحظر.' }, { quoted: rawMsg });
    }
    return;
  }

  try {
    const name = rawMsg.pushName || 'مستخدم واتساب';
    const isAdmin = phone === config.adminNumber;
    const role = isAdmin ? 'admin' : 'user';

    await dbService.upsertUser(phone, name, role);

    if (rawMsg.message) {
      logger.info(`Message keys from ${phone}: ${Object.keys(rawMsg.message).join(', ')}`);
      if (rawMsg.message.pollUpdateMessage) {
        logger.info(`Raw pollUpdateMessage: ${JSON.stringify(rawMsg.message.pollUpdateMessage)}`);
      }
    }

    let body = extractMessageBody(rawMsg, sock.user || {}, phone);
    // Strip markdown backticks that users might accidentally copy-paste from bot responses
    body = body.replace(/`/g, '').trim();

    // Skip echo suppression for poll votes — they are genuine user selections, not echoes
    const isPollVote = rawMsg.isPollSelection || rawMsg.message?.pollUpdateMessage;
    if (body && !isPollVote) {
      const recentSent = recentPollSent.get(phone);
      if (recentSent && Date.now() - recentSent.ts < 5000) {
        if (recentSent.values.includes(body)) {
          logger.info(`Suppressing poll echo for ${phone}: "${body}"`);
          recentPollSent.clear(phone);
          return;
        }
      }
    }

    // Map Poll option selections to standard command terms
    const pollMap = {
      '🔍 البحث عن صوتية': 'بحث',
      'البحث عن صوتية': 'بحث',
      '📂 التصنيفات': 'تصنيفات',
      'التصنيفات': 'تصنيفات',
      '📋 جميع الصوتيات': 'جميع',
      'جميع الصوتيات': 'جميع',
      '✨ أحدث الصوتيات': 'جديد',
      'أحدث الصوتيات': 'جديد',
      '⭐ المفضلة': 'مفضلة',
      'المفضلة': 'مفضلة',
      '🔔 الاشتراك': 'اشتراك',
      'الاشتراك': 'اشتراك',
      '📤 إضافة صوتية': 'اضافة',
      'إضافة صوتية': 'اضافة',
      '📊 إحصائيات المكتبة': 'احصائيات',
      'إحصائيات المكتبة': 'احصائيات',
      '➡️ التالي': 'التالي',
      '⬅️ السابق': 'السابق',
      '🔙 القائمة الرئيسية': 'قائمة'
    };

    if (pollMap[body]) {
      body = pollMap[body];
    }
    
    // Create a polyfill for msg to make commands compatible
    const audioInfo = detectAudioMessage(rawMsg);
    const msg = {
      from: phone,
      remoteJid: remoteJid,
      body: body,
      pushname: name,
      hasMedia: audioInfo.hasAudio || !!(rawMsg.message?.documentMessage || rawMsg.message?.imageMessage),
      hasAudio: audioInfo.hasAudio,
      mimetype: audioInfo.mimetype || rawMsg.message?.documentMessage?.mimetype || rawMsg.message?.imageMessage?.mimetype,
      type: rawMsg.message?.audioMessage ? 'audio'
          : rawMsg.message?.documentMessage ? 'document'
          : rawMsg.message?.imageMessage ? 'image'
          : 'chat',
      reply: async (text) => await sock.sendMessage(remoteJid, { text }, { quoted: rawMsg }),
      raw: rawMsg,
      isPollSelection: !!(rawMsg.isPollSelection || (rawMsg.message && rawMsg.message.pollUpdateMessage))
    };

    if (body && !isPollVote) {
      const recentSent = recentPollSent.get(phone);
      if (recentSent && Date.now() - recentSent.ts < 5000) {
        if (recentSent.values.includes(body)) {
          logger.info(`Suppressing poll echo for ${phone}: "${body}"`);
          recentPollSent.clear(phone);
          return;
        }
      }
    }

    const session = sessionService.getSession(phone);

    if (body) {
      await dbLog('MESSAGE_RECV', `From: ${phone} (${name}) | Text: "${body}"`);
    }

    const cleanBody = body.toLowerCase().trim();
    if (['/start', 'ابدأ', 'البداية', 'القائمة', 'قائمة'].includes(cleanBody)) {
      sessionService.clearSession(phone);
      return await userCommands.handleStart(sock, msg);
    }

    // Handle incoming audio files
    if (msg.hasAudio) {
      const currentSession = sessionService.getSession(phone);
      if (currentSession.state === 'AWAITING_AUDIO_UPLOAD') {
        logger.info(`Received audio file from user ${phone}. Processing upload.`);
        await userCommands.handleAudioUpload(sock, msg);
        return;
      } else {
        // User sent an audio file without being in upload mode – prompt them
        logger.info(`Received unsolicited audio from user ${phone}. Suggesting upload flow.`);
        await msg.reply(`🎙️ استلمنا ملفك الصوتي!\n\nإذا كنت تريد إضافته للمكتبة، أرسل كلمة *اضافة* أولاً ثم أرسل الملف.`);
        return;
      }
    }

    if (session.state !== 'IDLE') {
      logger.info(`Routing message for ${phone} within active state: ${session.state}`);
      switch (session.state) {
        case 'AWAITING_SEARCH':
          await userCommands.executeSearch(sock, msg, body);
          return;
        case 'SEARCH_RESULTS': {
          const lastBooks = session.data.lastBooks || [];
          if (lastBooks.length === 0) {
            sessionService.clearSession(msg.from);
            break; // Let it fall through to normal command processing
          }
          
          let targetUuid = null;
          if (body === 'تحميل') {
            targetUuid = lastBooks[0].uuid; // Default to first audio
          } else if (body.startsWith('تحميل ')) {
            const num = parseInt(body.substring(5).trim(), 10);
            if (!isNaN(num) && num > 0 && num <= lastBooks.length) {
              targetUuid = lastBooks[num - 1].uuid;
            }
          } else {
            const num = parseInt(body, 10);
            if (!isNaN(num) && num > 0 && num <= lastBooks.length) {
              targetUuid = lastBooks[num - 1].uuid;
            }
          }

          if (targetUuid) {
            return await userCommands.downloadBook(sock, msg, targetUuid);
          }
          
          // If the message wasn't a valid download command for search results,
          // we don't return here so it can fall through to global commands
          break;
        }
        case 'AWAITING_CATEGORY_BROWSE':
          await userCommands.browseCategory(sock, msg, body);
          return;
        case 'BROWSE_ALL':
          await userCommands.handleBrowseAll(sock, msg, body);
          return;
        case 'AWAITING_AUDIO_UPLOAD':
          await msg.reply('❌ يرجى إرفاق الملف الصوتي الآن. لإلغاء العملية أرسل "القائمة".');
          return;
        case 'AWAITING_ADD_TITLE':
          await userCommands.handleAddTitle(sock, msg, session);
          return;
        case 'AWAITING_ADD_AUTHOR':
          await userCommands.handleAddAuthor(sock, msg, session);
          return;
        case 'AWAITING_ADD_CATEGORY':
          await userCommands.handleAddCategory(sock, msg, session);
          return;
        case 'AWAITING_ADD_LOCATION':
          await userCommands.handleAddLocation(sock, msg, session);
          return;
        case 'AWAITING_ADD_DATE':
          await userCommands.handleAddDate(sock, msg, session);
          return;
        case 'AWAITING_ADD_DESC':
          await userCommands.handleAddDescription(sock, msg, session);
          return;
      }
    }

    if (isAdmin) {
      if (body === 'طلبات') return await adminCommands.listRequests(sock, msg);
      if (body === 'قبول' || body.startsWith('قبول ')) return await adminCommands.approveRequest(sock, msg, body.substring(4).trim());
      if (body === 'رفض' || body.startsWith('رفض ')) {
        const paramStr = body.substring(3).trim();
        const spaceIdx = paramStr.indexOf(' ');
        let reqId = paramStr, reason = 'غير محدد';
        if (spaceIdx !== -1) { reqId = paramStr.substring(0, spaceIdx).trim(); reason = paramStr.substring(spaceIdx).trim(); }
        return await adminCommands.rejectRequest(sock, msg, reqId, reason);
      }
      if (body.startsWith('حذف ')) return await adminCommands.deleteBook(sock, msg, body.substring(4).trim());
      if (body.startsWith('تعديل ')) return await adminCommands.editBook(sock, msg, body.substring(6).trim());
      if (body === 'إحصائيات' || body === 'احصائيات الإدارة') return await adminCommands.displayAdminStats(sock, msg);
      if (body.startsWith('رسالة جماعية ')) return await adminCommands.broadcastMessage(sock, msg, body.substring(13).trim());
      if (body === 'نسخة احتياطية' || body === 'نسخة') return await adminCommands.sendBackup(sock, msg);
      if (body === 'إعادة بناء الفهرس' || body === 'تحديث الفهرس') return await adminCommands.rebuildCache(sock, msg);
      if (body === 'تنظيف الملفات المؤقتة' || body === 'تنظيف') return await adminCommands.cleanTempFiles(sock, msg);
      if (body === 'إعادة مزامنة Hugging Face' || body === 'مزامنة') return await adminCommands.resyncHf(sock, msg);
    }

    if (['بحث', 'البحث'].includes(cleanBody)) return await userCommands.promptSearch(sock, msg);
    if (['تصنيفات', 'التصنيفات'].includes(cleanBody)) return await userCommands.displayCategories(sock, msg);
    if (['جميع', 'جميع الصوتيات', 'كل الصوتيات'].includes(cleanBody)) return await userCommands.displayAllAudios(sock, msg);
    if (['جديد', 'أحدث الصوتيات', 'احدث الصوتيات'].includes(cleanBody)) return await userCommands.displayRecentBooks(sock, msg);
    if (['احصائيات', 'إحصائيات المكتبة', 'احصائيات المكتبة'].includes(cleanBody)) return await userCommands.displayLibraryStats(sock, msg);
    if (['مفضلة', 'المفضلة'].includes(cleanBody)) return await userCommands.displayFavorites(sock, msg);
    if (['اشتراك', 'الاشتراك'].includes(cleanBody)) return await userCommands.handleSubscribe(sock, msg);
    if (['اضافة', 'إضافة صوتية', 'اضافة صوتية'].includes(cleanBody)) return await userCommands.promptBookUpload(sock, msg);
    if (body.startsWith('تحميل ')) return await userCommands.downloadBook(sock, msg, body.substring(6).trim());
    if (body.startsWith('مفضلة ')) return await userCommands.addToFavorites(sock, msg, body.substring(6).trim());
    if (body.startsWith('حذف_مفضلة ')) return await userCommands.removeFromFavorites(sock, msg, body.substring(10).trim());

    if (!body || body.trim().length === 0) {
      return;
    }

    // Unrecognized message - show main menu with identifying text
    return await userCommands.handleStart(sock, msg);

  } catch (err) {
    logger.error(`Error in message routing for ${phone}: ${err.stack}`);
    await sock.sendMessage(rawMsg.key.remoteJid, { text: '❌ حدث خطأ داخلي أثناء معالجة رسالتك. يرجى المحاولة لاحقاً.' }).catch(() => {});
  }
}
