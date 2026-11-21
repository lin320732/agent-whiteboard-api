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

test('Unicode emoji and shortcodes render in prose while code and unknown names stay literal', () => {
  const html = renderMarkdown('讨论 😀 :smile: :thumbsup: :tada: :not_an_emoji: :)\n\n`:smile:`\n\n```text\n:thumbsup:\n```');
  assert.match(html, /讨论 😀 😄 👍 🎉 :not_an_emoji: :\)/);
  assert.match(html, /<code>:smile:<\/code>/);
  assert.match(html, /<code class="language-text">:thumbsup:\n<\/code>/);
});

test('emoji shortcodes work in named links, media captions and source labels', () => {
  const html = renderMarkdown('[发布 :tada:](https://example.com/report)\n\n![图 :smile:](https://example.com/chart.png)\n\n![video: 演示 :thumbsup:](https://www.youtube.com/watch?v=M7lc1UVf-VE)');
  assert.match(html, /发布 🎉<\/a>/);
  assert.match(html, /alt="图 😄"/);
  assert.match(html, /播放视频 · YouTube · 演示 👍/);
  assert.deepEqual(markdownLinks('[发布 :tada:](https://example.com/report)\n\n![图 :smile:](https://example.com/chart.png)'), [
    {url: 'https://example.com/report', label: '发布 🎉'},
    {url: 'https://example.com/chart.png', label: '图 😄'},
  ]);
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

test('HTTPS image syntax displays an image with a safe source link', () => {
  const html = renderMarkdown('![示意图 <img src=x>](https://example.com/chart.png)');
  assert.match(html, /<img src="https:\/\/example.com\/chart.png" alt="示意图 &lt;img src=x&gt;" loading="lazy" decoding="async" referrerpolicy="no-referrer">/);
  assert.match(html, /href="https:\/\/example.com\/chart.png"/);
  assert.doesNotMatch(html, /<img src=x>|onerror=/);
  assert.ok(html.includes('示意图 &lt;img src=x&gt;</a>'));
  assert.deepEqual(markdownLinks('![示意图](https://example.com/chart.png)'), [{url: 'https://example.com/chart.png', label: '示意图'}]);
});

test('audio and video use explicit image labels, native controls and source links', () => {
  const html = renderMarkdown('![audio: 讨论录音](https://media.example.com/talk.mp3)\n\n![视频：演示](https://media.example.com/demo.mp4 "观看 & 说明")');
  assert.match(html, /<audio controls preload="none" src="https:\/\/media.example.com\/talk.mp3"><\/audio>/);
  assert.match(html, /<video controls preload="none" playsinline src="https:\/\/media.example.com\/demo.mp4"><\/video>/);
  assert.match(html, /title="观看 &amp; 说明"/);
  assert.doesNotMatch(html, /autoplay|<iframe|<script/);
  assert.deepEqual(markdownLinks('![audio: 讨论录音](https://media.example.com/talk.mp3)\n\n![视频：演示](https://media.example.com/demo.mp4)'), [
    {url: 'https://media.example.com/talk.mp3', label: '讨论录音'},
    {url: 'https://media.example.com/demo.mp4', label: '演示'},
  ]);
});

test('HTTP media stays a link and escaped media labels cannot inject HTML', () => {
  const html = renderMarkdown('![video: 演示](http://example.com/demo.mp4) ![audio: <script>alert(1)</script>](https://example.com/talk.mp3 "&quot; onerror=&quot;evil")');
  assert.doesNotMatch(html, /<video\b/);
  assert.match(html, /href="http:\/\/example.com\/demo.mp4"/);
  assert.match(html, /<audio controls preload="none"/);
  assert.doesNotMatch(html, /<script\b|" onerror=/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('a linked image uses the surrounding link without nesting anchors', () => {
  const html = renderMarkdown('[![结构图](https://example.com/diagram.png)](https://example.com/report)');
  assert.match(html, /<a href="https:\/\/example.com\/report"[\s\S]*<img src="https:\/\/example.com\/diagram.png"/);
  assert.equal((html.match(/<a\b/g) || []).length, 1);
  assert.equal((html.match(/<\/a>/g) || []).length, 1);
});

test('standalone YouTube and Bilibili links become unloaded, expandable players', () => {
  const source = '[讲解](https://www.youtube.com/watch?v=M7lc1UVf-VE&t=1m30s)\n\nhttps://youtu.be/M7lc1UVf-VE\n\n![视频：演示](https://www.bilibili.com/video/BV1B7411m7LV?p=2&t=45)';
  const html = renderMarkdown(source);
  assert.equal((html.match(/class="markdown-video-embed"/g) || []).length, 3);
  assert.match(html, /data-embed-src="https:\/\/www.youtube-nocookie.com\/embed\/M7lc1UVf-VE\?start=90"/);
  assert.match(html, /data-embed-src="https:\/\/player.bilibili.com\/player.html\?bvid=BV1B7411m7LV&amp;p=2&amp;t=45&amp;autoplay=0"/);
  assert.doesNotMatch(html, /<iframe|autoplay="|<p><details/);
  assert.ok(html.indexOf('markdown-video-source') < html.indexOf('markdown-video-frame'), '原视频入口应在播放器之前可见');
  assert.deepEqual(markdownLinks(source), [
    {url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE&t=1m30s', label: '讲解'},
    {url: 'https://youtu.be/M7lc1UVf-VE', label: 'YouTube 视频'},
    {url: 'https://www.bilibili.com/video/BV1B7411m7LV?p=2&t=45', label: '演示'},
  ]);
});

test('Bilibili AV, episode and player links use the official player address', () => {
  for (const [source, destination] of [
    ['https://www.bilibili.com/video/av123456', 'aid=123456'],
    ['https://www.bilibili.com/bangumi/play/ep123456', 'episodeId=123456'],
    ['https://player.bilibili.com/player.html?aid=123456&episodeId=789', 'episodeId=789'],
  ]) assert.ok(renderMarkdown(source).includes(`data-embed-src="https://player.bilibili.com/player.html?${destination}&amp;autoplay=0"`), source);
});

test('Bilibili share links retain mobile playback identifiers without copying arbitrary parameters', () => {
  const html = renderMarkdown('https://player.bilibili.com/player.html?isOutside=true&aid=98647868&bvid=BV1B7411m7LV&cid=168325345&p=2&t=45&extra=unsafe');
  assert.match(html, /data-embed-src="https:\/\/player.bilibili.com\/player.html\?bvid=BV1B7411m7LV&amp;aid=98647868&amp;cid=168325345&amp;p=2&amp;t=45&amp;autoplay=0"/);
  const invalid = renderMarkdown('https://www.bilibili.com/video/BV1B7411m7LV?aid=oops&cid=9999999999999999');
  assert.match(invalid, /data-embed-src="https:\/\/player.bilibili.com\/player.html\?bvid=BV1B7411m7LV&amp;autoplay=0"/);
});

test('only recognized standalone video links embed; hostile labels stay text', () => {
  const invalid = [
    '[假域名](https://www.youtube.com.evil.example/watch?v=M7lc1UVf-VE)',
    '[错误 ID](https://www.youtube.com/watch?v=bad)',
    '[假 B 站](https://www.bilibili.com.evil.example/video/BV1B7411m7LV)',
    '文字 [讲解](https://www.youtube.com/watch?v=M7lc1UVf-VE) 仍是文字',
    '`https://youtu.be/M7lc1UVf-VE`',
  ];
  for (const source of invalid) assert.doesNotMatch(renderMarkdown(source), /markdown-video-embed|data-embed-src|<iframe/, source);
  const html = renderMarkdown('[&lt;img src=x onerror=evil&gt;](https://www.youtube.com/watch?v=M7lc1UVf-VE)');
  assert.match(html, /img src=x onerror=evil/);
  assert.doesNotMatch(html, /<img\b|<iframe|" onerror=/);
});

test('task lists render read-only checkboxes while preserving Markdown text', () => {
  const html = renderMarkdown('- [ ] 核对价格\n- [x] 整理结论\n- 普通条目');
  assert.match(html, /<li class="markdown-task-item"><input class="markdown-task-checkbox" type="checkbox" disabled aria-label="未完成">核对价格<\/li>/);
  assert.match(html, /<li class="markdown-task-item"><input class="markdown-task-checkbox" type="checkbox" disabled aria-label="已完成" checked>整理结论<\/li>/);
  assert.match(html, /<li>普通条目<\/li>/);
});

test('source extraction understands named/reference links and ignores URLs inside code', () => {
  const source = '[**官方**价格](https://example.com/pricing_(2026))\n\n[说明][doc]\n\nhttps://example.com/pricing_(2026).\n\n`https://example.com/inline-code`\n\n```text\nhttps://example.com/code-block\n```\n\n[doc]: https://example.com/docs "官方说明"';
  assert.deepEqual(markdownLinks(source), [
    {url: 'https://example.com/pricing_(2026)', label: '官方价格'},
    {url: 'https://example.com/docs', label: '说明'},
  ]);
});

test('GitHub and Chinese callout blockquotes render styled titles safely while leaving normal quotes intact', () => {
  const html = renderMarkdown([
    '> [!WARNING] 价格口径存疑 :warning:',
    '> 实际价差约为 **17%**，而非 20%。',
    '',
    '> [!结论] 条件支持小范围试点。',
    '',
    '> [!NOTE] <script>alert(1)</script>',
    '>',
    '> - 核对官方来源',
    '',
    '> [!UNKNOWN] 普通引用不会被改写',
    '',
    '> 原话摘录保持标准引用样式。',
  ].join('\n'));
  assert.match(html, /<blockquote class="markdown-callout markdown-callout-warning">/);
  assert.match(html, /<p class="markdown-callout-title"><span class="markdown-callout-icon" aria-hidden="true">⚠️<\/span><span>价格口径存疑 ⚠️<\/span><\/p>/);
  assert.match(html, /实际价差约为 <strong>17%<\/strong>/);
  assert.match(html, /<blockquote class="markdown-callout markdown-callout-tip">/);
  assert.match(html, /<span>结论<\/span><\/p>\n<p>条件支持小范围试点。<\/p>/);
  assert.match(html, /<blockquote class="markdown-callout markdown-callout-note">/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script\b|\sstyle=/);
  assert.match(html, /<blockquote>\n<p>\[!UNKNOWN\] 普通引用不会被改写<\/p>/);
  assert.match(html, /<blockquote>\n<p>原话摘录保持标准引用样式。<\/p>/);
});
