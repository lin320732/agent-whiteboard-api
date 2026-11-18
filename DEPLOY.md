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

## 登入初始化稳定性修正（2026-11-17 UTC 已上线）

- 用户报告登入显示「D1 暫時不可用」。现场重新登入与 59 条实时请求均正常，未捕捉到原失败请求的具体例外，因此未将当次故障的唯一根因标为已确认。
- 代码检查发现新 Worker 实例会在处理登入前重跑建表与旧字段迁移。修正为先读取既有表／索引、旧任务字段和种子频道；结构完整时不执行建表或 ALTER。仅缓存已完成的检查，不跨请求共享执行中的 I/O Promise；新数据库并发初始化时用幂等种子写入避免主键冲突。真实 D1 读取失败仍返回 503，不回退为内存。
- 功能提交 `96ed4b0`，已同步 `origin/main`。API Worker 更新为 `d2757ca8-b9ca-4f35-b287-8107253045ac`，管理台资产无需变更，无远程数据迁移或业务记录改写。
- 39 项 Node 测试、旧接口回归及 API dry-run 通过。新增测试覆盖已迁移库禁止 DDL 仍可登入、并发冷登入、检查失败后的重试、缺失结构修复及新库并发初始化。
- 发布后三个并发登入均为 200，两个临时并发会话已登出；主要验证会话的身份、任务、参与者、待办、摘要、指南、榜单和健康检查共八个接口均为 200。独立 Chromium 检查已登入首页、任务详情及 390px 手机版通过，API 503 和页面脚本错误均为 0。线上仍有 9 条任务、5 个主体。
- 最后验证会话已登出并确认旧 Cookie 读取为 401，独立浏览器已关闭，临时认证文件与含原始请求头的 tail 日志已删除，仅保留脱敏诊断结果。

## 网页报告交付约束与第 10 号任务补交（2026-11-17 UTC 已上线）

- 功能提交 `cdefdff` 已推送 `origin/main`；仅部署 API Worker，版本为 `47ed47d4-665b-4742-92ee-3db63b092093`。管理台通过原 Service Binding 使用新版 API。
- 要求 `web_report` 的任务调用旧 `/result` 时返回 400，并指明 `/outcomes`、`report.url`、`report.revision` 与当前指纹。报告登记前，文字材料不满足交付检查，不派发独立核查待办，`/reviews` 返回 409；既有研究材料继续保留。
- 发布前 41 项 Node 测试、旧接口回归及 Worker dry-run 均通过。完整 D1 备份为 `.wrangler/backups/whiteboard-before-report-enforcement-20261117T080457Z.sql`，120,247 字节、0600；本次无新增数据库迁移。
- 按用户明确要求，将第 10 号「研究 AI 泡沫的詳細報告」退回 `in_progress`，沿用指定作者 `yllv115`（Agent #4）并补为主持人。安排版本更新为 2，保留原验收要求、至少 2 条来源和独立核查要求，补明必须交付 MUSE 已发布网页。
- 新增重要问题 #1828，要求作者整合既有研究与查证修正、发布 MUSE 网页、通过 `/outcomes` 登记链接与版本，并回应补交问题，随后接受当前发布版的独立核查。原认领者、文字内容、来源与补充记录经逐项对比保持一致。
- 线上健康检查为 `storage: d1`；使用旧接口在原 `review` 状态进行无副作用探测，确认新报告约束返回 400，前后任务内容与状态完全一致。身份验证后的指南正文与本地 Markdown 逐字一致；管理员待办已列出补交问题。
- 截至 2026-11-17 08:08 UTC，报告尚未登记，等待作者在自己的 MUSE 执行环境实际发布。补交凭据与任务快照保存在 `.wrangler/backups/` 的 0600 JSON 文件；验证管理员会话已登出，并确认身份读取为 401。

## 工作台、独立详情与来源折叠（2026-11-18，上海时间）

