import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { initDatabase, getDb } from './src/database/connection.js';
import { hfService } from './src/services/hfService.js';
import { cacheService } from './src/services/cacheService.js';

const DATA_FILE = 'extracted_data_full.txt';
const FILES_DIR = '.';
const DELAY_BETWEEN_UPLOADS_MS = 3000;

function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
    input.on('error', err => reject(err));
  });
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function importTelegramAudios() {
  console.log('');
  console.log('بدء استيراد الصوتيات من تيليجرام...\n');

  const db = await initDatabase();

  if (!fs.existsSync(DATA_FILE)) {
    console.error(`لم يتم العثور على ملف ${DATA_FILE}.`);
    process.exit(1);
  }
  if (!fs.existsSync(FILES_DIR)) {
    console.error(`لم يتم العثور على مجلد ${FILES_DIR}.`);
    process.exit(1);
  }

  console.log('قراءة البيانات...');
  const raw = fs.readFileSync(DATA_FILE, 'utf-8').trim();
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l);

  const entries = lines.map(line => {
    const parts = line.split('|');
    return {
      file: parts[0],
      title: parts[1] || '(بدون عنوان)',
      presenter: parts[2] || '(غير محدد)',
      category: parts[3] || 'خطب',
      location: parts[4] || '',
      date_hijri: parts[5] || '',
      duration: parseInt(parts[6], 10) || 0
    };
  });

  console.log(`تم العثور على ${entries.length} صوتية في البيانات.\n`);

  let successCount = 0;
  let skipCount = 0;
  let errorCount = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    console.log(`معالجة ${i + 1}/${entries.length}: ${entry.file}`);

    try {
      const filePath = path.resolve(FILES_DIR, entry.file);

      if (!fs.existsSync(filePath)) {
        console.warn(`  ⚠️ الملف غير موجود: ${filePath} - تخطي`);
        skipCount++;
        continue;
      }

      console.log('  ⏳ فحص التكرار...');
      const sha256 = await computeFileSha256(filePath);
      const existing = await db.get('SELECT * FROM audios WHERE sha256 = ?', [sha256]);

      if (existing) {
        console.log(`  ⏭️ موجود مسبقاً: "${existing.title}"`);
        skipCount++;
        continue;
      }

      const stats = fs.statSync(filePath);
      const uuid = uuidv4();
      const ext = path.extname(filePath) || '.mp3';
      const hfPath = `audios/${uuid}${ext}`;

      console.log(`  ⬆️ رفع إلى Hugging Face...`);
      const hfUrl = await hfService.uploadFile(filePath, hfPath);

      await db.run(
        `INSERT INTO audios (
          uuid, title, presenter, category, description, keywords,
          hf_url, cover_url, location, date_hijri, duration, size, sha256,
          downloads, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          uuid,
          entry.title,
          entry.presenter,
          entry.category,
          '',
          `${entry.title} ${entry.presenter} ${entry.category}`,
          hfUrl,
          '',
          entry.location,
          entry.date_hijri,
          entry.duration,
          stats.size,
          sha256
        ]
      );

      console.log(`  ✅ تم: "${entry.title}"`);
      successCount++;

      if (i < entries.length - 1) {
        console.log(`  ⏱️ انتظار ${DELAY_BETWEEN_UPLOADS_MS / 1000} ثوانٍ...`);
        await delay(DELAY_BETWEEN_UPLOADS_MS);
      }

    } catch (err) {
      console.error(`  ❌ خطأ: ${err.message}`);
      errorCount++;
    }
  }

  console.log('\nتحديث الكاش...');
  await cacheService.refresh();

  console.log('\n=======================================');
  console.log('انتهت عملية الاستيراد!');
  console.log(`نجاح: ${successCount}`);
  console.log(`تخطي: ${skipCount}`);
  console.log(`أخطاء: ${errorCount}`);
  console.log(`إجمالي الصوتيات في الكاش: ${cacheService.getBooks().length}`);
  console.log('=======================================');
  process.exit(0);
}

importTelegramAudios();
