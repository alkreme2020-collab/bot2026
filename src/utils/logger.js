import winston from 'winston';
import path from 'path';
import { config } from '../config/index.js';

// Setup Winston configuration
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: path.join(config.rootDir, 'logs/error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(config.rootDir, 'logs/app.log') }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Reference to database logger to avoid circular dependencies
let dbLogWriter = null;

/**
 * Register the SQLite DB log writer function
 * @param {Function} writer
 */
export function setDbLogWriter(writer) {
  dbLogWriter = writer;
}

/**
 * Log to Winston and write a record in the database logs table
 * @param {string} type - Log type (e.g. INFO, WARN, ERROR, COMMAND, SYSTEM)
 * @param {string} message - Log message
 */
export async function dbLog(type, message) {
  const msgStr = typeof message === 'object' ? JSON.stringify(message) : String(message);
  logger.info(`[${type}] ${msgStr}`);
  
  if (dbLogWriter) {
    try {
      await dbLogWriter(type, msgStr);
    } catch (err) {
      logger.error(`Failed to write log to SQLite DB: ${err.message}`);
    }
  }
}

export default logger;
