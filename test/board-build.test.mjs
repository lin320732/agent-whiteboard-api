import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, realpath, appendFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBoard } from '../scripts/build-board.mjs';

test('production home preloads exclude optional features and deploys invalidate dependent bundles', async t => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'whiteboard-build-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sourceDir = path.join(dir, 'web'), outDir = path.join(dir, 'public');
  await cp(new URL('../web', import.meta.url), sourceDir, { recursive: true });
  const first = await buildBoard({ sourceDir, outDir });
  const html = await readFile(path.join(outDir, 'index.html'), 'utf8');
  const asset = (text, name, ext = 'js') => text.match(new RegExp(`/assets/${name}-[A-Z0-9]{8}\\.${ext}`))?.[0];
  assert.ok(asset(html, 'bootstrap'));
  assert.ok(asset(html, 'app'));
  assert.ok(asset(html, 'style', 'css'));
  assert.ok(first.preloads.length <= 4, 'the initial module graph must stay shallow');
  const project = fileURLToPath(new URL('../', import.meta.url));
  for (const url of first.preloads) {
    const output = Object.entries(first.metafile.outputs).find(([name]) => path.resolve(project, name) === path.join(outDir, url));
    assert.ok(output, `missing build output for ${url}`);
    for (const input of Object.keys(output[1].inputs)) {
      assert.doesNotMatch(input, /(?:vendor|reading|files-ui|agent-guide|agent-quotas|agent-visits|collaboration|outcome-view|floor-refs)\//);
      assert.doesNotMatch(path.basename(input), /^(?:reading|files-ui|agent-guide|agent-quotas|agent-visits|collaboration|outcome-view|floor-refs)\.js$/);
    }
  }
  for (const output of Object.values(first.metafile.outputs)) {
    for (const imported of output.imports) if (!imported.external) await access(path.resolve(project, imported.path));
  }
  const metadata = await readFile(path.join(outDir, 'bilibili-metadata.html'), 'utf8');
  assert.ok(asset(metadata, 'bilibili-metadata'));
  await buildBoard({ sourceDir, outDir });
  assert.equal(await readFile(path.join(outDir, 'index.html'), 'utf8'), html, 'unchanged builds keep identical asset URLs');

  await appendFile(path.join(sourceDir, 'reading.js'), '\nconsole.info("new-feature-version");\n');
  await buildBoard({ sourceDir, outDir });
  const updated = await readFile(path.join(outDir, 'index.html'), 'utf8');
  assert.notEqual(asset(updated, 'app'), asset(html, 'app'), 'a changed lazy import invalidates its loader');
  assert.notEqual(asset(updated, 'bootstrap'), asset(html, 'bootstrap'));
  assert.equal(asset(updated, 'style', 'css'), asset(html, 'style', 'css'));
  await access(path.join(outDir, asset(html, 'app')));
});
