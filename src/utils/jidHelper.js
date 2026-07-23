import fs from 'fs';
import path from 'path';
import logger from './logger.js';

const AUTH_DIR = path.join(process.cwd(), '.baileys_auth');

/**
 * Resolve a phone number to its correct WhatsApp JID.
 * Checks if there's a LID mapping for the phone number, and if so,
 * returns the LID-based JID. Otherwise returns the standard @s.whatsapp.net JID.
 * @param {string} phone - The phone number (digits only)
 * @returns {string} The WhatsApp JID to use for sending messages
 */
export function phoneToJid(phone) {
  // First try to find a LID mapping for this phone number
  try {
    const lidMappingFile = path.join(AUTH_DIR, `lid-mapping-${phone}.json`);
    if (fs.existsSync(lidMappingFile)) {
      const raw = fs.readFileSync(lidMappingFile, 'utf-8');
      const lidNumber = JSON.parse(raw);
      if (lidNumber) {
        return `${lidNumber}@lid`;
      }
    }
  } catch (err) {
    logger.warn(`Could not resolve phone ${phone} to LID: ${err.message}`);
  }

  // Fallback to standard JID
  return `${phone}@s.whatsapp.net`;
}