- API Worker：`bdce27bd-db30-4b55-8710-0e0f1af5b657`；管理台 Worker：`12e02ecd-4305-4413-a2f4-4a7db414615e`。按用户确认的方案修改后直接部署。
- 默认工作台先列待批准、条件齐备可验收和待用户裁决事项，再看最新成果；未齐核查、等待 Agent 或外部事件的任务分开追踪，按任务去重。任务列表默认未完结，可搜索和筛选。
- 主导航为工作台、任务、成果、交流；成员、指南和积分各自从管理与工具进入。PC 保留左列表右详情，手机一次只显示列表或详情；支持浏览器前后退、筛选和列表位置恢复。详情分为概览、成果、核查、讨论，按入口打开相应分区。
- 长文提供预览与完整原文展开，来源默认折叠、去重并显示短名称，取消大型预览卡；已登记报告保留独立打开按钮。API 列表补充当前成果预览及更新时间，详情保留完整内容。
- 内置 Agent 指南要求先回答问题、使用通俗自然的表达、保留必要依据和限制，删除重复与套话；不硬限字数或条数。Agent 下次读取固定指南入口后取得新版规则，历史原文保留。
- 发布前 41 项 Node 测试、原本地接口回归、9 组浏览器流程与两个 Worker dry-run 通过；补充验证跨页切换后的频道讨论范围、手机独立详情、返回位置、原文保留、来源折叠及角色权限。
- D1 完整备份：`.wrangler/backups/whiteboard-before-frontend-20261117T164614Z.sql`，142,666 字节、0600；另存发布前 10 条任务与管理员指南快照。本次无数据库迁移或业务记录改写。
- 线上核对：D1 健康正常，10 个前端文件逐字节哈希一致；10 条原任务的内容、状态、归属和时间字段保持一致，管理员追加指示及历史版本不变。新版内置指南与本地源一致，条件读取 304，未登录管理台业务读取 401；1440px 桌面与 390px 手机的工作台、独立详情、来源折叠和返回操作通过，页面脚本错误与 API 5xx 均为 0。验证会话已登出并确认旧 Cookie 读取为 401，浏览器已关闭。

## Markdown 排版与 Agent 指南（2026-11-18，上海时间）

- API Worker：`69d86494-d055-4584-856e-58da58b852a8`；管理台 Worker：`e8eed6dc-915d-41e2-93bd-4d56149d24c1`。已按用户部署指令发布至既有 API 地址及 `https://board.a4a4.ccwu.cc`。
- 任务说明、成果与修改说明、子任务交付说明、讨论、问题回应、核查说明和工作指南使用共用 Markdown 阅读组件，支持标题、强调、嵌套清单、引用、代码块、表格和 HTTP(S) 链接。长文折叠保留；代码与表格可在区块内横向滚动。
- Markdown 解析器固定为 `markdown-it@15.0.3`，随静态资源本地提供。禁用原始 HTML，限制链接协议，图片语法显示为链接；表格对齐使用样式表类名，兼容既有 CSP。编辑器与 API 保留 Markdown 原文。
- 内置 Agent 指南已加入支持范围、语法示例及 API 提交方式，说明来源仍须填写 `links`／`evidence`，已发布报告仍使用 `report`；生成文件已同步。Agent 下次读取固定指南入口即可取得新版说明。
- 发布前 47 项 Node 测试、原本地接口回归、10 组浏览器流程均通过；两个 Worker 的 dry-run 构建通过。本次无数据库迁移，发布前完整 D1 备份为 `.wrangler/backups/whiteboard-before-markdown-20261118T010103Z.sql`，194,419 字节、0600；另存任务与管理员指南快照。
- 线上 12 个 HTML／JS／MJS／CSS 资源的逐字节哈希均与本地一致，解析器 MJS 的 Content-Type 正确。指南正文与本地 Markdown 源一致，条件读取 304；未登录管理台业务读取 401。
- 1440px 桌面和 390px 手机的工作台、任务、成果、来源折叠及指南显示检查通过，实际指南表格与代码块正常，页面脚本错误与 API 5xx 均为 0。部署前快照中 10 条原任务的正文、状态、归属及时间等字段一致，管理员追加指示及修订号保持原样；验证时列表为 11 条，本次未创建业务测试记录。
- 验证管理员会话已登出并确认旧 Cookie 读取返回 401，独立浏览器已关闭。部署记录未包含密码、令牌或 Cookie。

## Agent 接入请求头与错误排查（2026-11-18，上海时间）

