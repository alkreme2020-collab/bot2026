import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { config } from '../config/index.js';
import { dbService } from '../services/dbService.js';
import { sessionService } from '../services/sessionService.js';
import { searchService } from '../services/searchService.js';
import { cacheService } from '../services/cacheService.js';
import { recentPollSent } from '../services/pollTracker.js';
import logger, { dbLog } from '../utils/logger.js';
import { phoneToJid } from '../utils/jidHelper.js';
import { msgStore } from '../bot/client.js';

// Supported audio MIME types
const SUPPORTED_AUDIO_MIMETYPES = [
  'audio/mpeg',       // MP3
  'audio/mp4',        // M4A / AAC
  'audio/ogg',        // OGG
  'audio/wav',        // WAV
  'audio/x-wav',
  'audio/webm',       // WEBM audio
  'audio/aac',        // AAC
  'audio/flac',       // FLAC
  'audio/x-m4a',
  'audio/mp3',
];

// Supported audio file extensions
const SUPPORTED_EXTENSIONS = ['.mp3', '.m4a', '.aac', '.ogg', '.wav', '.webm', '.flac', '.opus'];

/**
 * Format bytes into human-readable string in Arabic
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 بايت';
  const k = 1024;
  const sizes = ['بايت', 'كيلوبايت', 'ميغابايت', 'جيجابايت'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Format duration in seconds to mm:ss or hh:mm:ss string
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (!seconds || seconds === 0) return 'غير معروف';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Check if a MIME type or filename belongs to a supported audio format
 * @param {string} mimetype
 * @param {string} [filename]
 * @returns {boolean}
 */
function isAudioFile(mimetype, filename) {
  if (mimetype && SUPPORTED_AUDIO_MIMETYPES.some(m => mimetype.toLowerCase().startsWith(m.split('/')[0]) && mimetype.toLowerCase().includes(m.split('/')[1]))) {
    return true;
  }
  if (mimetype && mimetype.toLowerCase().startsWith('audio/')) {
    return true;
  }
  if (filename) {
    const ext = path.extname(filename).toLowerCase();
    return SUPPORTED_EXTENSIONS.includes(ext);
  }
  return false;
}

