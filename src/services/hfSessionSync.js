import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { uploadFiles } from '@huggingface/hub';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

const SESSION_FOLDER_IN_HF = 'whatsapp_session';
const DB_FILE_IN_HF = 'database.sqlite';
const SESSION_ARCHIVE_NAME = 'session.tar.gz';

// Debounce: prevent uploading more than once every 2 minutes
let uploadDebounceTimer = null;
let lastUploadTime = 0;
const UPLOAD_DEBOUNCE_MS = 2 * 60 * 1000; // 2 minutes
let uploadDbTimer = null;
let lastDbUploadTime = 0;

/**
 * Download a single file using native fetch (handles all redirects automatically).
 */
async function downloadFile(url, destPath) {
  const res = await fetch(url, {
    headers: config.hfToken ? { Authorization: `Bearer ${config.hfToken}` } : {},
    redirect: 'follow'
  });

  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
  return true;
}

export const hfSessionSync = {

  /**
   * Download the compressed session archive from HF Dataset and extract it.
   * Called once at startup before Baileys initializes.
   */
  async downloadSession(authDir) {
    if (!config.hfToken || !config.hfDataset) {
      logger.warn('[SessionSync] HF_TOKEN or HF_DATASET not set — skipping session download.');
      return;
    }

    logger.info(`[SessionSync] Checking for compressed session on Hugging Face (dataset: ${config.hfDataset})...`);

    // Ensure local auth directory exists BEFORE downloading
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }
    logger.info(`[SessionSync] Auth directory ready: ${authDir}`);

    const archivePath = path.join(process.cwd(), SESSION_ARCHIVE_NAME);
    const url = `https://huggingface.co/datasets/${config.hfDataset}/resolve/main/${SESSION_FOLDER_IN_HF}/${SESSION_ARCHIVE_NAME}`;

    try {
      const ok = await downloadFile(url, archivePath);
      
      if (!ok) {
        logger.warn('[SessionSync] ⚠️  No compressed session found on HF. Bot needs a new QR/Pairing code.');
        return;
      }

      logger.info(`[SessionSync] ✅ Session archive downloaded. Extracting...`);
      
      // Extract the tar.gz archive directly into authDir
      execSync(`tar -xzf ${SESSION_ARCHIVE_NAME} -C "${authDir}"`, { stdio: 'ignore' });
      
      // Cleanup the archive
      if (fs.existsSync(archivePath)) {
        fs.unlinkSync(archivePath);
      }
      
      logger.info(`[SessionSync] ✅ Session extracted successfully.`);
    } catch (err) {
      logger.error(`[SessionSync] Failed to download or extract session: ${err.message}`);
    }
  },

  /**
   * Compress local session files and upload as a single archive to HF Dataset.
   * Debounced: will not upload more than once every 2 minutes.
   */
  async uploadSession(authDir) {
    if (!config.hfToken || !config.hfDataset) return;
    if (!fs.existsSync(authDir)) return;

    // Clear any pending upload timer and schedule a new one
    if (uploadDebounceTimer) {
      clearTimeout(uploadDebounceTimer);
    }

    const now = Date.now();
    const timeSinceLast = now - lastUploadTime;
    const delay = timeSinceLast < UPLOAD_DEBOUNCE_MS
      ? UPLOAD_DEBOUNCE_MS - timeSinceLast
      : 0;

    if (delay > 0) {
      logger.info(`[SessionSync] Upload scheduled in ${Math.round(delay / 1000)}s (debounced).`);
    }

    uploadDebounceTimer = setTimeout(async () => {
      uploadDebounceTimer = null;
      lastUploadTime = Date.now();

      const files = fs.readdirSync(authDir);
      if (files.length === 0) return;

      const archivePath = path.join(process.cwd(), SESSION_ARCHIVE_NAME);

      try {
        // Compress the authDir contents into a tar.gz archive
        execSync(`tar -czf ${SESSION_ARCHIVE_NAME} -C "${authDir}" .`, { stdio: 'ignore' });

        const fileBuffer = fs.readFileSync(archivePath);
        
        await uploadFiles({
          repo: { type: 'dataset', name: config.hfDataset },
          accessToken: config.hfToken,
          files: [{
            path: `${SESSION_FOLDER_IN_HF}/${SESSION_ARCHIVE_NAME}`,
            content: new Blob([fileBuffer])
          }],
          commitTitle: 'Update compressed WhatsApp session'
        });

        logger.info(`[SessionSync] ✅ Session compressed and synced to HF (${(fileBuffer.length / 1024).toFixed(1)} KB).`);
        
        // Cleanup local archive
        if (fs.existsSync(archivePath)) {
          fs.unlinkSync(archivePath);
        }
      } catch (err) {
        logger.error(`[SessionSync] Failed to compress/upload session: ${err.message}`);
      }
    }, delay);
  },

  /**
   * Delete the session archive from HF Dataset.
   */
  async clearSession() {
    if (!config.hfToken || !config.hfDataset) return;

    logger.info('[SessionSync] 🗑️  Clearing invalid session from HuggingFace...');

    try {
      const { deleteFiles } = await import('@huggingface/hub');
      await deleteFiles({
        repo: { type: 'dataset', name: config.hfDataset },
        accessToken: config.hfToken,
        paths: [`${SESSION_FOLDER_IN_HF}/${SESSION_ARCHIVE_NAME}`],
        commitTitle: 'Clear invalidated WhatsApp session'
      });
      logger.info(`[SessionSync] ✅ Cleared session archive from HuggingFace.`);
    } catch (err) {
      logger.warn(`[SessionSync] deleteFiles failed (${err.message}), trying fallback overwrite...`);
      try {
        await uploadFiles({
          repo: { type: 'dataset', name: config.hfDataset },
          accessToken: config.hfToken,
          files: [{
            path: `${SESSION_FOLDER_IN_HF}/.session_cleared`,
            content: new Blob([JSON.stringify({ cleared: true, at: new Date().toISOString() })])
          }],
          commitTitle: 'Mark session as cleared'
        });
      } catch (fallbackErr) {
        logger.error(`[SessionSync] Could not clear HF session: ${fallbackErr.message}`);
      }
    }
  },

  /**
   * Download the SQLite database file from HF Dataset to local path.
   */
  async downloadDatabase() {
    if (!config.hfToken || !config.hfDataset) return;
    const url = `https://huggingface.co/datasets/${config.hfDataset}/resolve/main/${DB_FILE_IN_HF}`;
    logger.info(`[DBSync] Attempting to download database from HF...`);
    try {
      const ok = await downloadFile(url, config.dbPath);
      if (ok) {
        logger.info(`[DBSync] ✅ Database restored from HF.`);
      } else {
        logger.info(`[DBSync] No saved database on HF — starting fresh.`);
      }
    } catch (err) {
      logger.warn(`[DBSync] Failed to download database: ${err.message}`);
    }
  },

  /**
   * Upload the local SQLite database file to HF Dataset.
   */
  async uploadDatabase() {
    if (!config.hfToken || !config.hfDataset) return;
    if (!fs.existsSync(config.dbPath)) return;

    if (uploadDbTimer) clearTimeout(uploadDbTimer);

    const now = Date.now();
    const timeSinceLast = now - lastDbUploadTime;
    const delay = timeSinceLast < UPLOAD_DEBOUNCE_MS
      ? UPLOAD_DEBOUNCE_MS - timeSinceLast
      : 0;

    if (delay > 0) {
      logger.info(`[DBSync] Upload scheduled in ${Math.round(delay / 1000)}s (debounced).`);
    }

    uploadDbTimer = setTimeout(async () => {
      uploadDbTimer = null;
      lastDbUploadTime = Date.now();

      try {
        const fileBuffer = fs.readFileSync(config.dbPath);
        await uploadFiles({
          repo: { type: 'dataset', name: config.hfDataset },
          accessToken: config.hfToken,
          files: [{
            path: DB_FILE_IN_HF,
            content: new Blob([fileBuffer])
          }],
          commitTitle: 'Update database'
        });
        logger.info(`[DBSync] ✅ Database synced to HF (${(fileBuffer.length / 1024).toFixed(1)} KB).`);
      } catch (err) {
        logger.error(`[DBSync] Failed to upload database: ${err.message}`);
      }
    }, delay);
  },

  /**
   * Force upload the database immediately, bypassing debounce.
   */
  async forceUploadDatabase() {
    if (!config.hfToken || !config.hfDataset) return;
    if (!fs.existsSync(config.dbPath)) return;

    if (uploadDbTimer) {
      clearTimeout(uploadDbTimer);
      uploadDbTimer = null;
    }

    lastDbUploadTime = Date.now();

    try {
      const fileBuffer = fs.readFileSync(config.dbPath);
      await uploadFiles({
        repo: { type: 'dataset', name: config.hfDataset },
        accessToken: config.hfToken,
        files: [{
          path: DB_FILE_IN_HF,
          content: new Blob([fileBuffer])
        }],
        commitTitle: 'Force update database (critical operation)'
      });
      logger.info(`[DBSync] ✅ Database force-synced to HF (${(fileBuffer.length / 1024).toFixed(1)} KB).`);
    } catch (err) {
      logger.error(`[DBSync] Force upload failed: ${err.message}`);
    }
  }
};
