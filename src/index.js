import express from 'express';
import { initDatabase } from './database/connection.js';
import { cacheService } from './services/cacheService.js';
import { client, latestQr } from './bot/client.js';
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

// Clean Web QR Code Page Endpoint
app.get('/qr', (req, res) => {
  if (!latestQr) {
    return res.send(`
      <html>
        <head><meta http-equiv="refresh" content="5"><title>WhatsApp QR</title></head>
        <body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#f0f2f5;">
          <div style="text-align:center;background:white;padding:30px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.1);">
            <h2>✅ البوت متصل الآن بنجاح!</h2>
            <p>أو أنه يقوم بتوليد رمز QR جديد... جاري التحديث التلقائي كل 5 ثوانٍ.</p>
          </div>
        </body>
      </html>
    `);
  }

  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(latestQr)}`;
  res.send(`
    <html>
      <head><meta http-equiv="refresh" content="15"><title>Scan WhatsApp QR</title></head>
      <body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#111b21;color:white;">
        <div style="text-align:center;background:#202c33;padding:30px;border-radius:16px;box-shadow:0 8px 24px rgba(0,0,0,0.4);">
          <h2 style="color:#00a884;margin-bottom:10px;">امسح الرمز لربط البوت بالواتساب</h2>
          <p style="color:#8696a0;margin-bottom:20px;">قم بفتح واتساب على هاتفك ➔ الأجهزة المرتبطة ➔ مسح الرمز</p>
          <img src="${qrImageUrl}" alt="WhatsApp QR Code" style="border:10px solid white;border-radius:12px;width:300px;height:300px;"/>
          <p style="color:#8696a0;font-size:12px;margin-top:15px;">يتحدث الرمز تلقائياً كل 15 ثانية</p>
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
