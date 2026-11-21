async page => {
  await page.unrouteAll({behavior: 'wait'});
  await page.setViewportSize({width: 1280, height: 900});
  const errors = [], posts = [], metadataRequests = [];
  let releaseMetadata;
  const metadataGate = new Promise(resolve => { releaseMetadata = resolve; });
  const boardOrigin = 'https://board.example.test';
  page.on('pageerror', error => errors.push(error.message));
  const json = data => ({status: 200, contentType: 'application/json', body: JSON.stringify(data)});
  const prose = '**重点明确**，保留适用条件。\n\n- 核实价格\n  - 检查续费\n\n> 引用官方说明，运行 `npm test`。';
  const summary = [
    '## 结论', '', '**方案 A 更合适** :thumbsup:，当前比较已经核实首年价格，仍需保留续费条件。😀', '',
    '| 方案 | 首年 | 续费 | 币种 | 使用条件 | 备注 |', '| :--- | ---: | ---: | :---: | --- | --- |',
    '| A | 20 | 30 | CNY | 单人 | 待核对 |', '| B | 25 | 35 | CNY | 多人 | 已核对 |', '',
    prose, '', '```json', JSON.stringify({command: 'a'.repeat(180)}), '```', '',
    '[官方价格](https://example.com/pricing_(2026))。 https://example.com/docs.', '',
    '<img src=x onerror="window.markdownExecuted=true">', '',
    '<script>window.markdownExecuted=true</script>', '',
    '[危险链接](javascript:alert(1))', '', '- [ ] 核对图表', '- [x] 记录结论', '',
    '![图表](https://media.example.test/chart.svg)', '',
    '![audio: 讨论录音](https://media.example.test/talk.mp3)', '',
    '![video: 操作演示](https://media.example.test/demo.mp4)',
    '', '[YouTube 讲解](https://www.youtube.com/watch?v=M7lc1UVf-VE)',
    '', '[B 站演示](https://www.bilibili.com/video/BV1B7411m7LV?p=2)',
  ].join('\n');
  const plan = {goal: 'content', collaboration: 'hosted', configured: true, revision: 1, acceptance: {criteria: '可读，内容准确', min_sources: 0, independent_review: false, opposing_views: false}, schedule: {kind: 'once'}, delivery: {format: 'text'}};
  const task = {id: 1, title: 'Markdown 成果示例', status: 'review', detail: '## 任务目标\n\n整理 **价格比较**，保留 `CNY` 单位。', created_by: 'Owner', plan};
  let instructions = '## 当前重点\n\n先核对 **续费条件**。', version = 'v1';
  const guide = () => ({version, instructions, markdown: '# Agent 指南\n\n## Markdown 排版\n\n' + prose, bootstrap: '每轮先读取 /api/agent-guide'});
  const workflow = {enabled: true, host_id: 2, host: 'Host', plan, author_ids: [2], fingerprint: 'fp1', blocking: 0,
    outcomes: [
      {id: 2, author: 'Host', summary, links: '[官方价格](https://example.com/pricing_(2026))\nhttps://example.com/docs.', changes: '**修正**：补充续费条件。'},
      {id: 1, author: 'Host', summary: '**第一版结论**', changes: '**首次发布**'},
    ], reviews: [{reviewer: 'Checker', fingerprint: 'fp1', note: '**逐项核对**，金额一致。', evidence: 'https://example.com/docs'}], current_reviews: [],
    issues: [{id: 1, author: 'Checker', state: 'responded', text: '**核查问题**：需要说明续费条件。', response: '已在 **续费列** 中补充。', severity: 'suggestion'}],
    subtasks: [{id: 1, title: '核实金额', assignee: 'Worker', state: 'done', deliverable: '**列出金额**，保留币种。', summary: '**核实完成**', links: ''}],
  };
  // Match the deployed board's restrictive CSP while using the local asset server.
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (route.request().resourceType() !== 'document' && !url.startsWith(boardOrigin)) return route.continue();
    const localUrl = url.replace(boardOrigin, 'http://127.0.0.1:8765').replace('/bilibili-metadata?', '/bilibili-metadata.html?');
    const response = await route.fetch({url: localUrl});
    if (route.request().resourceType() !== 'document') return route.fulfill({response});
    if (route.request().url().includes('/bilibili-metadata')) return route.fulfill({response, headers: {...response.headers(), 'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts; script-src 'self' https://api.bilibili.com/x/web-interface/wbi/view"}});
    return route.fulfill({response, headers: {...response.headers(), 'content-security-policy': "default-src 'none'; base-uri 'none'; object-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: https:; media-src 'self' https:; frame-src 'self' https://www.youtube-nocookie.com https://player.bilibili.com https://www.bilibili.com", 'referrer-policy': 'no-referrer'}});
  });
  await page.route('https://media.example.test/**', route => {
    if (route.request().url().endsWith('/chart.svg')) return route.fulfill({status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="450"><rect width="900" height="450" fill="#a8c7b3"/></svg>'});
    return route.fulfill({status: 200, body: ''});
  });
  await page.route('https://api.bilibili.com/x/web-interface/wbi/view?**', async route => {
    const part = /[?&]p=([0-9]+)/.exec(route.request().url())?.[1];
    metadataRequests.push(part);
    await metadataGate;
    if (part === '1' && metadataRequests.filter(p => p === '1').length === 1) return route.fulfill({status: 412, contentType: 'application/javascript', body: ''});
    return route.fulfill({status: 200, contentType: 'application/javascript', body: 'whiteboardVideoInfo(' + JSON.stringify({code: 0, data: {aid: 98647868, bvid: 'BV1B7411m7LV', pages: [{page: 1, cid: 168325345}, {page: 2, cid: 168325346}]}}) + ')'});
  });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = request.url().replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    if (request.method() === 'POST') {
      const body = JSON.parse(request.postData()); posts.push({path, body});
      if (path === '/api/admin/agent-guide') {instructions = body.instructions; version = 'v2'; return route.fulfill(json(guide()));}
      return route.fulfill(json({ok: true}));
    }
    if (path === '/api/auth/me') return route.fulfill(json({user: {id: 1, name: 'Owner', role: 'admin'}}));
    if (path === '/api/tasks') return route.fulfill(json({tasks: [task]}));
    if (path === '/api/tasks/1') return route.fulfill(json({task, workflow, debate: [{id: 11, agent: 'Worker', content: prose, stance: '补充'}], verify_readiness: {ready: false, checks: []}}));
    if (path === '/api/agent-guide') return route.fulfill(json(guide()));
    if (path === '/api/messages') return route.fulfill(json({messages: [{author: 'Worker', text: '**频道进展**\n\n- 已核对价格\n\n[B 站视频](https://www.bilibili.com/video/BV1B7411m7LV)'}]}));
    if (path === '/api/topics') return route.fulfill(json({themes: [], topics: [{id: 1, title: '排版讨论', author: 'Host', replies: 1}]}));
    if (path === '/api/topics/1') return route.fulfill(json({topic: {id: 1, title: '排版讨论', author: 'Host', content: '**话题结论** :tada:'}, replies: [{id: 1, author: 'Worker', content: '*回复说明*'}], proposals: []}));
    return route.fulfill(json({channels: [], accounts: [], agents: [], leaderboard: [], highlights: [], decisions: [], items: [], waiting: [], contributions: []}));
  });
  const embedRequests = [];
  for (const host of ['www.youtube-nocookie.com', 'player.bilibili.com']) {
    await page.route(`https://${host}/**`, route => {
      embedRequests.push({url: route.request().url(), referer: route.request().headers().referer});
      if (host === 'player.bilibili.com') return route.fulfill({status: 200, contentType: 'text/html', body: '<!doctype html><script>location.replace("https://www.bilibili.com/blackboard/webplayer/mbplayer.html" + location.search)</script>'});
      return route.fulfill({status: 200, contentType: 'text/html', body: '<!doctype html><title>模拟视频播放器</title>'});
    });
  }
  await page.route('https://www.bilibili.com/blackboard/webplayer/mbplayer.html**', route => route.fulfill({status: 200, contentType: 'text/html', body: '<!doctype html><title>Bilibili mobile player mock</title>'}));
  await page.goto(boardOrigin);
  await page.locator('#navTasks').click();
  await page.locator('#taskList .task-item').click();
  await page.locator('#taskDetail .task-intro h2').waitFor();
  if (await page.locator('#taskDetail .task-intro strong').textContent() !== '价格比较') throw Error('任务说明没有 Markdown 排版');
  await page.locator('#taskDetail').getByRole('tab', {name: '成果', exact: true}).click();
  const block = page.locator('#detailPanel-outcome .current-outcome');
  const fold = block.locator('.outcome-summary > .text-fold');
  if (await fold.getAttribute('open') !== null) throw Error('长篇 Markdown 没有默认折叠');
  if ((await block.locator('.text-preview').first().textContent()).includes('**')) throw Error('摘要截断留下 Markdown 标记');
  await fold.locator(':scope > summary').click();
  const full = fold.locator('.full-text');
  for (const selector of ['h2', 'strong', 'ul ul', 'blockquote', 'pre code.language-json', '.markdown-table table', 'code', '.markdown-task-item input[disabled]', '.markdown-image img', '.markdown-audio audio[controls]', '.markdown-video video[controls]']) if (!await full.locator(selector).count()) throw Error(`正文缺少 ${selector}`);
  if (!(await full.textContent()).includes('👍') || !(await full.textContent()).includes('😀')) throw Error('成果中的 Emoji 没有显示');
  if (await full.locator('td.markdown-align-right').first().evaluate(cell => getComputedStyle(cell).textAlign) !== 'right') throw Error('CSP 下表格对齐失效');
  const image = full.locator('.markdown-image img');
  await image.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('#detailPanel-outcome .full-text .markdown-image img')?.naturalWidth === 900);
  if (await full.locator('script, svg, [style], [onerror], a[href^="javascript:"]').count() || await page.evaluate(() => !!window.markdownExecuted)) throw Error('不可信 Markdown 被执行');
  if (await full.locator('img').count() !== 1 || await image.getAttribute('alt') !== '图表') throw Error('图片未按安全语法显示');
  if (await full.locator('.markdown-audio audio').getAttribute('preload') !== 'none' || await full.locator('.markdown-video video').getAttribute('preload') !== 'none') throw Error('音视频没有按需加载');
  if (!await full.locator('.markdown-task-item input[checked][disabled]').count()) throw Error('待办勾选框没有显示');
  const embeds = full.locator('.markdown-video-embed');
  if (await embeds.count() !== 2 || await embeds.locator('iframe').count() || embedRequests.length || metadataRequests.length) throw Error('视频播放器在展开前请求了视频信息或第三方');
  const youtubeRequest = page.waitForRequest(request => request.url().startsWith('https://www.youtube-nocookie.com/embed/'));
  await embeds.first().locator('summary').click();
  const youtubeFrameRequest = await youtubeRequest;
  if (await embeds.first().locator('iframe').getAttribute('loading') !== 'eager') throw Error('主动展开后播放器仍延迟加载');
  if (!await embeds.first().locator('.markdown-video-source').isVisible()) throw Error('原视频入口不可见');
  if (!youtubeFrameRequest.headers().referer?.startsWith(boardOrigin)) throw Error('YouTube 播放器缺少站点来源');
  if (!await embeds.first().locator('iframe').count()) throw Error('YouTube 播放器没有展开');
  await embeds.first().locator('summary').click();
  await embeds.first().locator('iframe').waitFor({state: 'detached'});
  const metadataRequest = page.waitForRequest(request => request.url().includes('/x/web-interface/wbi/view?'));
  await embeds.last().locator('summary').click();
  await metadataRequest;
  const helper = page.frames().find(frame => frame.url().includes('/bilibili-metadata?'));
  if (!await helper.evaluate(() => {try {parent.document.body; return false;} catch {return true;}})) throw Error('B 站视频信息查询可以读取白板内容');
  await embeds.last().locator('summary').click();
  await embeds.last().locator('iframe').waitFor({state: 'detached'});
  const metadataResponse = page.waitForResponse(response => response.url().includes('/x/web-interface/wbi/view?'));
  releaseMetadata();
  await (await metadataResponse).finished();
  if (await embeds.last().locator('iframe').count()) throw Error('收起后异步视频信息请求重新打开了播放器');
  const bilibiliRequest = page.waitForRequest(request => request.url().startsWith('https://player.bilibili.com/player.html'));
  const bilibiliMobileNavigation = page.waitForEvent('framenavigated', {predicate: frame => frame.url().startsWith('https://www.bilibili.com/blackboard/webplayer/mbplayer.html')});
  await embeds.last().locator('summary').click();
  const biliUrl = (await bilibiliRequest).url();
  if (!biliUrl.includes('&aid=98647868') || !biliUrl.includes('&cid=168325346') || !biliUrl.includes('&p=2')) throw Error('B 站播放器缺少指定分集的 aid/cid');
  if (!await embeds.last().locator('iframe').count()) throw Error('B 站播放器没有展开');
  const mobilePlayer = await bilibiliMobileNavigation;
  if (await mobilePlayer.locator('title').textContent() !== 'Bilibili mobile player mock') throw Error('B 站移动播放器跳转后没有加载');
  await fold.locator(':scope > summary').click();
  await embeds.last().locator('iframe').waitFor({state: 'detached'});
  await fold.locator(':scope > summary').click();
  const named = full.getByRole('link', {name: '官方价格', exact: true});
  if (await named.getAttribute('href') !== 'https://example.com/pricing_(2026)' || await named.getAttribute('rel') !== 'noopener noreferrer') throw Error('命名链接丢失或缺少安全属性');
  if (await page.locator('#taskDetail .outcome-form textarea[name="summary"]').inputValue() !== summary) throw Error('编辑器没有保留 Markdown 原文');
  if (await block.locator(':scope > .change-note strong').textContent() !== '修正') throw Error('修改说明没有排版');
  await block.locator('.outcome-links > summary').click();
  if (!await block.locator('.source-list').getByRole('link', {name: '官方价格', exact: true}).count()) throw Error('来源丢失命名链接');
  await page.screenshot({path: '.playwright-cli/markdown-desktop.png', fullPage: true});

  await page.locator('#taskDetail').getByRole('tab', {name: /^核查/}).click();
  if (!await page.locator('#detailPanel-review .work-issue strong').filter({hasText: '核查问题'}).count() || !await page.locator('#detailPanel-review .markdown-body strong').filter({hasText: '逐项核对'}).count()) throw Error('问题或核查说明没有排版');
  await page.locator('#taskDetail').getByRole('tab', {name: /^讨论/}).click();
  if (!await page.locator('#debate-11 .markdown-body strong').count() || !await page.locator('#debate-11 ul ul').count()) throw Error('任务讨论没有排版');
  await page.locator('#navCommunity').click();
  await page.locator('#messages .markdown-body strong').waitFor();
  if (await page.locator('#messages .markdown-video-embed').count() !== 1) throw Error('频道讨论中的 B 站链接没有生成播放器');
  const discussionEmbed = page.locator('#messages .markdown-video-embed');
  const fallbackRequest = page.waitForRequest(request => request.url().startsWith('https://player.bilibili.com/player.html'));
  await discussionEmbed.locator('summary').click();
  if ((await fallbackRequest).url().includes('&cid=') || !await discussionEmbed.locator('.markdown-video-source').isVisible()) throw Error('视频信息请求失败后没有保留官方播放器和原视频入口');
  await discussionEmbed.locator('summary').click();
  await discussionEmbed.locator('iframe').waitFor({state: 'detached'});
  const retriedRequest = page.waitForRequest(request => request.url().startsWith('https://player.bilibili.com/player.html'));
  await discussionEmbed.locator('summary').click();
  if (!(await retriedRequest).url().includes('&cid=168325345') || metadataRequests.filter(p => p === '1').length !== 2) throw Error('讨论区播放器未重试视频信息请求');

  await page.locator('#workspaceMenu > summary').click();
  await page.locator('#workspaceMenu [data-settings="guide"]').click();
  if (await page.locator('#agentGuide .guide-current strong').last().textContent() !== '续费条件') throw Error('当前工作指示没有排版');
  const editor = page.locator('#agentGuide .guide-editor textarea');
  if (await editor.inputValue() !== instructions) throw Error('指南草稿没有保留 Markdown 原文');
  const revised = '## 新的重点\n\n- **先核对价格**\n- 保留条件';
  await editor.fill(revised);
  await page.locator('#agentGuide').getByRole('button', {name: '发布工作指示', exact: true}).click();
  await page.locator('#agentGuide .guide-current li strong').waitFor();
  if (posts.at(-1)?.body.instructions !== revised) throw Error('发布时转换或丢失 Markdown 原文');
  await page.locator('#agentGuide').getByText('查看完整指南', {exact: true}).click();
  if (!await page.locator('#agentGuide .guide-text h1').isVisible() || !await page.locator('#agentGuide .guide-text blockquote').count()) throw Error('完整指南仍为纯文字');

  await page.setViewportSize({width: 390, height: 844});
  await page.locator('#navOutcomes').click();
  await page.locator('#outcomeListReview .outcome-item').click();
  await page.locator('#outcomeDetail .outcome-summary > .text-fold > summary').click();
  const mobile = page.locator('#outcomeDetail .full-text');
  for (const selector of ['.markdown-table', 'pre']) {
    const region = mobile.locator(selector);
    if (!await region.evaluate(element => element.scrollWidth > element.clientWidth && getComputedStyle(element).overflowX === 'auto')) throw Error(`手机上 ${selector} 没有独立滚动`);
    if (!await region.evaluate(element => {element.scrollLeft = 40; return element.scrollLeft > 0;})) throw Error(`手机上 ${selector} 无法横向滚动`);
  }
  for (const selector of ['.markdown-image img', '.markdown-audio audio', '.markdown-video video']) {
    if (!await mobile.locator(selector).evaluate(element => element.getBoundingClientRect().right <= innerWidth + 1)) throw Error(`手机上 ${selector} 横向溢出`);
  }
  const mobileEmbed = mobile.locator('.markdown-video-embed').last();
  await mobileEmbed.locator('summary').click();
  if (metadataRequests.filter(p => p === '2').length !== 1) throw Error('重复展开同一分集未复用视频信息');
  if (!await mobileEmbed.evaluate(element => element.getBoundingClientRect().right <= innerWidth + 1)) throw Error('手机上外链播放器横向溢出');
  await page.waitForFunction(() => {
    const frame = document.querySelector('#outcomeDetail .full-text .markdown-video-embed[open] iframe');
    const nav = document.querySelector('.primary-nav');
    return frame && nav && frame.getBoundingClientRect().bottom < nav.getBoundingClientRect().top - 4;
  }, null, {timeout: 3500});
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Markdown 导致手机页面横向溢出');
  await page.screenshot({path: '.playwright-cli/markdown-mobile.png', fullPage: true});
  if (errors.length) throw Error(errors.join('\n'));
  return {task: true, outcome: true, discussion: true, community: true, guide: true, media: true, platformVideo: true, checklists: true, rawEditing: true, safeHTML: true, csp: true, mobile: true};
}
