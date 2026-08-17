# AI 一键部署 - 后端服务（最小可用版）

> 配合 [`Skill_Object`](../Skill_Object/) 的客户端 Skill 使用。
> 在本地一站跑通：注册 → 拿 Token → 装 Skill →「帮我部署上线」→ 浏览器看线上效果。

---

## 快速开始

```bash
cd Skill_Object_Backend
npm install
npm start
```

启动后访问 **http://localhost:3000** 打开管理后台。

---

## 端到端联调流程（5 步）

### 第 1 步：启动后端

```bash
cd Skill_Object_Backend
npm install
npm start
```

看到以下输出表示成功：

```
================================================
  AI 一键部署 - 后端服务
================================================
  管理后台:    http://localhost:3000/
  ...
```

### 第 2 步：注册用户，拿到 Token

浏览器打开 http://localhost:3000，输入用户名（如 `alice`），点「注册并生成 Token」。

记下返回的 **Token**（形如 `a3f8...d2c1`，64 字符）。

### 第 3 步：在 Skill 项目里设置本地后端地址

打开 `Skill_Object/index.js`，找到顶部：

```js
const API_BASE = process.env.DEPLOY_API_BASE || 'https://api.xxx.dev.com';
```

测试时通过环境变量覆盖（不修改源文件）：

**Windows CMD：**
```cmd
set DEPLOY_API_BASE=http://localhost:3000
```

**Windows PowerShell：**
```powershell
$env:DEPLOY_API_BASE="http://localhost:3000"
```

**macOS / Linux：**
```bash
export DEPLOY_API_BASE=http://localhost:3000
```

### 第 4 步：把 Skill 装到本地（写入 Token）

```bash
cd ../Skill_Object
npm install
node index.js --token=<第 2 步拿到的 Token>
```

输出：
```
✅ Skill 安装成功！
Token 已安全保存到本地配置文件（不进对话、不上LLM）
现在你可以在 Cursor / Cline 中对我说：
   👉 帮我部署上线
```

### 第 5 步：在 Cursor 中说「帮我部署上线」

AI 会自动调用 Skill。流程：

1. Token 校验通过 ✅
2. 检测当前项目 ✅
3. 代码风险扫描 ✅
4. 项目打包（zip） ✅
5. 上传到 http://localhost:3000/api/deploy ✅
6. 轮询部署状态（约 8 秒跑完 6 个阶段）✅
7. 输出：

```
✅ 部署完成！
你的线上访问地址：http://<你的子域名>.dev.local/sites/<taskId>/
```

8. 浏览器访问这个地址 → 看到你的项目已经在「线上」跑起来了 🎉

---

## 项目结构

```
Skill_Object_Backend/
├── server.js              # Express 主服务
├── package.json
├── public/
│   └── index.html         # 管理后台 UI
├── lib/
│   ├── auth.js            # 用户与鉴权
│   ├── storage.js         # JSON 文件型数据库
│   └── deployer.js        # 部署流水线（状态机）
├── data/                  # 自动创建（gitignored）
│   ├── db.json            # 用户 + 任务数据
│   ├── uploads/           # 原始 zip 包
│   └── deployed/          # 解压后的站点
└── README.md
```

---

## API 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET`  | `/` | 管理后台 UI |
| `POST` | `/api/auth/register` | 创建用户，返回 Token |
| `GET`  | `/api/auth/me` | 查当前用户（需 Bearer Token） |
| `POST` | `/api/deploy` | 上传 zip 包，返回 taskId（需 Bearer Token） |
| `GET`  | `/api/deploy/status?taskId=xxx` | 查部署状态（需 Bearer Token） |
| `GET`  | `/api/admin/tasks` | 列出所有任务 |
| `GET`  | `/api/admin/users` | 列出所有用户 |
| `DELETE` | `/api/admin/tasks/:id` | 删除任务 |
| `GET`  | `/sites/:taskId/` | 已部署站点的静态托管 |

### 部署状态机

```
pending → extracting → building → deploying → starting → configuring → success
                                                                    ↘ failed
```

每个阶段 1-2 秒，总耗时约 8 秒。

---

## 与生产部署平台的区别

本后端是**本地最小可用版**，用于：
- ✅ Skill 端到端流程演示
- ✅ UI / 交互验证
- ✅ 给客户/老板看 Demo

**不能做的事**（需要接生产平台）：
- ❌ 真 HTTPS / 真域名（返回的是 `*.dev.local`，仅本机可访问）
- ❌ 真容器隔离（所有站点都在同一 Node 进程内）
- ❌ 真构建（不会跑 `npm install` / `docker build`）
- ❌ 抗 DDoS / 跨用户隔离 / 计费 / 配额
- ❌ 多机分布式

要上生产，把 [server.js](server.js) 的 `deployer.runPipeline()` 换成真实的 Docker / K8s / 云函数调用即可，接口契约不变。

---

## 常见问题

**Q: 后端启动报「EADDRINUSE: 3000」？**
A: 换个端口：`PORT=3001 npm start`，然后 Skill 端 `set DEPLOY_API_BASE=http://localhost:3001`。

**Q: 浏览器访问 `xxx.dev.local` 打不开？**
A: 这是预期的！`.dev.local` 是占位域名，只有把后端绑到真域名（或本地 hosts）才能访问。改用返回的 `/sites/<taskId>/` 路径即可。

**Q: 想清空所有数据？**
A: 删 `data/` 目录即可。

**Q: 想看部署进度？**
A: 管理后台会自动 3 秒刷新一次，或直接看返回的 taskId 状态。