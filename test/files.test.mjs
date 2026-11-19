import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { fixture } from './helpers.mjs';

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

  // Stored file is also linked to taskId
  const taskFiles = await f.request('GET', `/api/files?task_id=${taskId}`, undefined, f.admin);
  assert.equal(taskFiles.data.files.length, 1);
  assert.equal(taskFiles.data.files[0].url, outcome.data.report.url);

  // Migration file is repeatable
  const sql = readFileSync(new URL('../migrations/0013-stored-files.sql', import.meta.url), 'utf8');
  f.DB.sqlite.exec(sql);
  f.DB.sqlite.exec(sql);
});
