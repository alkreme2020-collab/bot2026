import express from 'express';
import { initDatabase } from './database/connection.js';
import { cacheService } from './services/cacheService.js';
import { client, latestQr, latestPairingCode } from './bot/client.js';
import { config } from './config/index.js';
import logger from './utils/logger.js';

const app = express();

// Base health check status endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    systemTime: new Date().toISOString(),
    booksInCache: cacheService.getBooks().length,
    adminEnabled: !!config.adminNumber
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Clean Web QR Code & Pairing Code Endpoint
app.get(['/qr', '/code', '/pair'], (req, res) => {
  const pairingCodeDisplay = latestPairingCode
    ? `<div style="background:#00a884;color:white;padding:15px;border-radius:12px;font-size:28px;font-weight:bold;letter-spacing:4px;margin:20px 0;">${latestPairingCode}</div>
       <p style="color:#e9edef;font-size:14px;">خطوات استخدام كود الربط:<br>1. افتح واتساب على هاتفك ➔ الأجهزة المرتبطة ➔ <b>الربط برقم الهاتف</b><br>2. أدخل الكود الموضح أعلاه.</p>`
    : `<p style="color:#8696a0;">جاري توليد كود الربط بالرقم...</p>`;

  if (!latestQr && !latestPairingCode) {
    return res.send(`
      <html>
        <head><meta http-equiv="refresh" content="5"><title>WhatsApp Pairing</title></head>
        <body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#111b21;color:white;">
          <div style="text-align:center;background:#202c33;padding:35px;border-radius:16px;box-shadow:0 8px 24px rgba(0,0,0,0.4);max-width:450px;">
            <h2 style="color:#00a884;">✅ البوت متصل ومفعل بنجاح!</h2>
            <p style="color:#8696a0;">إذا لم يكن متصلاً، يرجى الانتظار ثوانٍ معدودة لتوليد كود الربط أو QR جديد...</p>
          </div>
        </body>
      </html>
    `);
  }

  const qrImageUrl = latestQr ? `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(latestQr)}` : '';

  res.send(`
    <html>
      <head><meta http-equiv="refresh" content="10"><title>WhatsApp Pairing Code</title></head>
      <body style="display:flex;justify-content:center;align-items:center;min-height:100vh;font-family:sans-serif;background:#111b21;color:white;margin:0;padding:20px;">
        <div style="text-align:center;background:#202c33;padding:35px;border-radius:16px;box-shadow:0 8px 24px rgba(0,0,0,0.4);max-width:450px;width:100%;">
          <h2 style="color:#00a884;margin-bottom:10px;">🔑 ربط البوت بالواتساب</h2>
          
          <!-- Pairing Code Section -->
          <div style="margin-bottom:30px;border-bottom:1px solid #374248;padding-bottom:20px;">
            <h3 style="color:#e9edef;margin-bottom:5px;">كود الربط برقم الهاتف:</h3>
            ${pairingCodeDisplay}
          </div>

          <!-- QR Code Section -->
          ${latestQr ? `
          <div>
            <h4 style="color:#8696a0;margin-bottom:10px;">أو مسح الـ QR Code:</h4>
            <img src="${qrImageUrl}" alt="WhatsApp QR Code" style="border:8px solid white;border-radius:12px;width:220px;height:220px;"/>
          </div>` : ''}

          <p style="color:#8696a0;font-size:12px;margin-top:20px;">يتجدد الكود تلقائياً كل 10 ثوانٍ عند الحاجة</p>
        </div>
      </body>
    </html>
  `);
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
