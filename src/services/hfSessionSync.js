import fs from 'fs';
import path from 'path';
import { uploadFiles } from '@huggingface/hub';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

const SESSION_FOLDER_IN_HF = 'whatsapp_session';

// Debounce: prevent uploading more than once every 2 minutes
let uploadDebounceTimer = null;
let lastUploadTime = 0;
const UPLOAD_DEBOUNCE_MS = 2 * 60 * 1000; // 2 minutes

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
   * Download all WhatsApp session files from HF Dataset to local authDir.
   * Called once at startup before Baileys initializes.
   */
  async downloadSession(authDir) {
    if (!config.hfToken || !config.hfDataset) {
      logger.warn('[SessionSync] HF_TOKEN or HF_DATASET not set — skipping session download.');
      return;
    }

    logger.info('[SessionSync] Checking for saved session on Hugging Face...');
    const files = await getSessionFileList();

    if (files.length === 0) {
      logger.info('[SessionSync] No saved session found on HF. Will start fresh (QR/Pairing needed).');
      return;
    }

    // Ensure local auth directory exists
    fs.mkdirSync(authDir, { recursive: true });

    let downloaded = 0;
    for (const filePath of files) {
      const fileName = path.basename(filePath);
      const localPath = path.join(authDir, fileName);
      const url = `https://huggingface.co/datasets/${config.hfDataset}/resolve/main/${filePath}`;
      try {
        const ok = await downloadFile(url, localPath);
        if (ok) downloaded++;
      } catch (err) {
        logger.error(`[SessionSync] Failed to download ${fileName}: ${err.message}`);
      }
    }

    logger.info(`[SessionSync] ✅ Downloaded ${downloaded}/${files.length} session files from HF.`);
  },

  /**
   * Upload all local session files from authDir to HF Dataset.
   * Debounced: will not upload more than once every 2 minutes.
   */
  async uploadSession(authDir) {
    if (!config.hfToken || !config.hfDataset) return;
    if (!fs.existsSync(authDir)) return;

    // Clear any pending upload timer and schedule a new one
    if (uploadDebounceTimer) {
      clearTimeout(uploadDebounceTimer);
    }

    // If last upload was recent, debounce and wait
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

      const files = fs.readdirSync(authDir).filter(f => {
        try { return fs.statSync(path.join(authDir, f)).isFile(); } catch { return false; }
      });
      if (files.length === 0) return;

      try {
        const filesToUpload = files.map(fileName => {
          const localPath = path.join(authDir, fileName);
          const fileBuffer = fs.readFileSync(localPath);
          return {
            path: `${SESSION_FOLDER_IN_HF}/${fileName}`,
            content: new Blob([fileBuffer])
          };
        });

        await uploadFiles({
          repo: { type: 'dataset', name: config.hfDataset },
          accessToken: config.hfToken,
          files: filesToUpload,
          commitTitle: 'Update WhatsApp session'
        });

        logger.info(`[SessionSync] ✅ Session synced to HF (${files.length} files).`);
      } catch (err) {
        logger.error(`[SessionSync] Failed to upload session to HF: ${err.message}`);
      }
    }, delay);
  }
};
