/** Sidebar: session list, search, workspace card and connection status. */

import { $, el, esc, clear, debounce, humanSize, timeAgo, dayGroup, fmtTime, truncate, downloadFile } from '../dom.js';
import { icon, MODE_ICONS } from '../icons.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { bus, state, setting, currentSession } from '../state.js';
import { notify } from './toast.js';
import { confirmDialog, promptDialog } from './modal.js';
import { openContextMenu } from './dropdown.js';

export function initSidebar() {
  $('#newSessionBtn')?.addEventListener('click', () => bus.emit('ui:new-session'));
  const search = $('#sessionSearch');
  search?.addEventListener('input', debounce(() => {
    state.ui.sessionFilter = search.value.trim();
    renderSessions();
  }, 180));
  $('#collapseSidebar')?.addEventListener('click', () => bus.emit('ui:toggle-sidebar'));
  $('#expandSidebar')?.addEventListener('click', () => bus.emit('ui:toggle-sidebar'));
  $('#changeWorkspaceBtn')?.addEventListener('click', () => bus.emit('ui:change-workspace'));
  $('#openWorkspaceBtn')?.addEventListener('click', async () => {
    const root = setting('workspace.root', '');
    if (!root) return;
    try {
      await api.openPath(root);
    } catch (error) {
      notify.warn(t('common.error'), error.message);
    }
  });
  $('#workspacePath')?.addEventListener('click', () => bus.emit('ui:change-workspace'));

  bus.on('sessions:loaded', renderSessions);
  bus.on('session:loaded', renderSessions);
  bus.on('session:created', renderSessions);
  bus.on('workspace:changed', renderWorkspace);
  bus.on('boot', () => {
    renderSessions();
    renderWorkspace();
  });

  renderSessions();
  renderWorkspace();
}

export function renderSessions() {
  const host = $('#sessionsList');
  if (!host) return;
  clear(host);
  const filter = (state.ui.sessionFilter || '').toLowerCase();
  let sessions = [...(state.sessions || [])];
  if (filter) {
    sessions = sessions.filter((item) => (item.title || '').toLowerCase().includes(filter));
  }
  if (!sessions.length) {
    host.append(el('div', { class: 'empty-mini', text: filter ? t('sidebar.no_results') : t('sidebar.empty') }));
    return;
  }
  const labels = {
    today: t('group.today'),
    yesterday: t('group.yesterday'),
    week: t('group.week'),
    older: t('group.older'),
  };
  let group = null;
  for (const session of sessions) {
    const label = dayGroup(session.updated_at, labels);
    if (label !== group) {
      group = label;
      host.append(el('div', { class: 'session-group-label', text: label }));
    }
    host.append(renderSessionItem(session));
  }
}

function renderSessionItem(session) {
  const mode = state.modes.find((item) => item.id === session.mode) || { accent: '#7c5cff', name: session.mode };
  const isActive = session.id === state.currentSessionId;
  const item = el('div', { class: `session-item${isActive ? ' active' : ''}`, role: 'listitem', dataset: { id: session.id } });

  item.append(el('span', { class: 'mode-dot', style: { background: mode.accent || 'var(--accent)', width: '7px', height: '7px', borderRadius: '50%', flex: '0 0 auto' } }));

  const main = el('div', { class: 'session-main' });
  const nameRow = el('div', { class: 'session-name' });
  if (session.pinned) nameRow.append(el('span', { class: 'session-pin', html: icon('pin', 11) }));
  nameRow.append(document.createTextNode(session.title || t('chat.placeholder_title')));
  main.append(nameRow);
  const model = state.models.find((entry) => entry.id === session.model_id);
  const sub = el('div', { class: 'session-sub' });
  sub.append(el('span', { text: mode.name || session.mode || '' }));
  sub.append(el('span', { text: '·' }));
  sub.append(el('span', { text: `${session.msg_count ?? 0} ${t('chat.messages')}` }));
  sub.append(el('span', { text: '·' }));
  sub.append(el('span', { text: timeAgo(session.updated_at, { just: t('time.just_now'), min: t('time.min'), hour: t('time.hour'), day: t('time.day') }) }));
  if (model) sub.append(el('span', { class: 'truncate', text: `· ${truncate(model.name || model.model || '', 16)}` }));
  main.append(sub);
  item.append(main);

  const actions = el('div', { class: 'session-actions' });
  actions.append(el('button', {
    class: 'icon-btn tiny ghost',
    html: icon('more', 13),
    title: t('common.more') || 'More',
    onclick: (event) => {
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      openContextMenu(rect.left, rect.bottom + 4, sessionMenu(session));
    },
  }));
  item.append(actions);

  item.addEventListener('click', () => bus.emit('ui:open-session', session.id));
  item.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openContextMenu(event.clientX, event.clientY, sessionMenu(session));
  });
  return item;
}

