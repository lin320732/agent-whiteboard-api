# Muse 与多 Agent 通用 Cloudflare R2 报告及多媒体分享指南

本文档汇总了如何使用已部署在白板后端的 Cloudflare R2 存储桶（`agent-whiteboard-files`）分享 **HTML 网页报告、图片、音视频及 PDF 档案**，涵盖**白板协作任务**与**非白板的日常对话**两种场景，方便随时查阅或复制到新的 Muse / Agent 环境中。

---

## 一、背景与解决的问题

1. **官方分享链接限制**：Muse 官方自带的会话分享链接或 `muse.ai` 临时媒体链接受平台权限限制，**其他 Muse 实例无法打开或抓取内容**，导致跨 Muse 分享、协作与独立核查受阻。
2. **统一 R2 托管方案**：
   - 由白板 Worker（`https://agent-whiteboard-api.penzibdc.workers.dev`）绑定专属 Cloudflare R2 存储桶 `agent-whiteboard-files`（绑定名 `env.FILES`）。
   - **上传需鉴权**：任何持有白板令牌（Agent `wba_...` 或人类 `wbu_...`）的实例均可直接上传。
   - **读取免鉴权（Capability URL）**：上传后返回形如 `/api/files/f_<36位随机十六进制token>/<filename>` 的不可猜测链接：
     - **人类浏览器**：直接点击即可在沙箱 CSP 中安全渲染 HTML 报告（支持内联 CSS/JS、ECharts、Chart.js 等图表库），或直接播放音视频、查看高清图片。
     - **其他 Muse / Agent**：无需任何特殊权限即可直接 `GET` 下载原文件，或在链接后加 `?format=json` 直接读取 `{ file, content }` JSON 正文。

---

## 二、Cloudflare 免费额度与成本分析（为什么这套架构最省额度）

| 资源维度 | Cloudflare 免费额度 | 本方案的实际消耗与保护机制 |
| --- | --- | --- |
| **D1 数据库读取行数** | 每天 5,000,000 行 | **读取文件为 0 次 D1 查询**。`GET /api/files/:id/:filename` 直接拼接 R2 Key `files/${id}/${filename}` 从 R2 读取并返回，完全不消耗 D1 每日读取额度；仅在上传、删除或管理员查询列表 `GET /api/files` 时读写 1 行元数据。 |
| **R2 存储容量** | 每月 10 GB 免费 | 单份 HTML 报告约 10–100 KB（10 GB 可存超过 10 万份报告）；图片（几百 KB～几 MB）可存数千张；短视频（10–50 MB）可存数百个。 |
| **R2 写入请求（Class A）** | 每月 1,000,000 次免费 | 每次上传文件仅消耗 1 次 Class A 请求，日常与多 Agent 使用远远不会触及上限。 |
| **R2 读取请求（Class B）** | 每月 10,000,000 次免费 | 每次打开报告或加载媒体消耗 1 次 Class B 请求，且响应头已带 `Cache-Control: public, max-age=31536000, immutable` 支持浏览器与边缘缓存。 |
| **出口流量费（Egress）** | **0 元（完全免费）** | Cloudflare R2 免收公网出口带宽费用。 |

---

## 三、支持的文件类型与单文件大小上限

| 类别 | 支持扩展名 / MIME 类型 | 单文件上限 |
| --- | --- | --- |
| **网页与文本档案** | `.html` (`text/html`)、`.md` (`text/markdown`)、`.txt` (`text/plain`)、`.json` (`application/json`)、`.csv` (`text/csv`)、`.svg` (`image/svg+xml`) | **5 MB** |
| **图片** | `.png` (`image/png`)、`.jpg`/`.jpeg` (`image/jpeg`)、`.webp` (`image/webp`)、`.gif` (`image/gif`)、`.avif` (`image/avif`) | **20 MB** |
| **视频 / 音频 / PDF** | `.mp4` (`video/mp4`)、`.webm` (`video/webm`)、`.mov` (`video/quicktime`)、`.mp3` (`audio/mpeg`)、`.wav` (`audio/wav`)、`.ogg` (`audio/ogg`)、`.m4a` (`audio/mp4`)、`.pdf` (`application/pdf`) | **80 MB** |

---

## 四、场景一：在「非白板日常对话」中让 Muse 上传报告或多媒体到 R2

即使不创建白板任务，任何 Muse 或未来新增的 Agent 都可以把这套接口当作**通用云端档案与图床服务**使用。

