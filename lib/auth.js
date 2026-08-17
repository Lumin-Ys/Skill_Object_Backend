/**
 * 账号 / 会话 / Skill Token
 *
 * 两套凭证：
 *   - sessionToken：控制台登录（注册即可）
 *   - skillToken：Skill CLI 调用部署 API（必须已购买且未过期）
 */

const crypto = require('crypto');
const storage = require('./storage');
const { getPlan } = require('./plans');

const ROOT_DOMAIN = process.env.ROOT_DOMAIN || 'dev.local';
const RESERVED_SLUGS = new Set([
  'www', 'api', 'console', 'admin', 'app', 'mail', 'ftp', 'sites', 'static',
  'assets', 'purchase', 'login', 'auth', 'cdn', 'status', 'help', 'docs',
  'support', 'root', 'system', 'null', 'undefined',
]);

function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

function genUserId() {
  return 'u_' + crypto.randomBytes(8).toString('hex');
}

function hashPassword(password, salt) {
  const usedSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, usedSalt, 32).toString('hex');
  return { salt: usedSalt, hash };
}

function verifyPassword(password, salt, hash) {
  if (!password || !salt || !hash) return false;
  try {
    const check = crypto.scryptSync(password, salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch {
    return false;
  }
}

function slugify(name) {
  return String(name || 'user')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20) || 'user';
}

function findUserByName(db, name) {
  const key = String(name || '').trim().toLowerCase();
  return Object.values(db.users).find(u => String(u.name || '').toLowerCase() === key) || null;
}

function findUserBySession(db, sessionToken) {
  if (!sessionToken) return null;
  const sid = db.sessions[sessionToken];
  if (!sid) return null;
  return db.users[sid.userId] || null;
}

function findUserBySkillToken(db, skillToken) {
  if (!skillToken) return null;
  const uid = db.skillIndex[skillToken];
  if (uid) return db.users[uid] || null;
  return Object.values(db.users).find(u => u.skillToken === skillToken) || null;
}

function isSubscribed(user) {
  if (!user || !user.plan || !user.planExpiresAt) return false;
  return new Date(user.planExpiresAt).getTime() > Date.now();
}

function planQuota(user) {
  const plan = getPlan(user.plan);
  return plan ? plan.deploys : 0;
}

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function normalizeSlug(raw) {
  return String(raw || '').toLowerCase().trim();
}

function validateSlug(raw) {
  const slug = normalizeSlug(raw);
  if (!/^[a-z][a-z0-9-]{1,18}[a-z0-9]$/.test(slug) && !/^[a-z][a-z0-9]{2,19}$/.test(slug)) {
    throw httpError('二级域名为 3-20 位，以字母开头，只能包含小写字母、数字和连字符', 400);
  }
  if (slug.includes('--')) {
    throw httpError('二级域名不能包含连续连字符', 400);
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw httpError('该二级域名为系统保留', 400);
  }
  return slug;
}

function slugTaken(db, slug, except = {}) {
  for (const u of Object.values(db.users || {})) {
    if (except.userId && u.id === except.userId) continue;
    if (u.slug === slug) return 'user';
  }
  for (const t of Object.values(db.tasks || {})) {
    if (except.taskId && t.id === except.taskId) continue;
    if (t.subdomain === slug) return 'task';
  }
  return null;
}

function publicUser(user) {
  const subscribed = isSubscribed(user);
  const plan = getPlan(user.plan);
  const slug = user.slug || slugify(user.name);
  return {
    id: user.id,
    name: user.name,
    displayName: user.displayName || user.name,
    slug,
    domain: user.domain || `${slug}.${ROOT_DOMAIN}`,
    rootDomain: ROOT_DOMAIN,
    plan: subscribed ? user.plan : null,
    planName: subscribed && plan ? plan.name : null,
    planExpiresAt: subscribed ? user.planExpiresAt : null,
    subscribed,
    deployUsed: user.deployUsed || 0,
    deployQuota: subscribed ? planQuota(user) : 0,
    skillToken: subscribed ? user.skillToken : null,
    createdAt: user.createdAt,
  };
}

function createSession(db, userId) {
  const sessionToken = genToken();
  db.sessions[sessionToken] = {
    userId,
    createdAt: new Date().toISOString(),
  };
  return sessionToken;
}

function registerUser(name, password) {
  const trimmed = String(name || '').trim();
  if (trimmed.length < 2 || trimmed.length > 30) {
    const err = new Error('用户名长度需在 2-30 之间');
    err.status = 400;
    throw err;
  }
  if (!password || String(password).length < 6) {
    const err = new Error('密码至少 6 位');
    err.status = 400;
    throw err;
  }

  return storage.update((db) => {
    if (findUserByName(db, trimmed)) {
      const err = new Error('用户名已被占用');
      err.status = 409;
      throw err;
    }

    const id = genUserId();
    const { salt, hash } = hashPassword(password);
    const slug = slugify(trimmed) + '-' + id.slice(2, 6);

    const user = {
      id,
      name: trimmed,
      displayName: trimmed,
      passwordSalt: salt,
      passwordHash: hash,
      slug,
      domain: `${slug}.${ROOT_DOMAIN}`,
      plan: null,
      planExpiresAt: null,
      skillToken: null,
      deployUsed: 0,
      createdAt: new Date().toISOString(),
    };

    db.users[id] = user;
    const sessionToken = createSession(db, id);
    return { sessionToken, user: publicUser(user) };
  });
}

function loginUser(name, password) {
  return storage.update((db) => {
    const user = findUserByName(db, name);
    if (!user || !verifyPassword(password, user.passwordSalt, user.passwordHash)) {
      const err = new Error('用户名或密码错误');
      err.status = 401;
      throw err;
    }
    const sessionToken = createSession(db, user.id);
    return { sessionToken, user: publicUser(user) };
  });
}

function logoutSession(sessionToken) {
  if (!sessionToken) return;
  storage.update((db) => {
    delete db.sessions[sessionToken];
  });
}

function purchasePlan(userId, planId) {
  const plan = getPlan(planId);
  if (!plan) {
    const err = new Error('套餐不存在');
    err.status = 400;
    throw err;
  }

  return storage.update((db) => {
    const user = db.users[userId];
    if (!user) {
      const err = new Error('用户不存在');
      err.status = 404;
      throw err;
    }

    const now = Date.now();
    const base = isSubscribed(user) ? new Date(user.planExpiresAt).getTime() : now;
    const expires = new Date(Math.max(base, now) + plan.days * 24 * 60 * 60 * 1000);

    if (user.skillToken && db.skillIndex[user.skillToken]) {
      delete db.skillIndex[user.skillToken];
    }

    const skillToken = genToken();
    user.plan = plan.id;
    user.planExpiresAt = expires.toISOString();
    user.skillToken = skillToken;
    user.deployUsed = 0;
    user.purchasedAt = new Date().toISOString();
    db.skillIndex[skillToken] = user.id;

    const orderId = 'ord_' + crypto.randomBytes(6).toString('hex');
    db.orders[orderId] = {
      id: orderId,
      userId: user.id,
      planId: plan.id,
      amount: plan.price,
      status: 'paid',
      createdAt: new Date().toISOString(),
    };

    return { orderId, user: publicUser(user) };
  });
}

function consumeDeployQuota(userId) {
  return storage.update((db) => {
    const user = db.users[userId];
    if (!user) return null;
    user.deployUsed = (user.deployUsed || 0) + 1;
    return publicUser(user);
  });
}

function updateProfile(userId, { displayName }) {
  const name = String(displayName || '').trim();
  if (name.length < 2 || name.length > 30) {
    throw httpError('显示名称长度需在 2-30 之间', 400);
  }
  return storage.update((db) => {
    const user = db.users[userId];
    if (!user) throw httpError('用户不存在', 404);
    user.displayName = name;
    return publicUser(user);
  });
}

function updateSlug(userId, rawSlug) {
  const slug = validateSlug(rawSlug);
  return storage.update((db) => {
    const user = db.users[userId];
    if (!user) throw httpError('用户不存在', 404);
    if (slugTaken(db, slug, { userId })) {
      throw httpError('该二级域名已被占用', 409);
    }
    user.slug = slug;
    user.domain = `${slug}.${ROOT_DOMAIN}`;
    for (const task of Object.values(db.tasks || {})) {
      if (task.userId !== userId) continue;
      if (task.subdomain) continue;
      task.domain = user.domain;
      if (task.status === 'success') {
        task.url = `${user.domain}/sites/${task.id}/`;
      }
    }
    return publicUser(user);
  });
}

function rotateSkillToken(userId) {
  return storage.update((db) => {
    const user = db.users[userId];
    if (!user) throw httpError('用户不存在', 404);
    if (!isSubscribed(user)) {
      throw httpError('请先购买套餐后再签发 Token', 402);
    }
    if (user.skillToken && db.skillIndex[user.skillToken]) {
      delete db.skillIndex[user.skillToken];
    }
    const skillToken = genToken();
    user.skillToken = skillToken;
    db.skillIndex[skillToken] = user.id;
    return publicUser(user);
  });
}

function getUserBySessionToken(sessionToken) {
  const db = storage.read();
  return findUserBySession(db, sessionToken);
}

function getUserBySkillToken(skillToken) {
  const db = storage.read();
  return findUserBySkillToken(db, skillToken);
}

function parseBearer(req) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  return m ? m[1] : '';
}

