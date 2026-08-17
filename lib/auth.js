/**
 * 用户与 Token 模块
 *
 * - createUser(): 创建用户，签发不可猜测的随机 Token
 * - getUserByToken(): Bearer Token 鉴权
 * - requireAuth(): Express 中间件
 *
 * Token 格式：32 字节随机 → 64 字符十六进制
 */

const crypto = require('crypto');
const storage = require('./storage');

function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

function genUserId() {
  return 'u_' + crypto.randomBytes(8).toString('hex');
}

/**
 * 创建用户并签发 Token
 * @param {string} name - 用户名（用于子域名生成）
 * @returns {{id, name, token, domain}}
 */
function createUser(name) {
  const id = genUserId();
  const token = genToken();
  // 子域名片段：用户名前缀 + 短哈希，确保唯一且 URL 安全
  const slug = slugify(name) + '-' + id.slice(2, 6);

  const user = {
    id,
    name,
    token,
    slug,
    domain: `${slug}.dev.local`,
    createdAt: new Date().toISOString(),
  };

  storage.update((db) => {
    db.users[token] = user;
  });

  return user;
}

/**
 * 根据 Token 查找用户
 */
function getUserByToken(token) {
  if (!token) return null;
  const db = storage.read();
  return db.users[token] || null;
}

/**
 * Express 中间件：从 Authorization: Bearer <token> 解析用户
 */
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const user = getUserByToken(m[1]);
  if (!user) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  req.user = user;
  next();
}

function slugify(name) {
  return String(name || 'user')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20) || 'user';
}

module.exports = {
  createUser,
  getUserByToken,
  requireAuth,
  slugify,
};