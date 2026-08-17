/**
 * 部署引擎
 *
 * 部署流水线状态机：
 *   pending → extracting → building → deploying → starting → configuring → success
 *                                                          ↘ failed
 *
 * 每个阶段有：
 *   - status: pending/building/.../success/failed
 *   - message: 给前端展示的中文消息
 *   - progress: 0-100 的整数
 *
 * 实际工作：
 *   1. 把 zip 落到 data/uploads/<taskId>.zip
 *   2. 解压到 data/deployed/<taskId>/
 *   3. 自动识别项目类型（Node / 静态 / Python / Go 等）
 *   4. 通过 Express 在 /sites/<taskId>/ 静态托管
 *   5. 返回完整 URL：https://<user.domain>/sites/<taskId>/
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const storage = require('./storage');
const { ROOT_DOMAIN } = require('./auth');

// ========================= 配置 =========================

const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DEPLOYED_DIR = path.join(DATA_DIR, 'deployed');

// 部署阶段定义：[status, message, progress, delay(ms)]
const STAGES = [
  ['extracting',  '正在解压代码包...',           15, 800],
  ['building',    '正在构建镜像（模拟）...',       35, 1500],
  ['deploying',   '正在部署到容器（模拟）...',     55, 1500],
  ['starting',    '正在启动容器（模拟）...',       75, 1200],
  ['configuring', '正在配置 HTTPS 路由（模拟）...', 90, 1000],
  ['success',     '部署完成',                      100, 0],
];

// ========================= 工具函数 =========================

function ensureDirs() {
  for (const d of [DATA_DIR, UPLOADS_DIR, DEPLOYED_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function genTaskId() {
  return 't_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * 识别项目类型
 */
function detectProjectType(deployDir) {
  const checks = [
    ['node',    'package.json'],
    ['python',  'requirements.txt'],
    ['python',  'pyproject.toml'],
    ['go',      'go.mod'],
    ['java',    'pom.xml'],
    ['java',    'build.gradle'],
    ['ruby',    'Gemfile'],
    ['rust',    'Cargo.toml'],
    ['static',  'index.html'],
  ];
  for (const [type, file] of checks) {
    if (fs.existsSync(path.join(deployDir, file))) return type;
  }
  return 'static';
}

/**
 * 更新任务状态
 */
function updateTask(taskId, patch) {
  return storage.update((db) => {
    if (!db.tasks[taskId]) return null;
    Object.assign(db.tasks[taskId], patch, { updatedAt: nowIso() });
    return db.tasks[taskId];
  });
}

function getTask(taskId) {
  const db = storage.read();
  return db.tasks[taskId] || null;
}

function detectProjectName(deployDir, fallback) {
  try {
    const entries = fs.readdirSync(deployDir).filter(n => n !== '__MACOSX' && n !== '.DS_Store');
    let root = deployDir;
    if (entries.length === 1) {
      const inner = path.join(deployDir, entries[0]);
      if (fs.existsSync(inner) && fs.statSync(inner).isDirectory()) root = inner;
    }
    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg && pkg.name) return String(pkg.name).replace(/^@[^/]+\//, '').slice(0, 60);
    }
    return path.basename(root).slice(0, 60) || fallback;
  } catch {
    return fallback;
  }
}

function taskPublicUrl(task) {
  const host = task.subdomain
    ? `${task.subdomain}.${ROOT_DOMAIN}`
    : (task.domain || `${ROOT_DOMAIN}`);
  return `${host}/sites/${task.id}/`;
}

// ========================= 主流程 =========================

/**
 * 创建部署任务
 * @returns {{taskId, status}}
 */
