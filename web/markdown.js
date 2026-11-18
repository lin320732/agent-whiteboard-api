import MarkdownIt from './vendor/markdown-it.mjs';
import emoji from './vendor/markdown-it-emoji/lib/full.mjs';
import emojiDefs from './vendor/markdown-it-emoji/lib/data/full.mjs';

// Raw HTML stays visible as text. Only absolute HTTP(S) destinations are accepted.
const markdown = new MarkdownIt({html: false, breaks: true, linkify: true});
markdown.linkify.set({fuzzyLink: false, fuzzyEmail: false});
// Support :shortcodes: without rewriting punctuation such as :) in prose.
markdown.use(emoji, {shortcuts: {}});
markdown.validateLink = value => {
  if (!/^https?:\/\//i.test(value)) return false;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); }
  catch { return false; }
};

function shortName(url) {
  const parsed = new URL(url);
  let part = parsed.pathname.split('/').filter(Boolean).pop() || '';
  try { part = decodeURIComponent(part); } catch { /* Keep encoded paths readable. */ }
  const chars = Array.from(part);
  return parsed.hostname + (part ? ` · ${chars.slice(0, 28).join('')}${chars.length > 28 ? '…' : ''}` : '');
}

markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index], url = token.attrGet('href');
  token.attrSet('class', 'plain-link');
  token.attrSet('target', '_blank');
  token.attrSet('rel', 'noopener noreferrer');
  if (!token.attrGet('title')) token.attrSet('title', url);
  // Preserve named link labels and keep bare URLs as compact as the existing UI.
  if (token.markup === 'linkify' && tokens[index + 1]?.type === 'text') tokens[index + 1].content = shortName(url);
  return renderer.renderToken(tokens, index, options);
};

function inlineText(tokens = []) {
  return tokens.map(token => {
    if (token.type === 'image') return inlineText(token.children);
    if (token.type === 'softbreak' || token.type === 'hardbreak') return '\n';
    return ['text', 'code_inline', 'emoji'].includes(token.type) ? token.content : '';
  }).join('');
}

function emojiText(value) {
  return value.replace(/:([A-Za-z0-9_+-]+):/g, (source, name) => Object.hasOwn(emojiDefs, name) ? emojiDefs[name] : source);
}

function mediaDetails(token) {
  const url = token.attrGet('src');
  // The plugin does not visit image-alt child tokens, so expand known aliases here.
  const original = emojiText(inlineText(token.children)).trim();
  const match = /^(audio|video|音频|音訊|视频|影片)\s*[:：]\s*(.*)$/i.exec(original);
  const kind = match ? /^(audio|音频|音訊)$/i.test(match[1]) ? 'audio' : 'video' : 'image';
  return {url, kind, label: (match ? match[2] : original) || shortName(url)};
}

