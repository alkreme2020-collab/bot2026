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

    let { state, saveCreds } = await useMultiFileAuthState(authDir);

    // ─── Session Health Check ──────────────────────────────────────────────
    const isRegistered = state?.creds?.registered === true;
    const hasAccountInfo = !!state?.creds?.account;
    const meId = state?.creds?.me?.id || null;

    logger.info(`[SessionCheck] registered=${isRegistered}, hasAccount=${hasAccountInfo}, me=${meId || 'unknown'}`);

    // ─── Auto-heal corrupted sessions ─────────────────────────────────────
    // If session files exist but registered=false, the session is corrupted.
    // Clear it immediately to avoid the infinite reconnect loop.
    if (!isRegistered && hasAccountInfo) {
      logger.warn('[SessionCheck] ⚠️  Corrupted session detected (hasAccount but NOT registered).');
      logger.warn('[SessionCheck] 🔧 Auto-healing: clearing corrupted session files…');
      
      try {
        const fsCheck = await import('fs');
        const pathCheck = await import('path');
        const sessionFiles = fsCheck.default.readdirSync(authDir);
        for (const f of sessionFiles) {
          fsCheck.default.unlinkSync(pathCheck.default.join(authDir, f));
        }
        logger.info(`[SessionCheck] ✅ Cleared ${sessionFiles.length} corrupted local session files.`);
      } catch (clearErr) {
        logger.warn(`[SessionCheck] Could not clear local session: ${clearErr.message}`);
      }

      // Also clear from HuggingFace so the corrupted session doesn't get re-downloaded
      await hfSessionSync.clearSession();
      logger.info('[SessionCheck] ✅ Corrupted session cleared from HuggingFace.');
      
      // Re-initialize auth state from scratch (empty directory)
      const freshAuth = await useMultiFileAuthState(authDir);
      state = freshAuth.state;
      saveCreds = freshAuth.saveCreds;
      logger.info('[SessionCheck] 🔄 Fresh auth state created. QR/Pairing code will be generated.');
    } else if (!isRegistered) {
      logger.warn('[SessionCheck] ⚠️  No session found. A new QR/Pairing code will be required.');
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
    let consecutive405Count = 0;
    const MAX_RECONNECT_DELAY_MS = 60000; // max 1 minute
    const MAX_405_BEFORE_SESSION_RESET = 3; // after 3 consecutive 405s, clear session

    async function clearAndRestart(reason) {
      logger.warn(`[SessionReset] Resetting session due to: ${reason}`);
      try {
        const fsReset = await import('fs');
        const pathReset = await import('path');
        const files = fsReset.default.readdirSync(authDir);
        for (const f of files) {
          fsReset.default.unlinkSync(pathReset.default.join(authDir, f));
        }
        logger.info(`[SessionReset] Local session cleared (${files.length} files).`);
      } catch (e) {
        logger.warn(`[SessionReset] Could not clear local files: ${e.message}`);
      }
      await hfSessionSync.clearSession();
      latestPairingCode = null;
      latestQr = null;
      isRequestingPairing = false;
      consecutive405Count = 0;
      reconnectAttempt = 0;
      logger.info('[SessionReset] ✅ Session purged. Restarting with fresh QR in 5s…');
      setTimeout(() => client.initialize(), 5000);
    }

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

        // ─── Detect repeated 405 failures (corrupted/expired session) ──────
        if (statusCode === 405) {
          consecutive405Count++;
          logger.warn(`[Connection] 405 failure count: ${consecutive405Count}/${MAX_405_BEFORE_SESSION_RESET}`);
          if (consecutive405Count >= MAX_405_BEFORE_SESSION_RESET) {
            await clearAndRestart('Repeated 405 Connection Failures — session expired or corrupted');
            return;
          }
        } else {
          consecutive405Count = 0; // reset on non-405 errors
        }
        // ────────────────────────────────────────────────────────────────────

        if (shouldReconnect) {
          scheduleReconnect();
        } else {
          logger.error('[Connection] ❌ Logged out permanently. Clearing session to allow fresh login…');

          // Note: Cannot send admin logout alert here — socket is already disconnected.
          logger.warn('[Connection] ❌ Bot logged out. Socket is closed, cannot notify admin via WhatsApp.');

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
              // Maintain max size 300 in msgStore to avoid memory growth
              if (msgStore.size > 300) {
                // Delete oldest 50 entries in batch to reduce frequent deletions
                const keysToDelete = [];
                for (const k of msgStore.keys()) {
                  keysToDelete.push(k);
                  if (keysToDelete.length >= 50) break;
                }
                keysToDelete.forEach(k => msgStore.delete(k));
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
