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
      return { isNew: false };
    } else {
      await db.run(
        'INSERT INTO users (phone, name, role, joined_at, last_seen) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
        [phone, name || 'مستخدم واتساب', role]
      );
      return { isNew: true };
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
  // AUDIOS & VIDEOS OPERATIONS
  // ==========================================

  /**
   * Add a new audio or video to the library index.
   * @param {object} audio
   */
  async addAudio(audio) {
    const db = getDb();
    await db.run(
      `INSERT INTO audios (
        uuid, title, presenter, category, description, keywords, 
        hf_url, cover_url, location, date_hijri, duration, size, sha256, media_type,
        downloads, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        audio.uuid,
        audio.title,
        audio.presenter || 'غير محدد',
        audio.category,
        audio.description || '',
        audio.keywords || '',
        audio.hf_url,
        audio.cover_url || '',
        audio.location || '',
        audio.date_hijri || '',
        audio.duration || 0,
        audio.size || 0,
        audio.sha256,
        audio.media_type || 'audio'
      ]
    );
  },

  /**
   * Check if an audio/video already exists by SHA256 hash.
   * @param {string} sha256
   * @returns {Promise<object|undefined>}
   */
  async getAudioBySha(sha256) {
    const db = getDb();
    return db.get('SELECT * FROM audios WHERE sha256 = ?', [sha256]);
  },

  /**
   * Get audio/video by UUID
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
    return db.all("SELECT * FROM audios WHERE media_type != 'video' OR media_type IS NULL ORDER BY created_at DESC");
  },

  /**
   * Get all videos in the database
   * @returns {Promise<Array<object>>}
   */
  async getAllVideos() {
    const db = getDb();
    return db.all("SELECT * FROM audios WHERE media_type = 'video' ORDER BY created_at DESC");
  },

  /**
   * Delete an audio/video from the library.
   * @param {string} uuid
   */
  async deleteAudio(uuid) {
    const db = getDb();
    await db.run('DELETE FROM audios WHERE uuid = ?', [uuid]);
  },

  /**
   * Update details of an existing audio/video.
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
  // BOOKS OPERATIONS
  // ==========================================

  /**
   * Add a new book to the library.
   * @param {object} book
   */
  async addBook(book) {
    const db = getDb();
    await db.run(
      `INSERT INTO books (
        uuid, title, author, category, description, keywords,
        hf_url, cover_url, pages_count, size, sha256, downloads, uploader_phone, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        book.uuid,
        book.title,
        book.author || 'غير محدد',
        book.category || 'عام',
        book.description || '',
        book.keywords || '',
        book.hf_url,
        book.cover_url || '',
        book.pages_count || 0,
        book.size || 0,
        book.sha256,
        book.uploader_phone || ''
      ]
    );
  },

  /**
   * Get book by SHA256 hash.
   * @param {string} sha256
   * @returns {Promise<object|undefined>}
   */
  async getBookBySha(sha256) {
    const db = getDb();
    return db.get('SELECT * FROM books WHERE sha256 = ?', [sha256]);
  },

  /**
   * Get book by UUID.
   * @param {string} uuid
   * @returns {Promise<object|undefined>}
   */
  async getBookByUuid(uuid) {
    const db = getDb();
    return db.get('SELECT * FROM books WHERE uuid = ?', [uuid]);
  },

  /**
   * Get all books in database.
   * @returns {Promise<Array<object>>}
   */
  async getAllBooks() {
    const db = getDb();
    return db.all('SELECT * FROM books ORDER BY created_at DESC');
  },

  /**
   * Delete a book from library.
   * @param {string} uuid
   */
  async deleteBook(uuid) {
    const db = getDb();
    await db.run('DELETE FROM books WHERE uuid = ?', [uuid]);
  },

  /**
   * Update details of an existing book.
   * @param {string} uuid
   * @param {object} details
   */
  async updateBook(uuid, details) {
    const db = getDb();
    await db.run(
      `UPDATE books SET 
        title = COALESCE(?, title),
        author = COALESCE(?, author),
        category = COALESCE(?, category),
        description = COALESCE(?, description),
        keywords = COALESCE(?, keywords),
        pages_count = COALESCE(?, pages_count),
        updated_at = CURRENT_TIMESTAMP
      WHERE uuid = ?`,
      [
        details.title,
        details.author,
        details.category,
        details.description,
        details.keywords,
        details.pages_count,
        uuid
      ]
    );
  },

  // ==========================================
  // REQUESTS OPERATIONS
  // ==========================================

  /**
   * Create a new temporary request (audio, video, or book).
   * @param {object} req
   */
  async createRequest(req) {
    const db = getDb();
    await db.run(
      `INSERT INTO requests (
        uuid, phone, status, title, presenter, category, description, location, date_hijri, audio_temp, media_type, book_author, book_pages, created_at
      ) VALUES (?, ?, 'WAITING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        req.uuid,
        req.phone,
        req.title,
        req.presenter || '',
        req.category || 'عام',
        req.description || '',
        req.location || '',
        req.date_hijri || '',
        req.audio_temp,
        req.media_type || 'audio',
        req.book_author || '',
        req.book_pages || 0
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
   * Record a download event.
   * @param {string} phone
   * @param {string} contentUuid
   * @param {string} [contentType='audio']
   */
  async recordDownload(phone, contentUuid, contentType = 'audio') {
    const db = getDb();
    const downloadUuid = uuidv4();
    
    await db.run(
      'INSERT INTO downloads (uuid, user_phone, audio_uuid, content_type, download_time) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
      [downloadUuid, phone, contentUuid, contentType]
    );
    
    if (contentType === 'book') {
      await db.run('UPDATE books SET downloads = downloads + 1 WHERE uuid = ?', [contentUuid]);
    } else {
      await db.run('UPDATE audios SET downloads = downloads + 1 WHERE uuid = ?', [contentUuid]);
    }
  },

  // ==========================================
  // CATEGORIES OPERATIONS
  // ==========================================

  /**
   * Get all categories ordered by display_order.
   * @returns {Promise<string[]>}
   */
  async getAllCategories() {
    const db = getDb();
    const rows = await db.all('SELECT name FROM categories ORDER BY display_order ASC');
    return rows.map(r => r.name);
  },

  /**
   * Get categories filtered by content_type ('audio', 'video', 'book').
   * @param {string} contentType
   * @returns {Promise<Array<object>>}
   */
  async getCategoriesByType(contentType) {
    const db = getDb();
    return db.all('SELECT * FROM categories WHERE content_type = ? ORDER BY display_order ASC', [contentType]);
  },

  /**
   * Add a new category with content type.
   * @param {string} name
   * @param {string} [contentType='audio']
   * @returns {Promise<boolean>}
   */
  async addCategory(name, contentType = 'audio') {
    const db = getDb();
    try {
      const maxOrder = await db.get('SELECT COALESCE(MAX(display_order), -1) + 1 as next FROM categories');
      await db.run('INSERT INTO categories (name, content_type, display_order) VALUES (?, ?, ?)', [name, contentType, maxOrder.next]);
      return true;
    } catch (e) {
      if (e.message.includes('UNIQUE')) return false;
      throw e;
    }
  },

  /**
   * Rename a category.
   * @param {string} oldName
   * @param {string} newName
   * @returns {Promise<boolean>}
   */
  async updateCategory(oldName, newName) {
    const db = getDb();
    try {
      await db.run('UPDATE categories SET name = ? WHERE name = ?', [newName, oldName]);
      await db.run('UPDATE audios SET category = ? WHERE category = ?', [newName, oldName]);
      await db.run('UPDATE books SET category = ? WHERE category = ?', [newName, oldName]);
      return true;
    } catch (e) {
      if (e.message.includes('UNIQUE')) return false;
      throw e;
    }
  },

  /**
   * Delete a category.
   * @param {string} name
   * @returns {Promise<boolean>}
   */
  async deleteCategory(name) {
    const db = getDb();
    const fallback = await db.get("SELECT name FROM categories WHERE name != ? ORDER BY display_order ASC LIMIT 1", [name]);
    const fallbackName = fallback ? fallback.name : 'عام';
    await db.run('UPDATE audios SET category = ? WHERE category = ?', [fallbackName, name]);
    await db.run('UPDATE books SET category = ? WHERE category = ?', [fallbackName, name]);
    await db.run('DELETE FROM categories WHERE name = ?', [name]);
    return true;
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
    const audios = await db.get("SELECT COUNT(*) as count FROM audios WHERE media_type != 'video' OR media_type IS NULL");
    const videos = await db.get("SELECT COUNT(*) as count FROM audios WHERE media_type = 'video'");
    const books = await db.get('SELECT COUNT(*) as count FROM books');
    const users = await db.get('SELECT COUNT(*) as count FROM users');
    const downloads = await db.get('SELECT COUNT(*) as count FROM downloads');
    const requests = await db.get("SELECT COUNT(*) as count FROM requests WHERE status = 'WAITING'");
    
    return {
      totalAudios: audios ? audios.count : 0,
      totalVideos: videos ? videos.count : 0,
      totalBooks: books ? books.count : 0,
      totalUsers: users ? users.count : 0,
      totalDownloads: downloads ? downloads.count : 0,
      totalRequests: requests ? requests.count : 0
    };
  },

  /**
   * Get audios added in the last 7 days.
   * @returns {Promise<Array<object>>}
   */
  async getAudiosThisWeek() {
    const db = getDb();
    return db.all(
      "SELECT * FROM audios WHERE (media_type != 'video' OR media_type IS NULL) AND created_at >= datetime('now', '-7 days') ORDER BY created_at DESC"
    );
  },

  /**
   * Get videos added in the last 7 days.
   * @returns {Promise<Array<object>>}
   */
  async getVideosThisWeek() {
    const db = getDb();
    return db.all(
      "SELECT * FROM audios WHERE media_type = 'video' AND created_at >= datetime('now', '-7 days') ORDER BY created_at DESC"
    );
  },

  /**
   * Get books added in the last 7 days.
   * @returns {Promise<Array<object>>}
   */
  async getBooksThisWeek() {
    const db = getDb();
    return db.all(
      "SELECT * FROM books WHERE created_at >= datetime('now', '-7 days') ORDER BY created_at DESC"
    );
  },

  /**
   * Delete log entries older than specified days.
   * @param {number} [daysToKeep=30]
   * @returns {Promise<number>}
   */
  async cleanOldLogs(daysToKeep = 30) {
    const db = getDb();
    const result = await db.run(
      `DELETE FROM logs WHERE date < datetime('now', '-' || ? || ' days')`,
      [daysToKeep]
    );
    return result.changes || 0;
  },

  /**
   * Delete download records older than specified days.
   * @param {number} [daysToKeep=90]
   * @returns {Promise<number>}
   */
  async cleanOldDownloads(daysToKeep = 90) {
    const db = getDb();
    const result = await db.run(
      `DELETE FROM downloads WHERE download_time < datetime('now', '-' || ? || ' days')`,
      [daysToKeep]
    );
    return result.changes || 0;
  },

  // ==========================================
  // ADVERTISEMENTS OPERATIONS
  // ==========================================

  /**
   * Add a new advertisement.
   * @param {string} text
   * @param {string} imageUrl
   * @param {number} days
   * @returns {Promise<string>}
   */
  async addAdvertisement(text, imageUrl, days) {
    const db = getDb();
    const adUuid = uuidv4();
    await db.run(
      `INSERT INTO advertisements (uuid, text, image_url, expires_at)
       VALUES (?, ?, ?, datetime('now', '+' || ? || ' days'))`,
      [adUuid, text, imageUrl || null, days]
    );
    return adUuid;
  },

  /**
   * Get active advertisements and auto-delete expired ones.
   * @returns {Promise<Array<object>>}
   */
  async getActiveAdvertisements() {
    const db = getDb();
    await db.run("DELETE FROM advertisements WHERE expires_at < datetime('now')");
    return db.all("SELECT * FROM advertisements WHERE expires_at >= datetime('now') ORDER BY created_at DESC");
  }
};
