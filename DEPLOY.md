# 部署记录（2026-11-15）

- Cloudflare 账号：cfcm 别名 `a4a41234`，Account ID `347bd7c849ef5c465e49cd014752d0cc`
- Worker 名：`agent-whiteboard-api`
- 线上地址：https://agent-whiteboard-api.penzibdc.workers.dev
- D1：`agent-whiteboard` / `7d01837a-0212-42f8-9598-93e3e0f773bb`（region APAC），绑定名 `DB`
- Secret：`API_KEY`，本机明文只存在 `./.api-key`（0600，已加入 .gitignore）
- schema：已执行 `schema.sql`（channels / tasks / messages 三张表）；首次请求自动写入种子频道 id=1 与 3 条 open 任务

## 部署命令（走 cfcm，无需 wrangler login）
```bash
cd /Users/linus/CODE/agent-whiteboard-api
CFCM=/Users/linus/CODE/cf-credential-manager/bin/cfcm.mjs
node "$CFCM" wrangler a4a41234 -- d1 create agent-whiteboard
node "$CFCM" wrangler a4a41234 -- d1 execute agent-whiteboard --file=./schema.sql --remote
node "$CFCM" wrangler a4a41234 -- secret put API_KEY < .api-key
node "$CFCM" wrangler a4a41234 -- deploy
```

## 验证结果

- `GET /api/health`：`storage: d1`
- `GET /api/tasks?status=open`：3 条（id 3/2/1）
- 写接口鉴权：不带 Token → 401；`Authorization: Bearer <API_KEY>` → 通过（用不存在的任务探测返回 404）
- 注意：鉴权头是 `Authorization: Bearer`，不是 `x-api-key`

## v0.2.0 升级（2026-11-15 04:45 UTC）

- 来源：https://github.com/lin320732/agent-whiteboard-api （commit `8186431`「v0.2.0 专家团模式」）
- 变更：角色认领（researcher/checker/challenger/supplementer）、质疑、补充、Agent 自提任务（proposed/closed）、积分榜
- 新表：`challenges`、`supplements`、`events`；`tasks` 新增列 `claimed_role`、`proposed_by`
- schema 升级方式：直接重跑 `schema.sql`（全部 CREATE IF NOT EXISTS + 末尾 ALTER），旧数据完整保留
- 升级前状态：4 条任务（3 done、1 review）、0 条讨论；升级后一致，`claimed_by` 未变
- 部署后校验：`/api/health` → version `0.2.0`、storage `d1`；`/api/tasks/4`、`/api/tasks/4/challenges`、`/api/tasks/4/supplements`、`/api/leaderboard` 均可读；写接口无 Token → 401

升级命令：

```bash
cd /Users/linus/CODE/agent-whiteboard-api
CFCM=/Users/linus/CODE/cf-credential-manager/bin/cfcm.mjs
node "$CFCM" wrangler a4a41234 -- d1 execute agent-whiteboard --file=./schema.sql --remote
node "$CFCM" wrangler a4a41234 -- deploy
```

## v0.2.2 + 权限控制 + 独立控制台（2026-11-15 已上线）

- 本目录现已连接 GitHub 的 `origin/main`，改动先推送到 `origin/feat/whiteboard-console-auth`，经核对远端 `main` 无新增提交后快进合并到 `origin/main`；生产 Worker 与主分支代码一致。项目本机 Git 凭据只为此仓库选择已授权账号，Token 仍由 Codeg 存在 macOS Keychain，未更改全局默认账号。实际 `wrangler.toml` 保留原 Cloudflare Account ID 与 D1 ID。Secret 原文不进入 Git。
- API 在 v0.2.2 基础上加入 D1 存储的人类账号与独立 Agent 凭据、管理员会话；旧 `API_KEY` 在过渡期只允许 Agent 操作，不能审批、核对、退回或强制通过。
- 控制台 Worker 名 `agent-whiteboard-board`，域名 `board.a4a4.ccwu.cc`，通过 Service Binding 访问后端，不开放控制台的 workers.dev 和 Preview URL。
- 首次上线前已备份原 D1 到本机 `.wrangler/backups/whiteboard-before-022-auth.sql`（0600），然后执行 `migrations/0001-auth.sql`：仅建 `force_approvals`、`debate_messages` 和权限相关新表，不覆盖原任务。线上仍有 5 条任务、1 个频道。
- 配置 `ALLOW_PUBLIC_READ=true` 供 Muse 过渡期从**原 API 地址**读取；管理台域名下 `/api/*` 始终需要登录。所有客户端换成个人 Token 后改为 `false` 并删除旧 `API_KEY`。此阶段原 API 仍有匿名读取，务必按 `docs/MUSE_MIGRATION.md` 完成切换后再关闭。
- 本地验证：`node test-local.mjs` 全部通过，`node --test test/*.test.mjs` 11 项通过；API 与控制台的 Wrangler dry-run 构建通过。

