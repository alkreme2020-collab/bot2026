import { makeWASocket, useMultiFileAuthState, DisconnectReason, getAggregateVotesInPollMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { handleMessage } from './handlers.js';
import logger from '../utils/logger.js';
import { hfSessionSync } from '../services/hfSessionSync.js';
import { config } from '../config/index.js';

export const msgStore = new Map();

export let latestQr = null;
export let latestPairingCode = null;
let isRequestingPairing = false;

export const client = {
  initialize: async () => {
    const authDir = process.env.AUTH_DIR || '/app/.baileys_auth';

    // Download saved session from Hugging Face before initializing (if available)
    await hfSessionSync.downloadSession(authDir);

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    // ─── Session Health Check ──────────────────────────────────────────────
    const isRegistered = state?.creds?.registered === true;
    const hasAccountInfo = !!state?.creds?.account;
    const meId = state?.creds?.me?.id || null;

    logger.info(`[SessionCheck] registered=${isRegistered}, hasAccount=${hasAccountInfo}, me=${meId || 'unknown'}`);

    if (!isRegistered) {
      logger.warn('[SessionCheck] ⚠️  Session is NOT registered. A new QR/Pairing code will be required.');
      logger.warn('[SessionCheck] → Open the bot URL on Render and scan the QR or use the pairing code.');
    } else {
      logger.info(`[SessionCheck] ✅ Valid session found for ${meId}. Connecting…`);
    }
    // ──────────────────────────────────────────────────────────────────────

    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      syncFullHistory: false,
      markOnlineOnConnect: true,
      keepAliveIntervalMs: 15000,
      browser: ['Ubuntu', 'Chrome', '110.0.5481.77'],
      getMessage: async (key) => {
        if (key && key.id) {
          const msg = msgStore.get(key.id);
          logger.info(`getMessage called for ID ${key.id}. Found in store: ${!!msg}`);
          return msg || undefined;
        }
        return undefined;
      }
    });

    // Request Pairing Code ONCE if BOT_NUMBER is provided and not registered yet
    let rawNumber = process.env.BOT_NUMBER || process.env.PAIRING_NUMBER;
    if (rawNumber && !state.creds.registered && !isRequestingPairing && !latestPairingCode) {
      const cleanNumber = rawNumber.replace(/[^0-9]/g, '');
      if (cleanNumber) {
        isRequestingPairing = true;
        setTimeout(async () => {
          try {
            if (!state.creds.registered) {
              const code = await sock.requestPairingCode(cleanNumber);
              latestPairingCode = code;
              logger.info('====================================================');
              logger.info(`YOUR WHATSAPP PAIRING CODE IS: [ ${code} ]`);
              logger.info('====================================================');
            }
          } catch (err) {
            logger.error(`Error generating pairing code: ${err.stack || err.message}`);
          } finally {
            isRequestingPairing = false;
          }
        }, 4000);
      }
    }

    // ─── Reconnection backoff state ────────────────────────────────────────
    let reconnectAttempt = 0;
    const MAX_RECONNECT_DELAY_MS = 60000; // max 1 minute

    function scheduleReconnect() {
      // Exponential backoff: 3s, 6s, 12s, 24s, 48s, 60s…
      const delay = Math.min(3000 * Math.pow(2, reconnectAttempt), MAX_RECONNECT_DELAY_MS);
      reconnectAttempt++;
      logger.warn(`[Reconnect] Attempt #${reconnectAttempt} scheduled in ${Math.round(delay / 1000)}s…`);
      setTimeout(() => {
        client.initialize();
      }, delay);
    }
    // ──────────────────────────────────────────────────────────────────────

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        latestQr = qr;
        logger.info('[Connection] QR Code generated — waiting for scan.');
        qrcode.generate(qr, { small: true }, (qrString) => {
          console.log('\n================ WhatsApp QR Code ================\n' + qrString + '\n==================================================\n');
        });
      }

      if (connection === 'connecting') {
        logger.info('[Connection] Connecting to WhatsApp servers…');
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error)?.output?.statusCode;
        const errorMessage = lastDisconnect?.error?.message || 'unknown';
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        logger.warn(`[Connection] Closed — statusCode=${statusCode || 'unknown'}, error="${errorMessage}", willReconnect=${shouldReconnect}`);

        if (shouldReconnect) {
          scheduleReconnect();
        } else {
          logger.error('[Connection] ❌ Logged out permanently. Clearing session to allow fresh login…');

          // ─── Notify admin on Telegram-style WhatsApp alert ─────────────
          // Try to send a WhatsApp message to admin before session is cleared
          if (config.adminNumber) {
            try {
              const adminJid = `${config.adminNumber}@s.whatsapp.net`;
              await sock.sendMessage(adminJid, {
                text: `⚠️ *تنبيه عاجل — البوت تم تسجيل خروجه!*\n\n` +
                      `تم فصل البوت من واتساب بشكل نهائي.\n` +
                      `📌 *الإجراء المطلوب:*\n` +
                      `افتح الرابط التالي وأعد ربط الحساب:\n` +
                      `https://bot2026-yzln.onrender.com`
              });
              logger.info('[Connection] Admin logout alert sent successfully.');
            } catch (alertErr) {
              logger.warn(`[Connection] Could not send admin logout alert: ${alertErr.message}`);
            }
          }
          // ────────────────────────────────────────────────────────────────

          // ─── Clear invalid session from HuggingFace FIRST ───────────────
          // This prevents the restart loop: invalid HF session → download → reject → loop
          await hfSessionSync.clearSession();
          // ────────────────────────────────────────────────────────────────

          latestPairingCode = null;
          latestQr = null;
          isRequestingPairing = false;
          // Clear the stale local session so the next boot forces a new QR
          try {
            const fs = await import('fs');
            const path = await import('path');
            const files = fs.default.readdirSync(authDir);
            for (const f of files) {
              fs.default.unlinkSync(path.default.join(authDir, f));
            }
            logger.info('[Connection] Local session files cleared. Restarting…');
          } catch (e) {
            logger.warn(`[Connection] Could not clear session files: ${e.message}`);
          }
          setTimeout(() => client.initialize(), 3000);
        }
      } else if (connection === 'open') {
        // Reset backoff on successful connection
        reconnectAttempt = 0;
        latestQr = null;
        latestPairingCode = null;
        isRequestingPairing = false;
        logger.info('✅✅✅ WhatsApp Bot Client is fully authenticated and READY! ✅✅✅');
        logger.info(`[Connection] Connected as: ${sock.user?.id || 'unknown'}`);

        // Show bot as online/available
        try {
          await sock.sendPresenceUpdate('available');
        } catch (e) {
          logger.warn(`Could not set presence: ${e.message}`);
        }

        // ─── Notify admin on successful connection ───────────────────────
        if (config.adminNumber) {
          try {
            const adminJid = `${config.adminNumber}@s.whatsapp.net`;
            const now = new Date().toLocaleString('ar-YE', { timeZone: 'Asia/Aden' });
            await sock.sendMessage(adminJid, {
              text: `✅ *البوت متصل ويعمل بشكل طبيعي*\n\n` +
                    `🕐 وقت الاتصال: ${now}\n` +
                    `📱 الحساب: ${sock.user?.id || 'غير محدد'}`
            });
            logger.info('[Connection] Admin connect notification sent.');
          } catch (notifyErr) {
            logger.warn(`[Connection] Could not send admin connect notification: ${notifyErr.message}`);
          }
        }
        // ────────────────────────────────────────────────────────────────

        // Upload session to HF immediately after successful connection
        await hfSessionSync.uploadSession(authDir);
      }
    });

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      // Sync updated credentials to HF Dataset for persistence
      await hfSessionSync.uploadSession(authDir);
    });

    sock.ev.on('messages.upsert', async (m) => {
      try {
        if (m.type === 'notify' || m.type === 'append') {
          for (let msg of m.messages) {
            // Store all messages so getMessage can resolve poll creation keys for decryption
            if (msg.key?.id && msg.message) {
              msgStore.set(msg.key.id, msg.message);
              logger.info(`Stored message in msgStore. ID: ${msg.key.id}, Keys: ${Object.keys(msg.message).join(', ')}`);
              // Maintain max size 500 in msgStore to avoid memory growth
              if (msgStore.size > 500) {
                const firstKey = msgStore.keys().next().value;
                msgStore.delete(firstKey);
              }
            }

            // Ignore protocol messages or status broadcast
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;

            if (!msg.key.fromMe) {
              await handleMessage(sock, msg);
            } else {
              // Self message testing
              const myJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
              if (msg.key.remoteJid === myJid) {
                await handleMessage(sock, msg);
              }
            }
          }
        }
      } catch (err) {
        logger.error(`Unhandled error inside client message loop: ${err.stack || err.message}`);
      }
    });

    sock.ev.on('messages.update', async (updates) => {
      for (const { key, update } of updates) {
        try {
          if (!update.pollUpdates?.length) continue;

          const pollCreation = key?.id ? msgStore.get(key.id) : null;
          if (!pollCreation) {
            logger.warn(`Poll update received but poll creation message was not found. ID: ${key?.id || 'unknown'}`);
            continue;
          }

          const aggregation = getAggregateVotesInPollMessage({
            message: pollCreation,
            pollUpdates: update.pollUpdates
          });

          const selected = aggregation.find(option => option.voters?.length > 0);
          const selectedName = selected?.name?.trim();
          if (!selectedName || selectedName === 'Unknown') {
            logger.warn(`Poll update received but selected option could not be resolved. ID: ${key?.id || 'unknown'}`);
            continue;
          }

          logger.info(`Resolved poll selection "${selectedName}" for chat ${key.remoteJid}`);
          await handleMessage(sock, {
            key: {
              remoteJid: key.remoteJid,
              fromMe: false,
              id: `poll_${Date.now()}_${Math.random().toString(36).slice(2)}`
            },
            message: {
              conversation: selectedName
            },
            messageTimestamp: Math.floor(Date.now() / 1000),
            pushName: 'مستخدم واتساب',
            isPollSelection: true
          });
        } catch (err) {
          logger.error(`Error handling poll update: ${err.stack || err.message}`);
        }
      }
    });
  }
};
