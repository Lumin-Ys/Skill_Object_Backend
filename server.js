/**
 * AI 一键部署 - 后端服务
 *
 * 端口：默认 3000，可通过 PORT 环境变量修改
 *
 * 页面：
 *   GET  /                           官网
 *   GET  /console                    控制台（需登录）
 *
 * 认证：
 *   POST /api/auth/register          注册账号（不发 Skill Token）
 *   POST /api/auth/login             登录控制台
 *   POST /api/auth/logout            退出
 *   GET  /api/auth/me                当前登录用户
 *
 * 购买：
 *   GET  /api/plans                  套餐列表
 *   POST /api/billing/purchase       购买套餐后签发 Skill Token
 *
 * 部署（Skill Token + 有效套餐）：
 *   POST /api/deploy
 *   GET  /api/deploy/status
 */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const {
  registerUser,
  loginUser,
  logoutSession,
  purchasePlan,
  consumeDeployQuota,
  updateProfile,
  updateSlug,
  rotateSkillToken,
  publicUser,
  requireSession,
  requireSkill,
} = require('./lib/auth');
const { listPlans } = require('./lib/plans');
const deployer = require('./lib/deployer');
const storage = require('./lib/storage');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({
  dest: deployer.UPLOADS_DIR,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (file.mimetype === 'application/zip' ||
        file.mimetype === 'application/x-zip-compressed' ||
        file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('仅支持 .zip 文件'));
    }
  },
});

function sendPage(res, name) {
  res.sendFile(path.join(PUBLIC_DIR, name));
}

// ========================= 页面 =========================

app.get('/', (req, res) => sendPage(res, 'index.html'));
app.get('/console', (req, res) => sendPage(res, 'console.html'));
app.get('/purchase', (req, res) => sendPage(res, 'purchase.html'));
app.use(express.static(PUBLIC_DIR, { index: false }));

// ========================= 公开接口 =========================

app.get('/api/public/stats', (req, res) => {
  const db = storage.read();
  res.json({
    users: Object.keys(db.users).length,
    tasks: Object.keys(db.tasks).length,
  });
});

app.get('/api/plans', (req, res) => {
  res.json({ plans: listPlans() });
});

// ========================= 认证 =========================

app.post('/api/auth/register', (req, res, next) => {
  try {
    const { name, password } = req.body || {};
    const result = registerUser(name, password);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

app.post('/api/auth/login', (req, res, next) => {
  try {
    const { name, password } = req.body || {};
    if (!name || !password) {
      return res.status(400).json({ error: '请输入用户名和密码' });
    }
    const result = loginUser(name, password);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

app.post('/api/auth/logout', requireSession, (req, res) => {
  logoutSession(req.sessionToken);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireSession, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.patch('/api/me/profile', requireSession, (req, res, next) => {
  try {
    const user = updateProfile(req.user.id, { displayName: req.body?.displayName });
    res.json({ user });
  } catch (e) { next(e); }
});

app.patch('/api/me/domain', requireSession, (req, res, next) => {
  try {
    const user = updateSlug(req.user.id, req.body?.slug);
    res.json({ user });
  } catch (e) { next(e); }
});

app.post('/api/me/token/rotate', requireSession, (req, res, next) => {
  try {
    const user = rotateSkillToken(req.user.id);
    res.json({ user });
  } catch (e) { next(e); }
});

app.get('/api/me/overview', requireSession, (req, res) => {
  const tasks = deployer.listTasksByUser(req.user.id);
  const user = publicUser(req.user);
  res.json({
    user,
    stats: {
      projects: tasks.length,
      success: tasks.filter(t => t.status === 'success').length,
      failed: tasks.filter(t => t.status === 'failed').length,
      running: tasks.filter(t => !['success', 'failed'].includes(t.status)).length,
      online: tasks.filter(t => t.status === 'success').length,
      deployUsed: user.deployUsed,
      deployQuota: user.deployQuota,
    },
  });
});

// ========================= 购买 =========================

app.post('/api/billing/purchase', requireSession, (req, res, next) => {
  try {
    const { planId } = req.body || {};
    if (!planId) return res.status(400).json({ error: '缺少 planId' });
    const result = purchasePlan(req.user.id, planId);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// ========================= 控制台：我的任务 =========================

app.get('/api/me/tasks', requireSession, (req, res) => {
  res.json({ tasks: deployer.listTasksByUser(req.user.id) });
});

app.patch('/api/me/tasks/:id', requireSession, (req, res, next) => {
  try {
    const task = deployer.updateTaskMeta(req.params.id, req.user.id, {
      name: req.body?.name,
      subdomain: req.body?.subdomain,
    });
    res.json({ task });
  } catch (e) { next(e); }
});

app.delete('/api/me/tasks/:id', requireSession, (req, res) => {
  const task = deployer.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权删除该任务' });
  }
  res.json({ ok: deployer.deleteTask(req.params.id) });
});

// ========================= 部署（Skill Token）=========================

app.post('/api/deploy', requireSkill, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '缺少文件字段 file' });
  }

  const zipPath = req.file.path + '.zip';
  try {
    fs.renameSync(req.file.path, zipPath);
  } catch (e) {
    fs.unlinkSync(req.file.path);
    return res.status(500).json({ error: '保存上传文件失败' });
  }

  consumeDeployQuota(req.user.id);
  const { taskId, status } = deployer.createTask(req.user, zipPath);
  res.json({ taskId, status });
});

app.get('/api/deploy/status', requireSkill, (req, res) => {
  const { taskId } = req.query;
  if (!taskId) {
    return res.status(400).json({ error: '缺少 taskId' });
  }
  const task = deployer.getTask(taskId);
  if (!task) {
    return res.status(404).json({ error: '任务不存在' });
  }
  if (task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权访问该任务' });
  }

  res.json({
    status: task.status,
    message: task.message,
    progress: task.progress,
    url: task.url,
    domain: task.domain,
    error: task.error,
    projectType: task.projectType,
    taskId,
  });
});

// ========================= 已部署站点 =========================

app.use('/sites/:taskId', (req, res) => {
  const taskId = req.params.taskId;
  const task = deployer.getTask(taskId);
  if (!task) return res.status(404).send('任务不存在');
  if (task.status !== 'success') {
    return res.status(503).send(`任务尚未就绪，当前状态：${task.status}`);
  }
  const deployDir = task.deployDir;
  if (!fs.existsSync(deployDir)) return res.status(404).send('已部署文件不存在');

  const subPath = req.path.replace(/\/+$/, '') || '/';
  let filePath = path.join(deployDir, subPath);

  if (!filePath.startsWith(deployDir)) {
    return res.status(403).send('Forbidden');
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    filePath = path.join(deployDir, 'index.html');
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('无 index.html，也未找到对应文件');
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  fs.createReadStream(filePath).pipe(res);
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.pdf':  'application/pdf',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
};

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.path });
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({
    error: err.message || 'Internal Server Error',
  });
});

app.listen(PORT, () => {
  console.log('');
  console.log('================================================');
  console.log('  AI 一键部署 - 后端服务');
  console.log('================================================');
  console.log(`  官网:        http://localhost:${PORT}/`);
  console.log(`  控制台:      http://localhost:${PORT}/console`);
  console.log(`  部署 API:    http://localhost:${PORT}/api/deploy`);
  console.log(`  数据目录:    ${path.join(__dirname, 'data')}`);
  console.log('================================================');
  console.log('');
  console.log('提示：注册账号后需购买套餐，才会签发 Skill Token');
  console.log('');
});
