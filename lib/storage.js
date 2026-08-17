/**
 * JSON 文件型存储
 *
 * 零依赖的本地存储层，将 users / tasks 持久化到 data/db.json。
 * 适合 MVP / 本地联调；生产环境请替换为 MySQL / Postgres / Redis。
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_DB = {
  users: {},     // token -> { id, name, token, createdAt, domain }
  tasks: {},     // taskId -> { id, userId, status, ... }
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadDB() {
  ensureDataDir();
  if (!fs.existsSync(DB_FILE)) {
    saveDB(DEFAULT_DB);
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const db = JSON.parse(raw);
    // 兼容老数据
    if (!db.users) db.users = {};
    if (!db.tasks) db.tasks = {};
    return db;
  } catch (e) {
    console.error('数据库损坏，使用空数据库:', e.message);
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
}

function saveDB(db) {
  ensureDataDir();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

/**
 * 读取（浅拷贝，避免外部直接修改内部对象）
 */
function read() {
  return loadDB();
}

/**
 * 原子更新：传入 mutator 函数，在锁内修改并落盘
 * 简单实现（单进程）；多进程请加文件锁。
 */
function update(mutator) {
  const db = loadDB();
  const result = mutator(db);
  saveDB(db);
  return result;
}

module.exports = {
  read,
  update,
  DATA_DIR,
  DB_FILE,
};