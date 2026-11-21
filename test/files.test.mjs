import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { fixture } from './helpers.mjs';

test('JSON media uploads infer MIME from filename or Data URL without defaulting to HTML', async () => {
  const f = await fixture();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNIWPDgPwAGJALgx/BMsgAAAABJRU5ErkJggg==', 'base64');
  const cases = [
    { body: { filename: 'castle.png', base64: png.toString('base64') }, filename: 'castle.png', mime: 'image/png', bytes: png },
    { body: { filename: 'castle.png', base64: `data:image/png;base64,${png.toString('base64')}` }, filename: 'castle.png', mime: 'image/png', bytes: png },
    { body: { base64: `data:image/png;charset=utf-8;base64,${png.toString('base64')}` }, filename: 'file.png', mime: 'image/png', bytes: png },
    { body: { filename: 'castle', content_type: 'image/png', base64: png.toString('base64') }, filename: 'castle.png', mime: 'image/png', bytes: png },
    { body: { filename: 'data.csv', content: 'name,value\ncastle,1' }, filename: 'data.csv', mime: 'text/csv; charset=utf-8', bytes: Buffer.from('name,value\ncastle,1') },
    { body: { content: '<h1>Legacy report</h1>' }, filename: 'file.html', mime: 'text/html; charset=utf-8', bytes: Buffer.from('<h1>Legacy report</h1>') },
  ];
  for (const { body, filename, mime, bytes } of cases) {
    const uploaded = await f.request('POST', '/api/files', body, f.worker.auth);
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
    assert.equal(uploaded.data.filename, filename);
    assert.equal(uploaded.data.content_type, mime);
    const object = f.FILES.store.get(`files/${uploaded.data.id}/${filename}`);
    assert.equal(object.httpMetadata.contentType, mime);
    const row = f.DB.sqlite.prepare('SELECT content_type FROM stored_files WHERE id=?').get(uploaded.data.id);
    assert.equal(row.content_type, mime);
    const response = await worker.fetch(new Request(uploaded.data.url), f.env, {});
    assert.equal(response.headers.get('Content-Type'), mime);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    if (mime === 'image/png') {
      assert.equal(response.headers.get('Content-Security-Policy'), null);
      const head = await worker.fetch(new Request(uploaded.data.url, { method: 'HEAD' }), f.env, {});
      assert.equal(head.headers.get('Content-Type'), mime);
      assert.equal(await head.text(), '');
      const metadata = await (await worker.fetch(new Request(uploaded.data.url + '?format=json'), f.env, {})).json();
      assert.equal(metadata.file.content_type, mime);
      assert.equal(Object.hasOwn(metadata.file, 'content'), false);
    }
  }
});

test('JSON binary uploads require base64 and reject untyped or conflicting media before storing', async () => {
  const f = await fixture();
  for (const body of [
    { base64: 'aGVsbG8=' },
    { filename: 'castle.png', content: 'iVBORw0KGgoAAAANSUhEUg==' },
    { filename: 'clip.mp4', content_type: 'video/mp4', content: 'AAAA' },
    { filename: 'castle.png', content_type: 'text/html', base64: 'aGVsbG8=' },
    { content_type: 'text/html', base64: 'data:image/png;base64,aGVsbG8=' },
  ]) {
    const response = await f.request('POST', '/api/files', body, f.worker.auth);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match(response.data.error, /base64|类型/);
  }
  assert.equal(f.FILES.store.size, 0);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM stored_files').get().n, 0);
});

