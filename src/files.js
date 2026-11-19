import { originAllowed, permit } from './auth.js';

function randomToken(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return `${prefix}${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
}

export const FILES_SCHEMA = `
CREATE TABLE IF NOT EXISTS stored_files (id TEXT PRIMARY KEY, r2_key TEXT NOT NULL UNIQUE, filename TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', content_type TEXT NOT NULL, size INTEGER NOT NULL, uploader_id INTEGER NOT NULL, task_id INTEGER, scope TEXT NOT NULL DEFAULT 'general', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS stored_files_task ON stored_files(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stored_files_uploader ON stored_files(uploader_id, created_at DESC);
`;

export async function initFilesSchema(db) {
  for (const sql of FILES_SCHEMA.split(';')) if (sql.trim()) await db.exec(sql.trim() + ';');
}

export class FileError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const fail = (message, status = 400) => { throw new FileError(message, status); };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-File-Name, X-File-Title, X-Task-Id',
};

const json = (data, status = 200) => new Response(JSON.stringify({ ok: true, ...data }, null, 2), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
});

const MIME_BY_EXT = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
};

const EXT_BY_MIME = {
  'text/html': 'html',
  'text/markdown': 'md',
  'text/plain': 'txt',
  'application/json': 'json',
  'text/csv': 'csv',
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
};

const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_MEDIA_BYTES = 80 * 1024 * 1024;

// Hosted HTML reports run inside an opaque sandbox so they can render charts, styles
// and external libraries without ever accessing dashboard cookies or origin storage.
const REPORT_HTML_CSP = "default-src 'none'; base-uri 'none'; sandbox allow-scripts allow-forms allow-popups; script-src 'unsafe-inline' 'unsafe-eval' https: blob:; style-src 'unsafe-inline' https:; img-src * data: blob:; font-src * data:; media-src * data: blob:; connect-src https:; frame-src https:;";
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:;";

function baseMime(raw) {
  return String(raw || '').split(';')[0].trim().toLowerCase();
}

function sanitizeFilename(raw, fallbackMime = 'text/html') {
  const cleaned = String(raw || '')
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[\x00-\x1f\x7f<>:"|?*#%]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  const base = baseMime(fallbackMime);
  const defaultExt = EXT_BY_MIME[base] || 'bin';
  if (!cleaned) return `file.${defaultExt}`;
  const dot = cleaned.lastIndexOf('.');
  if (dot <= 0 || dot === cleaned.length - 1) return `${cleaned}.${defaultExt}`;
  return cleaned;
}

function filenameContentType(filename) {
  const ext = String(filename || '').split('.').pop()?.toLowerCase() || '';
  return Object.hasOwn(MIME_BY_EXT, ext) ? MIME_BY_EXT[ext] : '';
}

function isTextContentType(contentType) {
  const mime = baseMime(contentType);
  return mime.startsWith('text/') || mime === 'application/json' || mime === 'image/svg+xml';
}

function resolveContentType(rawType, filename) {
  const inferredType = filenameContentType(filename);
  const mime = baseMime(rawType);
  if (mime && Object.hasOwn(EXT_BY_MIME, mime)) {
    if (inferredType && baseMime(inferredType) !== mime) fail('声明的档案类型与文件扩展名不符，请使用对应的 content_type');
    return mime.startsWith('text/') || mime === 'application/json' ? `${mime}; charset=utf-8` : mime;
  }
  if (inferredType) return inferredType;
  fail('不支持的档案类型；支持 HTML、Markdown、TXT、JSON、CSV、图片（PNG/JPG/WebP/GIF/SVG/AVIF）、视频（MP4/WebM/MOV）、音频（MP3/WAV/OGG/M4A）与 PDF');
}

function maxBytesForMime(contentType) {
  const mime = baseMime(contentType);
  if (isTextContentType(contentType)) return MAX_TEXT_BYTES;
  if (mime.startsWith('image/')) return MAX_IMAGE_BYTES;
  return MAX_MEDIA_BYTES;
}

function decodeBase64(b64) {
  const cleaned = String(b64 || '').trim().replace(/^data:[^,]*;base64,/i, '').replace(/\s+/g, '');
  if (!cleaned) fail('base64 内容不能为空');
  let binary;
  try {
    binary = atob(cleaned);
  } catch {
    fail('无效的 base64 编码');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function parseTaskId(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) fail('task_id 须为正整数');
  return n;
}

function parseScope(raw, hasTask) {
  if (raw == null || raw === '') return hasTask ? 'task' : 'general';
  const s = String(raw).trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,40}$/.test(s)) fail('scope 仅支持 1–40 位英数字、下划线或连字符');
  return s;
}

export function buildFileUrl(requestUrl, id, filename) {
  const u = new URL(requestUrl);
  return `${u.origin}/api/files/${id}/${encodeURIComponent(filename)}`;
}

export async function storeUploadedFile(env, principal, requestUrl, {
  filename,
  title = '',
  contentType,
  bytes,
  taskId = null,
  scope = null,
}) {
  if (!env.FILES) fail('R2 存储桶未配置（env.FILES）', 503);
  if (!(bytes instanceof Uint8Array)) fail('无效档案内容');
  if (bytes.byteLength === 0) fail('档案内容不能为空');
  const safeName = sanitizeFilename(filename, contentType);
  const resolvedType = resolveContentType(contentType, safeName);
  const limit = maxBytesForMime(resolvedType);
  if (bytes.byteLength > limit) {
    fail(`档案大小超过上限（当前 ${bytes.byteLength} 字节，该类型上限为 ${Math.round(limit / 1024 / 1024)} MB）`, 413);
  }
  const parsedTaskId = parseTaskId(taskId);
  if (parsedTaskId != null) {
    const task = await env.DB.prepare('SELECT id FROM tasks WHERE id=?').bind(parsedTaskId).first();
    if (!task) fail('关联的任务不存在', 404);
  }
  const resolvedScope = parseScope(scope, parsedTaskId != null);
  const safeTitle = String(title || '').trim().slice(0, 200) || safeName;
  const id = randomToken('f_');
  const r2Key = `files/${id}/${safeName}`;
  const createdAt = new Date().toISOString();

  await env.FILES.put(r2Key, bytes, {
    httpMetadata: { contentType: resolvedType },
    customMetadata: {
      id,
      filename: safeName,
      title: safeTitle,
      uploader_id: String(principal.id),
      ...(parsedTaskId ? { task_id: String(parsedTaskId) } : {}),
      scope: resolvedScope,
      created_at: createdAt,
    },
  });

  await env.DB.prepare(
    'INSERT INTO stored_files (id, r2_key, filename, title, content_type, size, uploader_id, task_id, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, r2Key, safeName, safeTitle, resolvedType, bytes.byteLength, principal.id, parsedTaskId, resolvedScope, createdAt).run();

  const url = buildFileUrl(requestUrl, id, safeName);
  return {
    id,
    url,
    filename: safeName,
    title: safeTitle,
    content_type: resolvedType,
    size: bytes.byteLength,
    task_id: parsedTaskId,
    scope: resolvedScope,
    created_at: createdAt,
  };
}

async function parseUploadRequest(request, url, pathFilename = null) {
  const headerType = baseMime(request.headers.get('Content-Type'));
  const queryName = pathFilename || url.searchParams.get('filename') || request.headers.get('X-File-Name') || '';
  const queryTitle = url.searchParams.get('title') || request.headers.get('X-File-Title') || '';
  const queryTaskId = url.searchParams.get('task_id') ?? url.searchParams.get('taskId') ?? request.headers.get('X-Task-Id');
  const queryScope = url.searchParams.get('scope');

  if (headerType === 'multipart/form-data') {
    const form = await request.formData().catch(() => null);
    if (!form) fail('无效的表单上传数据');
    const file = form.get('file');
    const textContent = form.get('content') ?? form.get('html');
    const filename = String(form.get('filename') || (file && typeof file.name === 'string' ? file.name : '') || queryName || 'report.html');
    const title = String(form.get('title') || queryTitle || '');
    const taskId = form.get('task_id') ?? form.get('taskId') ?? queryTaskId;
    const scope = form.get('scope') ?? queryScope;
    const explicitType = form.get('content_type') || (file && file.type) || '';
    let bytes;
    if (file && typeof file.arrayBuffer === 'function') {
      bytes = new Uint8Array(await file.arrayBuffer());
    } else if (typeof textContent === 'string') {
      bytes = new TextEncoder().encode(textContent);
    } else {
      fail('请在表单中提供 file 或 content 字段');
    }
    return { filename, title, contentType: explicitType, bytes, taskId, scope };
  }

  // Raw JSON upload: either a JSON API envelope {content/html/base64, filename, ...}
  // or raw body when X-File-Name / pathFilename is explicitly non-JSON or envelope fields exist.
  if (headerType === 'application/json' && !pathFilename) {
    const b = await request.json().catch(() => null);
    if (!b || typeof b !== 'object' || Array.isArray(b)) fail('无效 JSON');
    const hasContent = typeof b.content === 'string' || typeof b.html === 'string' || typeof b.base64 === 'string';
    if (!hasContent) fail('请提供 content（或 html）文本，或 base64 编码内容');
    const isBase64 = typeof b.base64 === 'string';
    const isHtml = typeof b.html === 'string';
    const filename = b.filename || queryName || (isHtml ? 'report.html' : 'file');
    const dataUrlType = isBase64 ? /^data:([^;,]+)(?:;[^,]*)?;base64,/i.exec(b.base64.trim())?.[1] : '';
    if (b.content_type && dataUrlType && baseMime(b.content_type) !== baseMime(dataUrlType)) fail('声明的档案类型与 Data URL 类型不符，请使用对应的 content_type');
    // application/json describes the envelope. Resolve the file's own MIME before
    // naming it or applying size limits; Base64 media must never default to HTML.
    const contentType = b.content_type || dataUrlType || (isHtml ? 'text/html' : filenameContentType(filename)) || (isBase64 ? '' : 'text/html');
    if (isBase64 && !contentType) fail('base64 档案须提供 content_type、带类型的 Data URL 或可识别的文件扩展名');
    const resolvedType = resolveContentType(contentType, filename);
    if (!isBase64 && !isTextContentType(resolvedType)) fail('二进制档案请使用 base64 字段或二进制直传，不能放在 content/html 文本字段');
    const bytes = isBase64
      ? decodeBase64(b.base64)
      : new TextEncoder().encode(isHtml ? b.html : b.content);
    return {
      filename,
      title: b.title || queryTitle || '',
      contentType: resolvedType,
      bytes,
      taskId: b.task_id ?? b.taskId ?? queryTaskId,
      scope: b.scope ?? queryScope,
    };
  }

  // Direct binary / raw text body upload (POST /api/files or PUT /api/files/:filename)
  const buf = await request.arrayBuffer().catch(() => null);
  if (!buf) fail('无法读取上传内容');
  return {
    filename: queryName || 'file',
    title: queryTitle,
    contentType: headerType || '',
    bytes: new Uint8Array(buf),
    taskId: queryTaskId,
    scope: queryScope,
  };
}

async function serveFile(request, env, id, requestedName) {
  if (!env.FILES) fail('R2 存储桶未配置（env.FILES）', 503);
  const url = new URL(request.url);
  let r2Key = requestedName ? `files/${id}/${requestedName}` : null;
  let object = r2Key ? await env.FILES.get(r2Key) : null;
  let row = null;

  if (!object) {
    row = await env.DB.prepare('SELECT * FROM stored_files WHERE id=?').bind(id).first();
    if (!row) fail('档案不存在或已删除', 404);
    r2Key = row.r2_key;
    object = await env.FILES.get(r2Key);
    if (!object) fail('档案内容不存在', 404);
  }

  const contentType = object.httpMetadata?.contentType || row?.content_type || 'application/octet-stream';
  const filename = object.customMetadata?.filename || row?.filename || requestedName || id;
  const title = object.customMetadata?.title || row?.title || filename;
  const mime = baseMime(contentType);

  if (url.searchParams.get('format') === 'json') {
    if (!row) row = await env.DB.prepare('SELECT * FROM stored_files WHERE id=?').bind(id).first();
    const isText = isTextContentType(contentType);
    const textContent = isText && request.method === 'GET'
      ? new TextDecoder().decode(await object.arrayBuffer())
      : null;
    return json({
      file: {
        id,
        url: buildFileUrl(request.url, id, filename),
        filename,
        title,
        content_type: contentType,
        size: object.size ?? row?.size ?? 0,
        task_id: row?.task_id ?? (object.customMetadata?.task_id ? Number(object.customMetadata.task_id) : null),
        scope: row?.scope || object.customMetadata?.scope || 'general',
        created_at: row?.created_at || object.customMetadata?.created_at || null,
        ...(textContent != null ? { content: textContent } : {}),
      },
    });
  }

  const headers = new Headers(CORS);
  headers.set('Content-Type', contentType);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  if (object.httpEtag) headers.set('ETag', object.httpEtag);
  if (Number.isFinite(object.size)) headers.set('Content-Length', String(object.size));

  const download = url.searchParams.get('download') === '1';
  const disposition = download ? 'attachment' : 'inline';
  headers.set('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`);

  if (mime === 'text/html') {
    headers.set('Content-Security-Policy', REPORT_HTML_CSP);
    headers.set('Referrer-Policy', 'no-referrer');
  } else if (mime === 'image/svg+xml') {
    headers.set('Content-Security-Policy', SVG_CSP);
  }

  return new Response(request.method === 'HEAD' ? null : object.body, {
    status: 200,
    headers,
  });
}