const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
const bilibiliHosts = new Set(['bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'player.bilibili.com']);

function videoSeconds(value) {
  if (value == null) return null;
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(value);
  if (!match || !match.slice(1).some(Boolean)) return null;
  const seconds = Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
  return Number.isSafeInteger(seconds) && seconds <= 604800 ? seconds : null;
}

function platformVideo(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (youtubeHosts.has(host)) {
    let id = '';
    if (host === 'youtu.be' || host === 'www.youtu.be') id = path.slice(1).replace(/\/$/, '');
    else if (path === '/watch') id = url.searchParams.get('v') || '';
    else id = /^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})\/?$/.exec(path)?.[1] || '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    const embed = new URL(`https://www.youtube-nocookie.com/embed/${id}`);
    const seconds = videoSeconds(url.searchParams.get('start') ?? url.searchParams.get('t'));
    if (seconds) embed.searchParams.set('start', String(seconds));
    return {provider: 'YouTube', embedUrl: embed.href};
  }
  if (bilibiliHosts.has(host)) {
    let id = '', key = '';
    const video = /^\/video\/(BV[0-9A-Za-z]{10}|av[0-9]+)\/?$/i.exec(path);
    const episode = /^\/bangumi\/play\/ep([0-9]+)\/?$/.exec(path);
    if (video) {id = video[1]; key = /^BV/i.test(id) ? 'bvid' : 'aid'; id = key === 'aid' ? id.slice(2) : `BV${id.slice(2)}`;}
    else if (episode) {id = episode[1]; key = 'episodeId';}
    else if (host === 'player.bilibili.com' && path === '/player.html') {
      const bvid = url.searchParams.get('bvid') || '';
      const aid = url.searchParams.get('aid') || '';
      const episodeId = url.searchParams.get('episodeId') || '';
      if (/^[0-9]+$/.test(episodeId)) {id = episodeId; key = 'episodeId';}
      else if (/^BV[0-9A-Za-z]{10}$/.test(bvid)) {id = bvid; key = 'bvid';}
      else if (/^[0-9]+$/.test(aid)) {id = aid; key = 'aid';}
    }
    if (!id) return null;
    const embed = new URL('https://player.bilibili.com/player.html');
    embed.searchParams.set(key, id);
    const page = Number(url.searchParams.get('p'));
    if (Number.isSafeInteger(page) && page > 1 && page <= 9999) embed.searchParams.set('p', String(page));
    const seconds = videoSeconds(url.searchParams.get('t'));
    if (seconds) embed.searchParams.set('t', String(seconds));
    embed.searchParams.set('autoplay', '0');
    return {provider: '哔哩哔哩', embedUrl: embed.href};
  }
  return null;
}

function renderVideoEmbed({url, label, provider, embedUrl}) {
  const escape = markdown.utils.escapeHtml;
  return `<details class="markdown-video-embed" data-embed-src="${escape(embedUrl)}"><summary>播放视频 · ${escape(provider)} · ${escape(label)}</summary><span class="markdown-video-frame"></span><a class="plain-link markdown-video-source" href="${escape(url)}" target="_blank" rel="noopener noreferrer">在${escape(provider)}打开原视频</a></details>\n`;
}

// Image syntax embeds HTTPS images. An audio:/video: alt prefix embeds a
// direct media file; HTTP links remain available without mixed-content loads.
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index], escape = markdown.utils.escapeHtml;
  const {url, kind, label} = mediaDetails(token);
  const href = escape(url), caption = escape(label);
  const insideLink = tokens.slice(0, index).reduce((depth, item) => depth + (item.type === 'link_open' ? 1 : item.type === 'link_close' ? -1 : 0), 0) > 0;
  if (insideLink && kind !== 'image') return caption;
  const link = `<a class="plain-link" href="${href}" title="${escape(token.attrGet('title') || url)}" target="_blank" rel="noopener noreferrer">${caption}</a>`;
  if (platformVideo(url)) return insideLink ? caption : link;
  if (new URL(url).protocol !== 'https:') return insideLink ? caption : link;
  if (kind === 'image') return `<span class="markdown-media markdown-image"><img src="${href}" alt="${caption}" loading="lazy" decoding="async" referrerpolicy="no-referrer"><span class="markdown-media-caption">${insideLink ? caption : link}</span></span>`;
  const player = kind === 'audio'
    ? `<audio controls preload="none" src="${href}"></audio>`
    : `<video controls preload="none" playsinline src="${href}"></video>`;
  return `<span class="markdown-media markdown-${kind}">${player}<span class="markdown-media-caption">${link}</span></span>`;
};

// A discussion checklist is display-only; changes are made in the Markdown
// source, so reading a task never silently edits it.
markdown.core.ruler.after('inline', 'task-list', state => {
  for (let i = 0; i < state.tokens.length; i++) {
    if (state.tokens[i].type !== 'list_item_open') continue;
    const inline = state.tokens[i + 2];
    if (state.tokens[i + 1]?.type !== 'paragraph_open' || inline?.type !== 'inline') continue;
    const first = inline.children?.[0];
    const marker = first?.type === 'text' && /^\[([ xX])\](?:\s|$)/.exec(first.content);
    if (!marker) continue;
    const checked = marker[1].toLowerCase() === 'x';
    first.content = first.content.slice(marker[0].length);
    const checkbox = new state.Token('html_inline', '', 0);
    checkbox.content = `<input class="markdown-task-checkbox" type="checkbox" disabled aria-label="${checked ? '已完成' : '未完成'}"${checked ? ' checked' : ''}>`;
    inline.children.unshift(checkbox);
    state.tokens[i].attrJoin('class', 'markdown-task-item');
  }
});

