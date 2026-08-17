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
    updateTask(taskId, { projectType });

    // 阶段 2..N：模拟后续步骤（带进度回调）
    for (let i = 1; i < STAGES.length; i++) {
      const [status, message, progress, delay] = STAGES[i];
      await sleep(delay);

      if (status === 'success') {
        // 最终阶段：分配 URL
        const url = `${task.domain}/sites/${taskId}/`;
        updateTask(taskId, { status, message, progress, url });
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

/**
 * 列出某用户的所有任务
 */
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
  deleteTask,
  listTasksByUser,
  listAllTasks,
  UPLOADS_DIR,
  DEPLOYED_DIR,
};