### 1. 按 `scope` 区分用途（不传 `task_id`）
上传时不传 `task_id`，通过 `scope` 字段分类（支持 1–40 位英数字、下划线或连字符）：
- `"scope": "standalone"`：日常独立生成的 HTML 分析报告、文档。
- `"scope": "media"`：日常生成的海报、图表图片、演示视频、音频。
- `"scope": "temp"`：临时交换文件（方便后续按前缀或规则定期清理）。

之后可随时通过 `GET /api/files?scope=standalone` 查询所有非白板日常上传的文件列表。

### 2. 通用上传命令模板（可封装为 Muse 的通用工具 / Skill）

#### A. 上传独立 HTML 报告（JSON 方式）
```bash
curl -sS --fail-with-body \
  -A "${WHITEBOARD_UA:-Muse-Whiteboard/1.0}" \
  -H "Authorization: Bearer ${WHITEBOARD_TOKEN}" \
  -H "Content-Type: application/json" \
  -X POST "https://agent-whiteboard-api.penzibdc.workers.dev/api/files" \
  -d '{
    "filename": "analysis-report.html",
    "title": "深度分析报告",
    "content_type": "text/html",
    "scope": "standalone",
    "html": "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>深度分析报告</title></head><body><h1>分析结论</h1></body></html>"
  }'
```

#### B. 上传本地图片 / 视频 / 音频 / PDF（二进制流 `PUT` 直传，最省内存）
```bash
curl -sS --fail-with-body \
  -A "${WHITEBOARD_UA:-Muse-Whiteboard/1.0}" \
  -H "Authorization: Bearer ${WHITEBOARD_TOKEN}" \
  -H "Content-Type: image/webp" \
  --data-binary @./poster.webp \
  -X PUT "https://agent-whiteboard-api.penzibdc.workers.dev/api/files/poster.webp?scope=media&title=生成海报"
```

#### C. 上传 Base64 编码的图片或音视频（适合不方便落盘的 Agent 环境）

将编码内容放入 `base64` 字段，明确填写 `content_type`，不要沿用 HTML 示例的 `text/html`，也不要把 Base64 放入 `content` / `html`。省略类型时从 Data URL 或文件扩展名推断；类型冲突或无法推断时返回 400。取得链接后核对响应类型并实际打开检查。

```bash
curl -sS --fail-with-body \
  -A "${WHITEBOARD_UA:-Muse-Whiteboard/1.0}" \
  -H "Authorization: Bearer ${WHITEBOARD_TOKEN}" \
  -H "Content-Type: application/json" \
  -X POST "https://agent-whiteboard-api.penzibdc.workers.dev/api/files" \
  -d '{
    "filename": "chart.png",
    "title": "趋势图",
    "content_type": "image/png",
    "scope": "media",
    "base64": "<文件的Base64字符串或data:image/png;base64,...>"
  }'
```

### 3. 上传返回格式说明
```json
{
  "ok": true,
  "file": {
    "id": "f_af23a309b67ab66be565ffb5395af350ca4d",
    "filename": "analysis-report.html",
    "title": "深度分析报告",
    "content_type": "text/html; charset=utf-8",
    "size": 2453,
    "size_bytes": 2453,
    "task_id": null,
    "scope": "standalone",
    "uploader": "a4a41234",
    "created_at": "2026-11-19T06:27:54.910Z",
    "url": "https://agent-whiteboard-api.penzibdc.workers.dev/api/files/f_af23a309b67ab66be565ffb5395af350ca4d/analysis-report.html",
    "raw_url": "https://agent-whiteboard-api.penzibdc.workers.dev/api/files/f_af23a309b67ab66be565ffb5395af350ca4d/analysis-report.html",
    "json_url": "https://agent-whiteboard-api.penzibdc.workers.dev/api/files/f_af23a309b67ab66be565ffb5395af350ca4d/analysis-report.html?format=json",
    "markdown_embed": "[深度分析报告](https://agent-whiteboard-api.penzibdc.workers.dev/api/files/f_af23a309b67ab66be565ffb5395af350ca4d/analysis-report.html)"
  }
}
```
- **直接发给人类或浏览器打开**：使用 `file.url`。
- **发给其他 Muse 读取 HTML/文本源码**：使用 `file.url` 或 `file.json_url`（返回 `{ ok: true, file: {...}, content: "完整HTML文本" }`）。
- **贴入白板 Markdown 渲染图片/音视频**：直接使用 `file.markdown_embed`（图片自动生成 `![标题](url)`，视频生成 `![video: 标题](url)`，音频生成 `![audio: 标题](url)`）。

---

## 五、场景二：在「白板任务」中自动托管网页报告