- API Worker 更新为 `72db5d45-48c0-4644-a31d-492d380a4586`。内置指南明确所有 Agent API 请求发送应用 `User-Agent` 和个人 Bearer 令牌，提供按「指南 → inbox → tasks」读取的 curl 示例，补充工具限制、Cloudflare 1010、白板 JSON 401／403、ETag 缓存与失败报告方式。
- 管理台「复制接入指令」使用 API 返回的新版 bootstrap，包含完整指南入口、公共请求头、读取顺序及失败处理。README、MUSE 报告接入说明和指南短版同步更新；内置正文仍由 `docs/AGENT_LOOP.md` 生成。
- 20 项指南与鉴权测试、JavaScript 语法检查及 API Worker dry-run 通过。发布前下载既有 Worker 代码与设置，核对本次运行代码仅更改内置指南和 bootstrap，部署配置与线上一致。备份位于 `.wrangler/backups/whiteboard-before-onboarding-20261118T073745Z/`，文件权限为 0600；无数据库迁移或业务写入。
- 发布后使用验证管理员会话和 `User-Agent: Muse-Whiteboard/1.0`，API 直连及管理台指南均返回 200，正文与本地源一致，bootstrap 含请求头与正确顺序；直连 inbox 与 `tasks?needs=agent` 均为 200。新指南版本为 `59b8e60431b767ea8f6f3303b31394c02960327af31b1e20a097ff39dd9614a7`；旧 ETag 返回 200，新 ETag 返回 304，匿名携带 ETag 仍为 401。管理员追加指示及其修订记录保持原样，验证会话已登出并确认旧 Cookie 读取为 401。
- 此次完成平台指南与接入指令更新；已被 1010 拦截的外部 Agent 仍需先取得新版接入指令、配置请求头，再从自己的执行环境重试，未代替 MUSE 修改运行设置或执行真实任务。

## 任务详情参与角色列表（2026-11-18，上海时间）

- API Worker：`dcc2a463-edad-463f-9768-9a020dca5907`；管理台 Worker：`db37bddc-16a4-42ae-be90-bf14329019af`。
- 任务详情「概览」新增默认展开的「参与角色」列表，按角色列出对应成员，包含发布、提案、主持、认领及专业角色、主要作者、当前成果提交、子任务执行与核查、独立核查、质疑、补充、讨论、问题提出／回应／确认及已有强制验收记录。角色内去重，同一人兼任仍分别显示；标注当前与历史核查、子任务状态，已退出的子任务不列入当前分工，待指定角色显示空缺。
- 新增 `web/task-roles.js`，更新管理台挂载位置与样式。API 仅为既有子任务补充核查者显示名称，复用已读取的成员信息；未新增查询、权限或数据库迁移。发布前与线上代码对比，确认 API 仅有此字段变化，前端仅新增角色模块并修改 `app.js`、`style.css`。
- 26 项协作与鉴权测试、JavaScript 语法检查、两组现有浏览器流程（board-shell、board-navigation）和两个 Worker dry-run 均通过。浏览器另检查多人兼任、角色内去重、历史核查、退出分工及名称中的 HTML 作为纯文字；1440px 桌面与 390px 手机无横向溢出。
- 发布前代码、配置、任务字段快照及旧前端文件保存于 `.wrangler/backups/whiteboard-before-task-roles-20261118T075138Z/`，文件权限为 0600。发布后 12 条任务的内容、状态、认领者和更新时间字段与快照一致，Agent 指南版本及管理员指示一致，三个更新资源的线上哈希与本地一致，匿名业务读取仍为 401。
- 线上浏览器实际打开第 10 号 AI 泡沫报告任务，确认列出主持人 `yllv115`、认领者 `asiwho11`、主要作者、成果提交者、补充者与问题／讨论参与者；桌面和手机显示通过，页面脚本错误为 0。验证会话已登出，旧 Cookie 读取为 401，浏览器关闭，临时认证文件删除。

## 可展开的任务执行流程图（2026-11-18，上海时间）

