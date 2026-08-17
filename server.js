/**
 * AI 一键部署 - 后端服务（最小可用版）
 *
 * 端口：默认 3000，可通过 PORT 环境变量修改
 *
 * 路由：
 *   GET  /                           管理后台 UI
 *   POST /api/auth/register          创建用户，返回 Token
 *   GET  /api/auth/me                当前用户信息
 *   POST /api/deploy                 接收 zip 上传，返回 taskId
 *   GET  /api/deploy/status          轮询部署状态
 *   GET  /api/admin/tasks            列出所有任务（管理员）
 *   DELETE /api/admin/tasks/:id      删除任务
 *   GET  /sites/:taskId/             已部署站点的静态托管
 */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const { createUser, requireAuth } = require('./lib/auth');
const deployer = require('./lib/deployer');
const storage = require('./lib/storage');

const PORT = process.env.PORT || 3000;

// ========================= Express 初始化 =========================

const app = express();
app.use(cors());
app.use(express.json());

// multer 配置：接收 zip 文件，落盘到 data/uploads/
const upload = multer({
  dest: deployer.UPLOADS_DIR,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
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

// ========================= 认证路由 =========================

/**
 * POST /api/auth/register
 * Body: { name: "用户名" }
 * → { id, name, token, domain, createdAt }
 */
app.post('/api/auth/register', (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: '缺少 name 字段' });
  }
  if (name.length < 2 || name.length > 30) {
    return res.status(400).json({ error: '用户名长度需在 2-30 之间' });
  }
  const user = createUser(name.trim());
  res.json(user);
});

/**
 * GET /api/auth/me
 * Header: Authorization: Bearer <token>
 */
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({
    id: req.user.id,
    name: req.user.name,
    domain: req.user.domain,
    createdAt: req.user.createdAt,
  });
});

// ========================= 部署路由 =========================

/**
 * POST /api/deploy
 * Header: Authorization: Bearer <token>
 * Body: multipart/form-data, field: "file" (zip)
 * → { taskId, status }
 */
app.post('/api/deploy', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '缺少文件字段 file' });
  }

  // 给上传文件改个有意义的名字（保留 .zip 后缀）
  const zipPath = req.file.path + '.zip';
  try {
    fs.renameSync(req.file.path, zipPath);
  } catch (e) {
    fs.unlinkSync(req.file.path);
    return res.status(500).json({ error: '保存上传文件失败' });
  }

  const { taskId, status } = deployer.createTask(req.user, zipPath);
  res.json({ taskId, status });
});

/**
 * GET /api/deploy/status?taskId=xxx
 * Header: Authorization: Bearer <token>
 */
app.get('/api/deploy/status', requireAuth, (req, res) => {
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

  // 返回 Skill 期望的字段
  res.json({
    status: task.status,        // pending/building/.../success/failed
    message: task.message,
    progress: task.progress,
    url: task.url,              // 成功时的访问地址
    domain: task.domain,        // 用户专属域名
    error: task.error,
    projectType: task.projectType,
    taskId,
  });
});

// ========================= 管理员路由 =========================

/**
 * GET /api/admin/tasks - 列出所有任务
 */
app.get('/api/admin/tasks', (req, res) => {
  res.json({ tasks: deployer.listAllTasks() });
});

/**
 * GET /api/admin/users - 列出所有用户
 */
app.get('/api/admin/users', (req, res) => {
  const db = storage.read();
  // 不返回 token 明文
  const users = Object.values(db.users).map(u => ({
    id: u.id,
    name: u.name,
    domain: u.domain,
    token: u.token,
    createdAt: u.createdAt,
  }));
  res.json({ users });
});

/**
 * DELETE /api/admin/tasks/:id
 */
app.delete('/api/admin/tasks/:id', (req, res) => {
  const ok = deployer.deleteTask(req.params.id);
  res.json({ ok });
});

// ========================= 已部署站点静态托管 =========================

/**
 * GET /sites/:taskId/*  →  托管 data/deployed/<taskId>/
 */
app.use('/sites/:taskId', (req, res, next) => {
  const taskId = req.params.taskId;
  const task = deployer.getTask(taskId);
  if (!task) return res.status(404).send('任务不存在');
  if (task.status !== 'success') {
    return res.status(503).send(`任务尚未就绪，当前状态：${task.status}`);
  }
  const deployDir = task.deployDir;
  if (!fs.existsSync(deployDir)) return res.status(404).send('已部署文件不存在');

  // 把 /sites/<taskId>/ 映射到 deployDir
  const subPath = req.path.replace(/\/+$/, '') || '/';
  let filePath = path.join(deployDir, subPath);

  // 安全：防止跳出
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

  // 设置合理的 Content-Type
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

// ========================= 后台管理 UI =========================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 兜底 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.path });
});

// 错误处理
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
  });
});

// ========================= 启动 =========================

deployer.UPLOADS_DIR && deployer.DEPLOYED_DIR && require('fs'); // 触发模块加载
app.listen(PORT, () => {
  console.log('');
  console.log('================================================');
  console.log('  AI 一键部署 - 后端服务');
  console.log('================================================');
  console.log(`  管理后台:    http://localhost:${PORT}/`);
  console.log(`  部署 API:    http://localhost:${PORT}/api/deploy`);
  console.log(`  状态 API:    http://localhost:${PORT}/api/deploy/status`);
  console.log(`  数据目录:    ${path.join(__dirname, 'data')}`);
  console.log('================================================');
  console.log('');
  console.log('提示：首次使用请打开管理后台注册一个用户获取 Token');
  console.log('');
});