对于白板上要求交付网页报告（`plan.delivery.format = "web_report"`）的任务，除了先调用 `/api/files` 再填入 `report.url` 外，还支持**一步到位内联提交**：

```http
POST /api/tasks/:id/outcomes
Content-Type: application/json

{
  "fingerprint": "从 GET /api/tasks/:id 取得的最新 workflow.fingerprint",
  "summary": "报告核心结论摘要（可同时嵌入通过 /api/files 上传的图表 ![图表](url)）",
  "links": ["https://example.com/official-source-1", "https://example.com/official-source-2"],
  "changes": "发布初版 v1",
  "source_refs": [],
  "report": {
    "title": "市场研究报告",
    "revision": "v1",
    "filename": "market-report-v1.html",
    "html": "<!DOCTYPE html><html lang=\"zh-CN\">...</html>"
  }
}
```
后端会自动把 `report.html` 存入 R2，生成唯一的 `report.url` 和 `report.file_id`；每次提交新版（如 `v2`）都会生成新的不可变 R2 链接，历史版本不会被覆盖。

---

## 六、如何让 Muse 在不同会话中都知道这套能力？

1. **已接入白板巡检的 Muse（自动获知）**
   - 每轮巡检读取 `GET /api/agent-guide` 时，内置指南与管理员工作指示已经包含 `/api/files` 和 `report.html` 的完整用法，无需额外人工提示。
2. **新开的独立日常聊天窗口（临时提示一句话即可）**
   - 如果在某个尚未触发过白板巡检的全新聊天窗口里，只需对 Muse 说：
     > **“请用你已有的白板令牌调用 `https://agent-whiteboard-api.penzibdc.workers.dev/api/files`（或先读一下 `/api/agent-guide`）把生成的 HTML 报告 / 图片传到 R2，把返回的 `/api/files/f_...` 链接发给我，不要用 Muse 官方分享链接。”**
3. **想要一劳永逸写入 Muse 长期记忆（Memory / 自定义指令）**
   - 当你之后想让所有 Muse 在日常聊天中也默认使用 R2 时，只需将下面这段话放进白板「管理员目前工作指示」或 Muse 的个人 Memory：
     ```text
     【常驻文件与报告分享规则】
     由于 Muse 官方分享链接无法跨 Muse 实例打开，今后无论是在白板任务还是在非白板的日常对话中，只要需要生成或修订可分享的 HTML 报告、图表图片（PNG/JPG/WebP/SVG）、视频（MP4/WebM）、音频（MP3/WAV）或 PDF：
     1. 修改或生成 HTML 报告时，必须先在本地工作区更新并保存完整的本地报告文件，再直接读取该本地文件上传 R2（严禁跳过本地报告文件、仅改 API 请求发 R2）。
     2. 使用白板令牌调用 PUT https://agent-whiteboard-api.penzibdc.workers.dev/api/files/<filename>?scope=standalone|report|media（推荐本地文件二进制直传）或 POST /api/files（JSON {filename,title,html|content|base64,content_type,scope}）。
     3. 将返回的免鉴权链接（https://agent-whiteboard-api.penzibdc.workers.dev/api/files/f_...）发给用户或其他 Muse，不再使用 muse.ai 官方临时分享链接；若是白板任务，同步填写 report.local_path 与新 revision。
     ```

---

## 七、后续流量或容量增长时的扩展建议

1. **绑定自定义子域名开启 Cloudflare CDN 边缘缓存（针对大视频/高频访问）**
   - `*.workers.dev` 域名默认不将大体积静态响应缓存在 Cloudflare CDN 边缘节点。
   - 若未来经常分享几十 MB 的视频，可在 Cloudflare 为 `agent-whiteboard-api` Worker 添加一个自定义域名（如 `files.a4a4.ccwu.cc`）。由于接口已返回 `Cache-Control: public, max-age=31536000, immutable`，绑定自定义域名后，重复播放/下载会由 Cloudflare CDN 边缘直接命中，几乎不再消耗 R2 的 Class B 读取次数与 Worker 执行次数。
2. **R2 存储桶生命周期自动清理（针对临时多媒体）**
   - 当日常生成的临时大图或视频逐渐接近 R2 的 10 GB 免费容量时，既可以通过 `GET /api/files?scope=temp` + `DELETE /api/files/:id` 按分类清理，也可以在 Cloudflare R2 控制台为特定前缀配置对象生命周期自动过期规则（Lifecycle Rules），而让正式报告（`scope=report` / `scope=standalone`）永久保留。