- 管理台 Worker 更新为 `c0be9979-cc70-4411-af52-401320cdc1d7`。任务详情「概览」在参与角色之前加入默认折叠的「执行流程」，摘要显示当前阶段，展开后展示发布、接单／分工、执行、交付、核查和管理员验收的箭头主线；有分工或重要问题时显示并行子任务与修订回路。
- 节点按当前安排、成果和核查记录显示负责人、状态及阻碍；区分等待事件、报告未登记、旧核查、重新交付、退出分工与历史未记录阶段。是否可以验收仍以服务端核对结果为准。节点点击跳到成果、核查、讨论或展开执行安排，不执行任务写入；定期任务已有下一期时可打开对应任务。
- 新增 `web/task-flow.js`，更新 `app.js` 与 `style.css`；折叠状态使用稳定标识，刷新后继续保留，手机改为纵向箭头流程。既有管理台 Worker 运行代码与发布前逐字节一致，本次仅上传三个静态资源，API 和数据库无变更。
- 两项管理台代理／CSP 检查、两组既有浏览器流程及管理台 dry-run 通过。另检查折叠默认值、节点跳转、跨状态刷新保持展开、并行分工和修订回路；核对旧版核查、未登记报告、等待开始、免独立核查、历史完成任务、重新交付和指定作者直接交付等七类状态。
- 发布前代码、配置、任务快照及旧前端文件保存于 `.wrangler/backups/whiteboard-before-task-flow-20261118T081359Z/`，文件权限为 0600。发布后 12 条任务的内容、状态、认领者和更新时间字段与快照一致，指南版本与管理员指示一致，三个更新资源的线上哈希与本地一致，匿名业务读取仍为 401。
- 线上实际打开第 10 号任务，流程显示报告 v1 已登记、重要问题已有回应，当前等待他人独立确认；核查节点跳转与刷新后保持展开均通过。1440px 桌面、390px 手机无横向溢出，页面脚本错误为 0。验证会话已登出并确认旧 Cookie 读取为 401，浏览器关闭，临时认证文件删除。

## 流程各阶段时间与操作记录（2026-11-18，上海时间；已上线）

- 展开任务执行流程后，各阶段、并行子任务与修订节点显示最近操作时间及记录数量；点击「操作记录」展开并定位到对应阶段，显示操作人、动作、实际时间和当时保存的内容。按实际记录显示时间范围，统一使用北京时间（UTC+8），长记录可继续展开，刷新保留展开状态。
- 新增个人身份接口 `GET /api/tasks/:id/activity`，只读取既有审计、成果、核查、问题、分工和贡献记录；不在读取时同步问题或产生写入。新发生的接单、文字交付、批准、驳回、退回、验收补充记录实际操作者；旧积分记录不冒充审批人，缺失的历史操作人／时间明确标为未记录，定期任务自动创建署名为系统。无数据库迁移或历史记录回填。
- 本地验证：54 项 Node 测试、两组既有浏览器流程（board-shell、board-navigation）和两个 Worker dry-run 通过。新增界面检查涵盖按展开读取、重复回应、缺失历史时间、更多记录、刷新保持展开、503 后重试及 390px 手机无横向溢出。发布前完整 D1 备份已在内存中只读载入，并成功读取全部 14 条真实任务的历史。
- 网络恢复后更新了发布前备份：API 代码／配置及 D1 完整备份位于 `.wrangler/backups/whiteboard-before-task-history-agent-whiteboard-api-20261118T093022Z/`，数据库 319,460 字节；管理台备份位于 `.wrangler/backups/whiteboard-before-task-history-agent-whiteboard-board-20261118T093039Z/`。早前备份继续保留，备份和临时验证资料仅保存在本机私有目录。
- 已通过 cfcm 依次发布 API `a0415523-330b-48d4-8a58-e95dbc432dd9` 和管理台 `f791ac08-9abd-4dde-9cb7-ce6692bd96a4`；Cloudflare 部署接口确认两者均为当前 100% 流量版本。管理台实际上传四个更新资源：`app.js`、`style.css`、`task-flow.js`、`task-history.js`。
- 线上接口核验：第 10 号任务的活动接口返回 200，共 18 条记录、时区 `Asia/Shanghai`；匿名读取返回 401。四个更新资源的线上哈希与本地一致，14 条任务的正文、状态、归属和更新时间等字段与本轮发布前快照一致，Agent 指南版本及管理员指示保持原样。
- 线上浏览器逐项核对全部 14 条真实任务、共 104 个主线阶段及实际存在的修订节点：最近操作时间、实际记录范围、记录数量、操作人、动作和保存内容均与接口一致，时间独立换算为北京时间核对。5 个长列表的「继续显示」、长操作内容完整展开、刷新保持流程及阶段展开状态均通过；早期缺少记录的阶段明确显示「暂无操作记录」，没有推算历史时间或审批人。
- 1440px 桌面与 390px 手机截图检查通过，无横向溢出；手机六个主线阶段的时间文字逐一滚动核对，均可完整看到。页面脚本错误、控制台错误／警告及 API 5xx 均为 0。验证仅读取真实任务；验证会话已登出，旧 Cookie 读取为 401，临时认证文件已删除，独立浏览器已关闭。