export async function filesRoute(request, env, principal, path) {
  const isRoot = path === '/api/files';
  const itemMatch = path.match(/^\/api\/files\/(f_[A-Za-z0-9_-]{16,})(?:\/([^/]+))?$/);
  const putNamedMatch = (request.method === 'PUT' || request.method === 'POST') && !itemMatch
    ? path.match(/^\/api\/files\/([^/]+)$/)
    : null;

  if (!isRoot && !itemMatch && !putNamedMatch) return null;

  try {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // Capability link read: unguessable f_<token> allows direct browser viewing, <img>/<video> tags, and Agent fetching.
    if (itemMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      const id = itemMatch[1];
      const requestedName = itemMatch[2] ? decodeURIComponent(itemMatch[2]) : null;
      return await serveFile(request, env, id, requestedName);
    }

    if (!principal?.id) fail('请使用个人账号或独立 Agent 令牌', 401);
    if (!originAllowed(request, env, principal)) fail('来源不符', 403);

    if (isRoot && request.method === 'GET') {
      const url = new URL(request.url);
      const taskId = parseTaskId(url.searchParams.get('task_id') ?? url.searchParams.get('taskId'));
      const scope = url.searchParams.get('scope');
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      let sql = `SELECT f.*, COALESCE(l.display_name, p.name) AS uploader
        FROM stored_files f
        LEFT JOIN principals p ON p.id = f.uploader_id
        LEFT JOIN principal_labels l ON l.principal_id = p.id
        WHERE 1=1`;
      const args = [];
      if (taskId != null) { sql += ' AND f.task_id=?'; args.push(taskId); }
      if (scope) { sql += ' AND f.scope=?'; args.push(String(scope).trim().toLowerCase()); }
      sql += ' ORDER BY f.created_at DESC, f.rowid DESC LIMIT ?';
      args.push(limit);
      const { results } = await env.DB.prepare(sql).bind(...args).all();
      const files = results.map(row => ({
        id: row.id,
        url: buildFileUrl(request.url, row.id, row.filename),
        filename: row.filename,
        title: row.title,
        content_type: row.content_type,
        size: row.size,
        uploader_id: row.uploader_id,
        uploader: row.uploader || '未知账号',
        task_id: row.task_id,
        scope: row.scope,
        created_at: row.created_at,
      }));
      return json({ files });
    }

    if ((isRoot && (request.method === 'POST' || request.method === 'PUT')) || putNamedMatch) {
      const canUpload = principal.kind === 'agent' || permit(principal, 'task:create') || permit(principal, 'admin');
      if (!canUpload) fail('需要 Agent、发布者或管理员权限才能上传档案', 403);
      const url = new URL(request.url);
      const named = putNamedMatch ? decodeURIComponent(putNamedMatch[1]) : null;
      const parsed = await parseUploadRequest(request, url, named);
      const file = await storeUploadedFile(env, principal, request.url, parsed);
      return json({ file, ...file }, 201);
    }

    if (itemMatch && request.method === 'DELETE') {
      const id = itemMatch[1];
      const row = await env.DB.prepare('SELECT * FROM stored_files WHERE id=?').bind(id).first();
      if (!row) fail('档案不存在', 404);
      if (!permit(principal, 'admin') && row.uploader_id !== principal.id) {
        fail('只有上传者本人或管理员可删除档案', 403);
      }
      if (env.FILES) await env.FILES.delete(row.r2_key);
      await env.DB.prepare('DELETE FROM stored_files WHERE id=?').bind(id).run();
      return json({ deleted: id });
    }

    fail('不支持此方法', 405);
  } catch (e) {
    if (e instanceof FileError) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), {
        status: e.status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
      });
    }
    throw e;
  }
}
