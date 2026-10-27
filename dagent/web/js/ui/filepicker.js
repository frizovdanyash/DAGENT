/** In-app file/folder browser (native dialogs are not available in a browser tab). */

import { $, el, esc, clear, humanSize, debounce } from '../dom.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { state, setting } from '../state.js';
import { openDialog } from './modal.js';
import { notify } from './toast.js';

/**
 * @param {object} options
 * @param {'file'|'dir'} options.mode
 * @param {string} [options.title]
 * @param {Function} [options.filter] (entry) => bool - which files are selectable
 * @param {string} [options.start] initial folder
 * @param {string} [options.hint]
 * @returns {Promise<string|null>} selected absolute path
 */
export function pickPath(options = {}) {
  const {
    mode = 'file',
    title = mode === 'dir' ? t('settings.workspace_root') : t('models.browse'),
    filter = null,
    start = '',
    hint = '',
    okText = t('common.select'),
  } = options;

  return new Promise((resolve) => {
    let current = start || setting('workspace.root') || '';
    let selected = null;
    let settled = false;

    const pathBar = el('input', { class: 'input-t mono', type: 'text', value: current, placeholder: '/home/user' });
    const list = el('div', { class: 'picker-list' });
    const wrap = el('div', { class: 'picker' });
    const crumbs = el('div', { class: 'picker-path' });
    wrap.append(crumbs, pathBar, list);
    if (hint) wrap.append(el('div', { class: 'hint', text: hint }));

    const footerInfo = el('div', { class: 'hint grow', text: '' });
    const handle = openDialog({
      title,
      icon: mode === 'dir' ? 'folder' : 'file',
      size: 'medium',
      body: wrap,
      onClose: () => {
        if (!settled) resolve(null);
      },
      footer: [
        el('button', {
          class: 'btn ghost',
          html: `${icon('plus', 14)} ${esc(mode === 'dir' ? t('common.create') : '')}`.trim(),
          onclick: async () => {
            if (mode !== 'dir') return;
            const name = window.prompt(mode === 'dir' ? 'New folder name' : 'File name');
            if (!name) return;
            try {
              await api.setWorkspace(`${current}/${name}`);
              await load(current);
            } catch (error) {
              notify.error(t('common.error'), error.message);
            }
          },
        }),
        footerInfo,
        el('button', { class: 'btn', text: t('common.cancel'), onclick: () => { settled = true; handle.close(); resolve(null); } }),
        el('button', {
          class: 'btn accent',
          text: okText,
          onclick: () => {
            const value = mode === 'dir' ? current : selected;
            if (!value) {
              notify.warn(t('common.error'), mode === 'dir' ? '' : 'Select a file first');
              return;
            }
            settled = true;
            handle.close();
            resolve(value);
          },
        }),
      ],
    });

    async function load(path) {
      list.textContent = '';
      list.append(el('div', { class: 'empty-mini', text: t('common.loading') }));
      try {
        const data = await api.browse(path || '');
        current = data.path || path || '';
        pathBar.value = current;
        renderCrumbs(current);
        clear(list);
        selected = null;
        footerInfo.textContent = mode === 'dir' ? current : '';

        if (data.parent) {
          const up = el('div', { class: 'picker-item dir' });
          up.append(el('span', { html: icon('chevronLeft', 15) }));
          up.append(el('span', { text: '..' }));
          up.addEventListener('click', () => load(data.parent));
          list.append(up);
        }
        const entries = data.entries || [];
        if (!entries.length) list.append(el('div', { class: 'empty-mini', text: 'Empty folder' }));
        for (const entry of entries) {
          const selectable = entry.type === 'dir' ? mode === 'dir' : !filter || filter(entry);
          const row = el('div', { class: `picker-item ${entry.type}${selectable ? '' : ' dim'}` });
          row.append(el('span', { html: icon(entry.type === 'dir' ? 'folder' : entry.gguf ? 'cpu' : 'file', 15) }));
          row.append(el('span', { class: 'grow truncate', text: entry.name }));
          if (entry.type === 'file') row.append(el('span', { class: 'pi-size', text: humanSize(entry.size) }));
          row.addEventListener('click', () => {
            if (entry.type === 'dir') {
              load(entry.path);
              return;
            }
            if (!selectable) return;
            list.querySelectorAll('.picker-item.sel').forEach((node) => node.classList.remove('sel'));
            row.classList.add('sel');
            selected = entry.path;
            footerInfo.textContent = `${entry.name} · ${humanSize(entry.size)}`;
          });
          row.addEventListener('dblclick', () => {
            if (entry.type === 'file' && selectable) {
              settled = true;
              handle.close();
              resolve(entry.path);
            }
          });
          list.append(row);
        }
      } catch (error) {
        clear(list);
        list.append(el('div', { class: 'empty-mini', text: error.message }));
      }
    }

    function renderCrumbs(path) {
      clear(crumbs);
      const parts = String(path || '').split(/[\\/]/).filter(Boolean);
      let accumulated = String(path).startsWith('\\') || /^[A-Za-z]:/.test(path) ? '' : '/';
      crumbs.append(el('span', { html: icon('folder', 13) }));
      if (/^[A-Za-z]:/.test(String(path))) {
        accumulated = parts.shift() + '\\';
      }
      parts.forEach((part, index) => {
        accumulated = `${accumulated.replace(/[\\/]$/, '')}/${part}`;
        const target = accumulated;
        const crumb = el('button', { class: 'btn tiny ghost', text: part, onclick: () => load(target) });
        crumbs.append(crumb);
        if (index < parts.length - 1) crumbs.append(el('span', { class: 'muted', text: '/' }));
      });
      if (!parts.length) crumbs.append(el('span', { class: 'muted', text: path || '/' }));
    }

    pathBar.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') load(pathBar.value.trim());
    });
    pathBar.addEventListener('input', debounce(() => load(pathBar.value.trim()), 600));

    load(current);
  });
}

/** Quick preview of a workspace file (used by the Files tab and changed-file clicks). */
export async function previewFile(relativePath) {
  const root = setting('workspace.root', '');
  const absolute = relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath)
    ? relativePath
    : `${root}/${relativePath}`.replace(/\/{2,}/g, '/');
  try {
    const data = await api.readFile(absolute);
    const body = el('div', { class: 'col' });
    body.append(el('div', { class: 'picker-path', text: data.path }));
    if (data.binary) {
      body.append(el('div', { class: 'hint', text: `Binary file · ${humanSize(data.size)}` }));
    } else {
      const { highlight } = await import('../highlight.js');
      const block = el('div', { class: 'code-block' });
      block.innerHTML = `<div class="code-head"><span class="code-lang">${esc(data.language || 'text')}</span><span class="code-file">${esc(humanSize(data.size))}</span></div>
        <div class="code-scroll" style="max-height:52vh"><pre><code>${highlight(data.content.slice(0, 60000), data.language || 'text')}</code></pre></div>`;
      body.append(block);
    }
    let handle = null;
    handle = openDialog({
      title: relativePath.split('/').pop(),
      icon: 'fileCode',
      size: 'wide',
      body,
      footer: [
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn', text: t('common.close'), onclick: () => handle?.close() }),
      ],
    });
  } catch (error) {
    notify.error(t('common.error'), error.message);
  }
}
