import { makeWASocket, useMultiFileAuthState, DisconnectReason, getAggregateVotesInPollMessage, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { handleMessage } from './handlers.js';
import logger from '../utils/logger.js';
import { hfSessionSync } from '../services/hfSessionSync.js';
import { config } from '../config/index.js';

export const msgStore = new Map();

export let latestQr = null;
export let latestPairingCode = null;
export let isConnected = false;
let isRequestingPairing = false;

// ─── Module-level state (persists across reconnections) ──────────────────────
let reconnectAttempt = 0;
let consecutive405Count = 0;
const MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000; // max 5 minutes
const MAX_405_BEFORE_LONG_WAIT = 3;

// Cached auth state — created ONCE, reused for all reconnections
let cachedAuthDir = null;
let cachedState = null;
let cachedSaveCreds = null;
let isFirstBoot = true;

export const client = {
  /**
   * First boot: download session, create auth state, connect.
   * Called only ONCE at startup.
   */
  initialize: async () => {
    const fs = await import('fs');
    const path = await import('path');
    const authDir = process.env.AUTH_DIR || path.default.join(process.cwd(), '.baileys_auth');
    cachedAuthDir = authDir;

    // Download saved session from Hugging Face (only on first boot)
    if (isFirstBoot) {
      await hfSessionSync.downloadSession(authDir);
      isFirstBoot = false;
    }

    let { state, saveCreds } = await useMultiFileAuthState(authDir);

    // ─── Session Health Check ──────────────────────────────────────────────
    const isRegistered = state?.creds?.registered === true;
    const hasAccountInfo = !!state?.creds?.account;
    const meId = state?.creds?.me?.id || null;

    logger.info(`[SessionCheck] registered=${isRegistered}, hasAccount=${hasAccountInfo}, me=${meId || 'unknown'}`);

    // Auto-heal corrupted sessions
    if (!isRegistered && hasAccountInfo) {
      logger.warn('[SessionCheck] ⚠️  Corrupted session detected. Auto-healing…');
      try {
        const fsCheck = await import('fs');
        const pathCheck = await import('path');
        const sessionFiles = fsCheck.default.readdirSync(authDir);
        for (const f of sessionFiles) {
          fsCheck.default.unlinkSync(pathCheck.default.join(authDir, f));
        }
        logger.info(`[SessionCheck] ✅ Cleared ${sessionFiles.length} corrupted session files.`);
      } catch (clearErr) {
        logger.warn(`[SessionCheck] Could not clear: ${clearErr.message}`);
      }
      await hfSessionSync.clearSession();
      const freshAuth = await useMultiFileAuthState(authDir);
      state = freshAuth.state;
      saveCreds = freshAuth.saveCreds;
      logger.info('[SessionCheck] 🔄 Fresh auth state created.');
    } else if (!isRegistered) {
      logger.warn('[SessionCheck] ⚠️  No session. QR/Pairing code will be generated.');
    } else {
      logger.info(`[SessionCheck] ✅ Valid session for ${meId}. Connecting…`);
    }

    // Cache the auth state for reconnections
    cachedState = state;
    cachedSaveCreds = saveCreds;

    // Start the actual connection
    await client._connect();
  },

  /**
   * Internal: Create socket and connect using cached auth state.
   * This is called for BOTH initial connection and reconnections.
   * It does NOT re-download session or re-create auth state.
   */
  _connect: async () => {
    const authDir = cachedAuthDir;
    const state = cachedState;
    const saveCreds = cachedSaveCreds;

    // Fetch the latest WhatsApp Web version to prevent 405 Connection Failure
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info(`[Connection] Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      syncFullHistory: false,
      markOnlineOnConnect: true,
      keepAliveIntervalMs: 15000,
      browser: ['Mac OS', 'Safari', '17.5'],
      retryRequestDelayMs: 2000,
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

    // ─── Reconnection helpers ──────────────────────────────────────────────

    function scheduleReconnect() {
      // Exponential backoff: 10s, 20s, 40s, 80s, 160s, 300s (max 5 min)
      const delay = Math.min(10000 * Math.pow(2, reconnectAttempt), MAX_RECONNECT_DELAY_MS);
      reconnectAttempt++;
      logger.warn(`[Reconnect] Attempt #${reconnectAttempt} scheduled in ${Math.round(delay / 1000)}s…`);
      setTimeout(() => {
        // IMPORTANT: use _connect(), NOT initialize()
        // This reuses the same auth state instead of creating new credentials
        client._connect();
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
        isConnected = false;
        const statusCode = (lastDisconnect?.error)?.output?.statusCode;
        const errorMessage = lastDisconnect?.error?.message || 'unknown';
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        logger.warn(`[Connection] Closed — statusCode=${statusCode || 'unknown'}, error="${errorMessage}", willReconnect=${shouldReconnect}`);

        // ─── Detect repeated 405 failures ──────────────────────────────────
        if (statusCode === 405) {
          consecutive405Count++;
          logger.warn(`[Connection] 405 failure count: ${consecutive405Count}/${MAX_405_BEFORE_LONG_WAIT}`);
          
          if (consecutive405Count >= MAX_405_BEFORE_LONG_WAIT) {
            // Don't clear session or restart — just wait much longer
            const longWait = 5 * 60 * 1000; // 5 minutes
            logger.warn(`[Connection] ⏳ Too many 405s. Waiting ${longWait / 60000} minutes before next attempt…`);
            consecutive405Count = 0;
            reconnectAttempt = 0;
            setTimeout(() => client._connect(), longWait);
            return;
          }
        } else {
          consecutive405Count = 0;
        }
        // ────────────────────────────────────────────────────────────────────

        if (shouldReconnect) {
          scheduleReconnect();
        } else {
          logger.error('[Connection] ❌ Logged out permanently. Clearing session…');
          logger.warn('[Connection] ❌ Bot logged out. Socket is closed.');

          // Clear invalid session from HuggingFace
          await hfSessionSync.clearSession();

          latestPairingCode = null;
          latestQr = null;
          isRequestingPairing = false;
          
          // Clear local session files
          try {
            const fs = await import('fs');
            const path = await import('path');
            const files = fs.default.readdirSync(authDir);
            for (const f of files) {
              fs.default.unlinkSync(path.default.join(authDir, f));
            }
            logger.info('[Connection] Local session files cleared.');
          } catch (e) {
            logger.warn(`[Connection] Could not clear session files: ${e.message}`);
          }
          
          // Full re-initialize (need new auth state after logout)
          isFirstBoot = true;
          setTimeout(() => client.initialize(), 5000);
        }
      } else if (connection === 'open') {
        // Reset everything on successful connection
        reconnectAttempt = 0;
        consecutive405Count = 0;
        isConnected = true;
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
