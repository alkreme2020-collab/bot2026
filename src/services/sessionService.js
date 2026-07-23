import { config } from '../config/index.js';
import { dbService } from './dbService.js';
import logger from '../utils/logger.js';

// In-memory store for interactive state sessions and message times
const sessions = new Map();
const lastMessageTimes = new Map();

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
   * Check if user is in cooldown period between submitting books.
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
  }
};
