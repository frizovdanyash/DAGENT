/** Top bar: session title, mode pills, model switcher, context meter. */

import { $, el, esc, clear, clamp, truncate } from '../dom.js';
import { icon, MODE_ICONS } from '../icons.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { bus, state, setting, setSetting, currentSession, currentMode } from '../state.js';
import { notify } from './toast.js';
import { promptDialog } from './modal.js';
import { openDropdown } from './dropdown.js';

export function initTopbar() {
  renderModes();
  renderModelSwitch();
  updateTitle();

  $('#sessionTitle')?.addEventListener('click', renameSession);
  $('#toggleMonitorBtn')?.addEventListener('click', () => bus.emit('ui:toggle-monitor'));
  $('#topSettingsBtn')?.addEventListener('click', () => bus.emit('ui:open-settings', state.ui.settingsTab));
  $('#modelSwitchBtn')?.addEventListener('click', (event) => openModelSwitcher(event.currentTarget));

  bus.on('boot', () => {
    renderModes();
    renderModelSwitch();
    updateTitle();
  });
  bus.on('models:loaded', renderModelSwitch);
  bus.on('session:loaded', () => {
    updateTitle();
    renderModes();
    renderModelSwitch();
  });
  bus.on('session:title', updateTitle);
  bus.on('sessions:loaded', updateTitle);
  bus.on('mode:changed', renderModes);
  bus.on('context', updateContextMeter);
  bus.on('session:loaded', () => updateContextMeter(null));
  bus.on('ui:model-switcher', () => openModelSwitcher($('#modelSwitchBtn')));
  bus.on('ui:mode-picker', () => cycleMode());
}

/* ------------------------------ modes ------------------------------ */

export function renderModes() {
  const host = $('#modePills');
  if (!host) return;
  clear(host);
  const active = currentMode();
  for (const mode of state.modes || []) {
    const pill = el('button', {
      class: `mode-pill${mode.id === active?.id ? ' active' : ''}`,
      role: 'tab',
      title: `${mode.name} - ${mode.tagline || ''}`,
      'aria-selected': mode.id === active?.id ? 'true' : 'false',
      style: { '--mode-accent': mode.accent || 'var(--accent)' },
    });
    pill.append(el('span', { html: icon(MODE_ICONS[mode.id] || mode.icon || 'wand', 15) }));
    pill.append(el('span', { text: mode.name }));
    pill.addEventListener('click', () => setMode(mode.id));
    host.append(pill);
  }
}

export async function setMode(modeId) {
  const mode = state.modes.find((item) => item.id === modeId);
  if (!mode) return;
  const session = currentSession();
  try {
    if (session) {
      await api.patchSession(session.id, { mode: modeId });
      session.mode = modeId;
    } else {
      await setSetting('agent.mode', modeId);
    }
    state.settings.agent = { ...(state.settings.agent || {}), mode: modeId };
    bus.emit('mode:changed', modeId);
    bus.emit('sessions:loaded', state.sessions);
    notify.info(t('toast.mode_switched', { mode: mode.name }));
  } catch (error) {
    notify.error(t('common.error'), error.message);
  }
}

function cycleMode() {
  const modes = state.modes || [];
  if (!modes.length) return;
  const index = modes.findIndex((mode) => mode.id === currentMode()?.id);
  const next = modes[(index + 1) % modes.length];
  setMode(next.id);
}

/* ------------------------------ title ------------------------------ */

export function updateTitle() {
  const titleNode = $('#sessionTitle');
  const metaNode = $('#sessionMeta');
  if (!titleNode) return;
  const session = currentSession();
  titleNode.textContent = session?.title || t('chat.placeholder_title');
  if (metaNode) {
    clear(metaNode);
    if (!session) {
      metaNode.append(el('span', { text: t('chat.empty_sub').slice(0, 60) }));
      return;
    }
    const mode = state.modes.find((item) => item.id === session.mode);
    if (mode) metaNode.append(el('span', { html: `${icon(MODE_ICONS[mode.id] || 'wand', 11)} ${esc(mode.name)}` }));
    const model = state.models.find((item) => item.id === session.model_id) || state.activeModel;
    if (model) metaNode.append(el('span', { text: truncate(model.name || model.model || '', 24) }));
    if (session.msg_count !== undefined) metaNode.append(el('span', { text: `${session.msg_count} ${t('chat.messages')}` }));
    if (session.pinned) metaNode.append(el('span', { html: icon('pin', 11) }));
  }
}