function sessionMenu(session) {
  return [
    {
      title: t('common.open'),
      icon: 'chat',
      onClick: () => bus.emit('ui:open-session', session.id),
    },
    {
      title: t('common.rename'),
      icon: 'pencil',
      onClick: async () => {
        const value = await promptDialog({ title: t('common.rename'), value: session.title || '', okText: t('common.save') });
        if (value === null) return;
        await api.patchSession(session.id, { title: value });
        session.title = value;
        bus.emit('sessions:loaded', state.sessions);
        if (session.id === state.currentSessionId) bus.emit('session:title', value);
      },
    },
    {
      title: session.pinned ? t('cmd.pin').replace('Закрепить', 'Открепить') : t('cmd.pin'),
      icon: 'pin',
      onClick: async () => {
        await api.patchSession(session.id, { pinned: session.pinned ? 0 : 1 });
        session.pinned = session.pinned ? 0 : 1;
        await refresh();
      },
    },
    {
      title: t('cmd.duplicate'),
      icon: 'copy',
      onClick: async () => {
        const result = await api.duplicateSession(session.id);
        notify.ok(t('toast.session_created'), result.session?.title || '');
        await refresh();
        bus.emit('ui:open-session', result.session.id);
      },
    },
    { separator: true },
    {
      title: `${t('common.export')} .md`,
      icon: 'export',
      onClick: () => exportSession(session, 'md'),
    },
    {
      title: `${t('common.export')} .json`,
      icon: 'export',
      onClick: () => exportSession(session, 'json'),
    },
    {
      title: t('cmd.summarize'),
      icon: 'layers',
      onClick: async () => {
        try {
          const result = await api.summarizeSession(session.id);
          notify.ok(t('cmd.summarize'), truncate(result.summary, 120));
        } catch (error) {
          notify.error(t('common.error'), error.message);
        }
      },
    },
    { separator: true },
    {
      title: t('common.clear'),
      icon: 'undo',
      onClick: async () => {
        const ok = await confirmDialog({ title: t('cmd.clear_session'), text: '', okText: t('common.clear'), danger: true });
        if (!ok) return;
        await api.clearSession(session.id);
        notify.info(t('toast.cleared'));
        if (session.id === state.currentSessionId) bus.emit('messages:changed');
        await refresh();
      },
    },
    {
      title: t('common.delete'),
      icon: 'trash',
      danger: true,
      onClick: async () => {
        const ok = await confirmDialog({ title: t('cmd.delete'), text: session.title || '', okText: t('common.delete'), danger: true });
        if (!ok) return;
        await api.deleteSession(session.id);
        notify.info(t('toast.session_deleted'));
        if (session.id === state.currentSessionId) bus.emit('ui:new-session');
        await refresh();
      },
    },
  ];
}

async function refresh() {
  try {
    const data = await api.sessions(state.ui.sessionFilter || '');
    state.sessions = data.sessions || [];
    bus.emit('sessions:loaded', state.sessions);
  } catch (error) {
    console.error(error);
  }
}

async function exportSession(session, format) {
  try {
    const response = await fetch(api.exportSessionUrl(session.id, format));
    const text = await response.text();
    const name = `${(session.title || 'session').replace(/[^\w.-]+/g, '_')}.${format}`;
    downloadFile(name, text, format === 'md' ? 'text/markdown;charset=utf-8' : 'application/json');
    notify.ok(t('common.export'), name);
  } catch (error) {
    notify.error(t('common.error'), error.message);
  }
}

export function renderWorkspace() {
  const info = state.workspace || {};
  const pathNode = $('#workspacePath');
  const metaNode = $('#workspaceMeta');
  if (pathNode) {
    pathNode.textContent = info.root || setting('workspace.root', '');
    pathNode.title = info.root || '';
  }
  if (metaNode) {
    clear(metaNode);
    if (info.exists === false) {
      metaNode.append(el('span', { class: 'tag warn', text: 'folder missing' }));
      return;
    }
    if (info.entries !== undefined) metaNode.append(el('span', { text: `${info.entries} ${t('sidebar.files')}` }));
    if (info.size_bytes) metaNode.append(el('span', { text: humanSize(info.size_bytes) }));
    if (info.is_git) metaNode.append(el('span', { class: 'tag ok', html: `${icon('git', 10)} ${esc(t('sidebar.git'))}` }));
    if (!setting('workspace.sandbox', true)) metaNode.append(el('span', { class: 'tag warn', text: 'no sandbox' }));
  }
}

export function renderStatus(status) {
  const dot = $('#connDot');
  const text = $('#connText');
  if (!dot || !text) return;
  const map = {
    online: ['ok', t('status.online')],
    connecting: ['warn', t('status.connecting')],
    reconnecting: ['warn', t('status.reconnect')],
    offline: ['err', t('status.offline')],
  };
  const [cls, label] = map[status] || map.connecting;
  dot.className = `dot ${cls}`;
  text.textContent = state.run && ['running', 'waiting'].includes(state.run.status)
    ? (state.run.status === 'waiting' ? t('status.waiting') : t('status.running'))
    : label;
  state.ui.connected = status === 'online';
}

export { refresh as refreshSessions };
