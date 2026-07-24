import fs from 'fs';
import path from 'path';
import https from 'https';
import { uploadFiles } from '@huggingface/hub';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

const SESSION_FOLDER_IN_HF = 'whatsapp_session';

/**
 * Download a single file from Hugging Face Dataset into local path.
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const token = config.hfToken;
    const options = {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    };

    https.get(url, options, (res) => {
      // Follow redirects (HF uses 302)
      if (res.statusCode === 302 || res.statusCode === 301) {
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode === 404) {
        return resolve(false); // File not found is OK (first run)
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
      }
      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on('finish', () => { fileStream.close(); resolve(true); });
      fileStream.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Get list of session files stored in HF Dataset.
 */
async function getSessionFileList() {
  return new Promise((resolve) => {
    const url = `https://huggingface.co/api/datasets/${config.hfDataset}/tree/main/${SESSION_FOLDER_IN_HF}`;
    const options = {
      headers: {
        Authorization: `Bearer ${config.hfToken}`,
        'Content-Type': 'application/json'
      }
    };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const files = JSON.parse(data);
            resolve(files.filter(f => f.type === 'file').map(f => f.path));
          } catch {
            resolve([]);
          }
        } else {
          resolve([]); // Folder doesn't exist yet
        }
      });
    }).on('error', () => resolve([]));
  });
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
   * Called after successful WhatsApp connection and on creds.update.
   */
  async uploadSession(authDir) {
    if (!config.hfToken || !config.hfDataset) return;
    if (!fs.existsSync(authDir)) return;

    const files = fs.readdirSync(authDir);
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

      logger.info(`[SessionSync] ✅ Uploaded ${files.length} session files to HF Dataset.`);
    } catch (err) {
      logger.error(`[SessionSync] Failed to upload session to HF: ${err.message}`);
    }
  }
};
