/** Floating dropdown menu with optional search and keyboard navigation. */

import { el, esc } from '../dom.js';
import { icon } from '../icons.js';

let current = null;

export function closeDropdown() {
  if (!current) return;
  current.node.remove();
  current.anchor?.removeAttribute('aria-expanded');
  current = null;
  document.getElementById('dropdownRoot')?.classList.remove('active');
}

/**
 * @param {object} config
 * @param {HTMLElement} config.anchor element the menu is attached to
 * @param {Array} config.items [{id,title,sub,icon,group,active,danger,onClick,keepOpen}]
 * @param {boolean} [config.searchable]
 * @param {string} [config.placeholder]
 * @param {Function} [config.onSelect] called with the item
 * @param {string} [config.align] 'left' | 'right'
 * @param {number} [config.width]
 * @param {Node} [config.footerNode]
 */
export function openDropdown(config = {}) {
  if (current && current.anchor === config.anchor) {
    closeDropdown();
    return null;
  }
  closeDropdown();

  const root = document.getElementById('dropdownRoot');
  const node = el('div', { class: 'dropdown', role: 'menu' });
  if (config.width) node.style.width = `${config.width}px`;

  let items = [...(config.items || [])];
  let selected = Math.max(0, items.findIndex((item) => item.active));

  const listWrap = el('div', { class: 'dropdown-list' });
  node.append(listWrap);

  let searchInput = null;
  if (config.searchable) {
    searchInput = el('input', {
      class: 'input-t',
      type: 'search',
      placeholder: config.placeholder || 'Search...',
      autocomplete: 'off',
    });
    const searchWrap = el('div', { class: 'dropdown-search' });
    searchWrap.append(searchInput);
    node.insertBefore(searchWrap, listWrap);
    searchInput.addEventListener('input', () => render(searchInput.value.trim().toLowerCase()));
  }

  function render(filter = '') {
    listWrap.textContent = '';
    const visible = items.filter((item) => {
      if (!filter) return true;
      return `${item.title || ''} ${item.sub || ''} ${item.group || ''}`.toLowerCase().includes(filter);
    });
    if (!visible.length) {
      listWrap.append(el('div', { class: 'empty-mini', text: config.emptyText || 'Nothing found' }));
      return;
    }
    let lastGroup = null;
    visible.forEach((item, index) => {
      if (item.group && item.group !== lastGroup) {
        listWrap.append(el('div', { class: 'dd-label', text: item.group }));
        lastGroup = item.group;
      }
      if (item.separator) {
        listWrap.append(el('div', { class: 'dd-sep' }));
        return;
      }
      const row = el('button', {
        class: `dd-item${item.active ? ' active' : ''}${item.danger ? ' danger' : ''}`,
        role: 'menuitem',
        dataset: { index: String(index) },
      });
      if (item.icon) {
        row.append(el('span', { class: 'dd-icon', html: icon(item.icon, 14) }));
      }
      const textWrap = el('span', { class: 'dd-text' });
      textWrap.append(el('span', { class: 'dd-title', html: item.titleHtml || esc(item.title || '') }));
      if (item.sub) textWrap.append(el('span', { class: 'dd-sub', text: item.sub }));
      row.append(textWrap);
      if (item.badge) row.append(el('span', { class: 'tag', text: item.badge }));
      if (item.active) row.append(el('span', { class: 'dd-check', html: icon('check', 15, 2.4) }));
      row.addEventListener('click', () => {
        config.onSelect?.(item);
        item.onClick?.(item);
        if (!item.keepOpen) closeDropdown();
      });
      row.addEventListener('mouseenter', () => {
        selected = index;
        highlight();
      });
      listWrap.append(row);
    });
    selected = Math.min(selected, visible.length - 1);
    highlight();
  }

  function highlight() {
    const rows = Array.from(listWrap.querySelectorAll('.dd-item'));
    rows.forEach((row, index) => row.classList.toggle('sel', index === selected));
    rows[selected]?.scrollIntoView({ block: 'nearest' });
  }

  node.addEventListener('keydown', (event) => {
    const rows = Array.from(listWrap.querySelectorAll('.dd-item'));
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selected = (selected + 1) % Math.max(1, rows.length);
      highlight();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      selected = (selected - 1 + rows.length) % Math.max(1, rows.length);
      highlight();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      rows[selected]?.click();
    }
  });

  if (config.footerNode) node.append(config.footerNode);

  root.append(node);
  root.classList.add('active');
  render('');
  position(node, config.anchor, config.align);

  current = { node, anchor: config.anchor };
  config.anchor?.setAttribute('aria-expanded', 'true');

  setTimeout(() => (searchInput || node).focus(), 20);

  const onDocDown = (event) => {
    if (!current) return;
    if (node.contains(event.target) || config.anchor?.contains(event.target)) return;
    closeDropdown();
    document.removeEventListener('mousedown', onDocDown, true);
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      closeDropdown();
      document.removeEventListener('keydown', onKey, true);
    }
  };
  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', () => closeDropdown(), { once: true });

  return { node, close: closeDropdown, refresh: render };
}

function position(node, anchor, align = 'left') {
  if (!anchor) {
    node.style.top = '70px';
    node.style.left = '50%';
    node.style.transform = 'translateX(-50%)';
    return;
  }
  const rect = anchor.getBoundingClientRect();
  const menuRect = node.getBoundingClientRect();
  const margin = 8;
  let top = rect.bottom + margin;
  if (top + menuRect.height > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - menuRect.height - margin);
  }
  let left = align === 'right' ? rect.right - menuRect.width : rect.left;
  left = Math.max(margin, Math.min(left, window.innerWidth - menuRect.width - margin));
  node.style.top = `${top}px`;
  node.style.left = `${left}px`;
  node.style.maxHeight = `${Math.min(menuRect.height || 420, window.innerHeight - top - margin)}px`;
}

/** Context menu at a point (right-click / "..." buttons). */
export function openContextMenu(x, y, items) {
  closeDropdown();
  const root = document.getElementById('dropdownRoot');
  const node = el('div', { class: 'ctx-menu', role: 'menu' });
  items.forEach((item) => {
    if (item.separator) {
      node.append(el('div', { class: 'dd-sep' }));
      return;
    }
    const row = el('button', { class: `ctx-item${item.danger ? ' danger' : ''}`, role: 'menuitem' });
    if (item.icon) row.append(el('span', { html: icon(item.icon, 14) }));
    row.append(el('span', { text: item.title }));
    if (item.kbd) row.append(el('kbd', { text: item.kbd }));
    row.addEventListener('click', () => {
      closeDropdown();
      item.onClick?.(item);
    });
    node.append(row);
  });
  root.append(node);
  root.classList.add('active');
  const rect = node.getBoundingClientRect();
  node.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  node.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  current = { node, anchor: null };
  const onDocDown = (event) => {
    if (!node.contains(event.target)) {
      closeDropdown();
      document.removeEventListener('mousedown', onDocDown, true);
    }
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      closeDropdown();
      document.removeEventListener('keydown', onKey, true);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0);
  document.addEventListener('keydown', onKey, true);
  return node;
}
