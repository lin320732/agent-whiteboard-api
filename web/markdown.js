import MarkdownIt from './vendor/markdown-it.mjs';

// Raw HTML stays visible as text. Only absolute HTTP(S) links are interactive.
const markdown = new MarkdownIt({html: false, breaks: true, linkify: true});
markdown.linkify.set({fuzzyLink: false, fuzzyEmail: false});
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
    return ['text', 'code_inline'].includes(token.type) ? token.content : '';
  }).join('');
}

// The board's CSP does not load remote images. Offer an explicit link instead.
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index], escape = markdown.utils.escapeHtml;
  const url = token.attrGet('src'), label = inlineText(token.children) || shortName(url);
  return `<a class="plain-link" href="${escape(url)}" title="${escape(token.attrGet('title') || url)}" target="_blank" rel="noopener noreferrer">${escape(label)}</a>`;
};

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
    const tokens = block.children || [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.type !== 'link_open' && token.type !== 'image') continue;
      const url = token.attrGet(token.type === 'image' ? 'src' : 'href');
      let label = '';
      if (token.type === 'image') label = inlineText(token.children);
      else if (token.markup !== 'linkify') {
        const end = tokens.findIndex((next, offset) => offset > index && next.type === 'link_close');
        label = inlineText(tokens.slice(index + 1, end));
      }
      if (!links.has(url)) links.set(url, {url, label: label || shortName(url)});
    }
  }
  return [...links.values()];
}
