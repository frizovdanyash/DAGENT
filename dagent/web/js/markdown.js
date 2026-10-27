/**
 * Dependency-free Markdown renderer used for every assistant message.
 * Supports: headings, lists (nested + task lists), tables, quotes, rules,
 * fenced code (with language + file name), inline code, bold/italic/strike,
 * links, images and autolinks. Output is HTML-escaped by construction.
 */

import { highlight, normalizeLanguage, renderDiff } from './highlight.js';

const CODE_TOKEN = '\u0000CODE';

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(url) {
  const value = String(url || '').trim();
  if (/^(javascript|data|vbscript):/i.test(value)) return '#';
  return value.replace(/"/g, '%22');
}

/* ------------------------------ inline ------------------------------ */

export function inline(text) {
  let out = escapeHtml(text);
  const stash = [];

  // inline code
  out = out.replace(/(`+)([\s\S]*?)\1/g, (match, ticks, code) => {
    stash.push(`<code class="inline">${code.replace(/^ | $/g, '')}</code>`);
    return `${CODE_TOKEN}${stash.length - 1}\u0000`;
  });

  // images
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (m, alt, url, title) => `<img src="${safeUrl(url)}" alt="${alt}" title="${title || alt}" loading="lazy" />`);

  // links
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (m, label, url, title) => `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${title}"` : ''}>${label}</a>`);

  // autolinks <https://...>
  out = out.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g,
    (m, url) => `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${url}</a>`);

  // bare urls
  out = out.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+[^\s<).,;:!?])/g,
    (m, prefix, url) => `${prefix}<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${url}</a>`);

  // bold + italic
  out = out.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  out = out.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>');
  out = out.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, '$1<em>$2</em>');
  out = out.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  out = out.replace(/==(?=\S)([\s\S]*?\S)==/g, '<mark>$1</mark>');

  // restore code spans
  out = out.replace(/\u0000CODE(\d+)\u0000/g, (m, index) => stash[Number(index)] || '');
  return out;
}

/* ------------------------------ blocks ------------------------------ */

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const FENCE_RE = /^\s{0,3}(```|~~~)\s*([\w+#.-]*)\s*(.*)$/;
const UL_RE = /^(\s*)([-*+])\s+(.*)$/;
const OL_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function isBlockStart(line) {
  return (
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    FENCE_RE.test(line) ||
    UL_RE.test(line) ||
    OL_RE.test(line) ||
    QUOTE_RE.test(line)
  );
}

function renderCode(info, code, index) {
  const language = normalizeLanguage(info.lang || 'text');
  const title = info.title || '';
  let body;
  if (language === 'diff' || info.lang === 'patch') {
    body = `<pre class="diff-body"><code>${renderDiff(code)}</code></pre>`;
  } else {
    body = `<pre><code class="lang-${language}">${highlight(code, language)}</code></pre>`;
  }
  return (
    `<div class="code-block" data-code-index="${index}">` +
    `<div class="code-head">` +
    `<span class="code-lang">${escapeHtml(info.lang || 'text')}</span>` +
    (title ? `<span class="code-file">${escapeHtml(title)}</span>` : '') +
    `<span class="code-actions">` +
    `<button class="icon-btn tiny ghost" data-action="copy-code" title="Copy"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.4"/><path d="M6 15H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1"/></svg></button>` +
    `</span></div>` +
    `<div class="code-scroll">${body}</div>` +
    `</div>`
  );
}

function parseList(lines, startIndex, ordered) {
  const itemRe = ordered ? OL_RE : UL_RE;
  let index = startIndex;
  const items = [];
  let baseIndent = null;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      // a blank line may still belong to the list if the next line continues it
      const next = lines[index + 1];
      if (next && (itemRe.test(next) || /^\s{2,}\S/.test(next))) {
        index += 1;
        continue;
      }
      break;
    }
    const match = itemRe.exec(line);
    if (match) {
      const indent = match[1].replace(/\t/g, '  ').length;
      if (baseIndent === null) baseIndent = indent;
      if (indent < baseIndent) break;
      if (indent > baseIndent) {
        // nested list: attach raw lines to the previous item
        if (items.length) items[items.length - 1].lines.push(line.slice(baseIndent));
        index += 1;
        continue;
      }
      items.push({ lines: [match[3]] });
      index += 1;
      continue;
    }
    if (/^\s{2,}\S/.test(line) && items.length) {
      items[items.length - 1].lines.push(line.replace(/^\s{1,4}/, ''));
      index += 1;
      continue;
    }
    // lazy continuation of the last item
    if (items.length && !isBlockStart(line)) {
      items[items.length - 1].lines.push(line);
      index += 1;
      continue;
    }
    break;
  }

  const tag = ordered ? 'ol' : 'ul';
  const isTask = items.length && /^\[[ xX]\]\s+/.test(items[0].lines[0] || '');
  const parts = items.map((item) => {
    let content = item.lines.join('\n');
    let checkbox = '';
    const taskMatch = /^\[([ xX])\]\s+([\s\S]*)$/.exec(content);
    if (taskMatch) {
      const checked = taskMatch[1].toLowerCase() === 'x';
      checkbox = `<input type="checkbox" disabled ${checked ? 'checked' : ''} />`;
      content = taskMatch[2];
    }
    const subLines = content.split('\n');
    const hasBlocks = subLines.some((line) => isBlockStart(line)) || subLines.length > 1;
    const html = hasBlocks ? parseBlocks(subLines) : `<p>${inline(content)}</p>`;
    return `<li>${checkbox}${html.replace(/^<p>([\s\S]*)<\/p>$/, '$1')}</li>`;
  });
  return { html: `<${tag}${isTask ? ' class="task-list"' : ''}>${parts.join('')}</${tag}>`, index };
}

