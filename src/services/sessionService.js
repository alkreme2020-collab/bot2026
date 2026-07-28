import { config } from '../config/index.js';
import { dbService } from './dbService.js';
import logger from '../utils/logger.js';

// In-memory store for interactive state sessions and message times
const sessions = new Map();
const lastMessageTimes = new Map();
let cleanupIntervalId = null;

export const sessionService = {
  /**
   * Enforce rate limit. Returns true if user sent messages too quickly.
   * @param {string} phone
   * @returns {boolean}
   */
  isRateLimited(phone) {
    const now = Date.now();
    const lastTime = lastMessageTimes.get(phone) || 0;
    
    if (now - lastTime < config.rateLimitMs) {
      logger.warn(`Rate limit triggered for user: ${phone}`);
      return true;
    }
    
    lastMessageTimes.set(phone, now);
    return false;
  },

  /**
   * Check if user is in cooldown period between submitting audios.
   * @param {string} phone
   * @returns {Promise<{isCooldown: boolean, remainingMs: number}>}
   */
  async checkRequestCooldown(phone) {
    try {
      const lastReq = await dbService.getLastRequestByUser(phone);
      if (!lastReq) {
        return { isCooldown: false, remainingMs: 0 };
      }

      // SQLite CURRENT_TIMESTAMP is UTC. Convert to local milliseconds.
      const lastTime = new Date(lastReq.created_at + ' UTC').getTime();
      const elapsed = Date.now() - lastTime;
      
      if (elapsed < config.requestCooldownMs) {
        return {
          isCooldown: true,
          remainingMs: config.requestCooldownMs - elapsed
        };
      }
    } catch (err) {
      logger.error(`Error checking user request cooldown for ${phone}: ${err.message}`);
    }
    return { isCooldown: false, remainingMs: 0 };
  },

  /**
   * Retrieve active session state for a user. Creates IDLE session if none exists.
   * @param {string} phone
   * @returns {object}
   */
  getSession(phone) {
    if (!sessions.has(phone)) {
      sessions.set(phone, {
        state: 'IDLE',
        data: {}
      });
    }
    return sessions.get(phone);
  },

  /**
   * Update the user session state.
   * @param {string} phone
   * @param {string} state - The new state
   * @param {object} [newData={}] - Additional details to merge
   */
  setSession(phone, state, newData = {}) {
    const current = this.getSession(phone);
    sessions.set(phone, {
      state,
      data: { ...current.data, ...newData }
    });
  },

  /**
   * Clear user session state back to IDLE
   * @param {string} phone
   */
  clearSession(phone) {
    sessions.delete(phone);
  },

  /**
   * Initialize periodic cleanup of stale sessions and rate limit entries.
   * Call once at startup.
   */
  init() {
    if (cleanupIntervalId) clearInterval(cleanupIntervalId);
    // Run cleanup every 5 minutes
    cleanupIntervalId = setInterval(() => {
      this.cleanup();
    }, 5 * 60 * 1000);
  },

  /**
   * Remove stale sessions (idle > 30 min) and old rate limit entries (> 5 min).
   */
  cleanup() {
    const now = Date.now();
    const SESSION_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
    const RATE_LIMIT_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

    // Clean stale sessions — we can't track last activity easily,
    // so we limit total size as a safety valve
    if (sessions.size > 200) {
      const keysToDelete = [];
      for (const key of sessions.keys()) {
        keysToDelete.push(key);
        if (sessions.size - keysToDelete.length <= 100) break;
      }
      keysToDelete.forEach(k => sessions.delete(k));
    }

    // Clean old rate limit timestamps
    for (const [phone, time] of lastMessageTimes.entries()) {
      if (now - time > RATE_LIMIT_MAX_AGE_MS) {
        lastMessageTimes.delete(phone);
      }
    }
  },

  /**
   * Stop the periodic cleanup interval.
   */
  destroy() {
    if (cleanupIntervalId) {
      clearInterval(cleanupIntervalId);
      cleanupIntervalId = null;
    }
  }
};
