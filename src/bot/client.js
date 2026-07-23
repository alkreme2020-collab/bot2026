import { makeWASocket, useMultiFileAuthState, DisconnectReason, getAggregateVotesInPollMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { handleMessage } from './handlers.js';
import logger from '../utils/logger.js';

export const msgStore = new Map();

export let latestQr = null;

export const client = {
  initialize: async () => {
    const authDir = process.env.AUTH_DIR || '/tmp/baileys_auth';
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

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

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        latestQr = qr;
        logger.info('WhatsApp QR Code generated. Please scan it:');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
        logger.warn(`WhatsApp connection closed. Reconnecting: ${shouldReconnect}`);
        if (shouldReconnect) {
          client.initialize();
        }
      } else if (connection === 'open') {
        latestQr = null;
        logger.info('WhatsApp Bot Client is fully authenticated and READY!');
      }
    });

    sock.ev.on('creds.update', saveCreds);

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