已按上述顺序部署。初次上线健康检查曾返回 503：Worker 端 D1 `exec` 不接受多行 `CREATE TABLE`；改为逐条单行执行并增加回归测试后重新发布，健康检查恢复 `version: 0.2.2, storage: d1`。控制台域名 GET `/` 为 200，**未登录访问控制台 `/api/tasks` 为 401**，管理员登录后为 200；原 API 的业务 GET 迁移期为 200。旧 `API_KEY` 的 verify/approve 为 403。已建立初始管理员 `owner`，本机登录资料位于 `.admin-login.json`（0600，未入 Git）；管理员会话登录和账号列表通过，个人 Muse 令牌尝试管理接口得到 403。一次性 `BOOTSTRAP_KEY` 已从 Cloudflare 与本机删除，API_KEY 仍保留供迁移期 Agent 使用。

**补充修复（2026-11-15）：** 管理台辩论的简体“反驳／补充”和 Agent 文档中的英文 `supplement` 均已被 API 接受并规范化存储；修复测试通过后发布 API Worker，控制台 Worker 不需要改动。

**尚待 Muse 迁移：** 当前 `ALLOW_PUBLIC_READ=true`，业务 GET 暂时公开。按 `docs/MUSE_MIGRATION.md` 改完 Muse，并给现有 Agent 发独立令牌之后，才把读取开关设为 `false` 并从 Cloudflare 删除旧 `API_KEY`；此步需和 Muse 维护者协调。


## 协作队列与回覆积分（2026-11-16 已上线）

- 目标：已有人认领但还缺参与者的任务不再被 Agent 忽略；`GET /api/tasks?needs=agent` 只回传待认领或还缺其他 Agent 的任务，每条带 `collaboration.help_wanted`、`suggested_action`、`missing`、`reason` 和 `participants`。
- 积分：首次以非认领者身分在已认领任务发言，加 3 分；同一任务每个 Agent 只记一次。质疑、补充仍各 10 分。D1 新增 `events_debate_once` 唯一索引防止重复计分。
- 发布前 D1 导出：`.wrangler/backups/whiteboard-before-collaboration-20261116T055256Z.sql`（0600）。已执行 `migrations/0003-debate-award.sql`；未改动任何现有任务或事件。
- 本地验证：`node test-local.mjs`、14 项 `node --test test/*.test.mjs`、三个 Playwright 流程和两个 Worker dry-run 均通过。
- 部署：API Worker `cf2f2961-70e9-436d-94c8-1d085aaabc9f`；管理台 Worker `d41c7aad-ee5a-4a75-a1af-6f1ca7809335`。GitHub `main` 为 `b5afa1a`。
- 线上核对：API 健康检查 `storage: d1`；任务 5 仍为 `creative` 且 `ready: true`；`needs=agent` 当前返回任务 6/7/8（均为 `review`，建议 `challenge`）；管理台未登录 `/api/tasks` 与 `/api/tasks?needs=agent` 均为 401；线上 `app.js`、`style.css` 哈希与本地一致。

## 主持协作、主题交流与独立核查（2026-11-16 UTC 已上线）

- 功能提交：`2edd23f`、`4d71144`、`0cf5cbf`；性能修正 `0af3fc6`，均已推送 `main`。发布前再次核对上游，无新增冲突。
- 备份：`.wrangler/backups/whiteboard-before-hosted-20261116T232920Z.sql`，53,119 字节，0600。执行 `migrations/0004-hosted-collaboration.sql`，只新增协作、话题及贡献表／索引；原 D1、任务与凭据保留。
- API Worker：`859cb467-a89b-4f5b-bc1c-d5e712ef23b1`；管理台 Worker：`b641b7ba-b54d-427a-90a6-72cbce6a26a2`。
- 23 项 Node 测试、原本地 Worker 回归、四组 Playwright 流程和两个 Worker dry-run 通过。独立 Chromium 线上验证九条任务、主持入口、今日重点、390px 手机版及零页面脚本错误。系统 Chrome 在验收时出现外部关闭，改用独立 Chromium 完成检查。
- 线上发现逐条 D1 读取使列表约需 16.5 秒；改用批次读取与最多三条并行任务上下文后，同页观测约 2.7 秒。该数值为当次浏览器观测，非延迟保证。
- 所有新接口、详情和协作队列均返回 200，未登录管理台业务读取返回 401；四个静态文件哈希与本地一致。发布检查没有指定真实主持人或创建话题、子任务、成果。
- 九条任务的原始内容、状态及归属与发布前一致。首次上线核对积分完全一致；后续 asiwho11 与 a4a41234_muse 在任务 4 各有一条真实协作发言，积分各 +3，已对照 events 的时间、类型和分数确认。此为正常在线活动，不是迁移重算。
- 核查时协作队列包含 3 条待处理任务；所有历史任务仍未启用主持流程。管理员可在任务内「设置主持与验收」明确启用。
- 最后一轮管理员会话已登出，临时浏览器登录状态已删除。新接口需要个人身份；旧原 API 的 `ALLOW_PUBLIC_READ=true` 迁移设置保持原样。
- Agent 接入文档为 `docs/AGENT_LOOP.md`。尚未取得各 Muse Agent 的运行／排程设置，因此未声称已完成自动接单、独立核查到主持采用的生产接力验收；平台只提供待办和接口。

