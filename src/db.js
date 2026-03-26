/**
 * SQLite через встроенный модуль Node.js (node:sqlite) — без нативной сборки.
 * Требуется Node.js >= 22.5.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const projectRoot = path.resolve(__dirname, '..');

/**
 * Полный путь к файлу БД.
 * @param {string} rawPath
 */
function resolveDbPath(rawPath) {
  if (path.isAbsolute(rawPath)) return rawPath;
  return path.join(projectRoot, rawPath);
}

/**
 * Создаёт каталог для файла БД при необходимости.
 * @param {string} filePath
 */
function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Создаёт таблицы users и sessions.
 * @param {import('node:sqlite').DatabaseSync} db
 */
function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id INTEGER PRIMARY KEY,
      display_name TEXT,
      default_city TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      telegram_id INTEGER PRIMARY KEY,
      fsm_state TEXT NOT NULL DEFAULT 'idle',
      fsm_payload TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/**
 * Открывает файл БД по DATABASE_PATH из .env.
 */
function createDatabase() {
  const raw = process.env.DATABASE_PATH || 'data/bot.sqlite';
  const fullPath = resolveDbPath(raw);
  ensureParentDir(fullPath);
  const db = new DatabaseSync(fullPath);
  initSchema(db);
  return db;
}

/** @type {import('node:sqlite').DatabaseSync | null} */
let singleton = null;

/**
 * Один экземпляр БД на процесс.
 */
function getDb() {
  if (!singleton) {
    singleton = createDatabase();
  }
  return singleton;
}

/**
 * Читает сессию FSM; если записи нет — idle и пустой payload.
 * @param {number} telegramId
 */
function getSessionRow(telegramId) {
  const db = getDb();
  const row = db
    .prepare(
      'SELECT fsm_state, fsm_payload FROM sessions WHERE telegram_id = ?'
    )
    .get(telegramId);
  if (!row) {
    return { state: 'idle', payload: {} };
  }
  let payload = {};
  try {
    payload = JSON.parse(row.fsm_payload || '{}');
  } catch {
    payload = {};
  }
  return { state: row.fsm_state, payload };
}

/**
 * Сохраняет состояние FSM (UPSERT).
 * @param {number} telegramId
 * @param {string} state
 * @param {object} payload
 */
function saveSessionRow(telegramId, state, payload) {
  const db = getDb();
  const json = JSON.stringify(payload || {});
  db.prepare(
    `INSERT INTO sessions (telegram_id, fsm_state, fsm_payload, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(telegram_id) DO UPDATE SET
       fsm_state = excluded.fsm_state,
       fsm_payload = excluded.fsm_payload,
       updated_at = datetime('now')`
  ).run(telegramId, state, json);
}

/**
 * Сбрасывает сессию в idle и очищает payload.
 * @param {number} telegramId
 */
function clearSessionToIdle(telegramId) {
  saveSessionRow(telegramId, 'idle', {});
}

/**
 * Профиль пользователя или undefined.
 * @param {number} telegramId
 */
function getUser(telegramId) {
  const db = getDb();
  return db
    .prepare(
      'SELECT telegram_id, display_name, default_city, updated_at FROM users WHERE telegram_id = ?'
    )
    .get(telegramId);
}

/**
 * Создаёт или обновляет поля профиля.
 * @param {number} telegramId
 * @param {{ display_name?: string | null, default_city?: string | null }} fields
 */
function upsertUser(telegramId, fields) {
  const db = getDb();
  const existing = getUser(telegramId);
  const display_name =
    fields.display_name !== undefined
      ? fields.display_name
      : existing?.display_name ?? null;
  const default_city =
    fields.default_city !== undefined
      ? fields.default_city
      : existing?.default_city ?? null;
  db.prepare(
    `INSERT INTO users (telegram_id, display_name, default_city, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(telegram_id) DO UPDATE SET
       display_name = excluded.display_name,
       default_city = excluded.default_city,
       updated_at = datetime('now')`
  ).run(telegramId, display_name, default_city);
}

module.exports = {
  getDb,
  getSessionRow,
  saveSessionRow,
  clearSessionToIdle,
  getUser,
  upsertUser,
};