// A video link on its own paragraph becomes a block, so the expandable player
// never ends up inside a <p> or starts loading while the board is being read.
markdown.core.ruler.after('emoji', 'platform-video', state => {
  for (let i = 1; i < state.tokens.length - 1; i++) {
    const inline = state.tokens[i];
    if (inline.type !== 'inline' || state.tokens[i - 1].type !== 'paragraph_open' || state.tokens[i + 1].type !== 'paragraph_close') continue;
    const children = inline.children || [];
    let url = '', label = '';
    if (children.length === 1 && children[0].type === 'image') {
      const media = mediaDetails(children[0]);
      if (media.kind === 'audio') continue;
      url = media.url; label = media.label;
    } else if (children[0]?.type === 'link_open' && children.at(-1)?.type === 'link_close' && children.filter(token => token.type === 'link_open').length === 1 && !children.some(token => token.type === 'image')) {
      url = children[0].attrGet('href');
      label = children[0].markup === 'linkify' ? '' : inlineText(children.slice(1, -1)).trim();
    }
    const video = url && platformVideo(url);
    if (!video) continue;
    const token = new state.Token('video_embed', '', 0);
    token.block = true;
    token.meta = {url, label: label || `${video.provider} 视频`, ...video};
    state.tokens.splice(i - 1, 3, token);
    i--;
  }
});

markdown.renderer.rules.video_embed = (tokens, index) => renderVideoEmbed(tokens[index].meta);

markdown.renderer.rules.table_open = () => '<div class="markdown-table" role="region" aria-label="表格" tabindex="0"><table>\n';
markdown.renderer.rules.table_close = () => '</table></div>\n';
for (const type of ['th_open', 'td_open']) {
  markdown.renderer.rules[type] = (tokens, index, options, env, renderer) => {
    const token = tokens[index], align = token.attrGet('style')?.match(/^text-align:(left|center|right)$/)?.[1];
    // Use stylesheet classes so table alignment also works under style-src 'self'.
    if (token.attrIndex('style') >= 0) token.attrs.splice(token.attrIndex('style'), 1);
    if (align) token.attrSet('class', `markdown-align-${align}`);
    return renderer.renderToken(tokens, index, options);
  };
}
for (const type of ['fence', 'code_block']) {
  const render = markdown.renderer.rules[type];
  markdown.renderer.rules[type] = (...args) => render(...args).replace('<pre>', '<pre tabindex="0" aria-label="代码块">');
}

export function renderMarkdown(value) {
  return markdown.render(String(value ?? ''));
}

// Parse source links with the same rules as the displayed text (including named
// links, escaped parentheses and reference links); code samples are not sources.
export function markdownLinks(value) {
  const links = new Map();
  for (const block of markdown.parse(String(value ?? ''), {})) {
    if (block.type === 'video_embed') {
      const {url, label} = block.meta;
      if (!links.has(url)) links.set(url, {url, label});
      continue;
    }
    const tokens = block.children || [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.type !== 'link_open' && token.type !== 'image') continue;
      const url = token.attrGet(token.type === 'image' ? 'src' : 'href');
      let label = '';
      if (token.type === 'image') label = mediaDetails(token).label;
      else if (token.markup !== 'linkify') {
        const end = tokens.findIndex((next, offset) => offset > index && next.type === 'link_close');
        label = inlineText(tokens.slice(index + 1, end));
      }
      if (!links.has(url)) links.set(url, {url, label: label || shortName(url)});
    }
  }
  return [...links.values()];
}