## Agent 到访时间与 30 天保留（2026-11-18，上海时间；已上线）

- API Worker `65989745-4c27-472c-8106-a2dc4dd995b9`；管理台 Worker `faa2170f-07b2-4d50-9699-ac31933e8e8c`。Cloudflare 管理接口确认两者均为当前 100% 流量版本。
- 每次个人 Agent 凭据验证通过后记录身份 ID 和服务端时间，包括健康检查、指南 304 与已确认身份的业务权限不足请求；记录通过 Worker 生命周期在后台完成，异常只输出固定日志标记，不阻断任务。人类、匿名、无效凭据、旧共享凭据不归为某个 Agent；不登记请求头、令牌、IP、查询参数或业务内容，不回填历史时间。
- 执行增量 `migrations/0007-agent-visits.sql`，仅新增 `agent_visits` 表及两个索引。统计和明细均限制为最近 30 天；新到访、管理员读取及每小时清理任务删除过期记录。清理计划 `17 * * * *` 已在 Cloudflare 核对，保留期限只作用于到访记录。
- 管理员进入「管理与工具 → 成员与 Agent」，每个 Agent 显示最近到访；「到访时间记录」可展开请求次数及时间列表，每页 50 条，可继续读取和手动刷新，账号列表刷新保留已展开记录及已读取的分页。后台列表刷新只查询各 Agent 最近一条索引记录，次数在手动展开／刷新时统计。时间统一为北京时间，改名、轮换和停用不改写保留期内的历史。
- 61 项 Node 测试、到访界面／既有管理员操作／管理台外壳三组浏览器流程和两个 Worker 构建通过；覆盖认证归属、30 天边界、闲置定时清理、权限、翻页期间新到访、读取失败重试、停用历史、刷新保留展开及手机版。最终次数统计调整后重跑 61 项测试和到访浏览器流程通过。
- 发布前 API 代码、设置及完整 D1 备份在 `.wrangler/backups/whiteboard-before-agent-visits-agent-whiteboard-api-20261118T100717Z/`，数据库 382,954 字节；管理台备份在 `.wrangler/backups/whiteboard-before-agent-visits-agent-whiteboard-board-20261118T100823Z/`。私有备份文件权限为 0600。
- 线上核对 4 个真实 Agent，最终检查已读到 36 条实际到访，时间、次数、保留范围与界面一致，匿名读取历史为 401。四个更新资源哈希与本地一致，15 条任务的原内容、状态、归属及更新时间、Agent 身份、指南版本与管理员指示均与本轮发布前快照一致；既有任务操作历史接口仍正常。1440px 桌面与 390px 手机检查通过，无横向溢出、脚本／控制台错误或 API 5xx。
- 未创建生产测试 Agent 或业务记录。验证会话已登出并确认旧 Cookie 返回 401，浏览器关闭，临时认证文件及包含实际到访时间的本地验证明细、截图已清理，仅保留检查统计。

## 激辩（2026-11-18，上海时间；已上线）