test('general R2 file hosting supports JSON HTML, binary image/video, capability URLs and zero-D1-read serving', async () => {
  const f = await fixture();

  // 1. Standalone HTML report upload (not tied to any task)
  const htmlUpload = await f.request('POST', '/api/files', {
    filename: 'muse-deep-dive.html',
    title: 'Muse 深度分析报告',
    html: '<!DOCTYPE html><html><head><title>Muse Report</title></head><body><h1>核心结论</h1><p>增长 42%</p></body></html>',
    scope: 'muse-reports',
  }, f.worker.auth);
  assert.equal(htmlUpload.status, 201);
  assert.match(htmlUpload.data.id, /^f_[A-Za-z0-9_-]{16,}$/);
  assert.match(htmlUpload.data.url, /\/api\/files\/f_[A-Za-z0-9_-]+\/muse-deep-dive\.html$/);
  assert.equal(htmlUpload.data.content_type, 'text/html; charset=utf-8');
  assert.equal(htmlUpload.data.scope, 'muse-reports');

  // 2. Reading via capability link requires no auth and 0 D1 reads on fast path
  const prepare = f.DB.prepare.bind(f.DB);
  let d1FileQueries = 0;
  f.DB.prepare = sql => {
    if (sql.includes('stored_files')) d1FileQueries++;
    return prepare(sql);
  };
  const path = new URL(htmlUpload.data.url).pathname;
  const rawRes = await worker.fetch(new Request(`https://board.test${path}`), f.env, {});
  assert.equal(rawRes.status, 200);
  assert.equal(d1FileQueries, 0, 'Direct R2 key lookup should not query D1 stored_files');
  assert.match(rawRes.headers.get('Content-Type'), /text\/html/);
  assert.match(rawRes.headers.get('Content-Security-Policy'), /sandbox allow-scripts/);
  assert.match(await rawRes.text(), /核心结论/);

  // 3. Other Muse reading ?format=json gets metadata + full HTML text content
  const jsonRes = await worker.fetch(new Request(`https://board.test${path}?format=json`), f.env, {});
  assert.equal(jsonRes.status, 200);
  const jsonBody = await jsonRes.json();
  assert.equal(jsonBody.ok, true);
  assert.match(jsonBody.file.content, /增长 42%/);

  // 4. Raw binary PUT upload for image and video
  const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
  const putImg = await worker.fetch(new Request('https://board.test/api/files/chart-v1.png?title=营收趋势图&scope=media', {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png', ...f.worker.auth },
    body: pngBytes,
  }), f.env, {});
  assert.equal(putImg.status, 201);
  const imgData = await putImg.json();
  assert.equal(imgData.content_type, 'image/png');
  assert.equal(imgData.size, pngBytes.byteLength);

  const getImg = await worker.fetch(new Request(imgData.url), f.env, {});
  assert.equal(getImg.status, 200);
  assert.equal(getImg.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(new Uint8Array(await getImg.arrayBuffer()), pngBytes);

  // 5. Base64 upload for video/mp4
  const mp4Bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);
  const b64 = Buffer.from(mp4Bytes).toString('base64');
  const videoUpload = await f.request('POST', '/api/files', {
    filename: 'demo.mp4',
    content_type: 'video/mp4',
    base64: `data:video/mp4;base64,${b64}`,
  }, f.host.auth);
  assert.equal(videoUpload.status, 201);
  assert.equal(videoUpload.data.content_type, 'video/mp4');

  // 6. Listing files with filters
  const listAll = await f.request('GET', '/api/files', undefined, f.worker.auth);
  assert.equal(listAll.status, 200);
  assert.equal(listAll.data.files.length, 3);

  const listReports = await f.request('GET', '/api/files?scope=muse-reports', undefined, f.worker.auth);
  assert.equal(listReports.data.files.length, 1);
  assert.equal(listReports.data.files[0].id, htmlUpload.data.id);

  // 7. Only uploader or admin can delete
  const forbiddenDel = await f.request('DELETE', `/api/files/${htmlUpload.data.id}`, undefined, f.checker.auth);
  assert.equal(forbiddenDel.status, 403);

  const okDel = await f.request('DELETE', `/api/files/${htmlUpload.data.id}`, undefined, f.worker.auth);
  assert.equal(okDel.status, 200);
  const afterDel = await worker.fetch(new Request(`https://board.test${path}`), f.env, {});
  assert.equal(afterDel.status, 404);
});

