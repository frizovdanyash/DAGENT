/** Command palette (Ctrl+K): actions, sessions, models and modes in one place. */

import { $, el, esc, clear, truncate } from '../dom.js';
import { icon, MODE_ICONS } from '../icons.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { bus, state, setting, setSetting, currentSession } from '../state.js';
import { notify } from './toast.js';
import * as theme from '../theme.js';

let open = false;

export function togglePalette() {
  if (open) closePalette();
  else openPalette();
}

export function openPalette(prefill = '') {
  if (open) return;
  open = true;
  const root = document.getElementById('paletteRoot');
  root.classList.add('active');

  const overlay = el('div', { class: 'overlay', style: { placeItems: 'start center', background: 'color-mix(in srgb, #05070d 55%, transparent)' } });
  const panel = el('div', { class: 'palette', role: 'dialog', 'aria-label': 'Command palette' });

  const inputWrap = el('div', { class: 'palette-input-wrap' });
  inputWrap.append(el('span', { html: icon('search', 17) }));
  const input = el('input', { class: 'palette-input', type: 'text', placeholder: t('palette.placeholder'), value: prefill, autocomplete: 'off', spellcheck: 'false' });
  inputWrap.append(input);
  const closeBtn = el('button', { class: 'icon-btn tiny ghost', html: icon('x', 14), onclick: () => closePalette() });
  inputWrap.append(closeBtn);

  const list = el('div', { class: 'palette-list' });
  const foot = el('div', { class: 'palette-foot' });
  foot.append(el('span', { html: `<kbd>↑</kbd><kbd>↓</kbd> navigate` }));
  foot.append(el('span', { html: `<kbd>Enter</kbd> ${esc(t('palette.hint_enter'))}` }));
  foot.append(el('span', { html: `<kbd>Esc</kbd> ${esc(t('palette.hint_esc'))}` }));

  panel.append(inputWrap, list, foot);
  overlay.append(panel);
  root.append(overlay);

  let items = [];
  let selected = 0;

  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) closePalette();
  });

  input.addEventListener('input', () => render());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selected = Math.min(selected + 1, items.length - 1);
      paint();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      selected = Math.max(selected - 1, 0);
      paint();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = items[selected];
      if (item) run(item);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closePalette();
    }
  });

  function run(item) {
    closePalette();
    setTimeout(() => item.run?.(), 10);
  }

  function build(query) {
    const out = [];
    const q = query.toLowerCase().trim();

    const actions = [
      { title: t('cmd.new_session'), sub: 'Ctrl+N', icon: 'plus', run: () => bus.emit('ui:new-session') },
      { title: t('cmd.open_settings'), sub: 'Ctrl+,', icon: 'settings', run: () => bus.emit('ui:open-settings', 'agent') },
      { title: t('cmd.add_model'), icon: 'cpu', run: () => bus.emit('ui:add-model') },
      { title: t('cmd.switch_model'), sub: 'Ctrl+M', icon: 'cloud', run: () => bus.emit('ui:model-switcher') },
      { title: t('cmd.stop'), sub: 'Ctrl+.', icon: 'stop', run: () => bus.emit('ui:stop') },
      { title: t('cmd.regenerate'), sub: 'Ctrl+R', icon: 'refresh', run: () => bus.emit('ui:regenerate') },
      { title: t('cmd.clear_session'), icon: 'undo', run: () => bus.emit('ui:clear-session') },
      { title: t('cmd.export_session'), icon: 'export', run: () => bus.emit('ui:export-session') },
      { title: t('cmd.summarize'), icon: 'layers', run: () => bus.emit('ui:summarize-session') },
      { title: t('cmd.workspace'), icon: 'folderOpen', run: () => bus.emit('ui:change-workspace') },
      { title: t('cmd.terminal'), icon: 'terminal', run: () => bus.emit('ui:open-terminal') },
      { title: t('cmd.toggle_sidebar'), sub: 'Ctrl+B', icon: 'menu', run: () => bus.emit('ui:toggle-sidebar') },
      { title: t('cmd.toggle_monitor'), sub: 'Ctrl+J', icon: 'monitor', run: () => bus.emit('ui:toggle-monitor') },
      {
        title: t('cmd.toggle_theme'),
        icon: 'moon',
        run: async () => {
          const isDark = theme.themeById(setting('ui.theme', 'midnight')).scheme === 'dark';
          const next = isDark ? 'daylight' : 'midnight';
          await setSetting('ui.theme', next);
          theme.refresh(state.settings);
        },
      },
      { title: t('cmd.search_sessions'), sub: 'Ctrl+F', icon: 'search', run: () => $('#sessionSearch')?.focus() },
      { title: t('cmd.about'), icon: 'info', run: () => bus.emit('ui:about') },
    ];

    const modeActions = (state.modes || []).map((mode) => ({
      title: `${t('cmd.switch_mode')}: ${mode.name}`,
      sub: mode.tagline || '',
      icon: MODE_ICONS[mode.id] || 'wand',
      group: t('palette.modes'),
      run: () => bus.emit('ui:set-mode', mode.id),
    }));

    const modelActions = (state.models || []).map((model) => ({
      title: `${t('cmd.switch_model')}: ${model.name || model.model}`,
      sub: model.kind === 'gguf' ? truncate(model.gguf_path || '', 60) : `${model.provider_label || model.provider_preset} · ${model.model}`,
      icon: model.kind === 'gguf' ? 'cpu' : 'cloud',
      group: t('palette.models'),
      run: async () => {
        await api.activateModel(model.id, state.currentSessionId || '');
        state.activeModel = model;
        bus.emit('models:loaded', state.models);
        notify.ok(t('toast.model_switched'), model.name || '');
      },
    }));

    const sessionActions = (state.sessions || []).slice(0, 40).map((session) => ({
      title: session.title || t('chat.placeholder_title'),
      sub: `${session.msg_count ?? 0} ${t('chat.messages')} · ${session.mode || ''}`,
      icon: 'chat',
      group: t('palette.sessions'),
      run: () => bus.emit('ui:open-session', session.id),
    }));

    const groups = [
      { label: t('palette.actions'), items: actions },
      { label: t('palette.modes'), items: modeActions },
      { label: t('palette.models'), items: modelActions },
      { label: t('palette.sessions'), items: sessionActions },
    ];

    for (const group of groups) {
      for (const item of group.items) {
        const haystack = `${item.title} ${item.sub || ''}`.toLowerCase();
        if (!q || haystack.includes(q) || fuzzy(q, haystack)) {
          out.push({ ...item, group: item.group || group.label, score: score(q, item.title) });
        }
      }
    }
    out.sort((a, b) => (b.score || 0) - (a.score || 0));
    return out.slice(0, 60);
  }

  function render() {
    items = build(input.value);
    selected = 0;
    clear(list);
    if (!items.length) {
      list.append(el('div', { class: 'empty-mini', text: t('palette.empty') }));
      return;
    }
    let lastGroup = null;
    items.forEach((item, index) => {
      if (item.group !== lastGroup && !input.value.trim()) {
        list.append(el('div', { class: 'palette-group', text: item.group }));
        lastGroup = item.group;
      }
      const node = el('div', { class: `palette-item${index === selected ? ' sel' : ''}`, dataset: { index: String(index) } });
      node.append(el('span', { class: 'pi-icon', html: icon(item.icon || 'zap', 14) }));
      const text = el('span', { class: 'pi-text' });
      text.append(el('span', { class: 'pi-title', text: item.title }));
      if (item.sub) text.append(el('span', { class: 'pi-sub', text: item.sub }));
      node.append(text);
      node.addEventListener('click', () => run(item));
      node.addEventListener('mouseenter', () => {
        selected = index;
        paint();
      });
      list.append(node);
    });
  }

  function paint() {
    list.querySelectorAll('.palette-item').forEach((node, index) => {
      node.classList.toggle('sel', index === selected);
      if (index === selected) node.scrollIntoView({ block: 'nearest' });
    });
  }

  render();
  setTimeout(() => input.focus(), 20);
}

export function closePalette() {
  if (!open) return;
  open = false;
  const root = document.getElementById('paletteRoot');
  root.classList.remove('active');
  clear(root);
}

function score(query, title) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const text = String(title || '').toLowerCase();
  if (text.startsWith(q)) return 100;
  if (text.includes(q)) return 60;
  return fuzzy(q, text) ? 30 : 0;
}

function fuzzy(query, text) {
  let index = 0;
  for (const char of text) {
    if (char === query[index]) index += 1;
    if (index >= query.length) return true;
  }
  return false;
}
