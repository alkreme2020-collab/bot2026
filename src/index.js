import express from 'express';
import QRCode from 'qrcode';
import { initDatabase } from './database/connection.js';
import { cacheService } from './services/cacheService.js';
import { client, latestQr, latestPairingCode } from './bot/client.js';
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
    if (!latestQr && !latestPairingCode) {
      return res.send(`
        <!DOCTYPE html>
        <html lang="ar" dir="rtl">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="refresh" content="5">
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
 * Bootstrap the entire application.
 */
async function startApp() {
  try {
    logger.info('Bootstrapping Arabic WhatsApp Book Library (Version 2.0)...');

    // 1. Initialize Database connection and verify schemas
    await initDatabase();

    // 2. Initialize in-memory Books Cache index
    await cacheService.init();

    // 3. Start HTTP Express Server (Used for keep-alive health pings)
    app.listen(config.port, () => {
      logger.info(`Express health server listening on port ${config.port}`);
    });

    // 4. Connect to WhatsApp Web
    logger.info('Connecting to WhatsApp Web interface...');
    await client.initialize();

  } catch (err) {
    logger.error(`Fatal error during application startup: ${err.stack}`);
    process.exit(1);
  }
}

// Handle termination signals
process.on('SIGINT', async () => {
  logger.info('SIGINT signal received. Closing resources...');
  cacheService.destroy();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM signal received. Closing resources...');
  cacheService.destroy();
  process.exit(0);
});

// Start application
startApp();
