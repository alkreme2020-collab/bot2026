import fs from 'fs';
import path from 'path';
import { uploadFiles } from '@huggingface/hub';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

const SESSION_FOLDER_IN_HF = 'whatsapp_session';
const DB_FILE_IN_HF = 'database.sqlite';

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

/**
 * Get list of session files stored in HF Dataset via API.
 */
async function getSessionFileList() {
  try {
    const url = `https://huggingface.co/api/datasets/${config.hfDataset}/tree/main/${SESSION_FOLDER_IN_HF}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.hfToken}`,
        'Content-Type': 'application/json'
      },
      redirect: 'follow'
    });

    if (!res.ok) return [];
    const files = await res.json();
    return files.filter(f => f.type === 'file').map(f => f.path);
  } catch {
    return [];
  }
}

export const hfSessionSync = {

  /**
   * Download the compressed WhatsApp session file from HF Dataset and extract it.
   */
  async downloadSession(authDir) {
    if (!config.hfToken || !config.hfDataset) {
      logger.warn('[SessionSync] HF_TOKEN or HF_DATASET not set — skipping session download.');
      return;
    }

    logger.info(`[SessionSync] Checking for saved session on Hugging Face (dataset: ${config.hfDataset})...`);
    fs.mkdirSync(authDir, { recursive: true });
    logger.info(`[SessionSync] Auth directory ready: ${authDir}`);

    const tarUrl = `https://huggingface.co/datasets/${config.hfDataset}/resolve/main/${SESSION_FOLDER_IN_HF}/session.tar.gz`;
    const tarLocalPath = path.join(authDir, 'session.tar.gz');

    try {
      const ok = await downloadFile(tarUrl, tarLocalPath);
      if (!ok) {
        logger.warn('[SessionSync] ⚠️  No saved session.tar.gz found on HF. Bot needs a new QR/Pairing code.');
        logger.warn(`[SessionSync] → Open your Render URL and scan the QR code.`);
        return;
      }

      logger.info(`[SessionSync] Downloaded session.tar.gz. Extracting...`);
      const { execSync } = await import('child_process');
      // Extract into authDir and remove the tar file
      execSync(`tar -xzf session.tar.gz`, { cwd: authDir });
      fs.unlinkSync(tarLocalPath);
      
      const filesExtracted = fs.readdirSync(authDir).length;
      logger.info(`[SessionSync] ✅ Session extracted successfully (${filesExtracted} files).`);
    } catch (err) {
      logger.error(`[SessionSync] Failed to download or extract session: ${err.message}`);
    }
  },

  /**
   * Compress and upload all local session files from authDir to HF Dataset.
   * Debounced: will not upload more than once every 2 minutes.
   */
  async uploadSession(authDir) {
    if (!config.hfToken || !config.hfDataset) return;
    if (!fs.existsSync(authDir)) return;

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

      const files = fs.readdirSync(authDir).filter(f => f !== 'session.tar.gz');
      if (files.length === 0) return;

      const tarLocalPath = path.join(authDir, 'session.tar.gz');

      try {
        const { execSync } = await import('child_process');
        
        // Compress the directory contents into session.tar.gz (excluding existing tar to prevent recursion)
        execSync(`tar -czf session.tar.gz --exclude=session.tar.gz .`, { cwd: authDir });
        
        const fileBuffer = fs.readFileSync(tarLocalPath);
        
        await uploadFiles({
          repo: { type: 'dataset', name: config.hfDataset },
          accessToken: config.hfToken,
          files: [{
            path: `${SESSION_FOLDER_IN_HF}/session.tar.gz`,
            content: new Blob([fileBuffer])
          }],
          commitTitle: `Update WhatsApp session (${files.length} files compressed)`
        });

        // Clean up the local tarball after upload
        fs.unlinkSync(tarLocalPath);

        logger.info(`[SessionSync] ✅ Session compressed and synced to HF (${(fileBuffer.length / 1024).toFixed(1)} KB).`);
      } catch (err) {
        logger.error(`[SessionSync] Failed to upload session to HF: ${err.message}`);
        if (fs.existsSync(tarLocalPath)) fs.unlinkSync(tarLocalPath);
      }
    }, delay);
  },

  /**
   * Delete all WhatsApp session files from HF Dataset.
   * Called when the bot is permanently logged out to prevent
   * the restart loop of re-downloading an invalid session.
   */
  async clearSession() {
    if (!config.hfToken || !config.hfDataset) return;

    logger.info('[SessionSync] 🗑️  Clearing invalid session from HuggingFace...');

    try {
      const files = await getSessionFileList();
      if (files.length === 0) {
        logger.info('[SessionSync] No session files found on HF to clear.');
        return;
      }

      // HuggingFace Hub API: delete files by uploading an empty commit with deletions
      const { deleteFiles } = await import('@huggingface/hub');
      await deleteFiles({
        repo: { type: 'dataset', name: config.hfDataset },
        accessToken: config.hfToken,
        paths: files,
        commitTitle: 'Clear invalidated WhatsApp session'
      });

      logger.info(`[SessionSync] ✅ Cleared ${files.length} session file(s) from HuggingFace.`);
    } catch (err) {
      // deleteFiles might not be available in older versions — fallback: overwrite with empty marker
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
        logger.info('[SessionSync] ✅ Placed session-cleared marker on HuggingFace.');
      } catch (fallbackErr) {
        logger.error(`[SessionSync] Could not clear HF session: ${fallbackErr.message}`);
      }
    }
  },

  /**
   * Download the SQLite database file from HF Dataset to local path.
   * Called once at startup BEFORE initDatabase so the persisted DB is used.
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
   * Debounced: will not upload more than once every 2 minutes.
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
   * Use for critical operations like approve/delete where data loss is unacceptable.
   */
  async forceUploadDatabase() {
    if (!config.hfToken || !config.hfDataset) return;
    if (!fs.existsSync(config.dbPath)) return;

    // Cancel any pending debounced upload
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
