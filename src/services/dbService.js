import { getDb } from '../database/connection.js';
import { v4 as uuidv4 } from 'uuid';

export const dbService = {
  // ==========================================
  // USERS OPERATIONS
  // ==========================================

  /**
   * Insert a user or update their last_seen and name.
   * @param {string} phone
   * @param {string} name
   * @param {string} [role='user']
   */
  async upsertUser(phone, name, role = 'user') {
    const db = getDb();
    const existing = await db.get('SELECT phone FROM users WHERE phone = ?', [phone]);
    
    if (existing) {
      // Update last seen and name (if name is provided)
      if (name) {
        await db.run(
          'UPDATE users SET name = ?, last_seen = CURRENT_TIMESTAMP WHERE phone = ?',
          [name, phone]
        );
      } else {
        await db.run(
          'UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE phone = ?',
          [phone]
        );
      }
    } else {
      // Insert new user
      await db.run(
        'INSERT INTO users (phone, name, role, joined_at, last_seen) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
        [phone, name || 'مستخدم واتساب', role]
      );
    }
  },

  /**
   * Get user by phone number
   * @param {string} phone
   * @returns {Promise<object|undefined>}
   */
  async getUser(phone) {
    const db = getDb();
    return db.get('SELECT * FROM users WHERE phone = ?', [phone]);
  },

  /**
   * Get all registered users
   * @returns {Promise<Array<object>>}
   */
  async getAllUsers() {
    const db = getDb();
    return db.all('SELECT * FROM users');
  },

  // ==========================================
  // AUDIOS OPERATIONS
  // ==========================================

  /**
   * Add a new audio to the library index.
   * @param {object} audio
   */
  async addAudio(audio) {
    const db = getDb();
    await db.run(
      `INSERT INTO audios (
        uuid, title, presenter, category, description, keywords, 
        hf_url, cover_url, location, date_hijri, duration, size, sha256, 
        downloads, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        audio.uuid,
        audio.title,
        audio.presenter,
        audio.category,
        audio.description || '',
        audio.keywords || '',
        audio.hf_url,
        audio.cover_url || '',
        audio.location || '',
        audio.date_hijri || '',
        audio.duration || 0,
        audio.size || 0,
        audio.sha256
      ]
    );
  },

  /**
   * Check if an audio already exists by SHA256 hash.
   * @param {string} sha256
   * @returns {Promise<object|undefined>}
   */
  async getAudioBySha(sha256) {
    const db = getDb();
    return db.get('SELECT * FROM audios WHERE sha256 = ?', [sha256]);
  },

  /**
   * Get audio by UUID
   * @param {string} uuid
   * @returns {Promise<object|undefined>}
   */
  async getAudioByUuid(uuid) {
    const db = getDb();
    return db.get('SELECT * FROM audios WHERE uuid = ?', [uuid]);
  },

  /**
   * Get all audios in the database
   * @returns {Promise<Array<object>>}
   */
  async getAllAudios() {
    const db = getDb();
    return db.all('SELECT * FROM audios ORDER BY created_at DESC');
  },

  /**
   * Delete an audio from the library.
   * @param {string} uuid
   */
  async deleteAudio(uuid) {
    const db = getDb();
    await db.run('DELETE FROM audios WHERE uuid = ?', [uuid]);
  },

  /**
   * Update details of an existing audio.
   * @param {string} uuid
   * @param {object} details
   */
  async updateAudio(uuid, details) {
    const db = getDb();
    await db.run(
      `UPDATE audios SET 
        title = COALESCE(?, title),
        presenter = COALESCE(?, presenter),
        category = COALESCE(?, category),
        description = COALESCE(?, description),
        keywords = COALESCE(?, keywords),
        location = COALESCE(?, location),
        date_hijri = COALESCE(?, date_hijri),
        updated_at = CURRENT_TIMESTAMP
      WHERE uuid = ?`,
      [
        details.title,
        details.presenter,
        details.category,
        details.description,
        details.keywords,
        details.location,
        details.date_hijri,
        uuid
      ]
    );
  },

  // ==========================================
  // REQUESTS OPERATIONS
  // ==========================================

  /**
   * Create a new temporary audio request.
   * @param {object} req
   */
  async createRequest(req) {
    const db = getDb();
    await db.run(
      `INSERT INTO requests (
        uuid, phone, status, title, presenter, category, description, location, date_hijri, audio_temp, created_at
      ) VALUES (?, ?, 'WAITING', ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        req.uuid,
        req.phone,
        req.title,
        req.presenter,
        req.category,
        req.description || '',
        req.location || '',
        req.date_hijri || '',
        req.audio_temp
      ]
    );
  },

  /**
   * Get details of a request by UUID.
   * @param {string} uuid
   * @returns {Promise<object|undefined>}
   */
  async getRequestByUuid(uuid) {
    const db = getDb();
    return db.get('SELECT * FROM requests WHERE uuid = ?', [uuid]);
  },

  /**
   * Get all requests waiting for approval.
   * @returns {Promise<Array<object>>}
   */
  async getPendingRequests() {
    const db = getDb();
    return db.all("SELECT * FROM requests WHERE status = 'WAITING' ORDER BY created_at ASC");
  },

  /**
   * Update the status of a request.
   * @param {string} uuid
   * @param {string} status
   */
  async updateRequestStatus(uuid, status) {
    const db = getDb();
    await db.run('UPDATE requests SET status = ? WHERE uuid = ?', [status, uuid]);
  },

  /**
   * Get the last request submitted by a user.
   * @param {string} phone
   * @returns {Promise<object|undefined>}
   */
  async getLastRequestByUser(phone) {
    const db = getDb();
    return db.get('SELECT * FROM requests WHERE phone = ? ORDER BY created_at DESC LIMIT 1', [phone]);
  },

  // ==========================================
  // FAVORITES OPERATIONS
  // ==========================================

  /**
   * Add an audio to user's favorites list.
   * @param {string} phone
   * @param {string} audioUuid
   */
  async addFavorite(phone, audioUuid) {
    const db = getDb();
    await db.run(
      'INSERT OR IGNORE INTO favorites (user_phone, audio_uuid) VALUES (?, ?)',
      [phone, audioUuid]
    );
  },

  /**
   * Remove an audio from user's favorites list.
   * @param {string} phone
   * @param {string} audioUuid
   */
  async removeFavorite(phone, audioUuid) {
    const db = getDb();
    await db.run(
      'DELETE FROM favorites WHERE user_phone = ? AND audio_uuid = ?',
      [phone, audioUuid]
    );
  },

  /**
   * Check if an audio is marked as favorite by a user.
   * @param {string} phone
   * @param {string} audioUuid
   * @returns {Promise<boolean>}
   */
  async isFavorite(phone, audioUuid) {
    const db = getDb();
    const fav = await db.get(
      'SELECT 1 FROM favorites WHERE user_phone = ? AND audio_uuid = ?',
      [phone, audioUuid]
    );
    return !!fav;
  },

  /**
   * Get all favorite audios of a user.
   * @param {string} phone
   * @returns {Promise<Array<object>>}
   */
  async getUserFavorites(phone) {
    const db = getDb();
    return db.all(
      `SELECT a.* FROM favorites f 
       JOIN audios a ON f.audio_uuid = a.uuid 
       WHERE f.user_phone = ? 
       ORDER BY a.title ASC`,
      [phone]
    );
  },

  // ==========================================
  // SUBSCRIBERS OPERATIONS (notifications)
  // ==========================================

  /**
   * Toggle subscription for a user. Returns new state: true=subscribed, false=unsubscribed.
   * @param {string} phone
   * @returns {Promise<boolean>}
   */
  async toggleSubscribe(phone) {
    const db = getDb();
    const existing = await db.get('SELECT phone FROM subscribers WHERE phone = ?', [phone]);
    if (existing) {
      await db.run('DELETE FROM subscribers WHERE phone = ?', [phone]);
      return false;
    } else {
      await db.run('INSERT OR IGNORE INTO subscribers (phone, subscribed_at) VALUES (?, CURRENT_TIMESTAMP)', [phone]);
      return true;
    }
  },

  /**
   * Check if a user is subscribed
   * @param {string} phone
   * @returns {Promise<boolean>}
   */
  async isSubscribed(phone) {
    const db = getDb();
    const sub = await db.get('SELECT 1 FROM subscribers WHERE phone = ?', [phone]);
    return !!sub;
  },

  /**
   * Get all subscribers phone numbers
   * @returns {Promise<string[]>}
   */
  async getAllSubscribers() {
    const db = getDb();
    const rows = await db.all('SELECT phone FROM subscribers');
    return rows.map(r => r.phone);
  },

  // ==========================================
  // DOWNLOADS OPERATIONS
  // ==========================================

  /**
   * Record an audio download event.
   * @param {string} phone
   * @param {string} audioUuid
   */
  async recordDownload(phone, audioUuid) {
    const db = getDb();
    const downloadUuid = uuidv4();
    
    // Add record
    await db.run(
      'INSERT INTO downloads (uuid, user_phone, audio_uuid, download_time) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
      [downloadUuid, phone, audioUuid]
    );
    
    // Increment download count in audios
    await db.run(
      'UPDATE audios SET downloads = downloads + 1 WHERE uuid = ?',
      [audioUuid]
    );
  },

  // ==========================================
  // STATISTICS OPERATIONS
  // ==========================================

  /**
   * Get summary counts for dashboard.
   * @returns {Promise<object>}
   */
  async getSummaryStats() {
    const db = getDb();
    const audios = await db.get('SELECT COUNT(*) as count FROM audios');
    const users = await db.get('SELECT COUNT(*) as count FROM users');
    const downloads = await db.get('SELECT COUNT(*) as count FROM downloads');
    const requests = await db.get('SELECT COUNT(*) as count FROM requests');
    
    return {
      totalAudios: audios.count,
      totalUsers: users.count,
      totalDownloads: downloads.count,
      totalRequests: requests.count
    };
  },

  /**
   * Get audios ordered by downloads descending.
   * @param {number} [limit=5]
   * @returns {Promise<Array<object>>}
   */
  async getTopDownloadedAudios(limit = 5) {
    const db = getDb();
    return db.all('SELECT * FROM audios ORDER BY downloads DESC LIMIT ?', [limit]);
  },

  /**
   * Get categories with counts.
   * @returns {Promise<Array<object>>}
   */
  async getTopCategories() {
    const db = getDb();
    return db.all('SELECT category, COUNT(*) as count FROM audios GROUP BY category ORDER BY count DESC');
  },

  /**
   * Get presenters with counts.
   * @param {number} [limit=5]
   * @returns {Promise<Array<object>>}
   */
  async getTopPresenters(limit = 5) {
    const db = getDb();
    return db.all('SELECT presenter, COUNT(*) as count FROM audios GROUP BY presenter ORDER BY count DESC LIMIT ?', [limit]);
  },

  /**
   * Get number of audios added in the last 7 days.
   * @returns {Promise<number>}
   */
  async getAudiosAddedThisWeek() {
    const db = getDb();
    const res = await db.get(
      "SELECT COUNT(*) as count FROM audios WHERE created_at >= date('now', '-7 days')"
    );
    return res.count;
  },

  /**
   * Get users with the most download activity.
   * @param {number} [limit=5]
   * @returns {Promise<Array<object>>}
   */
  async getMostActiveUsers(limit = 5) {
    const db = getDb();
    return db.all(
      `SELECT u.phone, u.name, COUNT(d.uuid) as download_count 
       FROM users u 
       JOIN downloads d ON u.phone = d.user_phone 
       GROUP BY u.phone 
       ORDER BY download_count DESC 
       LIMIT ?`,
      [limit]
    );
  }
};
