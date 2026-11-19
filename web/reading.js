// Keep the saved text intact. A preview is only a preview, never a generated conclusion.
import {renderMarkdown, markdownLinks} from './markdown.js';

const bilibiliLookups = new Map();
function bilibiliMetadata(query) {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.title = 'B 站视频信息';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.src = `/bilibili-metadata?${query}`;
    const finish = ids => {
      clearTimeout(timeout);
      window.removeEventListener('message', receive);
      frame.remove();
      if (ids && ['aid', 'cid'].every(name => Number.isSafeInteger(ids[name]) && ids[name] > 0)) resolve(ids);
      else reject(Error('video metadata unavailable'));
    };
    const receive = event => {
      if (event.origin === 'null' && event.source === frame.contentWindow && event.data?.type === 'whiteboard-bilibili-metadata') finish(event.data.ids);
    };
    const timeout = setTimeout(() => finish(null), 6500);
    window.addEventListener('message', receive);
    document.body.append(frame);
  });
}

async function videoSource(source) {
  const url = new URL(source);
  if (url.hostname !== 'player.bilibili.com' || url.searchParams.has('episodeId') || (url.searchParams.has('aid') && url.searchParams.has('cid'))) return source;
  const key = url.searchParams.has('bvid') ? 'bvid' : 'aid';
  const query = new URLSearchParams({[key]: url.searchParams.get(key), p: url.searchParams.get('p') || '1'}).toString();
  if (bilibiliLookups.get(query)?.expires < Date.now()) bilibiliLookups.delete(query);
  if (!bilibiliLookups.has(query)) {
    if (bilibiliLookups.size >= 100) bilibiliLookups.delete(bilibiliLookups.keys().next().value);
    const pending = bilibiliMetadata(query);
    bilibiliLookups.set(query, {pending, expires: Date.now() + 3600000});
  }
  const lookup = bilibiliLookups.get(query);
  try {
    const ids = await lookup.pending;
    for (const name of ['aid', 'cid']) url.searchParams.set(name, String(ids[name]));
    return url.href;
  } catch {
    if (bilibiliLookups.get(query) === lookup) bilibiliLookups.delete(query);
    return source;
  }
}

export function createReadingUI({node}) {
  const urlPattern = /https?:\/\/[^\s<>"'`]+/gi;
  function link(url, label) {
    const a = node('a', label, 'plain-link');
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = url;
    return a;
  }
  function markdown(value, className = '') {
    const box = node('div', null, `markdown-body ${className}`.trim());
    // The shared parser disables raw HTML and validates every link protocol.
    box.innerHTML = renderMarkdown(value);
    for (const embed of box.querySelectorAll('.markdown-video-embed')) {
      embed.addEventListener('toggle', async () => {
        const slot = embed.querySelector('.markdown-video-frame');
        if (!embed.open) { slot.replaceChildren(); return; }
        if (slot.firstChild) return;
        const iframe = document.createElement('iframe');
        iframe.title = embed.querySelector('summary').textContent.trim();
        // The iframe only exists after an explicit click, so start loading now.
        iframe.loading = 'eager';
        iframe.referrerPolicy = 'strict-origin-when-cross-origin';
        iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
        iframe.allowFullscreen = true;
        slot.append(iframe);
        slot.setAttribute('aria-busy', 'true');
        if (matchMedia('(max-width: 700px)').matches) {
          requestAnimationFrame(() => {
            if (embed.open && embed.isConnected) embed.scrollIntoView({
              block: 'center',
              behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
            });
          });
        }
        const source = await videoSource(embed.dataset.embedSrc);
        if (!embed.open || slot.firstChild !== iframe || !embed.isConnected) return;
        slot.removeAttribute('aria-busy');
        iframe.src = source;
      });
    }
    return box;
  }
  function sources(value, {label = '来源', exclude = []} = {}) {
    const text = String(value || ''), excluded = new Set(exclude.filter(Boolean));
    const allLinks = markdownLinks(text), urls = allLinks.filter(({url}) => !excluded.has(url));
    if (!text.trim() || (allLinks.length && !urls.length)) return null;
    const box = node('details', null, 'source-fold');
    box.append(node('summary', `${label}${urls.length ? `（${urls.length}）` : ''}`));
    const list = node('ul', null, 'source-list');
    for (const {url, label} of urls) {
      const item = node('li'); item.append(link(url, label)); list.append(item);
    }
    box.append(list);
    // Preserve labels, annotations and any non-URL source information without growing the page.
    const annotations = text.replace(urlPattern, '').replace(/[\s\[\]()*\-:：,，;；.。]+/g, '');
    if (annotations) box.append(markdown(text, 'source-notes'));
    return box;
  }
  function text(value, className = '', {limit = 360} = {}) {
    const valueText = String(value || '');
    if (className.split(/\s+/).includes('link-list')) return sources(valueText) || node('span');
    if (Array.from(valueText).length <= limit && valueText.split('\n').length <= 7) return markdown(valueText, className);
    const box = node('div', null, `readable-text ${className}`);
    const full = markdown(valueText, 'full-text');
    // Take preview text from parsed content so a cutoff never leaves visible
    // Markdown delimiters or a broken table/code fence in the collapsed view.
    const firstParagraph = full.querySelector('p')?.textContent.trim() || '';
    const previewText = firstParagraph.length >= 16 && Array.from(firstParagraph).length < limit ? firstParagraph : Array.from(full.textContent).slice(0, limit).join('').trimEnd();
    const preview = node('p', previewText + '…', 'text-preview');
    const fold = node('details', null, 'text-fold'), summary = node('summary', '展开全文');
    fold.append(summary, full);
    fold.addEventListener('toggle', () => {
      preview.hidden = fold.open;
      summary.textContent = fold.open ? '收起全文' : '展开全文';
      if (!fold.open) for (const embed of full.querySelectorAll('.markdown-video-embed[open]')) embed.open = false;
    });
    box.append(preview, fold);
    return box;
  }
  return {text, sources, markdown};
}