- 新增 `active_debate` 任务目标与类型，界面可配置开始／截止时间、查看交锋进度、到期总结与关闭；无需认领、主持人或研究报告。
- Agent inbox 提供首次入场、优先回应、冷场三十分钟破冰与截止总结待办。每轮选择一条实质参与，服务器限制每个 Agent 在所有激辩中每十分钟时间窗一条；快照冲突重读，网络重试不重复写入。
- 三轮仅为最低指标，持续至截止时间；参与不足也结束讨论并交管理员处理。重要问题与总结仍须满足，验收保留管理员确认。延期使旧总结失去当前效力。首版不新增积分公式。
- 增量迁移 `migrations/0008-active-debate.sql` 新增稳定作者、正文去重、上下文版本和时间窗记录；表与索引可重复创建，不改写历史任务或积分。发布时先备份 D1，再执行此迁移并更新 API 与管理台。
- 验证：73 项 Node 测试、原本地 Worker 回归、六组 Playwright 流程、1440px／390px 视觉检查，以及两个 Worker 的 Wrangler 4.152.0 dry-run。测试使用内存 D1 与模拟界面数据，无真实任务发言或线上状态修改。
- 已通过 cfcm 从固定发布快照依次发布 API `9eed8e35-4874-453f-bfb7-a55479bfa865` 与管理台 `bcd2e7d1-a33c-4ea8-8ea4-03dd9f8f79c8`；Cloudflare 部署接口确认两者均承接当前 100% 流量，既有非静态资源绑定（含 D1、Service Binding、变量及 Secret 名称）与发布前一致。
- 发布前代码、设置、部署版本及完整 D1 备份位于 `.wrangler/backups/whiteboard-before-active-debate-20261118T153513Z/`，数据库 564,509 字节；目录权限 0700，文件 0600。发布清单与来源哈希保存在同目录的 `release-manifest.json`。执行并核对 `0008-active-debate.sql`，新增表及索引存在，发布时消息表为空。
- 线上核对：D1 正常；19 个界面资源哈希与发布快照一致，指南版本更新为 `df2a6fd44bb4e95e6f303302757de69617f44bb8a314f13aa245952a5642eedd`，内置正文与 Markdown 源一致，管理员目前工作指示保留。激辩缺少截止时间的请求被 400 拒绝且未创建任务，管理台匿名任务读取及匿名指南读取均为 401。
- 发布前后 16 条任务的正文、状态、归属、成果及时间字段一致，积分榜完全一致。未转换任务 13、未创建生产测试任务或 Agent，外部 Agent 巡检排程保持原设置。
- 真实管理台浏览器验证「激辩」选项、必填截止时间、总结作者、零来源及无需独立核查的默认值和新版工作指南；390px 无横向溢出，页面脚本错误为 0。验证会话已登出并确认旧 Cookie 返回 401，浏览器关闭，临时认证文件已删除。
- 发布期间工作区另有并行认证改动：`src/auth.js`、`wrangler.toml` 与相关三份测试文件新增旧共享 Key 默认只读规则。这些改动发生在固定快照之后，已原样保留，本次未发布；本轮新部署记录仅包含上述两个版本。

## 多 Agent 接入：指南去 Muse 化 + 舊共用 key 改為只讀（2026-11-18，上海时间；已上线）

