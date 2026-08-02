import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { config } from '../../config/index.js';
import { dbService } from '../../services/dbService.js';
import { sessionService } from '../../services/sessionService.js';
import { searchService } from '../../services/searchService.js';
import { cacheService } from '../../services/cacheService.js';
import { recentPollSent } from '../../services/pollTracker.js';
import logger, { dbLog } from '../../utils/logger.js';
import { phoneToJid } from '../../utils/jidHelper.js';
import { msgStore } from '../../bot/client.js';
import { downloadMedia, getMediaMessageInfo } from '../../utils/mediaHandler.js';
import { 
  SUPPORTED_AUDIO_MIMETYPES, SUPPORTED_EXTENSIONS, EXTENSION_TO_MIMETYPE, 
  SUPPORTED_VIDEO_MIMETYPES, SUPPORTED_VIDEO_EXTENSIONS, VIDEO_EXTENSION_TO_MIMETYPE,
  SUPPORTED_BOOK_MIMETYPES, SUPPORTED_BOOK_EXTENSIONS, BOOK_EXTENSION_TO_MIMETYPE,
  MAIN_MENU_OPTIONS, CONTENT_TYPES 
} from '../../constants/audio.js';

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
 * Helper to build navigation poll options based on state
 */
export function buildNavPoll(options = {}) {
  const values = [];

  if (options.currentPage && options.totalPages) {
    if (options.currentPage > 1) values.push('⬅️ السابق');
    if (options.currentPage < options.totalPages) values.push('➡️ التالي');
  }

  if (options.hasDownloadMore) values.push('📥 تحميل رقم آخر');
  if (options.hasSearch) values.push('🔍 بحث جديد');
  if (options.hasAddMore) values.push('➕ إضافة محتوى آخر');

  if (options.extraOptions && Array.isArray(options.extraOptions)) {
    values.push(...options.extraOptions);
  }

  if (options.hasBack) values.push(options.backLabel || '↩️ رجوع');
  values.push('🔙 القائمة الرئيسية');

  return values;
}

