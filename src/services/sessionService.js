import { config } from '../config/index.js';
import { dbService } from './dbService.js';
import logger from '../utils/logger.js';

// In-memory store for interactive state sessions and message times
const sessions = new Map();
const lastMessageTimes = new Map();
// Tracks phones that had a non-IDLE session expire while they were away
const recentlyExpired = new Map();
let cleanupIntervalId = null;

export const sessionService = {
  /**
   * Enforce rate limit. Returns true if user sent messages too quickly.
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
   * Check if user is in cooldown period between submitting content.
   */
  async checkRequestCooldown(phone) {
    try {
      const lastReq = await dbService.getLastRequestByUser(phone);
      if (!lastReq) return { isCooldown: false, remainingMs: 0 };
      const lastTime = new Date(lastReq.created_at + ' UTC').getTime();
      const elapsed = Date.now() - lastTime;
      if (elapsed < config.requestCooldownMs) {
        return { isCooldown: true, remainingMs: config.requestCooldownMs - elapsed };
      }
    } catch (err) {
      logger.error(`Error checking user request cooldown for ${phone}: ${err.message}`);
    }
    return { isCooldown: false, remainingMs: 0 };
  },

  /**
   * Retrieve active session state for a user. Creates IDLE session if none exists.
   */
  getSession(phone) {
    if (!sessions.has(phone)) {
      sessions.set(phone, { state: 'IDLE', data: {}, lastActivity: Date.now() });
    }
    return sessions.get(phone);
  },

  /**
   * Update the user session state (merges data).
   */
  setSession(phone, state, newData = {}) {
    const current = this.getSession(phone);
    sessions.set(phone, {
      state,
      data: { ...current.data, ...newData },
      lastActivity: Date.now()
    });
  },

  /**
   * Refresh lastActivity timestamp without changing state/data.
   */
  updateActivity(phone) {
    const session = sessions.get(phone);
    if (session) session.lastActivity = Date.now();
  },

  /**
   * Clear user session state back to IDLE.
   */
  clearSession(phone) {
    sessions.delete(phone);
  },

  /**
   * Returns true (and clears the flag) if this phone had an active
   * wizard/flow session that expired while they were away.
   */
  wasAndClearExpired(phone) {
    if (!recentlyExpired.has(phone)) return false;
    recentlyExpired.delete(phone);
    return true;
  },

  /**
   * Initialize periodic cleanup of stale sessions and rate limit entries.
   * Call once at startup.
   */
  init() {
    if (cleanupIntervalId) clearInterval(cleanupIntervalId);
    cleanupIntervalId = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  },

  /**
   * Remove stale sessions (idle > 30 min) and old rate limit entries (> 5 min).
   */
  cleanup() {
    const now = Date.now();
    const SESSION_MAX_AGE_MS = 30 * 60 * 1000;     // 30 minutes
    const EXPIRED_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

    for (const [phone, session] of sessions.entries()) {
      const age = now - (session.lastActivity || now);
      if (age > SESSION_MAX_AGE_MS) {
        // Mark non-IDLE sessions so user gets a notification on their next message
        if (session.state !== 'IDLE') {
          recentlyExpired.set(phone, now);
          logger.info(`[SessionService] Session expired for ${phone} while in state ${session.state}`);
        }
        sessions.delete(phone);
      }
    }

    // Clean old recentlyExpired records
    for (const [phone, ts] of recentlyExpired.entries()) {
      if (now - ts > EXPIRED_MAX_AGE_MS) recentlyExpired.delete(phone);
    }

    // Clean old rate limit timestamps
    for (const [phone, time] of lastMessageTimes.entries()) {
      if (now - time > 5 * 60 * 1000) lastMessageTimes.delete(phone);
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
