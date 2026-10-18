'use strict';
/**
 * src/config.js – Centralised configuration derived from environment variables.
 * All paths are resolved to absolute paths under the project root so the app
 * works regardless of the current working directory when it is launched.
 */

const path = require('path');
const fs   = require('fs');

// Project root is always two levels up from this file (src/config.js → root)
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Load .env from the project root if it exists
const dotenvPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(dotenvPath)) {
  require('dotenv').config({ path: dotenvPath });
}

const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '500', 10);
const PORT            = parseInt(process.env.PORT || '3000', 10);
const LISTEN_HOST     = process.env.LISTEN_HOST || '127.0.0.1';
const CALLBACK_BASE_URL = (process.env.CALLBACK_BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const DATA_DIR        = path.join(PROJECT_ROOT, 'data');
const DB_PATH         = process.env.DB_PATH || path.join(DATA_DIR, 'loadtest.sqlite');
const K6_SCRIPT       = path.join(PROJECT_ROOT, 'k6', 'burst.js');
const K6_BIN          = process.env.K6_BIN || 'k6';
const LOG_LEVEL       = process.env.LOG_LEVEL || 'info';

// Ensure data directory exists
fs.mkdirSync(DATA_DIR, { recursive: true });

module.exports = {
  PROJECT_ROOT,
  PORT,
  LISTEN_HOST,
  CALLBACK_BASE_URL,
  DATA_DIR,
  DB_PATH,
  K6_SCRIPT,
  K6_BIN,
  LOG_LEVEL,
  MAX_CONCURRENCY,
};
