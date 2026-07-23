import express from 'express';
import { initDatabase } from './database/connection.js';
import { cacheService } from './services/cacheService.js';
import { client } from './bot/client.js';
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
