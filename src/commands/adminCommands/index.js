import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../config/index.js';
import { dbService } from '../../services/dbService.js';
import { hfService } from '../../services/hfService.js';
import { cacheService } from '../../services/cacheService.js';
import { sessionService } from '../../services/sessionService.js';
import logger, { dbLog } from '../../utils/logger.js';
import { formatBytes, userCommands } from '../userCommands/index.js';
import { phoneToJid } from '../../utils/jidHelper.js';
import { hfSessionSync } from '../../services/hfSessionSync.js';
import { downloadMedia } from '../../utils/mediaHandler.js';

/**
 * Helper to compute SHA256 checksum of a file.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
    input.on('error', err => reject(err));
  });
}

export const adminCommands = {
  /**
   * Display simplified admin help text
   */
  async showAdminHelp(client, msg) {
    const text = `🛠️ *أوامر لوحة التحكم للأدمن:*
━━━━━━━━━━━━━━━━━━

📌 *إدارة الطلبات:*
• \`طلبات\` — عرض قائمة الطلبات المعلقة
• \`قبول [رقم_الطلب]\` — قبول وإضافة المحتوى
• \`رفض [رقم_الطلب] [السبب]\` — رفض الطلب

📌 *إدارة المحتوى:*
• \`حذف [UUID أو الاسم]\` — حذف صوتية/فيديو/كتاب
• \`تعديل [UUID] العنوان:جديد | المقدم:جديد | القسم:جديد\`

📌 *إدارة التصنيفات:*
• \`تصنيفات الأدمن\` — عرض قائمة التصنيفات حسب النوع
• \`إضافة تصنيف [صوت|فيديو|كتاب] [الاسم]\` — إضافة تصنيف جديد
• \`حذف تصنيف [الاسم]\` — حذف تصنيف

📌 *أدوات المنظومة:*
• \`تقرير\` — التقرير الإحصائي الشامل
• \`رسالة جماعية [النص]\` — إرسال إشعار عام للكل
• \`نسخة احتياطية\` — تحميل ملف قاعدة البيانات
• \`تحديث الفهرس\` — إعادة بناء التخزين المؤقت
• \`تنظيف المؤقت\` — مسح الملفات المؤقتة الزائدة
• \`فحص المستودع\` — اختبار الاتصال بـ HuggingFace`;

    await msg.reply(text);
  },

  /**
   * List all pending requests
   */
  async listRequests(client, msg) {
    try {
      const requests = await dbService.getPendingRequests();
      if (requests.length === 0) {
        await msg.reply('📭 لا توجد أي طلبات محتوى معلقة حالياً.');
        return;
      }

      let response = `⏳ *طلبات المحتوى المعلقة للمراجعة (${requests.length}):*\n━━━━━━━━━━━━━━━━━━\n\n`;
      requests.forEach((req) => {
        const typeLabel = req.media_type === 'book' ? 'كتاب' : req.media_type === 'video' ? 'فيديو' : 'صوتية';
        response += `📝 *رقم الطلب:* \`${req.uuid}\`\n`;
        response += `📦 *النوع:* ${typeLabel}\n`;
        response += `📌 *العنوان:* ${req.title}\n`;
        if (req.media_type === 'book') {
          response += `✍️ *المؤلف:* ${req.book_author || 'غير محدد'}\n`;
        } else {
          response += `👤 *المقدم:* ${req.presenter || 'غير محدد'}\n`;
        }
        response += `📂 *التصنيف:* ${req.category}\n`;
        response += `📞 *المرسل:* ${req.phone}\n`;
        response += `✅ للقبول: \`قبول ${req.uuid}\`\n`;
        response += `❌ للرفض: \`رفض ${req.uuid} [السبب]\`\n\n`;
      });

      await msg.reply(response);
    } catch (err) {
      logger.error(`Error listing requests: ${err.message}`);
      await msg.reply('❌ فشل جلب طلبات الإضافة.');
    }
  },

  /**
   * Approve and process an audio, video, or book request
   */
  async approveRequest(client, msg, requestId) {
    if (!requestId || requestId.trim() === '') {
      const pending = await dbService.getPendingRequests();
      if (pending.length === 0) {
        await msg.reply('📭 لا توجد طلبات معلقة حالياً.');
        return;
      }
      requestId = pending[0].uuid;
    }

    const req = await dbService.getRequestByUuid(requestId);
    if (!req) {
      await msg.reply('❌ لم يتم العثور على طلب بهذا المعرف.');
      return;
    }

    if (req.status !== 'WAITING') {
      await msg.reply(`❌ هذا الطلب تم التعامل معه مسبقاً وحالته الحالية هي: *${req.status}*`);
      return;
    }

    const mediaType = req.media_type || 'audio';
    const typeLabel = mediaType === 'book' ? 'كتاب' : mediaType === 'video' ? 'فيديو' : 'صوتية';

    await msg.reply(`⏳ جاري معالجة الطلب ورفع ${typeLabel} إلى Hugging Face...`);

    try {
      if (!fs.existsSync(req.audio_temp)) {
        throw new Error(`Temporary file not found at ${req.audio_temp}`);
      }

      await dbService.updateRequestStatus(requestId, 'PROCESSING');

      const sha256 = await computeFileSha256(req.audio_temp);
      const duplicateAudio = await dbService.getAudioBySha(sha256);
      const duplicateBook = await dbService.getBookBySha(sha256);

      if (duplicateAudio || duplicateBook) {
        await dbService.updateRequestStatus(requestId, 'REJECTED');
        fs.unlinkSync(req.audio_temp);
        
        await msg.reply(`❌ تم إلغاء الطلب! هذا الملف مكرر وموجود بالفعل في المكتبة.`);
        await client.sendMessage(phoneToJid(req.phone), { text: `❌ نعتذر منك، لقد تم رفض اقتراحك لـ ${typeLabel} *"${req.title}"* لأنها موجودة بالفعل في المنصة.` });
        return;
      }

      const stats = fs.statSync(req.audio_temp);
      const fileSize = stats.size;
      const contentUuid = uuidv4();
      const ext = path.extname(req.audio_temp) || (mediaType === 'book' ? '.pdf' : mediaType === 'video' ? '.mp4' : '.mp3');

      // Upload to HF
      let hfFolder = 'audios';
      if (mediaType === 'video') hfFolder = 'videos';
      if (mediaType === 'book') hfFolder = 'books';

      const hfPath = `${hfFolder}/${contentUuid}${ext}`;
      const hfUrl = await hfService.uploadFile(req.audio_temp, hfPath);

      // Save in SQLite
      if (mediaType === 'book') {
        await dbService.addBook({
          uuid: contentUuid,
          title: req.title,
          author: req.book_author || req.presenter || 'غير محدد',
          category: req.category || 'عام',
          description: req.description,
          keywords: `${req.title} ${req.book_author || ''} ${req.category}`,
          hf_url: hfUrl,
          pages_count: req.book_pages || 0,
          size: fileSize,
          sha256,
          uploader_phone: req.phone
        });
      } else {
        await dbService.addAudio({
          uuid: contentUuid,
          title: req.title,
          presenter: req.presenter || 'غير محدد',
          category: req.category,
          description: req.description,
          location: req.location,
          date_hijri: req.date_hijri,
          keywords: `${req.title} ${req.presenter} ${req.category}`,
          hf_url: hfUrl,
          size: fileSize,
          sha256,
          media_type: mediaType
        });
      }

      await dbService.updateRequestStatus(requestId, 'APPROVED');
      await cacheService.refresh();
      await hfSessionSync.forceUploadDatabase();

      // Notify Subscribers
      await userCommands.notifySubscribers(client, {
        title: req.title,
        presenter: req.presenter || req.book_author,
        category: req.category,
        size: fileSize,
        media_type: mediaType
      });

      if (fs.existsSync(req.audio_temp)) {
        fs.unlinkSync(req.audio_temp);
      }

      await dbLog('CONTENT_APPROVED', `Admin approved request ${requestId}. ${typeLabel} uuid: ${contentUuid}`);

      await msg.reply(`✅ تم قبول ${typeLabel} بنجاح ورفعها للمنصة!\n\n🔗 الرابط: ${hfUrl}`);
      
      const userMsg = `🎉 بشرى سارة! تمت الموافقة على ${typeLabel}تك المقترحة *"${req.title}"* وتمت إضافتها للمنصة! شكرًا لك.`;
      await client.sendMessage(phoneToJid(req.phone), { text: userMsg });

    } catch (err) {
      logger.error(`Error approving request ${requestId}: ${err.message}`);
      await msg.reply(`❌ فشلت عملية المعالجة والقبول: ${err.message}`);
      await dbService.updateRequestStatus(requestId, 'WAITING').catch(() => {});
    }
  },

  /**
   * Reject a request with a reason
   */
  async rejectRequest(client, msg, requestId, reason) {
    if (!requestId || requestId.trim() === '') {
      const pending = await dbService.getPendingRequests();
      if (pending.length === 0) {
        await msg.reply('📭 لا توجد طلبات معلقة حالياً.');
        return;
      }
      requestId = pending[0].uuid;
    }

    const req = await dbService.getRequestByUuid(requestId);
    if (!req) {
      await msg.reply('❌ لم يتم العثور على طلب بهذا الرقم.');
      return;
    }

    if (req.status !== 'WAITING') {
      await msg.reply(`❌ هذا الطلب ليس معلقاً وحالته الحالية هي: ${req.status}`);
      return;
    }

    if (!reason || reason.trim() === '' || reason === 'غير محدد') {
      sessionService.setSession(msg.from, 'AWAITING_REJECT_REASON', { rejectRequestId: requestId });
      await msg.reply(`📝 اكتب سبب الرفض لـ *"${req.title}"* (أو أرسل "تخطي"):`);
      return;
    }

    try {
      await dbService.updateRequestStatus(requestId, 'REJECTED');
      if (fs.existsSync(req.audio_temp)) {
        fs.unlinkSync(req.audio_temp);
      }

      await dbLog('CONTENT_REJECTED', `Admin rejected request ${requestId} for reason: ${reason}`);
      await msg.reply('✅ تم رفض الطلب وحذف الملف المؤقت بنجاح.');
      
      await client.sendMessage(
        phoneToJid(req.phone),
        { text: `❌ نعتذر منك، لقد تم رفض المحتوى المقترح *"${req.title}"*.\n\n*سبب الرفض:* ${reason}` }
      );
    } catch (err) {
      logger.error(`Error rejecting request: ${err.message}`);
      await msg.reply('❌ حدث خطأ أثناء محاولة رفض الطلب.');
    }
  },

  /**
   * Delete content (Audio, Video, or Book)
   */
  async deleteAudio(client, msg, query) {
    if (!query) {
      await msg.reply('❌ يرجى كتابة الـ UUID أو اسم الملف المراد حذفه.');
      return;
    }

    try {
      let item = await dbService.getAudioByUuid(query);
      let isBook = false;

      if (!item) {
        item = await dbService.getBookByUuid(query);
        if (item) isBook = true;
      }

      if (!item) {
        const allAudios = cacheService.getAudios();
        const allVideos = cacheService.getVideos();
        const allBooks = cacheService.getBooks();

        const matchesAudio = allAudios.filter(a => a.title.toLowerCase().includes(query.toLowerCase()));
        const matchesVideo = allVideos.filter(v => v.title.toLowerCase().includes(query.toLowerCase()));
        const matchesBook = allBooks.filter(b => b.title.toLowerCase().includes(query.toLowerCase()));

        const totalMatches = [...matchesAudio, ...matchesVideo, ...matchesBook];

        if (totalMatches.length === 0) {
          await msg.reply('❌ لم يتم العثور على أي محتوى يطابق المدخلات.');
          return;
        }

        if (totalMatches.length > 1) {
          let list = '🔍 *نتائج البحث (اختر UUID للحذف المباشر):*\n\n';
          totalMatches.slice(0, 10).forEach((a, i) => {
            list += `${i + 1}. *${a.title}*\n   📎 \`${a.uuid}\`\n`;
          });
          list += '\nأرسل `حذف [الـ UUID]` للحذف المباشر.';
          await msg.reply(list);
          return;
        }

        item = totalMatches[0];
        if (matchesBook.includes(item)) isBook = true;
      }

      const mediaType = isBook ? 'book' : (item.media_type || 'audio');
      const typeLabel = mediaType === 'book' ? 'كتاب' : mediaType === 'video' ? 'فيديو' : 'صوتية';

      sessionService.setSession(msg.from, 'AWAITING_DELETE_CONFIRM', { deleteUuid: item.uuid, isBook });

      await msg.reply(`⚠️ تأكيد حذف ${typeLabel}:

*العنوان:* ${item.title}
*التصنيف:* ${item.category}
*الـ UUID:* \`${item.uuid}\`

للتأكيد أرسل: *تأكيد حذف ${item.uuid}*
للإلغاء أرسل: *إلغاء*`);

    } catch (err) {
      logger.error(`Error during delete lookup: ${err.message}`);
      await msg.reply('❌ فشل البحث عن المحتوى للحذف.');
    }
  },

  /**
   * Confirm deletion
   */
  async confirmDelete(client, msg, uuid) {
    try {
      const session = sessionService.getSession(msg.from);
      const isBook = session?.data?.isBook;

      let item = isBook ? await dbService.getBookByUuid(uuid) : await dbService.getAudioByUuid(uuid);
      if (!item && !isBook) {
        item = await dbService.getBookByUuid(uuid);
      }

      if (!item) {
        await msg.reply('❌ لم يتم العثور على المحتوى.');
        return;
      }

      await msg.reply(`⏳ جاري حذف ${item.title}...`);

      if (item.hf_url) {
        try {
          const urlPath = new URL(item.hf_url).pathname;
          const hfPath = urlPath.substring(urlPath.indexOf('/') + 1).split('/').slice(1).join('/');
          if (hfPath) {
            await hfService.deleteFile(hfPath);
          }
        } catch (e) {}
      }

      if (isBook) {
        await dbService.deleteBook(uuid);
      } else {
        await dbService.deleteAudio(uuid);
      }

      await cacheService.refresh();
      await hfSessionSync.forceUploadDatabase();

      await msg.reply(`✅ تم حذف *(${item.title})* نهائياً.`);
      await dbLog('CONTENT_DELETED', `Admin deleted ${uuid} (${item.title})`);
    } catch (err) {
      logger.error(`Error confirming deletion: ${err.message}`);
      await msg.reply('❌ فشل الحذف.');
    }
  },

  /**
   * Display Admin Dashboard Summary
   */
  async displayAdminStats(client, msg) {
    try {
      const summary = await dbService.getSummaryStats();
      const weeklyAudios = await dbService.getAudiosThisWeek();
      const weeklyVideos = await dbService.getVideosThisWeek();
      const weeklyBooks = await dbService.getBooksThisWeek();

      let text = `📊 *تقرير المنصة الشامل للأدمن:*\n━━━━━━━━━━━━━━━━━━\n\n`;
      text += `📈 *الملخص العام:*\n`;
      text += `- 🎧 الصوتيات: *${summary.totalAudios}* (جديد الأسبوع: *${weeklyAudios.length}*)\n`;
      text += `- 🎬 الفيديوهات: *${summary.totalVideos}* (جديد الأسبوع: *${weeklyVideos.length}*)\n`;
      text += `- 📚 الكتب: *${summary.totalBooks}* (جديد الأسبوع: *${weeklyBooks.length}*)\n`;
      text += `- 👥 المستخدمين المسجلين: *${summary.totalUsers}*\n`;
      text += `- ⬇️ إجمالي التحميلات: *${summary.totalDownloads}*\n`;
      text += `- ⏳ الطلبات المعلقة: *${summary.totalRequests}*\n`;

      await msg.reply(text);
    } catch (err) {
      logger.error(`Error displaying admin stats: ${err.message}`);
      await msg.reply('❌ فشل توليد التقرير الإحصائي.');
    }
  },

  /**
   * Display categories list grouped by content type
   */
  async listAdminCategories(client, msg) {
    try {
      const audioCats = await dbService.getCategoriesByType('audio');
      const videoCats = await dbService.getCategoriesByType('video');
      const bookCats = await dbService.getCategoriesByType('book');

      let text = `📂 *تصنيفات المنصة حسب النوع:*\n━━━━━━━━━━━━━━━━━━\n\n`;
      
      text += `🎧 *الصوتيات:*\n`;
      if (audioCats.length) audioCats.forEach(c => text += `• ${c.name}\n`);
      else text += `• لا توجد\n`;

      text += `\n🎬 *الفيديوهات:*\n`;
      if (videoCats.length) videoCats.forEach(c => text += `• ${c.name}\n`);
      else text += `• لا توجد\n`;

      text += `\n📚 *الكتب:*\n`;
      if (bookCats.length) bookCats.forEach(c => text += `• ${c.name}\n`);
      else text += `• لا توجد\n`;

      await msg.reply(text);
    } catch (err) {
      logger.error(`Error listing admin categories: ${err.message}`);
      await msg.reply('❌ فشل جلب التصنيفات.');
    }
  },

  /**
   * Add a new category (Syntax: إضافة تصنيف [صوت|فيديو|كتاب] [الاسم])
   */
  async addCategory(client, msg, text) {
    if (!text || text.trim() === '') {
      await msg.reply('❌ الصيغة: `إضافة تصنيف [صوت|فيديو|كتاب] [اسم التصنيف]`');
      return;
    }

    const parts = text.trim().split(' ');
    let type = 'audio';
    let catName = text.trim();

    if (parts[0] === 'صوت' || parts[0] === 'صوتيات') {
      type = 'audio';
      catName = parts.slice(1).join(' ');
    } else if (parts[0] === 'فيديو' || parts[0] === 'فيديوهات') {
      type = 'video';
      catName = parts.slice(1).join(' ');
    } else if (parts[0] === 'كتاب' || parts[0] === 'كتب') {
      type = 'book';
      catName = parts.slice(1).join(' ');
    }

    if (!catName || !catName.trim()) {
      await msg.reply('❌ اكتب اسم التصنيف المراد إضافته.');
      return;
    }

    try {
      const added = await dbService.addCategory(catName.trim(), type);
      if (!added) {
        await msg.reply(`⚠️ التصنيف *"${catName.trim()}"* موجود مسبقاً.`);
        return;
      }
      config.categories = await dbService.getAllCategories();
      await cacheService.refresh();
      await dbLog('CATEGORY_ADD', `Admin added category: ${catName.trim()} (${type})`);
      await msg.reply(`✅ تم إضافة تصنيف *"${catName.trim()}"* لنوع (${type}) بنجاح.`);
    } catch (err) {
      logger.error(`Error adding category: ${err.message}`);
      await msg.reply('❌ فشل إضافة التصنيف.');
    }
  },

  /**
   * Delete a category
   */
  async removeCategory(client, msg, name) {
    if (!name || name.trim() === '') {
      await msg.reply('❌ يرجى كتابة اسم التصنيف المراد حذفه.');
      return;
    }
    try {
      await dbService.deleteCategory(name.trim());
      config.categories = await dbService.getAllCategories();
      await cacheService.refresh();
      await dbLog('CATEGORY_DELETE', `Admin deleted category: ${name.trim()}`);
      await msg.reply(`✅ تم حذف التصنيف *"${name.trim()}"*.`);
    } catch (err) {
      logger.error(`Error deleting category: ${err.message}`);
      await msg.reply('❌ فشل حذف التصنيف.');
    }
  },

  /**
   * Broadcast message to all users
   */
  async broadcastMessage(client, msg, text) {
    if (!text || text.trim() === '') {
      await msg.reply('❌ يرجى كتابة الرسالة المراد إرسالها (مثال: `رسالة جماعية أهلاً بكم`).');
      return;
    }

    try {
      const users = await dbService.getAllUsers();
      if (users.length === 0) {
        await msg.reply('❌ لا يوجد مستخدمين مسجلين في البوت للإرسال لهم.');
        return;
      }

      await msg.reply(`⏳ البدء في إرسال رسالة جماعية إلى *${users.length}* مستخدم...`);
      
      let successCount = 0;
      for (const user of users) {
        try {
          if (user.phone === config.adminNumber) continue;
          await client.sendMessage(phoneToJid(user.phone), { text: `📢 *رسالة جماعية من منصة إعلام شبوة السلفي:*\n\n${text}` });
          successCount++;
          await new Promise(r => setTimeout(r, 2500));
        } catch (err) {}
      }

      await msg.reply(`✅ تم الإرسال بنجاح إلى *${successCount}* مستخدم.`);
      await dbLog('BROADCAST', `Admin broadcasted message: "${text}" to ${successCount} users`);
    } catch (err) {
      logger.error(`Error broadcasting message: ${err.message}`);
      await msg.reply('❌ حدث خطأ أثناء الإرسال الجماعي.');
    }
  },

  /**
   * Send DB Backup
   */
  async sendBackup(client, msg) {
    try {
      if (!fs.existsSync(config.dbPath)) {
        await msg.reply('❌ قاعدة البيانات غير موجودة حالياً.');
        return;
      }

      await msg.reply('⏳ جاري إرسال النسخة الاحتياطية...');
      await client.sendMessage(msg.remoteJid, {
        document: fs.readFileSync(config.dbPath),
        mimetype: 'application/x-sqlite3',
        fileName: 'database.sqlite',
        caption: `📦 *نسخة احتياطية لقاعدة البيانات*`
      }, { quoted: msg.raw });

      await dbLog('BACKUP', `Admin downloaded database backup file`);
    } catch (err) {
      logger.error(`Error sending database backup: ${err.message}`);
      await msg.reply('❌ فشل إرسال النسخة الاحتياطية.');
    }
  },

  /**
   * Rebuild Cache
   */
  async rebuildCache(client, msg) {
    try {
      await cacheService.refresh();
      await msg.reply(`✅ تم إعادة بناء التخزين المؤقت بنجاح.`);
    } catch (err) {
      await msg.reply(`❌ فشلت العملية: ${err.message}`);
    }
  },

  /**
   * Clean Temp Files
   */
  async cleanTempFiles(client, msg) {
    try {
      const dirs = ['uploads', 'temp'];
      let deletedCount = 0;
      
      for (const dirName of dirs) {
        const dirPath = path.join(config.rootDir, dirName);
        if (!fs.existsSync(dirPath)) continue;
        
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
          const filePath = path.join(dirPath, file);
          let shouldDelete = true;
          if (dirName === 'uploads') {
            const pendingReqs = await dbService.getPendingRequests();
            if (pendingReqs.some(r => r.audio_temp === filePath)) shouldDelete = false;
          }
          if (shouldDelete) {
            fs.unlinkSync(filePath);
            deletedCount++;
          }
        }
      }
      await msg.reply(`✅ تم مسح *${deletedCount}* ملف مؤقت.`);
      await dbLog('CLEANUP', `Admin cleaned up ${deletedCount} temp files`);
    } catch (err) {
      logger.error(`Error cleaning temp files: ${err.message}`);
      await msg.reply('❌ فشل تنظيف الملفات المؤقتة.');
    }
  },

  /**
   * Add Advertisement (Syntax: إضافة إعلان [عدد_الأيام] [النص])
   */
  async addAdvertisement(client, msg, text) {
    if (!text || text.trim() === '') {
      await msg.reply('❌ الصيغة: `إضافة إعلان [عدد_الأيام] [نص الإعلان]`\nيمكنك أيضاً إرفاق صورة مع هذا الأمر في الوصف.');
      return;
    }

    const parts = text.trim().split(' ');
    const days = parseInt(parts[0], 10);
    
    if (isNaN(days) || days <= 0) {
      await msg.reply('❌ يرجى تحديد عدد الأيام برقم صحيح. مثال: `إضافة إعلان 3 إعلان جديد`');
      return;
    }

    const adText = parts.slice(1).join(' ').trim();
    if (!adText) {
      await msg.reply('❌ يرجى كتابة نص الإعلان.');
      return;
    }

    let imageUrl = null;
    let tempPath = null;

    try {
      await msg.reply('⏳ جاري إضافة الإعلان...');

      const isImage = msg.raw.message?.imageMessage || msg.raw.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
      if (isImage) {
        // If it's a quoted message, we need to pass the quoted message part to downloadMedia
        // But getMediaMessageInfo extracts from msg.message.
        // It's safer to pass msg.raw if it's direct, or construct a fake rawMsg for quoted.
        let mediaRawMsg = msg.raw;
        if (msg.raw.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
           mediaRawMsg = { message: msg.raw.message.extendedTextMessage.contextInfo.quotedMessage };
        }
        
        const buffer = await downloadMedia(mediaRawMsg).catch(() => null);
        if (buffer) {
          tempPath = path.join(config.rootDir, 'temp', `ad_${uuidv4()}.jpg`);
          fs.writeFileSync(tempPath, buffer);
          
          const hfPath = `ads/ad_${uuidv4()}.jpg`;
          imageUrl = await hfService.uploadFile(tempPath, hfPath);
        }
      }

      await dbService.addAdvertisement(adText, imageUrl, days);

      await msg.reply(`✅ تم إضافة الإعلان بنجاح لمدة ${days} أيام.`);
      await dbLog('AD_ADDED', `Admin added ad for ${days} days: ${adText}`);

      const subscribers = await dbService.getAllSubscribers();
      if (subscribers.length > 0) {
        let successCount = 0;
        for (const phone of subscribers) {
          try {
            if (phone === config.adminNumber) continue;
            if (imageUrl) {
              await client.sendMessage(phoneToJid(phone), {
                image: { url: imageUrl },
                caption: `📢 *إعلان جديد:*\n\n${adText}`
              });
            } else {
              await client.sendMessage(phoneToJid(phone), {
                text: `📢 *إعلان جديد:*\n\n${adText}`
              });
            }
            successCount++;
            await new Promise(r => setTimeout(r, 2000));
          } catch (e) {}
        }
        await msg.reply(`✅ تم إرسال الإشعار لـ ${successCount} مشترك.`);
      }

    } catch (err) {
      logger.error(`Error adding advertisement: ${err.message}`);
      await msg.reply('❌ حدث خطأ أثناء إضافة الإعلان.');
    } finally {
      if (tempPath && fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    }
  }
};
