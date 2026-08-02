import express from 'express';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { initDatabase, closeDatabase } from './database/connection.js';
import { cacheService } from './services/cacheService.js';
import { client, latestQr, latestPairingCode, isConnected } from './bot/client.js';
import { hfSessionSync } from './services/hfSessionSync.js';
import { sessionService } from './services/sessionService.js';
import { dbService } from './services/dbService.js';
import { cleanupHandlerMaps } from './bot/handlers.js';
import { config } from './config/index.js';
import logger from './utils/logger.js';

const app = express();

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Clean Web QR Code & Pairing Code Endpoint
app.get(['/', '/qr', '/code', '/pair'], async (req, res) => {
  try {
    // Case 1: Bot is fully connected
    if (isConnected && !latestQr && !latestPairingCode) {
      return res.send(`
        <!DOCTYPE html>
        <html lang="ar" dir="rtl">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>حالة بوت الواتساب</title>
            <style>
              body { display: flex; justify-content: center; align-items: center; min-height: 100vh; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #111b21; color: white; margin: 0; }
              .card { text-align: center; background: #202c33; padding: 40px; border-radius: 16px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); max-width: 420px; width: 90%; }
              h2 { color: #00a884; margin-bottom: 12px; }
              p { color: #8696a0; font-size: 15px; }
            </style>
          </head>
          <body>
            <div class="card">
              <h2>✅ البوت متصل ومفعل بنجاح!</h2>
              <p>البوت يعمل الآن ومستعد لاستقبال الرسائل.<br>إذا انقطع الاتصال، سيظهر رمز QR وكود الربط هنا تلقائياً.</p>
            </div>
          </body>
        </html>
      `);
    }

    // Case 2: Not connected and no QR yet — bot is trying to connect
    if (!latestQr && !latestPairingCode) {
      return res.send(`
        <!DOCTYPE html>
        <html lang="ar" dir="rtl">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="refresh" content="10">
            <title>جاري الاتصال...</title>
            <style>
              body { display: flex; justify-content: center; align-items: center; min-height: 100vh; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #111b21; color: white; margin: 0; }
              .card { text-align: center; background: #202c33; padding: 40px; border-radius: 16px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); max-width: 420px; width: 90%; }
              h2 { color: #e6a817; margin-bottom: 12px; }
              p { color: #8696a0; font-size: 15px; }
              .spinner { border: 4px solid #2a3942; border-top: 4px solid #e6a817; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 15px auto; }
              @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            </style>
          </head>
          <body>
            <div class="card">
              <div class="spinner"></div>
              <h2>⏳ جاري الاتصال بسيرفرات واتساب...</h2>
              <p>البوت يحاول الاتصال. سيظهر رمز QR أو كود الربط هنا تلقائياً عند نجاح الاتصال بالسيرفر.<br><br>يتم تحديث الصفحة تلقائياً كل 10 ثوانٍ.</p>
            </div>
          </body>
        </html>
      `);
    }

    // Generate native PNG Data URL for QR Code
    let qrImageDataUrl = '';
    if (latestQr) {
      qrImageDataUrl = await QRCode.toDataURL(latestQr, { margin: 2, width: 260 });
    }

    res.send(`
      <!DOCTYPE html>
      <html lang="ar" dir="rtl">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="refresh" content="10">
          <title>ربط بوت الواتساب</title>
          <style>
            body { display: flex; justify-content: center; align-items: center; min-height: 100vh; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #111b21; color: white; margin: 0; padding: 20px; box-sizing: border-box; }
            .card { text-align: center; background: #202c33; padding: 30px; border-radius: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.6); max-width: 440px; width: 100%; border: 1px solid #2a3942; }
            h2 { color: #00a884; margin-top: 0; font-size: 24px; }
            .code-box { background: #00a884; color: #111b21; padding: 14px 20px; border-radius: 12px; font-size: 32px; font-weight: bold; letter-spacing: 6px; margin: 15px 0; display: inline-block; font-family: monospace; }
            .instructions { color: #e9edef; font-size: 14px; text-align: right; background: #111b21; padding: 15px; border-radius: 10px; margin-bottom: 20px; line-height: 1.6; }
            .qr-container { background: white; padding: 12px; border-radius: 16px; display: inline-block; margin-top: 10px; }
            .qr-container img { display: block; border-radius: 8px; }
            .footer { color: #8696a0; font-size: 12px; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>🔑 ربط حساب الواتساب</h2>
            
            ${latestPairingCode ? `
              <div style="margin-bottom: 20px;">
                <h3 style="color:#e9edef;margin-bottom:5px;font-size:16px;">طريقة 1: كود الربط السريع</h3>
                <div class="code-box">${latestPairingCode}</div>
                <div class="instructions">
                  <b>خطوات الربط بالرقم:</b><br>
                  1. افتح تطبيق واتساب على هاتفك.<br>
                  2. اذهب إلى <b>الأجهزة المرتبطة</b> ➔ <b>ربط جهاز</b>.<br>
                  3. اضغط في الأسفل على <b>الربط برقم الهاتف بدلاً من ذلك</b>.<br>
                  4. ادخل الكود الظاهر أعلاه.
                </div>
              </div>
            ` : ''}

            ${qrImageDataUrl ? `
              <div style="margin-top: 15px;">
                <h3 style="color:#e9edef;margin-bottom:10px;font-size:16px;">طريقة 2: مسح الـ QR Code</h3>
                <div class="qr-container">
                  <img src="${qrImageDataUrl}" width="240" height="240" alt="WhatsApp QR Code" />
                </div>
              </div>
            ` : ''}

            <div class="footer">يتم تحديث الصفحة تلقائياً كل 10 ثوانٍ</div>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Error generating QR code page: ' + err.message);
  }
});

/**
 * Graceful shutdown: close DB, sync to HF, and stop services.
 * @param {string} signal - The signal that triggered the shutdown
 */
async function gracefulShutdown(signal) {
  logger.info(`${signal} signal received. Starting graceful shutdown...`);

  // 1. Stop periodic cleanups
  cacheService.destroy();
  sessionService.destroy();

  // 2. Force upload latest database to HF before shutting down
  try {
    logger.info('[Shutdown] Uploading latest database to HF...');
    await hfSessionSync.forceUploadDatabase();
    logger.info('[Shutdown] Database synced to HF successfully.');
  } catch (err) {
    logger.error(`[Shutdown] Failed to sync database to HF: ${err.message}`);
  }

  // 3. Close database connection
  try {
    await closeDatabase();
  } catch (err) {
    logger.error(`[Shutdown] Failed to close database: ${err.message}`);
  }

  logger.info('[Shutdown] Graceful shutdown complete. Exiting.');
  process.exit(0);
}

/**
 * Bootstrap the entire application.
 */
async function startApp() {
  try {
    logger.info('Bootstrapping Arabic WhatsApp Audio Library (Version 2.0)...');

    // 0. Ensure necessary directories exist
    const dirsToCreate = ['temp', 'uploads'];
    for (const dir of dirsToCreate) {
      const dirPath = path.join(config.rootDir, dir);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        logger.info(`Created missing directory: ${dirPath}`);
      }
    }

    // 1. Download persisted database from Hugging Face (if available)
    await hfSessionSync.downloadDatabase();

    // 2. Initialize Database connection and verify schemas
    await initDatabase();

    // 3. Upload database immediately to ensure HF has the latest copy
    await hfSessionSync.uploadDatabase();

    // 4. Initialize in-memory Audios Cache index
    await cacheService.init();

    // 5. Initialize session cleanup intervals
    sessionService.init();

    // 6. Start HTTP Express Server (Used for keep-alive health pings)
    app.listen(config.port, () => {
      logger.info(`Express health server listening on port ${config.port}`);

      // ─── Keep-Alive Ping (Prevents Render free-tier sleep) ──────────────
      // Render shuts down free services after 15 minutes of inactivity.
      // We ping our health endpoint every 14 minutes to stay alive.
      // Uses the public RENDER_URL if available (external ping is more reliable).
      const KEEP_ALIVE_INTERVAL_MS = 14 * 60 * 1000; // 14 minutes
      setInterval(async () => {
        try {
          const url = config.renderUrl
            ? `${config.renderUrl}/health`
            : `http://localhost:${config.port}/health`;
          const res = await fetch(url);
          logger.info(`[KeepAlive] Ping OK — url=${url}, status=${res.status}`);
        } catch (err) {
          logger.warn(`[KeepAlive] Ping failed: ${err.message}`);
        }
      }, KEEP_ALIVE_INTERVAL_MS);
      logger.info(`[KeepAlive] Ping enabled every ${KEEP_ALIVE_INTERVAL_MS / 60000} minutes.`);

      // ─── Periodic Database Sync to HF (every 5 minutes) ────────────────
      setInterval(async () => {
        await hfSessionSync.uploadDatabase();
      }, 5 * 60 * 1000);
      logger.info(`[DBSync] Periodic database sync enabled every 5 minutes.`);

      // ─── Periodic Memory Cleanup (every 5 minutes) ─────────────────────
      setInterval(() => {
        try {
          cleanupHandlerMaps();
        } catch (err) {
          logger.warn(`[Cleanup] Handler maps cleanup failed: ${err.message}`);
        }
      }, 5 * 60 * 1000);
      logger.info(`[Cleanup] Periodic memory cleanup enabled every 5 minutes.`);

      // ─── Periodic DB Table Cleanup (every 24 hours) ────────────────────
      setInterval(async () => {
        try {
          const logsDeleted = await dbService.cleanOldLogs(30);
          const downloadsDeleted = await dbService.cleanOldDownloads(90);
          if (logsDeleted > 0 || downloadsDeleted > 0) {
            logger.info(`[Cleanup] DB cleanup: ${logsDeleted} old logs, ${downloadsDeleted} old downloads removed.`);
          }
        } catch (err) {
          logger.warn(`[Cleanup] DB table cleanup failed: ${err.message}`);
        }
      }, 24 * 60 * 60 * 1000);
      logger.info(`[Cleanup] DB table cleanup scheduled every 24 hours.`);
      // ──────────────────────────────────────────────────────────────────────
    });

    // 7. Connect to WhatsApp Web
    logger.info('Connecting to WhatsApp Web interface...');
    await client.initialize();

  } catch (err) {
    logger.error(`Fatal error during application startup: ${err.stack}`);
    process.exit(1);
  }
}

// ─── Global Error Handlers ──────────────────────────────────────────────────
// Prevent the bot from crashing on unhandled errors
process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled Promise Rejection: ${reason?.stack || reason}`);
  // Don't exit — let the bot continue running
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.stack || err.message}`);
  // For truly fatal errors, exit after logging
  if (err.message?.includes('ENOMEM') || err.message?.includes('out of memory')) {
    logger.error('Fatal memory error — exiting.');
    process.exit(1);
  }
  // Otherwise, try to keep running
});
// ──────────────────────────────────────────────────────────────────────────────

// Handle termination signals
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Start application
startApp();