function parseTable(lines, startIndex) {
  const header = lines[startIndex];
  const cells = (row) => row
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim());
  const headCells = cells(header);
  const sepCells = cells(lines[startIndex + 1]);
  const aligns = sepCells.map((cell) => {
    if (/^:-+:$/.test(cell)) return 'center';
    if (/^-+:$/.test(cell)) return 'right';
    if (/^:-+/.test(cell)) return 'left';
    return '';
  });
  let index = startIndex + 2;
  const rows = [];
  while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
    rows.push(cells(lines[index]));
    index += 1;
  }
  const head = headCells
    .map((cell, i) => `<th${aligns[i] ? ` style="text-align:${aligns[i]}"` : ''}>${inline(cell)}</th>`)
    .join('');
  const body = rows
    .map((row) => `<tr>${headCells.map((_, i) => `<td${aligns[i] ? ` style="text-align:${aligns[i]}"` : ''}>${inline(row[i] || '')}</td>`).join('')}</tr>`)
    .join('');
  return { html: `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`, index };
}

export function parseBlocks(lines) {
  const out = [];
  const codeStore = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1];
      const info = fence[2] || '';
      const rest = (fence[3] || '').trim();
      const titleMatch = /(?:title|file)=["']?([^"'\]]+)["']?/i.exec(rest);
      const body = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s{0,3}${marker}`).test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // skip closing fence
      codeStore.push({ lang: info, title: titleMatch ? titleMatch[1].trim() : (rest || ''), code: body.join('\n') });
      out.push(`@@CODE${codeStore.length - 1}@@`);
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1].length);
      const text = heading[2].replace(/\s+#+\s*$/, '');
      const id = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      index += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      out.push('<hr />');
      index += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const quote = [];
      while (index < lines.length && (QUOTE_RE.test(lines[index]) || (lines[index].trim() && quote.length && !isBlockStart(lines[index])))) {
        const match = QUOTE_RE.exec(lines[index]);
        quote.push(match ? match[1] : lines[index]);
        index += 1;
      }
      out.push(`<blockquote>${parseBlocks(quote)}</blockquote>`);
      continue;
    }

    if (line.includes('|') && lines[index + 1] && TABLE_SEP_RE.test(lines[index + 1])) {
      const table = parseTable(lines, index);
      out.push(table.html);
      index = table.index;
      continue;
    }

    if (UL_RE.test(line)) {
      const list = parseList(lines, index, false);
      out.push(list.html);
      index = list.index;
      continue;
    }

    if (OL_RE.test(line)) {
      const list = parseList(lines, index, true);
      out.push(list.html);
      index = list.index;
      continue;
    }

    // paragraph
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index]) && !FENCE_RE.test(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
      if (lines[index] && TABLE_SEP_RE.test(lines[index])) break;
    }
    if (paragraph.length) {
      const parts = paragraph.map((raw) => {
        const hardBreak = / {2,}$/.test(raw);
        return inline(raw.replace(/\s+$/, '')) + (hardBreak ? '<br />' : '');
      });
      out.push(`<p>${parts.join(' ').replace(/<br \/> /g, '<br />')}</p>`);
    } else {
      index += 1;
    }
  }

  let html = out.join('\n');
  html = html.replace(/@@CODE(\d+)@@/g, (match, id) => renderCode(codeStore[Number(id)], codeStore[Number(id)].code, Number(id)));
  return html;
}

/** Main entry: markdown text -> safe HTML. */
export function markdown(source, options = {}) {
  const text = String(source ?? '');
  if (!text.trim()) return '';
  if (options.plain === true) return `<p>${inline(text).replace(/\n/g, '<br />')}</p>`;
  return parseBlocks(text.replace(/\r\n/g, '\n').split('\n'));
}

/** Render markdown into an element. */
export function renderInto(node, source, options = {}) {
  if (!node) return;
  node.innerHTML = markdown(source, options);
  return node;
}

/** Plain-text preview of markdown (for session snippets / titles). */
export function plainText(source, limit = 140) {
  const text = String(source ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>~-]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

export { escapeHtml, CODE_TOKEN };