export const userCommands = {
  /**
   * Handle /start and show main welcome menu
   * @param {object} client
   * @param {object} msg
   * @param {boolean} [skipTextReply=false]
   */
  async handleStart(client, msg) {
    try {
      const sentMsg = await client.sendMessage(msg.remoteJid, {
        poll: {
          name: `🎙️ *مكتبة الصوتيات العربية* 🤖 منصة إعلام شبوة السلفي
  
📋 *القائمة الرئيسية:*
🔍 بحث | 📂 تصنيفات | 📋 جميع | 🆕 جديد | ⭐ مفضلة | 🔔 اشتراك | 📤 اضافة | 📊 احصائيات
  
اختر الخدمة المطلوبة من الأسفل:`,
          values: [
            "🔍 البحث عن صوتية",
            "📂 التصنيفات",
            "📋 جميع الصوتيات",
            "✨ أحدث الصوتيات",
            "⭐ المفضلة",
            "🔔 الاشتراك",
            "📤 إضافة صوتية",
            "📊 إحصائيات المكتبة"
          ],
          selectableCount: 1
        }
      });
      if (sentMsg?.key?.id) {
        logger.info(`Sending start poll. Msg ID: ${sentMsg.key.id}, hasMessage: ${!!sentMsg.message}`);
        if (sentMsg.message) {
          msgStore.set(sentMsg.key.id, sentMsg.message);
        }
      }
      recentPollSent.record(msg.from, [
        "🔍 البحث عن صوتية",
        "📂 التصنيفات",
        "📋 جميع الصوتيات",
        "✨ أحدث الصوتيات",
        "⭐ المفضلة",
        "🔔 الاشتراك",
        "📤 إضافة صوتية",
        "📊 إحصائيات المكتبة"
      ]);
    } catch (err) {
      logger.warn(`Could not send start poll: ${err.message}`);
    }
  },

  /**
   * Start or guide search process
   * @param {object} client
   * @param {object} msg
   */
  async promptSearch(client, msg) {
    sessionService.setSession(msg.from, 'AWAITING_SEARCH');
    await msg.reply('🔍 من فضلك أرسل اسم الصوتية، اسم المقدم، أو جزء من العنوان للبحث:');
  },

  /**
   * Execute search and reply with matches
   * @param {object} client
   * @param {object} msg
   * @param {string} query
   */
  async executeSearch(client, msg, query) {
    const results = searchService.search(query);
    const limit = Math.min(results.length, 6); // limit results
    
    // Store results in session so user can download by typing 'تحميل' or a number
    sessionService.setSession(msg.from, 'SEARCH_RESULTS', { 
      lastBooks: results.slice(0, limit) 
    });

    if (results.length === 0) {
      await msg.reply('😔 عذراً، لم نجد أي صوتيات تطابق بحثك. حاول استخدام كلمات مفتاحية أخرى أو تحقق من الإملاء.');
      return;
    }

    let response = `🔎 *نتائج البحث عن (${query}):* \n\n`;
    
    for (let i = 0; i < limit; i++) {
      const audio = results[i];
      response += `🎙️ *[${i + 1}]* *${audio.title}*\n`;
      response += `👤 *المقدم:* ${audio.presenter}\n`;
      response += `📂 *التصنيف:* ${audio.category}\n`;
      if (audio.location) response += `📍 *المكان:* ${audio.location}\n`;
      if (audio.date_hijri) response += `📅 *التاريخ:* ${audio.date_hijri}\n`;
      response += `💾 *الحجم:* ${formatBytes(audio.size)}\n`;
      response += `🔽 للتحميل أرسل رقم الصوتية (مثلاً: \`${i + 1}\` أو \`تحميل ${i + 1}\`)\n\n`;
    }

    if (results.length > limit) {
      response += `⚠️ تم عرض أول ${limit} نتائج فقط من أصل ${results.length}. يرجى تحديد البحث أكثر لنتائج أدق.`;
    }

    await msg.reply(response);
  },

  /**
   * Display audio categories list
   * @param {object} client
   * @param {object} msg
   * @param {boolean} [skipTextReply=false]
   */
  async displayCategories(client, msg) {
    sessionService.setSession(msg.from, 'AWAITING_CATEGORY_BROWSE');

    const categoriesList = config.categories.map((cat, idx) => `${idx + 1}️⃣ ${cat}`).join('\n');

    try {
      const sentMsg = await client.sendMessage(msg.remoteJid, {
        poll: {
          name: `📂 *تصنيفات الصوتيات المتوفرة:*\n\n${categoriesList}\n\nاختر التصنيف المطلوب:`,
          values: config.categories.map((cat, idx) => `${idx + 1}. ${cat}`),
          selectableCount: 1
        }
      });
      if (sentMsg?.key?.id && sentMsg.message) {
        msgStore.set(sentMsg.key.id, sentMsg.message);
      }
      recentPollSent.record(msg.from, config.categories.map((cat, idx) => `${idx + 1}. ${cat}`));
    } catch (err) {
      logger.warn(`Could not send category poll: ${err.message}`);
    }
  },

  /**
   * Browse audios in selected category
   * @param {object} client
   * @param {object} msg
   * @param {string} text
   */
  /**
   * Send a navigation poll for category pagination
   * @param {object} client
   * @param {object} msg
   * @param {string} category
   * @param {number} page
   * @param {number} totalPages
   */
  async _sendCategoryPoll(client, msg, category, page, totalPages) {
    const pollValues = [];
    if (page > 0) pollValues.push('⬅️ السابق');
    if (page < totalPages - 1) pollValues.push('➡️ التالي');
    pollValues.push('🔙 القائمة الرئيسية');

    try {
      const sentMsg = await client.sendMessage(msg.remoteJid, {
        poll: {
          name: `📂 ${category} — صفحة ${page + 1}/${totalPages}`,
          values: pollValues,
          selectableCount: 1
        }
      });
      if (sentMsg?.key?.id && sentMsg.message) {
        msgStore.set(sentMsg.key.id, sentMsg.message);
      }
      recentPollSent.record(msg.from, pollValues);
    } catch (err) {
      logger.warn(`Could not send category poll: ${err.message}`);
    }
  },

  /**
   * Browse audios in selected category with pagination (10 per page) + navigation poll
   * @param {object} client
   * @param {object} msg
   * @param {string} text
   */
  async browseCategory(client, msg, text) {
    const session = sessionService.getSession(msg.from);
    const cleanText = text.trim();
    const { page, allAudios, pageSize, totalPages } = (session.data || {});

    // Back to main menu
    if (cleanText === 'قائمة' || cleanText === '🔙 القائمة الرئيسية') {
      sessionService.clearSession(msg.from);
      return await this.handleStart(client, msg);
    }

    // Check for navigation if we have session data
    if (allAudios && page !== undefined && pageSize && totalPages) {
      // Download by number
      const num = parseInt(cleanText, 10);
      if (!isNaN(num) && num > 0 && num <= pageSize) {
        const idx = page * pageSize + (num - 1);
        if (idx < allAudios.length) {
          return await this.downloadBook(client, msg, allAudios[idx].uuid);
        }
      }
      if (cleanText.startsWith('تحميل ')) {
        const n = parseInt(cleanText.split(' ')[1], 10);
        if (!isNaN(n) && n > 0 && n <= pageSize) {
          const idx = page * pageSize + (n - 1);
          if (idx < allAudios.length) {
            return await this.downloadBook(client, msg, allAudios[idx].uuid);
          }
        }
      }

      // Next page
      if ((cleanText === 'التالي' || cleanText === '➡️ التالي') && page < totalPages - 1) {
        const newPage = page + 1;
        const pageAudios = allAudios.slice(newPage * pageSize, (newPage + 1) * pageSize);
        sessionService.setSession(msg.from, 'AWAITING_CATEGORY_BROWSE', {
          allAudios, page: newPage, pageSize, totalPages, lastBooks: pageAudios
        });
        const response = this._formatCategoryAudios(pageAudios, newPage, totalPages, session.data.categoryName);
        await msg.reply(response);
        await this._sendCategoryPoll(client, msg, session.data.categoryName, newPage, totalPages);
        return;
      }

      // Previous page
      if ((cleanText === 'السابق' || cleanText === '⬅️ السابق') && page > 0) {
        const newPage = page - 1;
        const pageAudios = allAudios.slice(newPage * pageSize, (newPage + 1) * pageSize);
        sessionService.setSession(msg.from, 'AWAITING_CATEGORY_BROWSE', {
          allAudios, page: newPage, pageSize, totalPages, lastBooks: pageAudios
        });
        const response = this._formatCategoryAudios(pageAudios, newPage, totalPages, session.data.categoryName);
        await msg.reply(response);
        await this._sendCategoryPoll(client, msg, session.data.categoryName, newPage, totalPages);
        return;
      }
    }

    // Try to match as category first (from poll selection like "1. خطب" or "خطب")
    let catText = cleanText;
    if (/^\d+\.\s*/.test(catText)) {
      catText = catText.replace(/^\d+\.\s*/, '').trim();
    }

    const catIndex = parseInt(catText, 10) - 1;
    let category = '';

    if (!isNaN(catIndex) && catIndex >= 0 && catIndex < config.categories.length) {
      category = config.categories[catIndex];
    } else {
      const match = config.categories.find(c => c === catText);
      if (match) category = match;
    }

    if (category) {
      const audios = cacheService.getBooks().filter(a => a.category === category);
      if (audios.length === 0) {
        await msg.reply(`📂 تصنيف *(${category})* لا يحتوي على صوتيات حالياً.`);
        return;
      }

      const pSize = 10;
      const pg = 0;
      const tPages = Math.ceil(audios.length / pSize);
      const pageAudios = audios.slice(0, pSize);

      sessionService.setSession(msg.from, 'AWAITING_CATEGORY_BROWSE', {
        allAudios: audios,
        page: pg,
        pageSize: pSize,
        totalPages: tPages,
        categoryName: category,
        lastBooks: pageAudios
      });

      const response = this._formatCategoryAudios(pageAudios, pg, tPages, category);
      await msg.reply(response);
      await this._sendCategoryPoll(client, msg, category, pg, tPages);
      return;
    }

    // Not a category — try as download number (backward compat)
    if (session.data && session.data.lastBooks) {
      const num = parseInt(cleanText, 10);
      if (!isNaN(num) && num > 0 && num <= session.data.lastBooks.length) {
        return await this.downloadBook(client, msg, session.data.lastBooks[num - 1].uuid);
      }
      if (cleanText.startsWith('تحميل ')) {
        const n = parseInt(cleanText.split(' ')[1], 10);
        if (!isNaN(n) && n > 0 && n <= session.data.lastBooks.length) {
          return await this.downloadBook(client, msg, session.data.lastBooks[n - 1].uuid);
        }
      }
    }

    await msg.reply('❌ اختيار غير صحيح. استخدم الاستطلاع للتنقل أو أرسل رقم الصوتية للتحميل.');
  },

  /**
   * Format category audio page listing
   * @param {Array} pageAudios
   * @param {number} page
   * @param {number} totalPages
   * @param {string} category
   * @returns {string}
   */
  _formatCategoryAudios(pageAudios, page, totalPages, category) {
    let response = `📂 *${category} — الصفحة ${page + 1}/${totalPages}:* \n\n`;
    for (let i = 0; i < pageAudios.length; i++) {
      const audio = pageAudios[i];
      response += `🎙️ *[${i + 1}]* *${audio.title}* - ${audio.presenter}\n`;
      if (audio.location) response += `📍 *المكان:* ${audio.location}\n`;
      if (audio.date_hijri) response += `📅 *التاريخ:* ${audio.date_hijri}\n`;
      response += `💾 ${formatBytes(audio.size)}\n\n`;
    }
    response += `🔢 أرسل رقم الصوتية للتحميل (1-${pageAudios.length})`;
    return response;
  },

  /**
   * Send a navigation poll for browse-all pagination
   * @param {object} client
   * @param {object} msg
   * @param {number} page
   * @param {number} totalPages
   */
  async _sendBrowseAllPoll(client, msg, page, totalPages) {
    const pollValues = [];
    if (page > 0) pollValues.push('⬅️ السابق');
    if (page < totalPages - 1) pollValues.push('➡️ التالي');
    pollValues.push('🔙 القائمة الرئيسية');

    try {
      const sentMsg = await client.sendMessage(msg.remoteJid, {
        poll: {
          name: `📋 صفحة ${page + 1}/${totalPages} — اختر من الخيارات:`,
          values: pollValues,
          selectableCount: 1
        }
      });
      if (sentMsg?.key?.id && sentMsg.message) {
        msgStore.set(sentMsg.key.id, sentMsg.message);
      }
      recentPollSent.record(msg.from, pollValues);
    } catch (err) {
      logger.warn(`Could not send browse-all poll: ${err.message}`);
    }
  },

  /**
   * Build the formatted audio listing text for a page
   * @param {Array} pageAudios
   * @param {number} page
   * @param {number} totalPages
   * @returns {string}
   */
  _formatPageAudios(pageAudios, page, totalPages) {
    let response = `📋 *جميع الصوتيات - الصفحة ${page + 1}/${totalPages}:* \n\n`;
    for (let i = 0; i < pageAudios.length; i++) {
      const audio = pageAudios[i];
      response += `🎙️ *[${i + 1}]* *${audio.title}* - ${audio.presenter}\n`;
      if (audio.location) response += `📍 *المكان:* ${audio.location}\n`;
      if (audio.date_hijri) response += `📅 *التاريخ:* ${audio.date_hijri}\n`;
      response += `💾 ${formatBytes(audio.size)}\n\n`;
    }
    response += `🔢 أرسل رقم الصوتية للتحميل (1-${pageAudios.length})`;
    return response;
  },

  /**
   * Display all audios with pagination (10 per page)
   * @param {object} client
   * @param {object} msg
   */
  async displayAllAudios(client, msg) {
    const allAudios = cacheService.getBooks();
    if (allAudios.length === 0) {
      await msg.reply('📭 المكتبة لا تحتوي على صوتيات بعد.');
      return;
    }

    const pageSize = 10;
    const page = 0;
    const totalPages = Math.ceil(allAudios.length / pageSize);
    const pageAudios = allAudios.slice(0, pageSize);

    sessionService.setSession(msg.from, 'BROWSE_ALL', {
      allAudios,
      page,
      pageSize,
      totalPages,
      lastBooks: pageAudios
    });

    const response = this._formatPageAudios(pageAudios, page, totalPages);
    await msg.reply(response);
    await this._sendBrowseAllPoll(client, msg, page, totalPages);
  },

  /**
   * Handle pagination and download for browse-all mode (poll + text input)
   * @param {object} client
   * @param {object} msg
   * @param {string} text
   */
  async handleBrowseAll(client, msg, text) {
    const session = sessionService.getSession(msg.from);
    const { allAudios, page, pageSize, totalPages } = session.data;
    const lastBooks = session.data.lastBooks || [];

    const cleanText = text.trim();

    // Check if input is a download number referring to current page
    const num = parseInt(cleanText, 10);
    if (!isNaN(num) && num > 0 && num <= lastBooks.length) {
      return await this.downloadBook(client, msg, lastBooks[num - 1].uuid);
    }
    if (cleanText.startsWith('تحميل ')) {
      const parts = cleanText.split(' ');
      if (parts.length >= 2) {
        const n = parseInt(parts[1], 10);
        if (!isNaN(n) && n > 0 && n <= lastBooks.length) {
          return await this.downloadBook(client, msg, lastBooks[n - 1].uuid);
        }
      }
    }

    // Back to main menu
    if (cleanText === 'قائمة' || cleanText === '🔙 القائمة الرئيسية') {
      sessionService.clearSession(msg.from);
      return await this.handleStart(client, msg);
    }

    // Next page
    if (cleanText === 'التالي' || cleanText === '➡️ التالي') {
      if (page >= totalPages - 1) {
        await msg.reply('هذه آخر صفحة ✅');
        return;
      }
      const newPage = page + 1;
      const pageAudios = allAudios.slice(newPage * pageSize, (newPage + 1) * pageSize);

      sessionService.setSession(msg.from, 'BROWSE_ALL', {
        allAudios,
        page: newPage,
        pageSize,
        totalPages,
        lastBooks: pageAudios
      });

      const response = this._formatPageAudios(pageAudios, newPage, totalPages);
      await msg.reply(response);
      await this._sendBrowseAllPoll(client, msg, newPage, totalPages);
      return;
    }

    // Previous page
    if (cleanText === 'السابق' || cleanText === '⬅️ السابق') {
      if (page <= 0) {
        await msg.reply('هذه أول صفحة ✅');
        return;
      }
      const newPage = page - 1;
      const pageAudios = allAudios.slice(newPage * pageSize, (newPage + 1) * pageSize);

      sessionService.setSession(msg.from, 'BROWSE_ALL', {
        allAudios,
        page: newPage,
        pageSize,
        totalPages,
        lastBooks: pageAudios
      });

      const response = this._formatPageAudios(pageAudios, newPage, totalPages);
      await msg.reply(response);
      await this._sendBrowseAllPoll(client, msg, newPage, totalPages);
      return;
    }

    // Invalid input
    await msg.reply('❌ إدخال غير صحيح. استخدم الاستطلاع للتنقل بين الصفحات، أو أرسل رقم الصوتية للتحميل.');
  },

  /**
   * Show recent audios
   * @param {object} client
   * @param {object} msg
   */
  async displayRecentBooks(client, msg) {
    const audios = cacheService.getBooks().slice(0, 5); // top 5 recent

    if (audios.length === 0) {
      await msg.reply('📭 المكتبة لا تحتوي على صوتيات بعد.');
      return;
    }

    // Store results in session so user can download by typing 'تحميل' or a number
    sessionService.setSession(msg.from, 'SEARCH_RESULTS', { 
      lastBooks: audios
    });

    let response = `🆕 *أحدث الصوتيات المضافة للمكتبة:* \n\n`;
    audios.forEach((audio, idx) => {
      response += `*[${idx + 1}]* *${audio.title}*\n`;
      response += `👤 *المقدم:* ${audio.presenter} | 📂 *التصنيف:* ${audio.category}\n`;
      if (audio.location) response += `📍 *المكان:* ${audio.location}\n`;
      if (audio.date_hijri) response += `📅 *التاريخ:* ${audio.date_hijri}\n`;
      response += `🔽 للتحميل أرسل رقم الصوتية (مثلاً: \`${idx + 1}\` أو \`تحميل ${idx + 1}\`)\n\n`;
    });

    await msg.reply(response);
  },

  /**
   * Display library public stats
   * @param {object} client
   * @param {object} msg
   */
  async displayLibraryStats(client, msg) {
    try {
      const stats = await dbService.getSummaryStats();
      const response = `📊 *إحصائيات مكتبة الصوتيات:*

🎙️ إجمالي عدد الصوتيات: *${stats.totalAudios}*
👥 المشتركون بالبوت: *${stats.totalUsers}*
📥 إجمالي عمليات التحميل: *${stats.totalDownloads}*
⏱️ طلبات الإضافة المعلقة: *${stats.totalRequests}*

شكراً لمساهمتكم في نشر المعرفة! ❤️`;
      await msg.reply(response);
    } catch (err) {
      logger.error(`Error displaying stats: ${err.message}`);
      await msg.reply('❌ حدث خطأ أثناء جلب الإحصائيات. يرجى المحاولة لاحقاً.');
    }
  },

  /**
   * Manage and display user favorites
   * @param {object} client
   * @param {object} msg
   */
  async displayFavorites(client, msg) {
    try {
      const favs = await dbService.getUserFavorites(msg.from);
      if (favs.length === 0) {
        await msg.reply('⭐ قائمتك المفضلة فارغة حالياً.\n\nيمكنك إضافة أي صوتية للمفضلة عن طريق إرسال: `مفضلة رقم_الصوتية_uuid`');
        return;
      }

      // Store results in session so user can download by typing 'تحميل' or a number
      sessionService.setSession(msg.from, 'SEARCH_RESULTS', { 
        lastBooks: favs
      });

      let response = `⭐ *صوتياتك المفضلة:* \n\n`;
      favs.forEach((audio, idx) => {
        response += `*[${idx + 1}]* *${audio.title}*\n`;
        response += `👤 *المقدم:* ${audio.presenter}\n`;
        if (audio.location) response += `📍 *المكان:* ${audio.location}\n`;
        if (audio.date_hijri) response += `📅 *التاريخ:* ${audio.date_hijri}\n`;
        response += `🔽 للتحميل: \`${idx + 1}\` أو \`تحميل ${idx + 1}\`\n`;
        response += `❌ للإزالة: \`حذف_مفضلة ${audio.uuid}\`\n\n`;
      });

      await msg.reply(response);
    } catch (err) {
      logger.error(`Error showing favorites: ${err.message}`);
      await msg.reply('❌ فشل تحميل قائمتك المفضلة.');
    }
  },

  /**
   * Toggle subscription for notifications
   * @param {object} client
   * @param {object} msg
   */
  async handleSubscribe(client, msg) {
    try {
      const nowSubscribed = await dbService.toggleSubscribe(msg.from);
      if (nowSubscribed) {
        await msg.reply(`✅ تم الاشتراك في الإشعارات بنجاح! 🔔

سنرسل لك إشعاراً فور إضافة أي صوتية جديدة إلى المكتبة.

لإلغاء الاشتراك، اختر "🔔 الاشتراك" مرة أخرى.`);
      } else {
        await msg.reply(`✅ تم إلغاء الاشتراك في الإشعارات.

يمكنك الاشتراك مرة أخرى في أي وقت من خلال القائمة الرئيسية.`);
      }
      await dbLog('SUBSCRIBE_TOGGLE', `${nowSubscribed ? 'Subscribed' : 'Unsubscribed'}: ${msg.from}`);
    } catch (err) {
      logger.error(`Error toggling subscription: ${err.message}`);
      await msg.reply('❌ حدث خطأ أثناء تعديل حالة الاشتراك.');
    }
  },

  /**
   * Notify all subscribers about a new audio. Sends in batches with delays to avoid bans.
   * @param {object} client
   * @param {object} audio
   */
  async notifySubscribers(client, audio) {
    try {
      const subscribers = await dbService.getAllSubscribers();
      if (subscribers.length === 0) return;

      logger.info(`Notifying ${subscribers.length} subscribers about new audio: ${audio.title}`);
      const caption = `🔔 *صوتية جديدة مضافة للمكتبة!*
      
🎙️ *${audio.title}*
👤 *المقدم:* ${audio.presenter}
📂 *التصنيف:* ${audio.category}
${audio.location ? `📍 *المكان:* ${audio.location}\n` : ''}${audio.date_hijri ? `📅 *التاريخ:* ${audio.date_hijri}\n` : ''}💾 ${formatBytes(audio.size)}

يمكنك تحميلها الآن من خلال البوت بالبحث عن العنوان.`;

      const phoneToJid = (await import('../utils/jidHelper.js')).phoneToJid;
      let sent = 0;
      for (const phone of subscribers) {
        try {
          await client.sendMessage(phoneToJid(phone), { text: caption });
          sent++;
          await new Promise(r => setTimeout(r, 1500)); // 1.5s delay between each
        } catch (err) {
          logger.warn(`Failed to notify subscriber ${phone}: ${err.message}`);
        }
      }
      logger.info(`Subscribers notified: ${sent}/${subscribers.length}`);
    } catch (err) {
      logger.error(`Error notifying subscribers: ${err.message}`);
    }
  },

  /**
   * Add an audio to user's favorites
   * @param {object} client
   * @param {object} msg
   * @param {string} uuid
   */
  async addToFavorites(client, msg, uuid) {
    try {
      const audio = await dbService.getAudioByUuid(uuid);
      if (!audio) {
        await msg.reply('❌ عذراً، لم نجد الصوتية المطلوبة.');
        return;
      }

      await dbService.addFavorite(msg.from, uuid);
      await msg.reply(`⭐ تمت إضافة صوتية *(${audio.title})* بنجاح إلى مفضلتك!`);
      await dbLog('FAVORITE_ADD', `User ${msg.from} added audio ${uuid} to favorites`);
    } catch (err) {
      logger.error(`Error adding favorite: ${err.message}`);
      await msg.reply('❌ فشل إضافة الصوتية للمفضلة.');
    }
  },

  /**
   * Remove an audio from user's favorites
   * @param {object} client
   * @param {object} msg
   * @param {string} uuid
   */
  async removeFromFavorites(client, msg, uuid) {
    try {
      await dbService.removeFavorite(msg.from, uuid);
      await msg.reply(`⭐ تم إزالة الصوتية من قائمة المفضلة.`);
    } catch (err) {
      logger.error(`Error removing favorite: ${err.message}`);
      await msg.reply('❌ فشل إزالة الصوتية من المفضلة.');
    }
  },

  /**
   * Download audio file from HuggingFace resolve URL and send to user
   * @param {object} client
   * @param {object} msg
   * @param {string} uuid
   */
  async downloadBook(client, msg, uuid) {
    try {
      const audio = await dbService.getAudioByUuid(uuid);
      if (!audio) {
        await msg.reply('❌ عذراً، لم نجد هذه الصوتية في نظامنا.');
        return;
      }

      await msg.reply(`⏳ جاري تحميل صوتية *"${audio.title}"* وإرسالها لك، يرجى الانتظار...`);

      // Determine file extension from hf_url or default to mp3
      const urlPath = audio.hf_url.split('?')[0];
      const ext = path.extname(urlPath) || '.mp3';
      
      // Download file to local temp
      const tempFilename = `download_${uuidv4()}${ext}`;
      const tempPath = path.join(config.rootDir, 'temp', tempFilename);
      
      const response = await fetch(audio.hf_url, {
        headers: {
          'Authorization': `Bearer ${config.hfToken}`
        }
      });

      if (!response.ok) {
        throw new Error(`HF server returned HTTP status ${response.status}`);
      }

      // Write to temp file
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      fs.writeFileSync(tempPath, buffer);

      const cleanTitle = audio.title.replace(/[\\/:*?"<>|]/g, '') || 'audio';

      // Determine mimetype based on extension
      const mimetypeMap = {
        '.mp3': 'audio/mpeg',
        '.m4a': 'audio/mp4',
        '.aac': 'audio/aac',
        '.ogg': 'audio/ogg',
        '.wav': 'audio/wav',
        '.webm': 'audio/webm',
        '.flac': 'audio/flac',
        '.opus': 'audio/ogg',
      };
      const mimetype = mimetypeMap[ext.toLowerCase()] || 'audio/mpeg';

      // Send audio file
      await client.sendMessage(msg.remoteJid, {
        document: buffer,
        mimetype: mimetype,
        fileName: `${cleanTitle}${ext}`,
        caption: `🎙️ *صوتيتك جاهزة للتحميل:*
        
- *العنوان:* ${audio.title}
- *المقدم:* ${audio.presenter}
- *التصنيف:* ${audio.category}
${audio.location ? `- *المكان:* ${audio.location}\n` : ''}${audio.date_hijri ? `- *التاريخ:* ${audio.date_hijri}\n` : ''}- *الحجم:* ${formatBytes(audio.size)}

استماع ممتع! 🎧✨`
      }, { quoted: msg.raw });

      // Cleanup
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }

      // Record download stats
      await dbService.recordDownload(msg.from, uuid);
      await dbLog('DOWNLOAD', `User ${msg.from} downloaded audio: ${audio.title} (UUID: ${uuid})`);
    } catch (err) {
      logger.error(`Error downloading audio ${uuid}: ${err.message}`);
      await msg.reply('❌ عذراً، حدث خطأ أثناء محاولة جلب الملف من التخزين السحابي. يرجى التواصل مع الإدارة.');
    }
  },

  /**
   * Prompt user to upload an audio file
   * @param {object} client
   * @param {object} msg
   */
  async promptBookUpload(client, msg) {
    // Check request cooldown
    const cooldown = await sessionService.checkRequestCooldown(msg.from);
    if (cooldown.isCooldown) {
      const minutes = Math.ceil(cooldown.remainingMs / 60000);
      await msg.reply(`⚠️ عذراً، لقد قمت بإرسال طلب مؤخراً. يرجى الانتظار *${minutes} دقيقة* قبل تقديم طلب صوتية آخر لمنع إساءة الاستخدام.`);
      return;
    }

    sessionService.setSession(msg.from, 'AWAITING_AUDIO_UPLOAD');
    await msg.reply(`📤 ممتاز! يرجى إرسال الملف الصوتي الآن كملف مرفق.

✅ *الصيغ المدعومة:*
• MP3, M4A, AAC, OGG
• WAV, WEBM, FLAC, OPUS

💡 *نصيحة:* أرسل الملف كـ "مستند" وليس كصوتية مباشرة للحصول على أفضل جودة.`);
  },

  /**
   * Receive and validate audio upload, download to local uploads/
   * @param {object} client
   * @param {object} msg
   */
  async handleAudioUpload(client, msg) {
    try {
      const buffer = await downloadMediaMessage(
        msg.raw, 
        'buffer', 
        { }, 
        { logger }
      );
      
      if (!buffer) {
        throw new Error('Failed to download media buffer');
      }

      // Validate audio file by checking common audio magic bytes
      const header = buffer.subarray(0, 12);
      const headerHex = header.toString('hex').toLowerCase();
      
      // MP3: ID3 tag or MPEG sync
      const isMP3 = headerHex.startsWith('494433') || (header[0] === 0xFF && (header[1] & 0xE0) === 0xE0);
      // M4A/AAC: ftyp box
      const isM4A = headerHex.substring(8, 16) === '66747970'; // 'ftyp'
      // OGG: OggS
      const isOGG = headerHex.startsWith('4f676753');
      // WAV: RIFF
      const isWAV = headerHex.startsWith('52494646');
      // FLAC: fLaC
      const isFLAC = headerHex.startsWith('664c6143');
      // WEBM/MKV: EBML
      const isWEBM = headerHex.startsWith('1a45dfa3');

      // Check mimetype from message
      const mimetype = msg.mimetype || '';
      const isValidMime = mimetype.startsWith('audio/') || 
                          mimetype === 'application/octet-stream' ||
                          mimetype === 'video/ogg'; // some ogg files are reported as video

      if (!isMP3 && !isM4A && !isOGG && !isWAV && !isFLAC && !isWEBM && !isValidMime) {
        await msg.reply('❌ عذراً، الملف المرسل لا يبدو ملفاً صوتياً صالحاً.\n\nيرجى إرسال ملف بأحد الصيغ المدعومة: MP3, M4A, AAC, OGG, WAV, FLAC.');
        sessionService.clearSession(msg.from);
        return;
      }

      // Check size limit (bytes to MB)
      const sizeMb = buffer.length / (1024 * 1024);
      if (sizeMb > config.maxFileSizeMb) {
        await msg.reply(`❌ عذراً، حجم الملف (${sizeMb.toFixed(2)} MB) يتجاوز الحد المسموح به وهو *${config.maxFileSizeMb} MB*.`);
        sessionService.clearSession(msg.from);
        return;
      }

      // Determine extension
      let ext = '.mp3';
      if (isOGG || mimetype.includes('ogg')) ext = '.ogg';
      else if (isM4A || mimetype.includes('mp4') || mimetype.includes('m4a')) ext = '.m4a';
      else if (isWAV || mimetype.includes('wav')) ext = '.wav';
      else if (isFLAC || mimetype.includes('flac')) ext = '.flac';
      else if (isWEBM || mimetype.includes('webm')) ext = '.webm';
      else if (mimetype.includes('aac')) ext = '.aac';

      // Save to temporary uploads file
      const tempId = uuidv4();
      const tempFilename = `upload_${tempId}${ext}`;
      const tempPath = path.join(config.rootDir, 'uploads', tempFilename);
      
      fs.writeFileSync(tempPath, buffer);

      // Save file details in user session
      sessionService.setSession(msg.from, 'AWAITING_ADD_TITLE', {
        audio_temp: tempPath,
        file_size: buffer.length,
        file_ext: ext
      });

      await msg.reply(`📥 تم استلام الملف الصوتي بنجاح! (${sizeMb.toFixed(2)} MB)\n\nمن فضلك أرسل *عنوان الصوتية* الآن:`);
    } catch (err) {
      logger.error(`Error during audio upload handling: ${err.message}`);
      await msg.reply('❌ حدث خطأ أثناء تحميل واستلام الملف. يرجى إعادة المحاولة.');
      sessionService.clearSession(msg.from);
    }
  },

  /**
   * Save audio title from wizard
   * @param {object} client
   * @param {object} msg
   * @param {object} session
   */
  async handleAddTitle(client, msg, session) {
    const title = msg.body.trim();
    if (title.length < 2) {
      await msg.reply('❌ عنوان الصوتية قصير جداً. يرجى كتابة عنوان صحيح:');
      return;
    }

    sessionService.setSession(msg.from, 'AWAITING_ADD_AUTHOR', { title });
    await msg.reply('ممتاز! من فضلك أرسل *اسم المقدم أو الشيخ*:');
  },

  /**
   * Save presenter from wizard
   * @param {object} client
   * @param {object} msg
   * @param {object} session
   */
  async handleAddAuthor(client, msg, session) {
    const presenter = msg.body.trim();
    if (presenter.length < 2) {
      await msg.reply('❌ اسم المقدم قصير جداً. يرجى إدخال اسم صحيح:');
      return;
    }

    sessionService.setSession(msg.from, 'AWAITING_ADD_CATEGORY', { presenter });

    let catMsg = `📁 اختر *تصنيف الصوتية* بالنقر على خيار الاستطلاع أدناه أو إرسال الرقم:\n\n`;
    config.categories.forEach((cat, index) => {
      catMsg += `*${index + 1}* - ${cat}\n`;
    });
    
    await msg.reply(catMsg);

    try {
      const sentMsg = await client.sendMessage(msg.remoteJid, {
        poll: {
          name: "📁 اختر تصنيف الصوتية المناسب:",
          values: config.categories.map((cat, idx) => `${idx + 1}. ${cat}`),
          selectableCount: 1
        }
      });
      if (sentMsg?.key?.id && sentMsg.message) {
        msgStore.set(sentMsg.key.id, sentMsg.message);
      }
    } catch (err) {
      logger.warn(`Could not send upload category poll: ${err.message}`);
    }
  },

  /**
   * Save category from wizard
   * @param {object} client
   * @param {object} msg
   * @param {object} session
   */
  async handleAddCategory(client, msg, session) {
    let text = msg.body.trim();
    if (/^\d+\.\s*/.test(text)) {
      text = text.replace(/^\d+\.\s*/, '').trim();
    }

    const index = parseInt(text, 10) - 1;
    let category = '';

    if (!isNaN(index) && index >= 0 && index < config.categories.length) {
      category = config.categories[index];
    } else {
      // Verify if text matches category name directly
      const match = config.categories.find(c => c === text);
      if (match) {
        category = match;
      }
    }

    if (!category) {
      await msg.reply('❌ خيار غير صحيح! يرجى إرسال الرقم المقابل للتصنيف الصحيح فقط.');
      return;
    }

    sessionService.setSession(msg.from, 'AWAITING_ADD_LOCATION', { category });
    await msg.reply('📍 من فضلك أرسل *المكان* (اسم المسجد، المنطقة، المحافظة) أو أرسل "تخطي" للمتابعة:');
  },

  /**
   * Save location from wizard
   * @param {object} client
   * @param {object} msg
   * @param {object} session
   */
  async handleAddLocation(client, msg, session) {
    const text = msg.body.trim();
    const location = text.toLowerCase() === 'تخطي' ? '' : text;

    sessionService.setSession(msg.from, 'AWAITING_ADD_DATE', { location });
    await msg.reply('📅 من فضلك أرسل *التاريخ الهجري* (مثال: 4 محرم 1448هـ) أو أرسل "تخطي" للمتابعة:');
  },

  /**
   * Save hijri date from wizard
   * @param {object} client
   * @param {object} msg
   * @param {object} session
   */
  async handleAddDate(client, msg, session) {
    const text = msg.body.trim();
    const date_hijri = text.toLowerCase() === 'تخطي' ? '' : text;

    sessionService.setSession(msg.from, 'AWAITING_ADD_DESC', { date_hijri });
    await msg.reply('📝 أرسل *وصفاً مختصراً* للصوتية (اختياري) أو أرسل كلمة *\'تخطي\'* للمتابعة:');
  },

  /**
   * Save description and complete user audio proposal request. Notify admin!
   * @param {object} client
   * @param {object} msg
   * @param {object} session
   */
  async handleAddDescription(client, msg, session) {
    const text = msg.body.trim();
    const description = text.toLowerCase() === 'تخطي' ? '' : text;
    const { title, presenter, category, location, date_hijri, audio_temp, file_size, file_ext } = session.data;

    try {
      const requestUuid = uuidv4();
      
      // Save request in DB
      await dbService.createRequest({
        uuid: requestUuid,
        phone: msg.from,
        title,
        presenter,
        category,
        description,
        location,
        date_hijri,
        audio_temp
      });

      // Clear session
      sessionService.clearSession(msg.from);

      // Confirm to user
      await msg.reply(`✅ تم استلام صوتيتك وتفاصيلها بنجاح!
      
سيدخل الملف الصوتي مرحلة المراجعة وسنقوم بإشعارك تلقائياً فور اعتماده وإضافته للمكتبة.`);

      // Log action
      await dbLog('AUDIO_PROPOSAL', `User ${msg.from} proposed audio: ${title} (Request UUID: ${requestUuid})`);

      // Notify Admin
      const adminMsg = `⚠️ *طلب إضافة صوتية جديدة معلق* ⚠️

- *رقم الطلب:* ${requestUuid}
- *عنوان الصوتية:* ${title}
- *المقدم:* ${presenter}
- *المكان:* ${location || 'غير محدد'}
- *التاريخ:* ${date_hijri || 'غير محدد'}
- *التصنيف:* ${category}
- *الحجم:* ${formatBytes(file_size)}
- *المرسل:* ${msg.from}

✅ للموافقة والرفع: أرسل \`قبول ${requestUuid}\`
❌ للرفض مع إشعار: أرسل \`رفض ${requestUuid} [سبب الرفض]\``;

      // Send notification message and the actual audio file to admin
      const adminJid = phoneToJid(config.adminNumber);
      await client.sendMessage(adminJid, { text: adminMsg });
      
      // Determine mimetype for admin preview
      const mimetypeMap = {
        '.mp3': 'audio/mpeg',
        '.m4a': 'audio/mp4',
        '.aac': 'audio/aac',
        '.ogg': 'audio/ogg',
        '.wav': 'audio/wav',
        '.webm': 'audio/webm',
        '.flac': 'audio/flac',
        '.opus': 'audio/ogg',
      };
      const ext = file_ext || '.mp3';
      const mimetype = mimetypeMap[ext] || 'audio/mpeg';
      
      await client.sendMessage(adminJid, { 
        document: fs.readFileSync(audio_temp), 
        mimetype: mimetype, 
        fileName: `${title}${ext}`,
        caption: `🎙️ ملف صوتية: ${title}` 
      });

      try {
        const sentMsg = await client.sendMessage(adminJid, {
          poll: {
            name: `⚡ إجراء سريع للطلب (${title}):`,
            values: [
              `قبول ${requestUuid}`,
              `رفض ${requestUuid}`
            ],
            selectableCount: 1
          }
        });
        if (sentMsg?.key?.id && sentMsg.message) {
          msgStore.set(sentMsg.key.id, sentMsg.message);
        }
      } catch (e) {}

      logger.info(`Notified admin about pending request: ${requestUuid}`);
    } catch (err) {
      logger.error(`Error finalizing audio upload request: ${err.message}`);
      await msg.reply('❌ حدث خطأ غير متوقع أثناء إرسال طلبك للإدارة. يرجى التواصل مع المسؤولين.');
      sessionService.clearSession(msg.from);
    }
  }
};