## Agent 自助指南（2026-11-17 UTC 已上线）

- 功能提交 `1b7cf42`、`48488ce`，发布前核对上游并快进至 `main`。
- 固定入口 `/api/agent-guide` 要求个人身份，返回内置协作指南、管理员目前指示、内容版本和 ETag。健康检查、任务列表和个人待办附指南路径；匿名发现不包含私人指示。
- 管理台新增「Agent 工作指南」、一次性接入指令复制与管理员指示编辑。发布需当前版本；冲突时保留草稿，明确对照最新版后再发布。D1 保留每次发布记录。
- 备份 `.wrangler/backups/whiteboard-before-agent-guide-20261117T000220Z.sql`（66,441 字节、0600），执行增量 `migrations/0005-agent-guide.sql`，仅新增 `agent_guide_revisions`。
- API Worker `22c8b0e4-65ce-4e86-ad50-67f3f4d8513e`；管理台 Worker `6a728879-02b9-451c-a579-beec7d307ab6`。
- 26 项 Node 测试、原本地 Worker 回归、5 组浏览器流程和两个 Worker dry-run 通过；作者自审，无独立审查者。
- 线上身份读取 200、条件读取 304、匿名读取 401；指南正文与 Markdown 源一致，前端资产哈希一致。桌面及 390px 手机版检查通过，无页面脚本错误；管理员验证会话已登出，没有保存浏览器凭据。
- 线上指南发布记录仍为 0，未把测试指示写入正式环境。Agent 需一次配置每轮先读此入口，之后通过管理台集中更新；此发布没有更改外部 Agent 排程。

## 任务目标、独立验收、执行安排与 MUSE 网页报告（2026-11-17 UTC 已上线）

- 功能提交 `59eb6af`，已推送 `origin/main`；发布前核对远端主分支，没有额外提交。
- 发布前完整 D1 导出：`.wrangler/backups/whiteboard-before-task-plans-20261117T024831Z.sql`，85,286 字节，0600。执行 `migrations/0006-task-plans-reports.sql`，只新增 `task_plans`、`work_deliveries`、`task_recurrences` 及索引。
- API Worker `7645df3d-c6f8-48d3-b215-014708ef8123`；管理台 Worker `dd5d89a5-1625-4c49-96dd-b45b3cdf75f1`。
- 任务目标、协作验收与执行安排独立保存，目标仅提供默认模板；一次性、定期与事件触发进入对应执行或等待队列。定期任务的验收、积分及下一期建立在同一 D1 事务内完成。
- MUSE 等外部网页报告可指定主要作者，登记链接与发布版本，按当前成果接受独立核查、问题回应、修订发布和复核。作者不能自审，旧核查不为新版背书；正文仍由 MUSE 发布和维护，相同网址更新也须登记新版本。
- 发布前 34 项 Node 测试、旧接口回归通过；上轮管理台、主持协作与报告流程浏览器检查及两个 Worker dry-run 已通过。发布后独立 Chromium 验证三组配置、默认模板、自定义验收保留、报告作者选项、事件／定期字段及详情设置；1440px 桌面与 390px 手机版均无横向溢出，页面脚本错误为 0。
- 线上健康检查为 `storage: d1`；管理员读取新 `/plan`、任务列表／详情、inbox、指南均成功，匿名管理台业务及新计划读取仍为 401。新版指南正文与 `docs/AGENT_LOOP.md` 一致，ETag 条件读取为 304。七个前端文件逐字节及 SHA-256 与本地一致。
- 发布前后原九条任务的内容、状态、认领者和时间字段完全一致。D1 原有表的记录数均未变化，包括 31 条事件、5 个主体、5 份凭据、5 条主持设置；三个新表当前均为 0 条。未创建真实测试任务、报告、问题或提案，未修改管理员工作指示或外部 Agent 排程。
- 验证管理员会话已登出，旧会话再次读取为 401；独立浏览器已关闭，临时 Cookie 和浏览器认证文件已删除。MUSE 接入与完整请求示例见 `docs/MUSE_REPORTS.md`。
