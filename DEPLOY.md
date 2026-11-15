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

- 本目录现已连接 GitHub 的 `origin/main`，在 `feat/whiteboard-console-auth` 分支开发；实际 `wrangler.toml` 保留原 Cloudflare Account ID 与 D1 ID。Secret 原文不进入 Git。
- API 在 v0.2.2 基础上加入 D1 存储的人类账号与独立 Agent 凭据、管理员会话；旧 `API_KEY` 在过渡期只允许 Agent 操作，不能审批、核对、退回或强制通过。
- 控制台 Worker 名 `agent-whiteboard-board`，域名 `board.a4a4.ccwu.cc`，通过 Service Binding 访问后端，不开放控制台的 workers.dev 和 Preview URL。
- 首次上线前已备份原 D1 到本机 `.wrangler/backups/whiteboard-before-022-auth.sql`（0600），然后执行 `migrations/0001-auth.sql`：仅建 `force_approvals`、`debate_messages` 和权限相关新表，不覆盖原任务。线上仍有 5 条任务、1 个频道。
- 配置 `ALLOW_PUBLIC_READ=true` 供 Muse 过渡期从**原 API 地址**读取；管理台域名下 `/api/*` 始终需要登录。所有客户端换成个人 Token 后改为 `false` 并删除旧 `API_KEY`。此阶段原 API 仍有匿名读取，务必按 `docs/MUSE_MIGRATION.md` 完成切换后再关闭。
- 本地验证：`node test-local.mjs` 全部通过，`node --test test/*.test.mjs` 10 项通过；API 与控制台的 Wrangler dry-run 构建通过。

已按上述顺序部署。初次上线健康检查曾返回 503：Worker 端 D1 `exec` 不接受多行 `CREATE TABLE`；改为逐条单行执行并增加回归测试后重新发布，健康检查恢复 `version: 0.2.2, storage: d1`。控制台域名 GET `/` 为 200，**未登录访问控制台 `/api/tasks` 为 401**，管理员登录后为 200；原 API 的业务 GET 迁移期为 200。旧 `API_KEY` 的 verify/approve 为 403。已建立初始管理员 `owner`，本机登录资料位于 `.admin-login.json`（0600，未入 Git）；管理员会话登录和账号列表通过，个人 Muse 令牌尝试管理接口得到 403。一次性 `BOOTSTRAP_KEY` 已从 Cloudflare 与本机删除，API_KEY 仍保留供迁移期 Agent 使用。

**尚待 Muse 迁移：** 当前 `ALLOW_PUBLIC_READ=true`，业务 GET 暂时公开。按 `docs/MUSE_MIGRATION.md` 改完 Muse，并给现有 Agent 发独立令牌之后，才把读取开关设为 `false` 并从 Cloudflare 删除旧 `API_KEY`；此步需和 Muse 维护者协调。