function requireSession(req, res, next) {
  const token = parseBearer(req);
  const user = getUserBySessionToken(token);
  if (!user) {
    return res.status(401).json({ error: '请先登录控制台' });
  }
  req.user = user;
  req.sessionToken = token;
  next();
}

/**
 * Skill CLI 鉴权：必须是已购买且未过期的 skillToken
 */
function requireSkill(req, res, next) {
  const token = parseBearer(req);
  const user = getUserBySkillToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  if (!isSubscribed(user)) {
    return res.status(402).json({
      error: 'Skill 未开通或已过期，请登录控制台购买套餐',
      code: 'SUBSCRIPTION_REQUIRED',
    });
  }
  const quota = planQuota(user);
  if (quota !== -1 && (user.deployUsed || 0) >= quota) {
    return res.status(402).json({
      error: '本月部署次数已用尽，请升级套餐',
      code: 'QUOTA_EXCEEDED',
    });
  }
  req.user = user;
  next();
}

module.exports = {
  ROOT_DOMAIN,
  registerUser,
  loginUser,
  logoutSession,
  purchasePlan,
  consumeDeployQuota,
  updateProfile,
  updateSlug,
  rotateSkillToken,
  validateSlug,
  slugTaken,
  publicUser,
  isSubscribed,
  requireSession,
  requireSkill,
  getUserBySkillToken,
  slugify,
};