function createTask(user, zipPath) {
  ensureDirs();

  const taskId = genTaskId();
  const task = {
    id: taskId,
    userId: user.id,
    userName: user.name,
    domain: user.domain,
    status: 'pending',
    message: '任务已创建，等待调度',
    progress: 0,
    zipPath,
    zipSize: fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0,
    deployDir: path.join(DEPLOYED_DIR, taskId),
    projectType: null,
    name: null,
    subdomain: null,
    url: null,
    error: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  storage.update((db) => {
    db.tasks[taskId] = task;
  });

  // 异步推进流水线
  setImmediate(() => runPipeline(taskId));

  return { taskId, status: task.status };
}

/**
 * 推进部署流水线
 */
async function runPipeline(taskId) {
  let task = getTask(taskId);
  if (!task) return;

  try {
    // 阶段 1：解压（同步执行）
    updateTask(taskId, {
      status: 'extracting',
      message: '正在解压代码包...',
      progress: 10,
    });

    if (!fs.existsSync(task.zipPath)) {
      throw new Error('代码包丢失：' + task.zipPath);
    }

    // 清空目标目录
    if (fs.existsSync(task.deployDir)) {
      fs.rmSync(task.deployDir, { recursive: true, force: true });
    }
    fs.mkdirSync(task.deployDir, { recursive: true });

    const zip = new AdmZip(task.zipPath);
    zip.extractAllTo(task.deployDir, true);

    const projectType = detectProjectType(task.deployDir);
    const name = detectProjectName(task.deployDir, task.userName || 'project');
    updateTask(taskId, { projectType, name });

    // 阶段 2..N：模拟后续步骤（带进度回调）
    for (let i = 1; i < STAGES.length; i++) {
      const [status, message, progress, delay] = STAGES[i];
      await sleep(delay);

      if (status === 'success') {
        const latest = getTask(taskId) || task;
        updateTask(taskId, { status, message, progress, url: taskPublicUrl(latest) });
      } else {
        updateTask(taskId, { status, message, progress });
      }
    }
  } catch (e) {
    console.error(`[deploy] 任务 ${taskId} 失败:`, e.message);
    updateTask(taskId, {
      status: 'failed',
      message: '部署失败：' + e.message,
      progress: 0,
      error: e.message,
    });
  }
}

/**
 * 删除任务（管理员用）
 */
function deleteTask(taskId) {
  const task = getTask(taskId);
  if (!task) return false;

  storage.update((db) => {
    delete db.tasks[taskId];
  });

  // 清理文件
  try {
    if (fs.existsSync(task.zipPath)) fs.unlinkSync(task.zipPath);
    if (fs.existsSync(task.deployDir)) fs.rmSync(task.deployDir, { recursive: true, force: true });
  } catch (e) {
    // ignore
  }

  return true;
}

function updateTaskMeta(taskId, userId, patch) {
  const { validateSlug, slugTaken } = require('./auth');
  return storage.update((db) => {
    const task = db.tasks[taskId];
    if (!task) {
      const err = new Error('任务不存在');
      err.status = 404;
      throw err;
    }
    if (task.userId !== userId) {
      const err = new Error('无权修改该任务');
      err.status = 403;
      throw err;
    }
    if (patch.name !== undefined) {
      const name = String(patch.name || '').trim();
      if (name.length < 1 || name.length > 60) {
        const err = new Error('项目名称长度为 1-60');
        err.status = 400;
        throw err;
      }
      task.name = name;
    }
    if (patch.subdomain !== undefined) {
      const raw = String(patch.subdomain || '').trim();
      if (!raw) {
        task.subdomain = null;
      } else {
        const slug = validateSlug(raw);
        if (slugTaken(db, slug, { taskId, userId: null })) {
          const err = new Error('该二级域名已被占用');
          err.status = 409;
          throw err;
        }
        task.subdomain = slug;
      }
      task.url = taskPublicUrl(task);
    }
    task.updatedAt = nowIso();
    return task;
  });
}
function listTasksByUser(userId) {
  const db = storage.read();
  return Object.values(db.tasks)
    .filter(t => t.userId === userId)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

/**
 * 列出所有任务（管理员）
 */
function listAllTasks() {
  const db = storage.read();
  return Object.values(db.tasks)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  createTask,
  getTask,
  updateTask,
  updateTaskMeta,
  deleteTask,
  listTasksByUser,
  listAllTasks,
  taskPublicUrl,
  UPLOADS_DIR,
  DEPLOYED_DIR,
};