test('POST /api/tasks/:id/outcomes accepts inline report.html, auto-hosts in R2, and allows other Muse to review', async () => {
  const f = await fixture();
  const created = await f.request('POST', '/api/tasks', {
    title: 'Muse 芯片行业 HTML 报告',
    plan: {
      goal: 'analysis',
      collaboration: 'hosted',
      acceptance: { criteria: '含图表与官方数据出处', min_sources: 1, independent_review: true, opposing_views: false },
      schedule: { kind: 'once' },
      delivery: { format: 'web_report', author_id: f.worker.id },
    },
  }, f.admin);
  assert.equal(created.status, 201);
  const taskId = created.data.id;
  await f.request('POST', `/api/tasks/${taskId}/workflow`, { host_id: f.host.id, acceptance: '含图表与官方数据出处', min_sources: 1 }, f.admin);

  const before = (await f.request('GET', `/api/tasks/${taskId}`, undefined, f.worker.auth)).data;

  // Author submits inline HTML directly in /outcomes without pre-providing report.url
  const outcome = await f.request('POST', `/api/tasks/${taskId}/outcomes`, {
    fingerprint: before.workflow.fingerprint,
    summary: '已完成芯片行业分析，包含营收对比与风险评估',
    links: ['https://example.com/official-filing'],
    changes: '首次通过白板直接托管 HTML 报告 v1',
    source_refs: [],
    report: {
      title: '芯片行业分析报告 v1',
      revision: 'v1',
      html: '<!DOCTYPE html><html><body><h1>芯片行业分析 v1</h1><p>数据出处：official-filing</p></body></html>',
    },
  }, f.worker.auth);
  assert.equal(outcome.status, 201);
  assert.ok(outcome.data.report.url, 'Should auto-generate hosted report.url');
  assert.match(outcome.data.report.url, /\/api\/files\/f_[A-Za-z0-9_-]+\/task-\d+-v1\.html$/);
  assert.ok(outcome.data.report.file_id);

  // Reviewer Muse fetches the task, reads report.url content, and submits independent review
  const detail = (await f.request('GET', `/api/tasks/${taskId}`, undefined, f.checker.auth)).data;
  assert.equal(detail.workflow.outcomes[0].report.url, outcome.data.report.url);

  const reportRes = await worker.fetch(new Request(outcome.data.report.url), f.env, {});
  assert.equal(reportRes.status, 200);
  assert.match(await reportRes.text(), /芯片行业分析 v1/);

  const review = await f.request('POST', `/api/tasks/${taskId}/reviews`, {
    fingerprint: detail.workflow.fingerprint,
    report_revision: 'v1',
    note: '已直接读取白板托管的 HTML 报告 v1，数据与出处核对一致',
    evidence: [outcome.data.report.url, 'https://example.com/official-filing'],
  }, f.checker.auth);
  assert.equal(review.status, 201);

  const readyDetail = (await f.request('GET', `/api/tasks/${taskId}`, undefined, f.admin)).data;
  assert.equal(readyDetail.verify_readiness.ready, true);

  // Stored file is also linked to taskId and includes convenience URLs + markdown embed + task_title + path
  const taskFiles = await f.request('GET', `/api/files?task_id=${taskId}`, undefined, f.admin);
  assert.equal(taskFiles.data.files.length, 1);
  assert.equal(taskFiles.data.files[0].url, outcome.data.report.url);
  assert.equal(taskFiles.data.files[0].raw_url, outcome.data.report.url);
  assert.equal(taskFiles.data.files[0].json_url, `${outcome.data.report.url}?format=json`);
  assert.equal(taskFiles.data.files[0].size_bytes, taskFiles.data.files[0].size);
  assert.equal(taskFiles.data.files[0].task_title, 'Muse 芯片行业 HTML 报告');
  assert.match(taskFiles.data.files[0].path, /^\/api\/files\/f_[A-Za-z0-9_-]+\/task-\d+-v1\.html$/);
  assert.ok(taskFiles.data.files[0].markdown_embed.includes(outcome.data.report.url));

  // Service-binding requests arriving with api.internal resolve public URLs instead of api.internal
  const proxiedReq = new Request('https://api.internal/api/files', { headers: f.worker.auth });
  const proxiedRes = await worker.fetch(proxiedReq, { ...f.env, PUBLIC_API_ORIGIN: 'https://public-api.example.test' }, {});
  assert.equal(proxiedRes.status, 200);
  const proxiedData = await proxiedRes.json();
  assert.ok(proxiedData.files[0].url.startsWith('https://public-api.example.test/api/files/f_'));
  assert.ok(!proxiedData.files[0].url.includes('api.internal'));
  assert.ok(proxiedData.files[0].path.startsWith('/api/files/f_'));

  // Image and video uploads generate proper markdown_embed helpers
  const img = await f.request('POST', '/api/files', {
    filename: 'trend.png',
    title: '趋势图',
    content_type: 'image/png',
    base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNIWPDgPwAGJALgx/BMsgAAAABJRU5ErkJggg==',
    scope: 'media',
  }, f.worker.auth);
  assert.equal(img.status, 201);
  assert.equal(img.data.markdown_embed, `![趋势图](${img.data.url})`);
  assert.equal(img.data.json_url, `${img.data.url}?format=json`);

  // Migration file is repeatable
  const sql = readFileSync(new URL('../migrations/0013-stored-files.sql', import.meta.url), 'utf8');
  f.DB.sqlite.exec(sql);
  f.DB.sqlite.exec(sql);
});

