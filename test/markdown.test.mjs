import test from 'node:test';
import assert from 'node:assert/strict';
import {renderMarkdown, markdownLinks} from '../web/markdown.js';

test('Markdown formats Chinese prose, nested lists, quotes, tables and code', () => {
  const html = renderMarkdown([
    '## 结论', '', '**方案 A** 更合适，*暂定*，~~旧方案~~，命令 `npm test`。', '',
    '1. 核对来源', '   - 比较续费价', '   - 记录币种', '2. 整理交付', '',
    '> 保留适用条件。', '', '| 项目 | 金额 |', '| :--- | ---: |', '| A | 20 |', '',
    '```json', '{"ok":true}', '```', '', '---', '', '下一步', '继续核对',
  ].join('\n'));
  for (const markup of ['<h2>结论</h2>', '<strong>方案 A</strong>', '<em>暂定</em>', '<s>旧方案</s>', '<code>npm test</code>', '<ol>', '<ul>', '<blockquote>', '<table>', '<hr>', 'class="language-json"', '下一步<br>\n继续核对']) assert.ok(html.includes(markup), markup);
  assert.match(html, /<ol>[\s\S]*<ul>[\s\S]*<\/ul>[\s\S]*<\/ol>/);
  assert.ok(html.includes('class="markdown-align-right"'));
  assert.doesNotMatch(html, /\sstyle=/);
});

test('untrusted HTML and escaped entities stay text, including inside code', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<svg onload=alert(1)>\n\n&lt;img src=x&gt;\n\n```html\n<img src=x onerror=alert(1)>\n```');
  assert.doesNotMatch(html, /<(script|img|svg)\b/i);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('class="language-html"'));
});

test('links accept HTTP(S), escape labels and titles, and preserve sentence punctuation', () => {
  const html = renderMarkdown('[**官方**](https://example.com/a_(b) "价格 & 条件")。 https://example.com/pricing.');
  assert.ok(html.includes('href="https://example.com/a_(b)"'));
  assert.ok(html.includes('<strong>官方</strong></a>。'));
  assert.ok(html.includes('title="价格 &amp; 条件"'));
  assert.ok(html.includes('title="https://example.com/pricing">example.com · pricing</a>.'));
  assert.equal((html.match(/target="_blank" rel="noopener noreferrer"/g) || []).length, 2);
  const hostile = renderMarkdown('[&lt;img src=x&gt;](https://example.com/ "&quot; onmouseover=&quot;alert(1)")');
  assert.doesNotMatch(hostile, /<img\b|" onmouseover=/);
  assert.ok(hostile.includes('&lt;img src=x&gt;'));
});

test('unsafe, relative and non-HTTP protocols never produce links or images', () => {
  for (const destination of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java&#x73;cript:alert(1)', 'javascript&#58;alert(1)', 'vbscript:evil', 'file:///etc/passwd', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/png;base64,AAAA', 'mailto:owner@example.com', '//evil.example/path', '/api/auth/logout', '#task']) {
    const source = `[链接](${destination}) ![图片](${destination})`;
    assert.doesNotMatch(renderMarkdown(source), /<(a|img)\b/i, destination);
    assert.deepEqual(markdownLinks(source), [], destination);
  }
});

test('image syntax offers a safe named link without loading an external image', () => {
  const html = renderMarkdown('![示意图 <img src=x>](https://example.com/chart.png)');
  assert.doesNotMatch(html, /<img\b/);
  assert.match(html, /href="https:\/\/example.com\/chart.png"/);
  assert.ok(html.includes('示意图 &lt;img src=x&gt;</a>'));
  assert.deepEqual(markdownLinks('![示意图](https://example.com/chart.png)'), [{url: 'https://example.com/chart.png', label: '示意图'}]);
});

test('source extraction understands named/reference links and ignores URLs inside code', () => {
  const source = '[**官方**价格](https://example.com/pricing_(2026))\n\n[说明][doc]\n\nhttps://example.com/pricing_(2026).\n\n`https://example.com/inline-code`\n\n```text\nhttps://example.com/code-block\n```\n\n[doc]: https://example.com/docs "官方说明"';
  assert.deepEqual(markdownLinks(source), [
    {url: 'https://example.com/pricing_(2026)', label: '官方价格'},
    {url: 'https://example.com/docs', label: '说明'},
  ]);
});