async function renameSession() {
  const session = currentSession();
  if (!session) {
    bus.emit('ui:new-session');
    return;
  }
  const value = await promptDialog({
    title: t('common.rename'),
    value: session.title || '',
    okText: t('common.save'),
    hint: t('cmd.summarize'),
  });
  if (value === null || !value.trim()) return;
  await api.patchSession(session.id, { title: value.trim() });
  session.title = value.trim();
  updateTitle();
  bus.emit('sessions:loaded', state.sessions);
}

/* ------------------------------ model switcher ------------------------------ */

export function renderModelSwitch() {
  const nameNode = $('#modelName');
  const subNode = $('#modelSub');
  const kindNode = $('#modelKindIcon');
  const button = $('#modelSwitchBtn');
  if (!nameNode || !subNode || !kindNode || !button) return;
  const model = state.activeModel;
  if (!model) {
    nameNode.textContent = t('models.none');
    subNode.textContent = t('models.click_to_add');
    kindNode.innerHTML = icon('plus', 15);
    return;
  }
  nameNode.textContent = model.name || model.model || 'model';
  const isGguf = model.kind === 'gguf' || model.kind === 'local';
  subNode.textContent = isGguf
    ? `GGUF · ${truncate(model.model || model.gguf_path || '', 26)}`
    : truncate(`${model.provider_label || model.provider_preset || 'API'} · ${model.model || ''}`, 34);
  kindNode.innerHTML = icon(isGguf ? 'cpu' : model.kind === 'anthropic' ? 'sparkle' : 'cloud', 15);
  button.title = `${t('models.switch')} (Ctrl+M)`;
}

export function openModelSwitcher(anchor) {
  const items = [];
  const groups = { api: [], gguf: [] };
  for (const model of state.models) {
    const isGguf = model.kind === 'gguf' || model.kind === 'local';
    (isGguf ? groups.gguf : groups.api).push({
      id: model.id,
      title: model.name || model.model || 'model',
      sub: isGguf
        ? truncate(model.gguf_path || model.model || '', 54)
        : truncate(`${model.provider_label || model.provider_preset || 'API'} · ${model.model || ''}`, 54),
      icon: isGguf ? 'cpu' : model.kind === 'anthropic' ? 'sparkle' : 'cloud',
      active: model.id === state.activeModel?.id,
      badge: model.favorite ? '★' : '',
      onClick: () => activate(model.id),
    });
  }
  if (groups.api.length) items.push(...groups.api.map((item) => ({ ...item, group: t('models.kind_api') })));
  if (groups.gguf.length) items.push(...groups.gguf.map((item) => ({ ...item, group: t('models.kind_gguf') })));
  items.push({ separator: true });
  items.push({
    id: '__add',
    title: t('models.add'),
    sub: t('models.subtitle'),
    icon: 'plus',
    onClick: () => bus.emit('ui:open-settings', 'models'),
  });
  items.push({
    id: '__manage',
    title: t('models.manage'),
    icon: 'settings',
    onClick: () => bus.emit('ui:open-settings', 'models'),
  });

  openDropdown({
    anchor: anchor || $('#modelSwitchBtn'),
    items,
    searchable: state.models.length > 4,
    placeholder: t('models.search'),
    width: 420,
    align: 'right',
    emptyText: t('models.empty'),
  });
}

async function activate(modelId) {
  try {
    const result = await api.activateModel(modelId, state.currentSessionId || '');
    state.activeModel = result.profile;
    const session = currentSession();
    if (session) session.model_id = modelId;
    renderModelSwitch();
    updateTitle();
    bus.emit('sessions:loaded', state.sessions);
    notify.ok(t('toast.model_switched'), result.profile?.name || '');
  } catch (error) {
    notify.error(t('common.error'), error.message);
  }
}

/* ------------------------------ context meter ------------------------------ */

export function updateContextMeter(info) {
  const fill = $('#ctxFill');
  const text = $('#ctxText');
  const meter = $('#ctxMeter');
  if (!fill || !text || !meter) return;
  if (!info || !info.context_window) {
    fill.style.width = '0%';
    text.textContent = '0%';
    fill.className = '';
    meter.title = t('settings.context_window');
    return;
  }
  const percent = clamp(Math.round((info.estimated_tokens / info.context_window) * 100), 0, 100);
  fill.style.width = `${percent}%`;
  fill.className = percent > 90 ? 'danger' : percent > 70 ? 'warn' : '';
  text.textContent = `${percent}%`;
  meter.title = `${info.estimated_tokens} / ${info.context_window} tokens${info.compressed ? ' (compressed)' : ''}`;
}
