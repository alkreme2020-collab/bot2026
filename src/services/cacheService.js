import { dbService } from './dbService.js';
import logger from '../utils/logger.js';

let audiosCache = [];
let videosCache = [];
let booksCache = [];
let refreshIntervalId = null;

export const cacheService = {
  /**
   * Initialize cache on startup and schedule auto-refresh every 10 minutes.
   */
  async init() {
    logger.info('Initializing Content Caches...');
    await this.refresh();

    if (refreshIntervalId) {
      clearInterval(refreshIntervalId);
    }
    refreshIntervalId = setInterval(async () => {
      logger.info('Auto-refreshing content cache...');
      try {
        await this.refresh();
      } catch (err) {
        logger.error(`Auto-refresh of cache failed: ${err.message}`);
      }
    }, 600000);
  },

  /**
   * Fetch all content from the database and update caches in memory.
   */
  async refresh() {
    try {
      const audios = await dbService.getAllAudios();
      const videos = await dbService.getAllVideos();
      const books = await dbService.getAllBooks();

      audiosCache = audios;
      videosCache = videos;
      booksCache = books;

      logger.info(`Content Cache refreshed. Audios: ${audiosCache.length}, Videos: ${videosCache.length}, Books: ${booksCache.length}`);
    } catch (err) {
      logger.error(`Failed to refresh content cache: ${err.message}`);
      throw err;
    }
  },

  /**
   * Return cached audios array.
   * @returns {Array<object>}
   */
  getAudios() {
    return audiosCache;
  },

  /**
   * Return cached videos array.
   * @returns {Array<object>}
   */
  getVideos() {
    return videosCache;
  },

  /**
   * Return cached books array.
   * @returns {Array<object>}
   */
  getBooks() {
    return booksCache;
  },

  /**
   * Stop scheduled interval.
   */
  destroy() {
    if (refreshIntervalId) {
      clearInterval(refreshIntervalId);
      refreshIntervalId = null;
    }
  }
};
