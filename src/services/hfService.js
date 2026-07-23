import { uploadFiles } from '@huggingface/hub';
import fs from 'fs';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

export const hfService = {
  /**
   * Upload a local file to the Hugging Face Dataset repository.
   * @param {string} localPath - Absolute local file path
   * @param {string} pathInRepo - Path inside the dataset repository (e.g. 'books/pdf/uuid.pdf')
   * @returns {Promise<string>} - Resolve/Download URL of the uploaded file
   */
  async uploadFile(localPath, pathInRepo) {
    // Validate config keys
    if (!config.hfToken || config.hfToken.startsWith('hf_placeholder')) {
      throw new Error('Hugging Face Access Token is not set. Please provide a valid HF_TOKEN in your .env file.');
    }
    if (!config.hfDataset || config.hfDataset.includes('your_username')) {
      throw new Error('Hugging Face Dataset name is not configured. Please set HF_DATASET in your .env file.');
    }

    logger.info(`Starting upload to Hugging Face: ${localPath} -> ${pathInRepo}`);

    try {
      // Read file content
      const fileBuffer = fs.readFileSync(localPath);
      // Create a web Blob object from buffer (supported natively in Node.js 18+)
      const fileBlob = new Blob([fileBuffer]);

      // Call HF Upload API
      await uploadFiles({
        repo: {
          type: 'dataset',
          name: config.hfDataset
        },
        accessToken: config.hfToken,
        files: [
          {
            path: pathInRepo,
            content: fileBlob
          }
        ]
      });

      // Construct direct access URL
      const downloadUrl = `https://huggingface.co/datasets/${config.hfDataset}/resolve/main/${pathInRepo}`;
      logger.info(`Hugging Face upload successful. Direct URL: ${downloadUrl}`);
      return downloadUrl;
    } catch (err) {
      logger.error(`Failed to upload file to Hugging Face Hub: ${err.message}`);
      throw err;
    }
  }
};
