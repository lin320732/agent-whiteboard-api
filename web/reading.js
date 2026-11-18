// Keep the saved text intact. A preview is only a preview, never a generated conclusion.
import {renderMarkdown, markdownLinks} from './markdown.js';

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
      embed.addEventListener('toggle', () => {
        const slot = embed.querySelector('.markdown-video-frame');
        if (!embed.open) { slot.replaceChildren(); return; }
        if (slot.firstChild) return;
        const iframe = document.createElement('iframe');
        iframe.src = embed.dataset.embedSrc;
        iframe.title = embed.querySelector('summary').textContent.trim();
        iframe.loading = 'lazy';
        iframe.referrerPolicy = 'strict-origin-when-cross-origin';
        iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
        iframe.allowFullscreen = true;
        slot.append(iframe);
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
