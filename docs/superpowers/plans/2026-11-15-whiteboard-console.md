# 白板权限与控制台 Implementation Plan

> **For agentic workers:** 当前会话内逐项实现；用自动测试和线上只读探测核实结果。

**Goal:** 在 v0.2.2 白板 API 上增加可撤销的人类/Agent 身份、部署独立控制台 Worker，并交付 Muse 迁移说明。

**Architecture:** API Worker 继续绑定原 D1；新增 `principals`、`api_credentials`、`sessions`。控制台 Worker 托管静态页面，通过同源 `/api` 和 Service Binding 访问 API。权限始终由 API 检查，Muse 使用人类专属 Bearer 凭据。

**Tech Stack:** 原生 Cloudflare Workers ES modules、D1、Wrangler、原生 HTML/CSS/JS、Node.js 24 内置 sqlite 测试。

**Spec:** `docs/superpowers/specs/2026-11-15-whiteboard-console.md`

## Global Constraints

- 部署账号 `a4a41234`；原 Worker 与 D1 保持绑定。控制台域名 `board.a4a4.ccwu.cc`。
- v0.2.2 辩论、审核门槛与 v0.1/v0.2 接口行为继续可用；不破坏旧 D1 数据。
- 管理员才可核对、强制通过、退回、审批/驳回；旧 API_KEY 临时只能使用 Agent 接口。
- 所有身份凭据由系统生成足够随机的值；原文不进 Git/D1/日志。

## Review Focus

- 旧共享 Token 调用 verify/force/approve/reject 必须 403。
- 请求体冒充他人名字和 human role 必须无效。
- D1 缺失或异常不得在正式环境降级到内存。
- 未授权 GET、登录 cookie 的跨站 POST、受禁账号的旧会话均应拒绝。
- 控制台直接 workers.dev、任务文本中 HTML、登录秘密出现在输出等必须受控。

---

### Task 1: API 身份和 D1 迁移

**Files:** 新增 `src/auth.js`、`migrations/0001-auth.sql`、`test/auth.test.mjs`；修改 `src/index.js`、`test-local.mjs`。

**Interfaces:** `authenticate(request, env, db): Promise<principal|null>`；`permit(principal, action): boolean`；`actor(principal, body)`；D1 的 `principals`、`api_credentials`、`sessions`。`TEST_MEMORY=1` 仅供原有记忆体测试。

- [ ] **Step 1:** 写 D1 SQLite 测试：禁止匿名读、旧 Token 禁审批、Agent body 不能冒名、人类发布 open、会话管理员可审批、Origin 不合时拒绝、D1 失败 503。
- [ ] **Step 2:** 运行 `node --test test/auth.test.mjs` 观察预期失败。
- [ ] **Step 3:** 实现随机账号密码/令牌哈希、手工账号增删、网页登录会话与路由 ACL，提供一次性管理员 bootstrap；调整旧接口从凭据推导身份。
- [ ] **Step 4:** 运行 `node --test test/auth.test.mjs` 与 `node test-local.mjs`，全部通过。
- [ ] **Step 5:** 提交代码、测试和迁移文件。

### Task 2: 控制台 Worker 与浏览器界面

**Files:** 新增 `web/worker.js`、`web/index.html`、`web/app.js`、`web/style.css`、`wrangler.board.toml`、`test/board.test.mjs`。

**Interfaces:** 静态 GET `/`、同源 `/api/*` Service Binding；页面根据 `/api/auth/me` 的 `kind`/`role` 展示动作，服务端权限为准。

- [ ] **Step 1:** 写最小服务绑定/静态路由测试，核查 API 不经静态缓存、无直连不受控入口。
- [ ] **Step 2:** 运行 `node --test test/board.test.mjs` 观察失败。
- [ ] **Step 3:** 实现登录、频道与任务列表/详情、创建任务、讨论、辩论回复与证据、审核门槛、积分榜、管理员审核与账号/Agent 签发撤销；用 `textContent` 渲染用户数据。
- [ ] **Step 4:** 运行服务测试和全部本地 API 测试。
- [ ] **Step 5:** 提交控制台文件与配置。

### Task 3: Muse 迁移与发布准备

**Files:** 新增 `docs/MUSE_MIGRATION.md`；修改 `README.md`、`DEPLOY.md`、`.gitignore`。

**Interfaces:** Muse 用 `Authorization: Bearer <personal-token>` 读写，Agent 用独立令牌。部署文档区分保留匿名读取阶段与最终关停旧 Token 阶段。

- [ ] **Step 1:** 写具体 Muse 改动、示例请求、错误处理、辩论/审核渲染与切换检查单。
- [ ] **Step 2:** 检查文档没有实际令牌或错误的 `cd api` 命令。
- [ ] **Step 3:** 运行测试并审查变更；提交文档。

### Task 4: Cloudflare 与 GitHub 交付

**Files:** 配置保留当前 D1 ID 的 `wrangler.toml`；上线日志追加至 `DEPLOY.md`。

**Interfaces:** 使用 cfcm 的 `a4a41234`；先备份 D1，执行增量建表，再设 bootstrap Secret、部署 API+board，创建初始管理员；校验线上健康、鉴权和域名。仓库通过钥匙串指定账号推送 feature branch，不覆盖 Codeg 全局凭据。

- [ ] **Step 1:** 审查 diff 与证据，完成完整测试。
- [ ] **Step 2:** 在原账号备份 D1 并执行增量建表；发布 API 与控制台。
- [ ] **Step 3:** 创建首位管理员；验证控制台未授权读取被拒、旧 Token 的管理员操作被拒；核对迁移期间 API 匿名读取开关状态。
- [ ] **Step 4:** 将 feature branch 推送 GitHub，输出部署地址和后续 Muse 切换步骤。
