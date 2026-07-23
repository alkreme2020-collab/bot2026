import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/index.js';
import logger, { setDbLogWriter } from '../utils/logger.js';

let db = null;

/**
 * Initialize the SQLite database, open connection, verify/create tables, and register the log writer.
 * @returns {Promise<import('sqlite').Database>}
 */
export async function initDatabase() {
  logger.info(`Initializing SQLite database at: ${config.dbPath}`);
  
  db = await open({
    filename: config.dbPath,
    driver: sqlite3.Database
  });

  // Enable foreign keys constraints
  await db.run('PRAGMA foreign_keys = ON');

  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS audios (
      uuid TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      presenter TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT,
      keywords TEXT,
      hf_url TEXT NOT NULL,
      cover_url TEXT,
      location TEXT DEFAULT '',
      date_hijri TEXT DEFAULT '',
      duration INTEGER DEFAULT 0,
      size INTEGER DEFAULT 0,
      sha256 TEXT UNIQUE,
      downloads INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      phone TEXT PRIMARY KEY,
      name TEXT,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      role TEXT DEFAULT 'user'
    );

    CREATE TABLE IF NOT EXISTS requests (
      uuid TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      status TEXT DEFAULT 'WAITING',
      title TEXT,
      presenter TEXT,
      category TEXT,
      description TEXT,
      location TEXT DEFAULT '',
      date_hijri TEXT DEFAULT '',
      audio_temp TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS favorites (
      user_phone TEXT,
      audio_uuid TEXT,
      PRIMARY KEY (user_phone, audio_uuid),
      FOREIGN KEY (user_phone) REFERENCES users(phone) ON DELETE CASCADE,
      FOREIGN KEY (audio_uuid) REFERENCES audios(uuid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS subscribers (
      phone TEXT PRIMARY KEY,
      subscribed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS downloads (
      uuid TEXT PRIMARY KEY,
      user_phone TEXT NOT NULL,
      audio_uuid TEXT NOT NULL,
      download_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_phone) REFERENCES users(phone) ON DELETE CASCADE,
      FOREIGN KEY (audio_uuid) REFERENCES audios(uuid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS logs (
      uuid TEXT PRIMARY KEY,
      type TEXT,
      message TEXT,
      date DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Add new columns for existing databases (safe to run even if columns exist)
  try { await db.run('ALTER TABLE audios ADD COLUMN location TEXT DEFAULT \'\''); } catch (e) {}
  try { await db.run('ALTER TABLE audios ADD COLUMN date_hijri TEXT DEFAULT \'\''); } catch (e) {}
  try { await db.run('ALTER TABLE requests ADD COLUMN location TEXT DEFAULT \'\''); } catch (e) {}
  try { await db.run('ALTER TABLE requests ADD COLUMN date_hijri TEXT DEFAULT \'\''); } catch (e) {}

  // Setup logging integration to write into logs table
  setDbLogWriter(async (type, message) => {
    try {
      const logUuid = uuidv4();
      await db.run(
        'INSERT INTO logs (uuid, type, message, date) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
        [logUuid, type, message]
      );
    } catch (err) {
      // Direct console logging as fallback to prevent recursive error loops
      console.error(`Error writing log to SQLite: ${err.message}`);
    }
  });

  logger.info('Database initialized and tables verified.');
  return db;
}

/**
 * Get active database instance
 * @returns {import('sqlite').Database}
 */
export function getDb() {
  if (!db) {
    throw new Error('Database not initialized! Call initDatabase() first.');
  }
  return db;
}