test('public file fast path performs zero D1 reads/writes even with session cookie or Agent bearer and works during D1 outage', async () => {
  const f = await fixture();
  const uploaded = await f.request('POST', '/api/files', {
    filename: 'report-fast.html',
    title: '快路径报告',
    html: '<!DOCTYPE html><html><body><h1>Fast Path</h1></body></html>',
    scope: 'standalone',
  }, f.worker.auth);
  assert.equal(uploaded.status, 201);
  const filePath = uploaded.data.path;

  const visitsBefore = f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM agent_visits').get().n;
  const origPrepare = f.DB.prepare.bind(f.DB);
  let totalDbQueries = 0;
  f.DB.prepare = sql => {
    totalDbQueries++;
    return origPrepare(sql);
  };

  try {
    // 1. Anonymous, admin session cookie (dashboard gallery), and Agent bearer (Muse fetching) all hit 0 D1 queries
    for (const headers of [
      {},
      { Cookie: f.admin.Cookie },
      { ...f.checker.auth },
    ]) {
      const getRes = await worker.fetch(new Request(`https://board.test${filePath}`, { headers }), f.env, {});
      assert.equal(getRes.status, 200);
      assert.equal(getRes.headers.get('Accept-Ranges'), 'bytes');
      assert.match(getRes.headers.get('Content-Security-Policy'), /sandbox allow-scripts/);
      assert.match(await getRes.text(), /Fast Path/);

      const headRes = await worker.fetch(new Request(`https://board.test${filePath}`, { method: 'HEAD', headers }), f.env, {});
      assert.equal(headRes.status, 200);
      assert.equal(await headRes.text(), '');

      const jsonRes = await worker.fetch(new Request(`https://board.test${filePath}?format=json`, { headers }), f.env, {});
      assert.equal(jsonRes.status, 200);
      assert.equal(jsonRes.headers.get('Cache-Control'), 'no-store');
      assert.equal(jsonRes.headers.get('ETag'), null);
      const jsonBody = await jsonRes.json();
      assert.equal(jsonBody.file.title, '快路径报告');
      assert.equal(jsonBody.file.scope, 'standalone');
      assert.match(jsonBody.file.content, /Fast Path/);
    }
    assert.equal(totalDbQueries, 0, 'Public file GET/HEAD/?format=json on R2 hit must execute 0 D1 queries');
  } finally {
    f.DB.prepare = origPrepare;
  }

  const visitsAfter = f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM agent_visits').get().n;
  assert.equal(visitsAfter, visitsBefore, 'Public file reads with Agent bearer must not pollute agent_visits');

  // 2. R2 hit still serves cleanly even when D1 is offline
  const brokenEnv = {
    ...f.env,
    DB: { prepare() { throw new Error('D1 quota exhausted'); }, exec() { throw new Error('D1 quota exhausted'); } },
  };
  const duringOutage = await worker.fetch(new Request(`https://board.test${filePath}`), brokenEnv, {});
  assert.equal(duringOutage.status, 200);
  assert.match(await duringOutage.text(), /Fast Path/);

  // 3. Short link without filename falls back to D1 cleanly; fails with 503 if D1 is offline
  const shortUrl = `https://board.test/api/files/${uploaded.data.id}`;
  const shortOk = await worker.fetch(new Request(shortUrl), f.env, {});
  assert.equal(shortOk.status, 200);
  assert.match(await shortOk.text(), /Fast Path/);
  const shortOutage = await worker.fetch(new Request(shortUrl), brokenEnv, {});
  assert.equal(shortOutage.status, 503);
});

