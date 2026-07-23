import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/index.js';
import { dbService } from '../services/dbService.js';
import { hfService } from '../services/hfService.js';
import { cacheService } from '../services/cacheService.js';
import logger, { dbLog } from '../utils/logger.js';
import { formatBytes, userCommands } from './userCommands.js';
import { phoneToJid } from '../utils/jidHelper.js';

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
   * List all pending requests
   * @param {object} client
   * @param {object} msg
   */
  async listRequests(client, msg) {
    try {
      const requests = await dbService.getPendingRequests();
      if (requests.length === 0) {
        await msg.reply('📭 لا توجد أي طلبات صوتيات معلقة حالياً.');
        return;
      }

      let response = `⏳ *طلبات الصوتيات المعلقة للمراجعة:* \n\n`;
      requests.forEach((req) => {
        response += `📝 *رقم الطلب:* \`${req.uuid}\`\n`;
        response += `🎙️ *عنوان الصوتية:* ${req.title}\n`;
        response += `👤 *المقدم:* ${req.presenter} | 📂 *التصنيف:* ${req.category}\n`;
        response += `📍 *المكان:* ${req.location || 'غير محدد'} | 📅 *التاريخ:* ${req.date_hijri || 'غير محدد'}\n`;
        response += `📞 *المرسل:* ${req.phone}\n`;
        response += `🔽 للقبول: \`قبول ${req.uuid}\`\n`;
        response += `❌ للرفض: \`رفض ${req.uuid} [السبب]\`\n\n`;
      });

      await msg.reply(response);
    } catch (err) {
      logger.error(`Error listing requests: ${err.message}`);
      await msg.reply('❌ فشل جلب طلبات الإضافة.');
    }
  },

  /**
   * Approve and process an audio request
   * @param {object} client
   * @param {object} msg
   * @param {string} requestId
   */
  async approveRequest(client, msg, requestId) {
    // If no requestId provided, auto-pick the latest pending request
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

    await msg.reply(`⏳ جاري معالجة الطلب ورفع الصوتية إلى Hugging Face. قد يستغرق هذا بضع ثوانٍ...`);

    try {
      // 1. Check if temporary file exists
      if (!fs.existsSync(req.audio_temp)) {
        throw new Error(`Temporary audio file not found at ${req.audio_temp}`);
      }

      // 2. Set status to PROCESSING
      await dbService.updateRequestStatus(requestId, 'PROCESSING');

      // 3. Compute SHA256 checksum and check duplicates
      const sha256 = await computeFileSha256(req.audio_temp);
      const duplicateAudio = await dbService.getAudioBySha(sha256);
      if (duplicateAudio) {
        // Update request to REJECTED because it's a duplicate
        await dbService.updateRequestStatus(requestId, 'REJECTED');
        fs.unlinkSync(req.audio_temp);
        
        await msg.reply(`❌ تم إلغاء الطلب! هذه الصوتية مكررة وموجودة بالفعل في المكتبة باسم *(${duplicateAudio.title})*.`);
        await client.sendMessage(phoneToJid(req.phone), { text: `❌ نعتذر منك، لقد تم رفض اقتراحك لصوتية *"${req.title}"* لأنها موجودة بالفعل في المكتبة.` });
        return;
      }

      // 4. Get file size
      const stats = fs.statSync(req.audio_temp);
      const fileSize = stats.size;

      // 5. Generate Audio UUID
      const audioUuid = uuidv4();

      // 6. Determine extension from temp file path
      const ext = path.extname(req.audio_temp) || '.mp3';

      // 7. Upload audio file to Hugging Face
      const hfPath = `audios/${audioUuid}${ext}`;
      const hfUrl = await hfService.uploadFile(req.audio_temp, hfPath);

      // 8. Save new audio record in SQLite
      await dbService.addAudio({
        uuid: audioUuid,
        title: req.title,
        presenter: req.presenter,
        category: req.category,
        description: req.description,
        location: req.location,
        date_hijri: req.date_hijri,
        keywords: `${req.title} ${req.presenter} ${req.category}`,
        hf_url: hfUrl,
        size: fileSize,
        sha256
      });

      // 9. Update request status to APPROVED
      await dbService.updateRequestStatus(requestId, 'APPROVED');

      // 10. Refresh audios cache
      await cacheService.refresh();

      // 11. Notify subscribers
      const audioData = {
        title: req.title,
        presenter: req.presenter,
        category: req.category,
        location: req.location,
        date_hijri: req.date_hijri,
        size: fileSize
      };
      await userCommands.notifySubscribers(client, audioData);

      // Cleanup local temp file
      fs.unlinkSync(req.audio_temp);

      // Log DB audit trail
      await dbLog('AUDIO_APPROVED', `Admin approved request ${requestId}. Audio uuid: ${audioUuid}`);

      // Notify Admin and user
      await msg.reply(`✅ تم قبول الصوتية بنجاح ورفعها للفهرس!\n\n🔗 رابط الملف: ${hfUrl}`);
      
      await client.sendMessage(phoneToJid(req.phone), { text: `🎉 بشرى سارة! تمت الموافقة على صوتيتك المقترحة *"${req.title}"* وتمت إضافتها للمكتبة الصوتية للجميع! شكرًا لك.` });
    } catch (err) {
      logger.error(`Error approving request ${requestId}: ${err.message}`);
      await msg.reply(`❌ فشلت عملية معالجة وقبول الطلب: ${err.message}`);
      // Revert status to WAITING in case of transient errors (e.g. HF network issues)
      await dbService.updateRequestStatus(requestId, 'WAITING').catch(() => {});
    }
  },

  /**
   * Reject an audio request with a reason
   * @param {object} client
   * @param {object} msg
   * @param {string} requestId
   * @param {string} reason
   */
  async rejectRequest(client, msg, requestId, reason) {
    // If no requestId provided, auto-pick the latest pending request
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
      const { sessionService } = await import('../services/sessionService.js');
      sessionService.setSession(msg.from, 'AWAITING_REJECT_REASON', { rejectRequestId: requestId });
      
      await msg.reply(`📝 يرجى كتابة سبب الرفض لصوتية *"${req.title}"* لإرساله للمستخدم.\n\n(أو أرسل "تخطي" للرفض بدون تحديد سبب).`);
      return;
    }

    try {

      // Update status to REJECTED
      await dbService.updateRequestStatus(requestId, 'REJECTED');

      // Cleanup file if it exists
      if (fs.existsSync(req.audio_temp)) {
        fs.unlinkSync(req.audio_temp);
      }

      // Log database audit trail
      await dbLog('AUDIO_REJECTED', `Admin rejected request ${requestId} for reason: ${reason}`);

      await msg.reply('✅ تم رفض الطلب وحذف الملف المؤقت بنجاح.');
      
      await client.sendMessage(
        phoneToJid(req.phone),
        { text: `❌ نعتذر منك، لقد تم رفض صوتيتك المقترحة *"${req.title}"*.\n\n*سبب الرفض:* ${reason}` }
      );
    } catch (err) {
      logger.error(`Error rejecting request: ${err.message}`);
      await msg.reply('❌ حدث خطأ أثناء محاولة رفض الطلب.');
    }
  },

  /**
   * Delete an existing audio
   * @param {object} client
   * @param {object} msg
   * @param {string} query - Can be audio UUID or title
   */
  async deleteBook(client, msg, query) {
    if (!query) {
      await msg.reply('❌ يرجى كتابة الـ UUID الخاص بالصوتية أو الاسم المراد حذفه (مثال: `حذف [المعرف]`).');
      return;
    }

    try {
      let audio = await dbService.getAudioByUuid(query);
      if (!audio) {
        // Try deleting by exact title search in cache
        const match = cacheService.getBooks().find(a => a.title === query.trim());
        if (match) audio = match;
      }

      if (!audio) {
        await msg.reply('❌ لم يتم العثور على أي صوتية تطابق المدخلات.');
        return;
      }

      await dbService.deleteAudio(audio.uuid);
      await cacheService.refresh();
      
      await dbLog('AUDIO_DELETED', `Admin deleted audio ${audio.uuid} (${audio.title})`);
      await msg.reply(`✅ تم حذف صوتية *(${audio.title})* بنجاح من قاعدة البيانات والفهرس.`);
    } catch (err) {
      logger.error(`Error deleting audio: ${err.message}`);
      await msg.reply('❌ فشل حذف الصوتية.');
    }
  },

  /**
   * Edit an existing audio's details
   * Command Format: تعديل uuid العنوان:الجديد | المقدم:الجديد | التصنيف:الجديد
   * @param {object} client
   * @param {object} msg
   * @param {string} text - Command parameters
   */
  async editBook(client, msg, text) {
    const parts = text.split(' ');
    const uuid = parts[0];
    const detailsRaw = text.substring(uuid.length).trim();

    if (!uuid || !detailsRaw) {
      await msg.reply('❌ طريقة خاطئة! الصيغة: `تعديل [الـ uuid] العنوان:الاسم الجديد | المقدم:اسم المقدم | التصنيف:القسم`');
      return;
    }

    try {
      const audio = await dbService.getAudioByUuid(uuid);
      if (!audio) {
        await msg.reply('❌ لم يتم العثور على صوتية بهذا الـ UUID.');
        return;
      }

      const updates = {};
      const pairs = detailsRaw.split('|');
      
      for (const pair of pairs) {
        const splitPair = pair.split(':');
        if (splitPair.length >= 2) {
          const key = splitPair[0].trim();
          const value = splitPair.slice(1).join(':').trim();
          
          if (key === 'العنوان') updates.title = value;
          if (key === 'المقدم') updates.presenter = value;
          if (key === 'التصنيف') {
            if (config.categories.includes(value)) {
              updates.category = value;
            } else {
              await msg.reply(`⚠️ التصنيف "${value}" غير موجود بالاختيارات. تم تجاهل تعديل القسم.`);
            }
          }
          if (key === 'الوصف') updates.description = value;
          if (key === 'المكان') updates.location = value;
          if (key === 'التاريخ') updates.date_hijri = value;
        }
      }

      if (Object.keys(updates).length === 0) {
        await msg.reply('❌ لم يتم توفير حقول تعديل صالحة.');
        return;
      }

      await dbService.updateAudio(uuid, updates);
      await cacheService.refresh();

      await dbLog('AUDIO_EDITED', `Admin edited audio ${uuid}: ${JSON.stringify(updates)}`);
      await msg.reply(`✅ تم تعديل بيانات صوتية *(${audio.title})* وتحديث الفهرس بنجاح.`);
    } catch (err) {
      logger.error(`Error editing audio details: ${err.message}`);
      await msg.reply('❌ فشل تعديل بيانات الصوتية.');
    }
  },

  /**
   * Display detailed admin stats
   * @param {object} client
   * @param {object} msg
   */
  async displayAdminStats(client, msg) {
    try {
      const summary = await dbService.getSummaryStats();
      const weeklyAdded = await dbService.getAudiosAddedThisWeek();
      const topAudios = await dbService.getTopDownloadedAudios(5);
      const topCats = await dbService.getTopCategories();
      const topPresenters = await dbService.getTopPresenters(5);
      const activeUsers = await dbService.getMostActiveUsers(5);

      let statsMsg = `📊 *تقرير إحصائيات إدارة الصوتيات:* \n\n`;
      statsMsg += `📈 *الملخص العام:*\n`;
      statsMsg += `- الصوتيات المؤرشفة: *${summary.totalAudios}* (جديد هذا الأسبوع: *${weeklyAdded}*)\n`;
      statsMsg += `- المستخدمين المسجلين: *${summary.totalUsers}*\n`;
      statsMsg += `- إجمالي التحميلات: *${summary.totalDownloads}*\n`;
      statsMsg += `- إجمالي المقترحات: *${summary.totalRequests}*\n\n`;

      statsMsg += `⭐ *الصوتيات الأكثر تحميلاً:*\n`;
      topAudios.forEach((a, i) => {
        statsMsg += `${i + 1}. *${a.title}* (${a.downloads} تحميل)\n`;
      });
      statsMsg += `\n📂 *التصنيفات الأكثر نشاطاً:*\n`;
      topCats.forEach((c) => {
        statsMsg += `- ${c.category}: *${c.count}* صوتية\n`;
      });

      statsMsg += `\n👤 *أكثر المقدمين طلباً:*\n`;
      topPresenters.forEach((p) => {
        statsMsg += `- ${p.presenter}: *${p.count}* صوتية\n`;
      });

      statsMsg += `\n👥 *المستخدمون الأكثر نشاطاً:*\n`;
      activeUsers.forEach((u) => {
        statsMsg += `- ${u.name} (${u.phone.split('@')[0]}): *${u.download_count}* تحميل\n`;
      });

      await msg.reply(statsMsg);
    } catch (err) {
      logger.error(`Error displaying admin stats: ${err.message}`);
      await msg.reply('❌ فشل توليد التقرير الإحصائي للإدارة.');
    }
  },

  /**
   * Broadcast a message to all users
   * @param {object} client
   * @param {object} msg
   * @param {string} text - Message to broadcast
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
          // Avoid broadcasting to the admin themselves to prevent duplicate spam
          if (user.phone === config.adminNumber) continue;
          
          await client.sendMessage(phoneToJid(user.phone), { text: `📢 *رسالة جماعية من إدارة مكتبة الصوتيات:*\n\n${text}` });
          successCount++;
          // Small delay to prevent WhatsApp blocking
          await new Promise(r => setTimeout(r, 300));
        } catch (err) {
          logger.warn(`Failed to send broadcast to ${user.phone}: ${err.message}`);
        }
      }

      await msg.reply(`✅ تم الانتهاء من الإرسال الجماعي بنجاح إلى *${successCount}* مستخدم.`);
      await dbLog('BROADCAST', `Admin broadcasted message: "${text}" to ${successCount} users`);
    } catch (err) {
      logger.error(`Error broadcasting message: ${err.message}`);
      await msg.reply('❌ حدث خطأ أثناء محاولة الإرسال الجماعي.');
    }
  },

  /**
   * Send database SQLite file to admin as a backup
   * @param {object} client
   * @param {object} msg
   */
  async sendBackup(client, msg) {
    try {
      if (!fs.existsSync(config.dbPath)) {
        await msg.reply('❌ قاعدة البيانات غير موجودة في هذا المسار حالياً.');
        return;
      }

      await msg.reply('⏳ جاري تحضير ملف النسخة الاحتياطية وإرساله لك...');

      await client.sendMessage(msg.remoteJid, {
        document: fs.readFileSync(config.dbPath),
        mimetype: 'application/x-sqlite3',
        fileName: 'database.sqlite',
        caption: `📦 *نسخة احتياطية لقاعدة البيانات* 
        
- *التاريخ:* ${new Date().toLocaleString('ar-EG')}
- *المسار:* database.sqlite`
      }, { quoted: msg.raw });

      await dbLog('BACKUP', `Admin downloaded database backup file`);
      logger.info('Database backup file successfully sent to admin.');
    } catch (err) {
      logger.error(`Error sending database backup: ${err.message}`);
      await msg.reply('❌ فشل تصدير وإرسال النسخة الاحتياطية.');
    }
  },

  /**
   * Manually rebuild in-memory audios cache
   * @param {object} client
   * @param {object} msg
   */
  async rebuildCache(client, msg) {
    try {
      await cacheService.refresh();
      await msg.reply(`✅ تم إعادة بناء فهرس الصوتيات بنجاح. الفهرس يحتوي حالياً على *${cacheService.getBooks().length}* صوتية.`);
    } catch (err) {
      await msg.reply(`❌ فشلت عملية إعادة بناء الفهرس: ${err.message}`);
    }
  },

  /**
   * Dry-run to check Hugging Face connection and configuration
   * @param {object} client
   * @param {object} msg
   */
  async resyncHf(client, msg) {
    try {
      if (!config.hfToken || config.hfToken.startsWith('hf_placeholder')) {
        await msg.reply('❌ الـ Token الخاص بـ Hugging Face غير معدل في الإعدادات بشكل صحيح.');
        return;
      }
      
      // Attempt dry-run or verify repo
      await msg.reply(`🔄 التحقق من الاتصال بمستودع Hugging Face *(${config.hfDataset})*...`);
      
      const response = await fetch(`https://huggingface.co/api/datasets/${config.hfDataset}`, {
        headers: {
          'Authorization': `Bearer ${config.hfToken}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        await msg.reply(`✅ تم الاتصال بنجاح بمستودع Hugging Face!\n\n- الاسم: ${data.id}\n- النوع: Dataset\n- الخصوصية: ${data.private ? 'خاص (Private)' : 'عام (Public)'}`);
      } else {
        throw new Error(`HF returned status ${response.status}: ${response.statusText}`);
      }
    } catch (err) {
      logger.error(`Error checking Hugging Face connection: ${err.message}`);
      await msg.reply(`❌ فشل الاتصال بـ Hugging Face: ${err.message}`);
    }
  },

  /**
   * Delete leftover files in temp/ and uploads/ folders
   * @param {object} client
   * @param {object} msg
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
            // Check if file is in pending request
            const pendingReqs = await dbService.getPendingRequests();
            const isActive = pendingReqs.some(r => r.audio_temp === filePath);
            if (isActive) shouldDelete = false;
          }
          
          if (shouldDelete) {
            fs.unlinkSync(filePath);
            deletedCount++;
          }
        }
      }
      
      await msg.reply(`✅ تم تنظيف المجلدات المؤقتة بنجاح. تم حذف *${deletedCount}* ملف.`);
      await dbLog('CLEANUP', `Admin cleaned up ${deletedCount} temp files`);
    } catch (err) {
      logger.error(`Error cleaning temp files: ${err.message}`);
      await msg.reply('❌ فشل تنظيف الملفات المؤقتة.');
    }
  }
};