export const userCommands = {
  /**
   * Main welcome menu (12 options)
   */
  async handleStart(client, msg) {
    try {
      const pollText = `🎙️ منصة إعلام شبوة السلفي 🤖\nمكتبة علمية شاملة للصوتيات والفيديوهات والكتب.`;
      const sentMsg = await client.sendMessage(msg.remoteJid, {
        poll: {
          name: pollText,
          values: MAIN_MENU_OPTIONS,
          selectableCount: 1
        }
      });
      if (sentMsg?.key?.id && sentMsg.message) {
        msgStore.set(sentMsg.key.id, sentMsg.message);
      }
      recentPollSent.record(msg.from, MAIN_MENU_OPTIONS);
    } catch (err) {
      logger.warn(`Could not send start poll: ${err.message}`);
    }
  },

  /**
   * Prompt user to select Content Type (audio/video/book) for Search or Browse or Add
   */
  async promptContentType(client, msg, context = 'search') {
    const titles = {
      search: '🔍 اختر نوع المحتوى للبحث:',
      browse: '📂 اختر نوع المحتوى للتصفح:',
      add: '➕ اختر نوع المحتوى للإضافة:'
    };

    const pollValues = ['🎧 صوتيات', '🎬 فيديوهات', '📚 كتب', '🔙 القائمة الرئيسية'];
    
    sessionService.setSession(msg.from, 'SELECTING_CONTENT_TYPE', { context });

    try {
      const sentMsg = await client.sendMessage(msg.remoteJid, {
        poll: {
          name: titles[context] || titles.search,
          values: pollValues,
          selectableCount: 1
        }
      });
      if (sentMsg?.key?.id && sentMsg.message) {
        msgStore.set(sentMsg.key.id, sentMsg.message);
      }
      recentPollSent.record(msg.from, pollValues);
    } catch (err) {
      logger.warn(`Could not send content type poll: ${err.message}`);
    }
  },

  /**
   * Display Categories for a specific content type
   */
  async displayCategoriesForType(client, msg, contentType, context = 'browse') {
    client.sendPresenceUpdate('composing', msg.remoteJid).catch(() => {});
    
    const categories = await dbService.getCategoriesByType(contentType);
    const typeObj = CONTENT_TYPES[contentType] || CONTENT_TYPES.audio;

    const values = categories.map(c => `📋 ${c.name}`);
    if (context === 'search') {
      values.push(`🔍 بحث في كل ${typeObj.label}`);
    }
    values.push('↩️ رجوع');
    values.push('🔙 القائمة الرئيسية');

    sessionService.setSession(msg.from, 'SELECTING_CATEGORY', {
      contentType,
      context,
      backTo: 'SELECTING_CONTENT_TYPE'
    });

    try {
      const sentMsg = await client.sendMessage(msg.remoteJid, {
        poll: {
          name: `📂 تصنيفات ${typeObj.label} (${typeObj.emoji}):`,
          values,
          selectableCount: 1
        }
      });
      if (sentMsg?.key?.id && sentMsg.message) {
        msgStore.set(sentMsg.key.id, sentMsg.message);
      }
      recentPollSent.record(msg.from, values);
    } catch (err) {
      logger.warn(`Could not send categories poll: ${err.message}`);
    }
  },

  /**
   * Prompt user to type search keyword
   */
  async promptSearchInput(client, msg, contentType, categoryName = null) {
    const typeObj = CONTENT_TYPES[contentType] || CONTENT_TYPES.audio;
    
    sessionService.setSession(msg.from, 'AWAITING_SEARCH', {
      contentType,
      categoryName,
      backTo: categoryName ? 'SELECTING_CATEGORY' : 'SELECTING_CONTENT_TYPE'
    });

    const text = categoryName
      ? `🔍 اكتب كلمة البحث في تصنيف *(${categoryName})*:\n\n💡 اكتب *إلغاء* للرجوع`
      : `🔍 اكتب كلمة البحث في كل *${typeObj.label}*:\n\n💡 اكتب *إلغاء* للرجوع`;

    await msg.reply(text);
  },

  /**
   * Execute search and display results
   */
  async executeSearch(client, msg, query, contentType = 'audio', categoryName = null) {
    client.sendPresenceUpdate('composing', msg.remoteJid).catch(() => {});
    
    let results = searchService.search(query, contentType);
    if (categoryName) {
      results = results.filter(item => item.category === categoryName);
    }

    const typeObj = CONTENT_TYPES[contentType] || CONTENT_TYPES.audio;
    const limit = Math.min(results.length, 6);
    const pageItems = results.slice(0, limit);

    sessionService.setSession(msg.from, 'CONTENT_LIST', {
      contentType,
      lastItems: pageItems,
      backTo: 'AWAITING_SEARCH',
      query
    });

    if (results.length === 0) {
      await msg.reply(`😔 عذراً، لم نجد أي ${typeObj.label} تطابق "${query}".`);
      
      const pollValues = buildNavPoll({ hasSearch: true, hasBack: true, backLabel: '↩️ رجوع' });
      const sentMsg = await client.sendMessage(msg.remoteJid, {
        poll: { name: '📌 اختر خطوتك القادمة:', values: pollValues, selectableCount: 1 }
      });
      if (sentMsg?.key?.id && sentMsg.message) msgStore.set(sentMsg.key.id, sentMsg.message);
      return;
    }

    let response = `🔍 *نتائج البحث عن (${query}) في ${typeObj.label}:*\n━━━━━━━━━━━━━━━━━━\n\n`;

    for (let i = 0; i < pageItems.length; i++) {
      const item = pageItems[i];
      response += `*[${i + 1}]* ${typeObj.emoji} *${item.title}*\n`;
      if (contentType === 'book') {
        response += `✍️ *المؤلف:* ${item.author || 'غير محدد'}\n`;
      } else {
        response += `👤 *المقدم:* ${item.presenter || 'غير محدد'}\n`;
      }
      response += `📂 *التصنيف:* ${item.category}\n`;
      response += `💾 *الحجم:* ${formatBytes(item.size)}\n\n`;
    }

    response += `━━━━━━━━━━━━━━━━━━\n📥 أرسل رقم المحتوى لتحميله (1-${pageItems.length})`;
    await msg.reply(response);

    const pollValues = buildNavPoll({ hasSearch: true, hasBack: true });
    try {
      const sentMsg = await client.sendMessage(msg.remoteJid, {
        poll: { name: '📌 التنقل بين الخيارات:', values: pollValues, selectableCount: 1 }
      });
      if (sentMsg?.key?.id && sentMsg.message) msgStore.set(sentMsg.key.id, sentMsg.message);
    } catch (e) {}
  },

  /**
   * Display all items of a content type (or category) with pagination
   */
  async listContent(client, msg, contentType = 'audio', categoryName = null, page = 0) {
    client.sendPresenceUpdate('composing', msg.remoteJid).catch(() => {});
    
    let allItems = [];
    if (contentType === 'video') {
      allItems = cacheService.getVideos();
    } else if (contentType === 'book') {
      allItems = cacheService.getBooks();
    } else {
      allItems = cacheService.getAudios();
    }

    if (categoryName) {
      allItems = allItems.filter(item => item.category === categoryName);
    }

    const typeObj = CONTENT_TYPES[contentType] || CONTENT_TYPES.audio;

    if (allItems.length === 0) {
      await msg.reply(`📭 لا يوجد محتوى في ${typeObj.label} ${categoryName ? `تصنيف (${categoryName})` : ''} حالياً.`);
      const pollValues = buildNavPoll({ hasAddMore: true, hasBack: true, backLabel: '↩️ رجوع للتصنيفات' });
      const sentMsg = await client.sendMessage(msg.remoteJid, {
        poll: { name: '📌 اختر إجراءً:', values: pollValues, selectableCount: 1 }
      });
      if (sentMsg?.key?.id && sentMsg.message) msgStore.set(sentMsg.key.id, sentMsg.message);
      return;
    }

    const pageSize = 10;
    const totalPages = Math.ceil(allItems.length / pageSize);
    const currentPage = Math.max(0, Math.min(page, totalPages - 1));
    const pageItems = allItems.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

    sessionService.setSession(msg.from, 'CONTENT_LIST', {
      contentType,
      categoryName,
      page: currentPage,
      pageSize,
      totalPages,
      allItems,
      lastItems: pageItems,
      backTo: categoryName ? 'SELECTING_CATEGORY' : 'SELECTING_CONTENT_TYPE'
    });

    let header = categoryName
      ? `📂 *${categoryName} — ${typeObj.label} (صفحة ${currentPage + 1} من ${totalPages}):*`
      : `${typeObj.emoji} *جميع ${typeObj.label} (صفحة ${currentPage + 1} من ${totalPages}):*`;

    let response = `${header}\n━━━━━━━━━━━━━━━━━━\n\n`;

    for (let i = 0; i < pageItems.length; i++) {
      const item = pageItems[i];
      response += `*[${i + 1}]* ${typeObj.emoji} *${item.title}*\n`;
      if (contentType === 'book') {
        response += `✍️ *المؤلف:* ${item.author || 'غير محدد'}\n`;
      } else {
        response += `👤 *المقدم:* ${item.presenter || 'غير محدد'}\n`;
      }
      response += `💾 ${formatBytes(item.size)}\n\n`;
    }

    response += `━━━━━━━━━━━━━━━━━━\n📥 أرسل رقم المحتوى لتحميله (1-${pageItems.length})`;
    await msg.reply(response);

    const pollValues = buildNavPoll({
      currentPage: currentPage + 1,
      totalPages,
      hasBack: true,
      backLabel: categoryName ? '↩️ رجوع للتصنيفات' : '↩️ رجوع'
    });

    try {
      const sentMsg = await client.sendMessage(msg.remoteJid, {
        poll: { name: `📋 صفحة ${currentPage + 1}/${totalPages} — اختر الإجراء:`, values: pollValues, selectableCount: 1 }
      });
      if (sentMsg?.key?.id && sentMsg.message) msgStore.set(sentMsg.key.id, sentMsg.message);
    } catch (e) {}
  },

  /**
   * Handle pagination and selection within content listing
   */
  async handleContentListInput(client, msg, text) {
    const session = sessionService.getSession(msg.from);
    const { contentType, categoryName, page, totalPages, lastItems } = (session.data || {});
    const cleanText = text.trim();

    // Check for numerical selection
    const num = parseInt(cleanText, 10);
    if (!isNaN(num) && num > 0 && lastItems && num <= lastItems.length) {
      const selectedItem = lastItems[num - 1];
      return await this.downloadContent(client, msg, selectedItem.uuid, contentType);
    }

    // Check for 'تحميل X'
    if (cleanText.startsWith('تحميل ')) {
      const n = parseInt(cleanText.split(' ')[1], 10);
      if (!isNaN(n) && n > 0 && lastItems && n <= lastItems.length) {
        const selectedItem = lastItems[n - 1];
        return await this.downloadContent(client, msg, selectedItem.uuid, contentType);
      }
    }

    // Navigation buttons
    if (cleanText === '➡️ التالي') {
      if (page < totalPages - 1) {
        return await this.listContent(client, msg, contentType, categoryName, page + 1);
      }
      await msg.reply('هذه آخر صفحة ✅');
      return;
    }

    if (cleanText === '⬅️ السابق') {
      if (page > 0) {
        return await this.listContent(client, msg, contentType, categoryName, page - 1);
      }
      await msg.reply('هذه أول صفحة ✅');
      return;
    }

    if (cleanText === '🔍 بحث جديد') {
      return await this.promptContentType(client, msg, 'search');
    }

    if (cleanText === '📥 تحميل رقم آخر') {
      await msg.reply('📥 أرسل رقم المحتوى المطلوب لتحميله.');
      return;
    }

    await msg.reply('❌ إدخال غير صحيح. أرسل رقم المحتوى لتحميله أو اختر من الاستطلاع.');
  },

  /**
   * Show Weekly Content (audio, video, or book)
   */
  async displayNewThisWeek(client, msg, contentType = 'audio') {
    client.sendPresenceUpdate('composing', msg.remoteJid).catch(() => {});
    const typeObj = CONTENT_TYPES[contentType] || CONTENT_TYPES.audio;

    try {
      let items = [];
      if (contentType === 'video') {
        items = await dbService.getVideosThisWeek();
      } else if (contentType === 'book') {
        items = await dbService.getBooksThisWeek();
      } else {
        items = await dbService.getAudiosThisWeek();
      }

      if (items.length === 0) {
        await msg.reply(`📭 لا تتوفر ${typeObj.label} جديدة هذا الأسبوع.`);
        const pollValues = buildNavPoll({ 
          extraOptions: [`${typeObj.emoji} جميع ${typeObj.label}`],
          hasBack: true 
        });
        const sentMsg = await client.sendMessage(msg.remoteJid, {
          poll: { name: '📌 المقترحات المتاحة:', values: pollValues, selectableCount: 1 }
        });
        if (sentMsg?.key?.id && sentMsg.message) msgStore.set(sentMsg.key.id, sentMsg.message);
        return;
      }

      sessionService.setSession(msg.from, 'CONTENT_LIST', {
        contentType,
        lastItems: items,
        backTo: 'SELECTING_CONTENT_TYPE'
      });

      let response = `🆕 *جديد هذا الأسبوع في ${typeObj.label} (${items.length}):*\n━━━━━━━━━━━━━━━━━━\n\n`;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        response += `*[${i + 1}]* ${typeObj.emoji} *${item.title}*\n`;
        response += `📂 التصنيف: ${item.category}\n\n`;
      }

      response += `━━━━━━━━━━━━━━━━━━\n📥 أرسل رقم المحتوى لتحميله (1-${items.length})`;
      await msg.reply(response);

      const pollValues = buildNavPoll({ hasBack: true });
      const sentMsg = await client.sendMessage(msg.remoteJid, {
        poll: { name: '📌 خيارات التنقل:', values: pollValues, selectableCount: 1 }
      });
      if (sentMsg?.key?.id && sentMsg.message) msgStore.set(sentMsg.key.id, sentMsg.message);

    } catch (err) {
      logger.error(`Error displaying weekly content: ${err.message}`);
      await msg.reply('❌ حدث خطأ أثناء جلب المحتوى الأسبوعي.');
    }
  },

  /**
   * Download content file (Audio, Video, Book) and send to user
   */
  async downloadContent(client, msg, uuid, contentType = 'audio') {
    try {
      const typeObj = CONTENT_TYPES[contentType] || CONTENT_TYPES.audio;
      client.sendPresenceUpdate('recording', msg.remoteJid).catch(() => {});

      let item = null;
      if (contentType === 'book') {
        item = await dbService.getBookByUuid(uuid);
      } else {
        item = await dbService.getAudioByUuid(uuid);
      }

      if (!item) {
        await msg.reply(`❌ عذراً، لم نجد هذا العنصر في النظام.`);
        return;
      }

      await msg.reply(`⏳ جاري تحميل ${typeObj.label} *"${item.title}"* وإرسالها لك...`);

      const urlPath = item.hf_url.split('?')[0];
      const ext = path.extname(urlPath) || (contentType === 'book' ? '.pdf' : contentType === 'video' ? '.mp4' : '.mp3');
      
      const tempFilename = `download_${uuidv4()}${ext}`;
      const tempPath = path.join(config.rootDir, 'temp', tempFilename);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 90000);

      let response;
      try {
        response = await fetch(item.hf_url, {
          headers: config.hfToken ? { Authorization: `Bearer ${config.hfToken}` } : {},
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        throw new Error(`HF server returned HTTP status ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      fs.writeFileSync(tempPath, buffer);

      const cleanTitle = item.title.replace(/[\\/:*?"<>|]/g, '') || 'file';
      const extLower = ext.toLowerCase();

      let mimetype = 'application/octet-stream';
      if (contentType === 'book') {
        mimetype = BOOK_EXTENSION_TO_MIMETYPE[extLower] || 'application/pdf';
      } else if (contentType === 'video') {
        mimetype = VIDEO_EXTENSION_TO_MIMETYPE[extLower] || 'video/mp4';
      } else {
        mimetype = EXTENSION_TO_MIMETYPE[extLower] || 'audio/mpeg';
      }

      const caption = `✅ *تم إرسال الملف!*
      
${typeObj.emoji} *العنوان:* ${item.title}
${contentType === 'book' ? `✍️ *المؤلف:* ${item.author || 'غير محدد'}\n` : `👤 *المقدم:* ${item.presenter || 'غير محدد'}\n`}📂 *التصنيف:* ${item.category}
💾 *الحجم:* ${formatBytes(item.size)}`;

      if (contentType === 'video') {
        await client.sendMessage(msg.remoteJid, { video: buffer, mimetype, caption }, { quoted: msg.raw });
      } else {
        await client.sendMessage(msg.remoteJid, {
          document: buffer,
          mimetype,
          fileName: `${cleanTitle}${ext}`,
          caption
        }, { quoted: msg.raw });
      }

      // Cleanup
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }

      // Record Download
      await dbService.recordDownload(msg.from, uuid, contentType);
      await dbLog('DOWNLOAD', `User ${msg.from} downloaded ${contentType}: ${item.title}`);

      // Follow-up Poll
      const followPollValues = buildNavPoll({ hasDownloadMore: true, hasSearch: true });
      try {
        const sentPoll = await client.sendMessage(msg.remoteJid, {
          poll: { name: '✅ ماذا تريد أن تفعل الآن؟', values: followPollValues, selectableCount: 1 }
        });
        if (sentPoll?.key?.id && sentPoll.message) msgStore.set(sentPoll.key.id, sentPoll.message);
      } catch (err) {}

    } catch (err) {
      logger.error(`Error downloading content ${uuid}: ${err.message}`);
      await msg.reply('❌ عذراً، حدث خطأ أثناء جلب الملف. يرجى المحاولة لاحقاً.');
    }
  },

  /**
   * Display Advertisements
   */
  async displayAdvertisements(client, msg) {
    client.sendPresenceUpdate('composing', msg.remoteJid).catch(() => {});
    try {
      const ads = await dbService.getActiveAdvertisements();
      if (ads.length === 0) {
        await msg.reply('📭 لا توجد إعلانات حالياً.');
      } else {
        await msg.reply('📢 *الإعلانات الحالية:*\n━━━━━━━━━━━━━━━━━━');
        for (const ad of ads) {
          if (ad.image_url) {
            await client.sendMessage(msg.remoteJid, {
              image: { url: ad.image_url },
              caption: ad.text
            });
          } else {
            await client.sendMessage(msg.remoteJid, { text: ad.text });
          }
        }
      }

      const pollValues = buildNavPoll({});
      const sentMsg = await client.sendMessage(msg.remoteJid, {
        poll: { name: '📌 القائمة الرئيسية:', values: pollValues, selectableCount: 1 }
      });
      if (sentMsg?.key?.id && sentMsg.message) msgStore.set(sentMsg.key.id, sentMsg.message);
    } catch (err) {
      logger.error(`Error displaying ads: ${err.message}`);
      await msg.reply('❌ حدث خطأ أثناء جلب الإعلانات.');
    }
  },

  /**
   * Display Library Stats for Audio, Video, Books
   */
  async displayLibraryStats(client, msg) {
    try {
      const stats = await dbService.getSummaryStats();
      const text = `📊 *إحصائيات المنصة الشاملة:*
━━━━━━━━━━━━━━━━━━

🎧 الصوتيات: *${stats.totalAudios}*
🎬 الفيديوهات: *${stats.totalVideos}*
📚 الكتب والمؤلفات: *${stats.totalBooks}*

👥 عدد المستفيدين: *${stats.totalUsers}*
⬇️ إجمالي التحميلات: *${stats.totalDownloads}*
⏳ الطلبات المعلقة: *${stats.totalRequests}*

شكراً لمساهمتكم في نشر الخير! ❤️`;

      await msg.reply(text);

      const pollValues = buildNavPoll({});
      const sentMsg = await client.sendMessage(msg.remoteJid, {
        poll: { name: '📌 الخيارات المتاحة:', values: pollValues, selectableCount: 1 }
      });
      if (sentMsg?.key?.id && sentMsg.message) msgStore.set(sentMsg.key.id, sentMsg.message);

    } catch (err) {
      logger.error(`Error displaying stats: ${err.message}`);
      await msg.reply('❌ حدث خطأ أثناء جلب الإحصائيات.');
    }
  },

  /**
   * Toggle Subscription for Notifications
   */
  async handleSubscribe(client, msg) {
    try {
      const nowSubscribed = await dbService.toggleSubscribe(msg.from);
      if (nowSubscribed) {
        await msg.reply(`✅ تم الاشتراك في الإشعارات بنجاح! 🔔\n\nستصلك إشعارات فور إضافة أي صوتيات أو فيديوهات أو كتب جديدة.`);
      } else {
        await msg.reply(`✅ تم إلغاء الاشتراك في الإشعارات.\n\nيمكنك إعادة الاشتراك في أي وقت.`);
      }
      await dbLog('SUBSCRIBE_TOGGLE', `${nowSubscribed ? 'Subscribed' : 'Unsubscribed'}: ${msg.from}`);

      const pollValues = buildNavPoll({});
      const sentMsg = await client.sendMessage(msg.remoteJid, {
        poll: { name: '📌 العودة:', values: pollValues, selectableCount: 1 }
      });
      if (sentMsg?.key?.id && sentMsg.message) msgStore.set(sentMsg.key.id, sentMsg.message);
    } catch (err) {
      logger.error(`Error toggling subscription: ${err.message}`);
      await msg.reply('❌ حدث خطأ أثناء تعديل حالة الاشتراك.');
    }
  },

  /**
   * User Content Upload Wizard (Select type -> File -> Title -> Author/Presenter -> Category -> Desc -> Confirm)
   */
  async promptAddContent(client, msg) {
    const cooldown = await sessionService.checkRequestCooldown(msg.from);
    if (cooldown.isCooldown) {
      const minutes = Math.ceil(cooldown.remainingMs / 60000);
      await msg.reply(`⚠️ عذراً، يرجى الانتظار *${minutes} دقيقة* قبل إرسال طلب جديد.`);
      return;
    }

    return await this.promptContentType(client, msg, 'add');
  },

  async handleAddMediaTypeSelection(client, msg, body) {
    const text = (body || '').trim();
    if (text.includes('صوتية') || text.includes('صوتيات') || text.includes('🎧')) {
      sessionService.setSession(msg.from, 'AWAITING_UPLOAD_FILE', { contentType: 'audio' });
      await msg.reply('📤 أرسل الملف الصوتي الآن (MP3, M4A, WAV, etc.):\n\n💡 اكتب *إلغاء* للرجوع.');
      return;
    }
    if (text.includes('فيديو') || text.includes('🎬')) {
      sessionService.setSession(msg.from, 'AWAITING_UPLOAD_FILE', { contentType: 'video' });
      await msg.reply('📤 أرسل ملف الفيديو الآن (MP4, MKV, WEBM, etc.):\n\n💡 اكتب *إلغاء* للرجوع.');
      return;
    }
    if (text.includes('كتب') || text.includes('📚')) {
      sessionService.setSession(msg.from, 'AWAITING_UPLOAD_FILE', { contentType: 'book' });
      await msg.reply('📤 أرسل ملف الكتاب الآن (PDF, EPUB, MOBI):\n\n💡 اكتب *إلغاء* للرجوع.');
      return;
    }
    if (text.includes('إلغاء') || text === 'cancel') {
      sessionService.clearSession(msg.from);
      return await this.handleStart(client, msg);
    }
  },

  async handleFileUpload(client, msg) {
    try {
      const session = sessionService.getSession(msg.from);
      const contentType = session?.data?.contentType || 'audio';
      const typeObj = CONTENT_TYPES[contentType] || CONTENT_TYPES.audio;

      const buffer = await downloadMedia(msg.raw);
      if (!buffer) throw new Error('Download failed');

      const sizeMb = buffer.length / (1024 * 1024);
      if (sizeMb > config.maxFileSizeMb) {
        await msg.reply(`❌ حجم الملف يتجاوز الحد المسموح (${config.maxFileSizeMb} MB).`);
        sessionService.clearSession(msg.from);
        return;
      }

      const tempId = uuidv4();
      const mediaInfo = getMediaMessageInfo(msg.raw);
      const originalFilename = mediaInfo?.message?.fileName || '';
      const ext = path.extname(originalFilename) || (contentType === 'book' ? '.pdf' : contentType === 'video' ? '.mp4' : '.mp3');
      const tempPath = path.join(config.rootDir, 'uploads', `user_${tempId}${ext}`);
      fs.writeFileSync(tempPath, buffer);

      sessionService.setSession(msg.from, 'AWAITING_ADD_TITLE', {
        contentType,
        tempPath,
        fileSize: buffer.length,
        ext
      });

      await msg.reply(`📥 تم استلام ملف ${typeObj.label} بنجاح! (${sizeMb.toFixed(2)} MB)\n\n✍️ أرسل *العنوان* الآن:`);
    } catch (err) {
      logger.error(`Error during file upload: ${err.message}`);
      await msg.reply('❌ حدث خطأ أثناء استلام الملف. تأكد من إرسال مستند صالح.');
    }
  },

  async handleAddTitle(client, msg) {
    const title = msg.body.trim();
    if (title.length < 2) {
      await msg.reply('❌ العنوان قصير جداً. أعد المحاولة:');
      return;
    }

    const session = sessionService.getSession(msg.from);
    const contentType = session?.data?.contentType || 'audio';

    if (contentType === 'book') {
      sessionService.setSession(msg.from, 'AWAITING_ADD_AUTHOR', { title });
      await msg.reply('✍️ أرسل *اسم المؤلف* (أو اكتب "تخطي"):');
    } else {
      sessionService.setSession(msg.from, 'AWAITING_ADD_AUTHOR', { title });
      await msg.reply('👤 أرسل *اسم المقدم/الشيخ*:');
    }
  },

  async handleAddAuthor(client, msg) {
    const text = msg.body.trim();
    const session = sessionService.getSession(msg.from);
    const contentType = session?.data?.contentType || 'audio';
    const authorOrPresenter = text.toLowerCase() === 'تخطي' ? 'غير محدد' : text;

    if (contentType === 'book') {
      sessionService.setSession(msg.from, 'AWAITING_ADD_CATEGORY', { author: authorOrPresenter });
    } else {
      sessionService.setSession(msg.from, 'AWAITING_ADD_CATEGORY', { presenter: authorOrPresenter });
    }

    return await this.displayCategoriesForType(client, msg, contentType, 'add');
  },

  async handleAddCategorySelect(client, msg, categoryName) {
    const session = sessionService.getSession(msg.from);
    const contentType = session?.data?.contentType || 'audio';

    sessionService.setSession(msg.from, 'AWAITING_ADD_DESC', { category: categoryName });
    await msg.reply('📝 أرسل *وصفاً مختصراً* (اختياري) أو أرسل كلمة *\'تخطي\'*:');
  },

  async handleAddDescription(client, msg) {
    const text = msg.body.trim();
    const desc = text.toLowerCase() === 'تخطي' ? '' : text;
    const session = sessionService.getSession(msg.from);
    const { contentType, tempPath, fileSize, title, author, presenter, category } = (session.data || {});
    const typeObj = CONTENT_TYPES[contentType] || CONTENT_TYPES.audio;

    try {
      const reqUuid = uuidv4();
      await dbService.createRequest({
        uuid: reqUuid,
        phone: msg.from,
        title,
        presenter: presenter || author || 'غير محدد',
        book_author: author || '',
        category: category || 'عام',
        description: desc,
        audio_temp: tempPath,
        media_type: contentType
      });

      sessionService.clearSession(msg.from);

      await msg.reply(`✅ تم استلام طلب إضافة ${typeObj.label} بنجاح!\n\nسيتم مراجعته وإشعارك عند القبول.`);
      await dbLog('USER_PROPOSAL', `User ${msg.from} proposed ${contentType}: ${title}`);

      // Notify Admin
      const adminJid = phoneToJid(config.adminNumber);
      const adminMsg = `⚠️ *طلب إضافة ${typeObj.label} معلق* ⚠️\n\n` +
        `- *العنوان:* ${title}\n` +
        `- *${contentType === 'book' ? 'المؤلف' : 'المقدم'}:* ${presenter || author}\n` +
        `- *التصنيف:* ${category}\n` +
        `- *الحجم:* ${formatBytes(fileSize)}\n` +
        `- *المرسل:* ${msg.from}\n\n` +
        `✅ للموافقة: \`قبول ${reqUuid}\`\n` +
        `❌ للرفض: \`رفض ${reqUuid}\``;

      await client.sendMessage(adminJid, { text: adminMsg });

      // Send document copy to admin
      if (fs.existsSync(tempPath)) {
        await client.sendMessage(adminJid, {
          document: fs.readFileSync(tempPath),
          mimetype: contentType === 'video' ? 'video/mp4' : contentType === 'book' ? 'application/pdf' : 'audio/mpeg',
          fileName: `${title}${path.extname(tempPath)}`,
          caption: `${typeObj.emoji} طلب جديد: ${title}`
        });
      }

    } catch (err) {
      logger.error(`Error completing user add proposal: ${err.message}`);
      await msg.reply('❌ حدث خطأ أثناء تقديم الطلب.');
    }
  }
};