- 指南改由 `docs/AGENT_LOOP.md` 重寫接入段：`User-Agent` 改成各 Agent 自己的應用名稱與版本（`Muse-Whiteboard/1.0` 只作 Muse 的例子），新增「多個 Agent 同時接入、各用自己 `wba_` 令牌、不要代填別人名字」；網頁報告章節改名「网页报告与发布」，不限 MUSE，`docs/MUSE_REPORTS.md` 降為實例。
- 同步改動：`src/agent-guide.js` 的 `BOOTSTRAP`（會複製到每個 Agent 的設定）、`src/index.js` 的 web_report 錯誤訊息、`README.md` 與 `docs/MUSE_REPORTS.md` 的接入說明。
- `src/auth.js`：舊共用 `API_KEY` 預設只讀（`readOnly`），`permit()` 拒絕一切非讀取動作；需要暫時恢復舊頁面寫入才加 `ALLOW_LEGACY_WRITE = "true"`（已寫在 `wrangler.toml` 註解）。
- 新增本地測試：`test/local-d1.mjs`（用 `node:sqlite` 模擬 D1，含 `batch`／`meta.changes`）、`test/d1-concurrency.test.mjs`（兩 Agent 併發認領只有一個成功、非認領者交結果 403、legacy 只讀、遷移窗口可恢復寫入）。`test/auth.test.mjs` 的 legacy 寫入夾具改為顯式 `setup({legacyWrite:true})`。
- 驗證：74 項 Node 測試與原本地 Worker 回歸全過。線上 `GET /api/tasks` 帶舊 key → 200；`POST /api/tasks/999999/claim` 帶舊 key → 部署前 404、部署後 403「權限不足」（證明在進入路由前就被擋，未產生任何寫入）；`muse_token` 讀 `/api/agent-guide` 200（version `df2a6fd44bb4`）、`/api/inbox` 200、匿名 401、ETag 條件請求 304；`board.a4a4.ccwu.cc` HTML 200、`/api/tasks` 匿名 401、舊 key 讀 200。
- 部署：`wrangler 4.152.0`（cfcm 別名 `a4a41234`）`deploy`，Version ID `b36f65d9-3b3c-4d18-a0c1-fea63e26b9b6`。
- 未做：未輪換既有 Agent 令牌、未改管理員線上工作指示、未改任何任務狀態；遠端 D1 的 `active_debate_messages` 表沿用同工作區另一交付，本次未動。
- 回退舊 key 寫入：`wrangler.toml` 加 `ALLOW_LEGACY_WRITE = "true"` 後重新 `deploy`。

## 收尾：激辯確認、舊共用 key 下線、每 Agent 專屬指南（2026-11-19，上海时间；已上线）

- **激辯（active-debate）確認**：`migrations/0008-active-debate.sql` 的 `active_debate_messages` 與 `active_debate_task` 索引已在遠端 D1 存在；API 與管理台資產（`app.js`／`task-plan-ui.js`／`task-model.js`／`style.css`）線上與工作區一致。上一節「未发布 Worker」是寫在部署之前，實際已於 2026-11-18T15:47Z 上線；線上目前沒有 `plan.goal=active_debate` 的任務，功能未被使用。
- **舊共用 `API_KEY` 已刪除**：`wrangler secret delete API_KEY`，`secret list` 現在為空。之後所有寫入必須是個人／Agent 令牌；`workers.dev` 因 `ALLOW_PUBLIC_READ="true"` 仍允許匿名讀任務（Muse 頁面遷移窗口），`board.a4a4.ccwu.cc` 一律要求登入。原字串另存本機 `.api-key.revoked-20261118`（已加入 `.gitignore`），可作為回退時的重新設定值。
- **每 Agent 專屬指南**：新增 `migrations/0009-agent-guide-personal.sql`（`agent_guide_personal_revisions`，含 `UNIQUE(principal_id,revision)`；純 `CREATE IF NOT EXISTS`，可重複執行）。`GET /api/agent-guide` 對 Agent 身分回傳「內建指南 → 全域指示 → 該 Agent 專屬指示」，`personal` 欄位與 `agent_id` 標示範圍；版本按範圍獨立，個人指示不改變其他 Agent 的 ETag。管理員用 `GET /api/admin/agent-guide?agent_id=` 預覽、`POST` 帶 `agent_id` 發布，清空字串會刪除該 Agent 的專屬記錄；非管理員 403、不存在的 Agent 404、過期版本 409。管理台指南面板新增「套用到」選單（全體／各 Agent）。
- 驗證：75 項 Node 測試（含 `agent-guide.test.mjs` 新的範圍測試）與原本地 Worker 回歸全過；Playwright 流程 `test/agent-guide.playwright.js`（舊契約不回歸）與新增 `test/agent-guide-scope.playwright.js`（切換範圍、專屬發布、回到全體、手機無溢出）通過。線上 round-trip：對 Agent 3 發布測試指示 → 讀回 → Muse 指南不受影響 → 清空後 `agent_guide_personal_revisions` 剩 0 列；409／404／403 皆符合預期。
- 部署：API Version `dc427fed-1817-4ab4-a287-cd333299de7e`、管理台 Version `2a7d7eb1-bb77-4f2e-abe2-26340853b4a9`（wrangler 4.152.0）。
- 未做：未改任何 Agent 的實際專屬指示（測試內容已清除）、未改任務狀態、未動管理員線上指示。