test('serveFile supports Range 206/416, HEAD without stream, If-None-Match 304 (RFC 9110 §14.2 precedence), and metadata fallback', async () => {
  const f = await fixture();
  // Minimal 64-byte synthetic MP4 fixture (ftyp + mdat header + deterministic payload)
  const mp4 = new Uint8Array(64);
  mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00], 0);
  for (let i = 16; i < 64; i++) mp4[i] = i;

  const putRes = await worker.fetch(new Request('https://board.test/api/files/clip.mp4?scope=media&title=测试短片', {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', ...f.worker.auth },
    body: mp4,
  }), f.env, {});
  assert.equal(putRes.status, 201);
  const uploaded = await putRes.json();
  const fileUrl = uploaded.url;

  // 1. Plain unconditional GET uses 1 R2 get and 0 R2 head
  f.FILES.stats.headCalls = 0;
  f.FILES.stats.getCalls = 0;
  const fullRes = await worker.fetch(new Request(fileUrl), f.env, {});
  assert.equal(fullRes.status, 200);
  assert.equal(fullRes.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(fullRes.headers.get('Content-Length'), '64');
  const etag = fullRes.headers.get('ETag');
  assert.ok(etag);
  assert.deepEqual(new Uint8Array(await fullRes.arrayBuffer()), mp4);
  assert.equal(f.FILES.stats.headCalls, 0);
  assert.equal(f.FILES.stats.getCalls, 1);

  // 2. HEAD uses R2 head only (never opens R2 body stream)
  f.FILES.stats.headCalls = 0;
  f.FILES.stats.getCalls = 0;
  const headRes = await worker.fetch(new Request(fileUrl, { method: 'HEAD' }), f.env, {});
  assert.equal(headRes.status, 200);
  assert.equal(headRes.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(headRes.headers.get('Content-Length'), '64');
  assert.equal(headRes.headers.get('ETag'), etag);
  assert.equal(await headRes.text(), '');
  assert.equal(f.FILES.stats.headCalls, 1);
  assert.equal(f.FILES.stats.getCalls, 0);

  // 3. Valid single byte ranges (start-end, open end, clamped end, suffix, oversized suffix, uint64 max bounds)
  for (const [header, start, end] of [
    ['bytes=0-15', 0, 15],
    ['bytes=16-31', 16, 31],
    ['bytes=48-', 48, 63],
    ['bytes=50-9999', 50, 63],
    ['bytes=0-18446744073709551615', 0, 63],
    ['bytes=-10', 54, 63],
    ['bytes=-9999', 0, 63],
    ['bytes=-18446744073709551615', 0, 63],
  ]) {
    f.FILES.stats.headCalls = 0;
    f.FILES.stats.getCalls = 0;
    const res = await worker.fetch(new Request(fileUrl, { headers: { Range: header } }), f.env, {});
    const expectedLen = end - start + 1;
    assert.equal(res.status, 206, header);
    assert.equal(res.headers.get('Accept-Ranges'), 'bytes', header);
    assert.equal(res.headers.get('Content-Range'), `bytes ${start}-${end}/64`, header);
    assert.equal(res.headers.get('Content-Length'), String(expectedLen), `${header} Content-Length must be slice length, not object.size`);
    assert.equal(res.headers.get('ETag'), etag, header);
    assert.equal(res.headers.get('Cache-Control'), 'public, max-age=31536000, immutable', header);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), mp4.subarray(start, end + 1), header);
    assert.equal(f.FILES.stats.headCalls, 1, header);
    assert.equal(f.FILES.stats.getCalls, 1, header);
  }

  // HEAD with Range still returns full metadata (200) without opening R2 body stream
  f.FILES.stats.headCalls = 0;
  f.FILES.stats.getCalls = 0;
  const headWithRange = await worker.fetch(new Request(fileUrl, { method: 'HEAD', headers: { Range: 'bytes=0-15' } }), f.env, {});
  assert.equal(headWithRange.status, 200);
  assert.equal(headWithRange.headers.get('Content-Length'), '64');
  assert.equal(headWithRange.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(f.FILES.stats.headCalls, 1);
  assert.equal(f.FILES.stats.getCalls, 0);

  // 4. Unsatisfiable ranges return 416 without calling R2 get()
  for (const badRange of ['bytes=64-', 'bytes=999-1000', 'bytes=18446744073709551615-', 'bytes=30-10', 'bytes=-0']) {
    f.FILES.stats.headCalls = 0;
    f.FILES.stats.getCalls = 0;
    const res = await worker.fetch(new Request(fileUrl, { headers: { Range: badRange } }), f.env, {});
    assert.equal(res.status, 416, badRange);
    assert.equal(res.headers.get('Content-Range'), 'bytes */64', badRange);
    assert.equal(res.headers.get('Cache-Control'), 'no-store', badRange);
    assert.equal(await res.text(), '', badRange);
    assert.equal(f.FILES.stats.headCalls, 1, badRange);
    assert.equal(f.FILES.stats.getCalls, 0, badRange);
  }

  // 5. Multi-range and non-bytes Range fall back to full 200
  for (const ignoredRange of ['bytes=0-3, 8-11', 'items=0-5', 'bytes=invalid']) {
    const res = await worker.fetch(new Request(fileUrl, { headers: { Range: ignoredRange } }), f.env, {});
    assert.equal(res.status, 200, ignoredRange);
    assert.equal(res.headers.get('Content-Length'), '64', ignoredRange);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), mp4, ignoredRange);
  }

  // 6. If-None-Match strong/weak/list/* returns 304 without Content-Length/Content-Disposition and takes precedence over Range
  for (const headers of [
    { 'If-None-Match': etag },
    { 'If-None-Match': `W/${etag}` },
    { 'If-None-Match': `"other-etag", W/${etag}` },
    { 'If-None-Match': '*' },
    { 'If-None-Match': `W/${etag}`, Range: 'bytes=0-15' },
    { 'If-None-Match': etag, Range: 'bytes=99999-' },
  ]) {
    f.FILES.stats.headCalls = 0;
    f.FILES.stats.getCalls = 0;
    const res = await worker.fetch(new Request(fileUrl, { headers }), f.env, {});
    assert.equal(res.status, 304, JSON.stringify(headers));
    assert.equal(res.headers.get('ETag'), etag);
    assert.equal(res.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
    assert.equal(res.headers.get('Accept-Ranges'), 'bytes');
    assert.equal(res.headers.get('Content-Length'), null);
    assert.equal(res.headers.get('Content-Disposition'), null);
    assert.equal(await res.text(), '');
    assert.equal(f.FILES.stats.headCalls, 1);
    assert.equal(f.FILES.stats.getCalls, 0);
  }

  // 7. Non-matching If-None-Match + valid Range returns 206
  const mismatchRange = await worker.fetch(new Request(fileUrl, { headers: { 'If-None-Match': '"stale"', Range: 'bytes=0-7' } }), f.env, {});
  assert.equal(mismatchRange.status, 206);
  assert.equal(mismatchRange.headers.get('Content-Length'), '8');
  assert.deepEqual(new Uint8Array(await mismatchRange.arrayBuffer()), mp4.subarray(0, 8));

  // 8. ?format=json ignores Range and If-None-Match, stays no-store without file ETag, and falls back to D1 for legacy objects missing customMetadata
  const jsonWithHeaders = await worker.fetch(new Request(`${fileUrl}?format=json`, {
    headers: { 'If-None-Match': etag, Range: 'bytes=0-5' },
  }), f.env, {});
  assert.equal(jsonWithHeaders.status, 200);
  assert.equal(jsonWithHeaders.headers.get('Cache-Control'), 'no-store');
  assert.equal(jsonWithHeaders.headers.get('ETag'), null);
  const jsonHead = await worker.fetch(new Request(`${fileUrl}?format=json`, { method: 'HEAD' }), f.env, {});
  assert.equal(jsonHead.status, 200);
  assert.equal(await jsonHead.text(), '');

  const storedEntry = f.FILES.store.get(`files/${uploaded.id}/clip.mp4`);
  storedEntry.customMetadata = {}; // simulate legacy object without R2 customMetadata
  const legacyJson = await (await worker.fetch(new Request(`${fileUrl}?format=json`), f.env, {})).json();
  assert.equal(legacyJson.file.title, '测试短片');
  assert.equal(legacyJson.file.scope, 'media');
  assert.ok(legacyJson.file.created_at);

  // 9. Malformed percent-encoding returns 400 JSON rather than 500 URIError
  const malformed = await worker.fetch(new Request(`https://board.test/api/files/${uploaded.id}/%E0%A4%A`), f.env, {});
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal((await malformed.json()).ok, false);

  // 10. Oversized filenames (>256 chars / >512 bytes) and mismatched alias filenames return 404 (preventing 1101 errors and alias amplification)
  const overlong = await worker.fetch(new Request(`https://board.test/api/files/${uploaded.id}/${'a'.repeat(1100)}.mp4`), f.env, {});
  assert.equal(overlong.status, 404);
  const wrongAlias = await worker.fetch(new Request(`https://board.test/api/files/${uploaded.id}/wrong-alias.bin`), f.env, {});
  assert.equal(wrongAlias.status, 404);
  const shortLinkStillWorks = await worker.fetch(new Request(`https://board.test/api/files/${uploaded.id}`), f.env, {});
  assert.equal(shortLinkStillWorks.status, 200);

  // 11. Fast path never bypasses auth for listing or deletion
  assert.equal((await worker.fetch(new Request('https://board.test/api/files'), f.env, {})).status, 401);
  assert.equal((await worker.fetch(new Request('https://board.test/api/files', { method: 'HEAD' }), f.env, {})).status, 401);
  assert.equal((await worker.fetch(new Request(`https://board.test/api/files/${uploaded.id}`, { method: 'DELETE' }), f.env, {})).status, 401);
});
