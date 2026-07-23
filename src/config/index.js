import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Load env variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../');

// Ensure directories exist
const directories = ['uploads', 'temp', 'logs'];
for (const dir of directories) {
  const dirPath = path.join(rootDir, dir);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Format raw phone input into WhatsApp format: number@c.us
 * @param {string} phone
 * @returns {string}
 */
function formatPhone(phone) {
  if (!phone) return '';
  let cleaned = phone.trim();
  // Strip any WhatsApp JID suffixes to get just the phone number
  cleaned = cleaned.replace(/@(c\.us|s\.whatsapp\.net)$/i, '');
  // Remove non-digit characters
  cleaned = cleaned.replace(/[^0-9]/g, '');
  return cleaned;
}

export const config = {
  rootDir,
  port: parseInt(process.env.PORT, 10) || 3000,
  hfToken: process.env.HF_TOKEN || '',
  hfDataset: process.env.HF_DATASET || '',
  adminNumber: formatPhone(process.env.ADMIN_NUMBER || ''),
  maxFileSizeMb: parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 100,
  rateLimitMs: parseInt(process.env.RATE_LIMIT_MS, 10) || 1000,
  requestCooldownMs: parseInt(process.env.REQUEST_COOLDOWN_MS, 10) || 180000,
  dbPath: path.join(rootDir, 'database.sqlite'),
  categories: [
    'خطب',
    'محاضرات',
    'دورة مهمات الشريعة',
  ]
};
