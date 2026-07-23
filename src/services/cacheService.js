import { dbService } from './dbService.js';
import logger from '../utils/logger.js';

// Internal memory array to hold all audios
let audiosCache = [];
let refreshIntervalId = null;

export const cacheService = {
  /**
   * Initialize cache on startup and schedule auto-refresh every 10 minutes.
   */
  async init() {
    logger.info('Initializing Audios Cache...');
    await this.refresh();

    // Auto-refresh interval (10 minutes = 600,000 ms)
    if (refreshIntervalId) {
      clearInterval(refreshIntervalId);
    }
    refreshIntervalId = setInterval(async () => {
      logger.info('Auto-refreshing audios cache...');
      try {
        await this.refresh();
      } catch (err) {
        logger.error(`Auto-refresh of cache failed: ${err.message}`);
      }
    }, 600000);
  },

  /**
   * Fetch all audios from the database and update cache in memory.
   * Call this manually when an audio is approved or deleted.
   */
  async refresh() {
    try {
      const audios = await dbService.getAllAudios();
      audiosCache = audios;
      logger.info(`Audios Cache refreshed. Total audios: ${audiosCache.length}`);
    } catch (err) {
      logger.error(`Failed to refresh audios cache: ${err.message}`);
      throw err;
    }
  },

  /**
   * Return the array of cached audios
   * @returns {Array<object>}
   */
  getBooks() {
    // Kept as getBooks() for compatibility with searchService and other callers
    return audiosCache;
  },

  /**
   * Stop the scheduled interval (useful for clean shutdown or rebuilds)
   */
  destroy() {
    if (refreshIntervalId) {
      clearInterval(refreshIntervalId);
      refreshIntervalId = null;
    }
  }
};
