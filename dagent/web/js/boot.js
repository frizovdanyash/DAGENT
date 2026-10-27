/**
 * DAGENT front-end entry point.
 * Boots the state, wires every UI module, connects the realtime stream and
 * installs the global keyboard shortcuts.
 */

import { $, el, esc, clear, debounce } from './dom.js';
import { icon } from './icons.js';
import { t, setLanguage, applyTranslations } from './i18n.js';
import { api } from './api.js';
import { bus, state, setting, setSetting, loadBootstrap, loadSession, refreshSessions, currentSession, isRunning } from './state.js';
import * as theme from './theme.js';
import { stream } from './events.js';
import { markdown } from './markdown.js';
import {
  initChat, renderAll, appendMessage, startLive, appendToken, appendReasoning, addLiveTool,
  updateTool, stopLive, setLiveStatus, showRunError, showApproval, showQuestion, clearPending,
  exportCurrentSession, updateEmptyState,
} from './ui/chat.js';
import { initComposer, send, stopRun, setInput, focus as focusInput, updateComposerMode, updateSendButton } from './ui/composer.js';
import { initSidebar, renderSessions, renderWorkspace, renderStatus } from './ui/sidebar.js';
import { initTopbar, renderModes, renderModelSwitch, updateTitle, setMode, openModelSwitcher } from './ui/topbar.js';
import { initMonitor, logActivity, renderPlan, trackChange, renderInfo, setTab, loadTree, openTerminal } from './ui/monitor.js';
import { openSettings } from './ui/settings.js';
import { openModelEditor } from './ui/models.js';
import { openPalette, togglePalette } from './ui/palette.js';
import { startOnboarding, shouldShow } from './ui/onboarding.js';
import { pickPath, previewFile } from './ui/filepicker.js';
import { notify, beep } from './ui/toast.js';
import { confirmDialog, openDialog } from './ui/modal.js';

let booted = false;

async function boot() {
  if (booted) return;
  booted = true;
  try {
    await loadBootstrap();
  } catch (error) {
    document.body.innerHTML = `<div style="padding:44px;font-family:system-ui;color:#e8eaf2;background:#0b0e17;min-height:100vh">
      <h1 style="letter-spacing:-.02em">DAGENT</h1>
      <p style="opacity:.75">${esc(t('toast.boot_failed'))}</p>
      <pre style="background:#151a28;padding:14px;border-radius:12px;overflow:auto;border:1px solid #232a3d">${esc(error.message)}</pre>
    </div>`;
    return;
  }

  setLanguage(setting('app.language', 'ru'));
  applyTranslations(document);
  theme.init(state.settings);

  applyLayout();
  initChat();
  initComposer();
  initSidebar();
  initTopbar();
  initMonitor();
  wireBus();
  wireStream();
  installShortcuts();
  renderQuickCards();

  stream.connect();

  const first = (state.sessions || [])[0];
  if (first) await openSession(first.id, { silent: true });
  else {
    renderSessions();
    renderWorkspace();
    updateTitle();
    updateEmptyState();
  }
  renderInfo();

  if (shouldShow()) setTimeout(() => startOnboarding(), 400);
}

/* ------------------------------------------------------------------ */
/* layout                                                              */
/* ------------------------------------------------------------------ */

function applyLayout() {
  const app = $('#app');
  if (!app) return;
  state.ui.sidebarCollapsed = Boolean(setting('ui.sidebar_collapsed', false));
  state.ui.monitorOpen = Boolean(setting('ui.show_monitor', true));
  app.classList.toggle('no-sidebar', state.ui.sidebarCollapsed);
  app.classList.toggle('no-monitor', !state.ui.monitorOpen);
  app.classList.toggle('sidebar-open', !state.ui.sidebarCollapsed && window.innerWidth <= 900);
  if (state.ui.monitorOpen && window.innerWidth <= 1180) app.classList.add('monitor-open');
}

function toggleSidebar() {
  state.ui.sidebarCollapsed = !state.ui.sidebarCollapsed;
  const app = $('#app');
  app.classList.toggle('no-sidebar', state.ui.sidebarCollapsed);
  app.classList.toggle('sidebar-open', !state.ui.sidebarCollapsed && window.innerWidth <= 900);
  setSetting('ui.sidebar_collapsed', state.ui.sidebarCollapsed);
}

function setMonitor(value) {
  state.ui.monitorOpen = Boolean(value);
  const app = $('#app');
  app.classList.toggle('no-monitor', !state.ui.monitorOpen);
  app.classList.toggle('monitor-open', state.ui.monitorOpen && window.innerWidth <= 1180);
  setSetting('ui.show_monitor', state.ui.monitorOpen);
}

/* ------------------------------------------------------------------ */
/* bus wiring                                                          */
/* ------------------------------------------------------------------ */

function wireBus() {
  bus.on('ui:new-session', newSession);
  bus.on('ui:open-session', (id) => openSession(id));
  bus.on('ui:open-settings', (section) => openSettings(section || 'models'));
  bus.on('ui:about', () => openSettings('about'));
  bus.on('ui:add-model', () => openModelEditor(null));
  bus.on('ui:model-switcher', () => openModelSwitcher($('#modelSwitchBtn')));
  bus.on('ui:mode-picker', () => openSettings('agent'));
  bus.on('ui:set-mode', (modeId) => setMode(modeId));
  bus.on('ui:palette', () => openPalette());
  bus.on('ui:toggle-sidebar', toggleSidebar);
  bus.on('ui:toggle-monitor', () => setMonitor(!state.ui.monitorOpen));
  bus.on('ui:set-monitor', (value) => setMonitor(value));
  bus.on('ui:show-monitor', (value) => setMonitor(value === undefined ? true : value));
  bus.on('ui:open-terminal', (command) => openTerminal(command || ''));
  bus.on('ui:change-workspace', changeWorkspace);
  bus.on('ui:export-session', (format) => exportCurrentSession(format || 'md'));
  bus.on('ui:summarize-session', summarizeSession);
  bus.on('ui:clear-session', clearSession);
  bus.on('ui:stop', () => stopRun());
  bus.on('ui:regenerate', () => resendLast());
  bus.on('ui:preview-file', (path) => previewFile(path));
  bus.on('ui:focus-input', () => focusInput());
  bus.on('ui:set-input', (text) => setInput(text));
  bus.on('ui:send', (text) => send(text));
  bus.on('ui:maybe-onboarding', () => { if (shouldShow()) startOnboarding(); });
  bus.on('ui:focus-last-user-message', recallLastUserMessage);

  bus.on('messages:changed', reloadMessages);
  bus.on('message:edited', reloadMessages);

  bus.on('run:started', async (result) => {
    if (!result) return;
    if (result.session_id && result.session_id !== state.currentSessionId) {
      await openSession(result.session_id, { silent: true });
    }
    state.run = {
      run_id: result.run_id,
      session_id: result.session_id || state.currentSessionId,
      status: 'running',
      iterations: 0,
      tools_used: 0,
      total_tokens: 0,
    };
    bus.emit('run:state', state.run);
    updateSendButton();
    renderStatus('online');
    startLive();
  });

  bus.on('settings:applied', () => {
    updateComposerMode();
    renderModes();
    renderModelSwitch();
  });
  bus.on('settings:closed', () => renderQuickCards());
  bus.on('settings:imported', async () => {
    await loadBootstrap();
    setLanguage(setting('app.language', 'ru'));
    applyTranslations(document);
    theme.refresh(state.settings);
    applyLayout();
    renderModes();
    renderModelSwitch();
    renderSessions();
    renderWorkspace();
    updateComposerMode();
    renderQuickCards();
    renderInfo();
    notify.ok(t('toast.settings_imported'));
  });
  bus.on('hotkeys:changed', () => notify.info(t('toast.hotkeys_saved')));

  bus.on('language:changed', async () => {
    applyTranslations(document);
    try {
      // mode names and taglines are localised by the backend
      const data = await api.modes();
      state.modes = data.modes || state.modes;
    } catch (error) {
      console.error('[DAGENT] could not reload modes', error);
    }
    renderModes();
    renderModelSwitch();
    updateComposerMode();
    renderQuickCards();
    renderSessions();
    renderWorkspace();
    updateTitle();
    renderInfo();
  });

  bus.on('workspace:changed', () => {
    renderWorkspace();
    loadTree();
    renderInfo();
  });

  bus.on('pending:changed', (pending) => {
    document.title = (pending && pending.length ? '• ' : '') + 'DAGENT';
  });

  bus.on('error', (error) => {
    if (error?.message) notify.error(t('common.error'), error.message);
  });

  bus.on('onboarding:done', () => {
    renderQuickCards();
    renderInfo();
  });

  window.addEventListener('resize', debounce(() => {
    const app = $('#app');
    if (!app) return;
    app.classList.toggle('sidebar-open', !state.ui.sidebarCollapsed && window.innerWidth <= 900);
    app.classList.toggle('monitor-open', state.ui.monitorOpen && window.innerWidth <= 1180);
  }, 160));

  window.addEventListener('beforeunload', (event) => {
    if (isRunning() && setting('ui.confirm_on_close', true)) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

async function reloadMessages() {
  if (!state.currentSessionId) {
    state.messages = [];
    renderAll();
    return;
  }
  try {
    const data = await api.session(state.currentSessionId);
    state.messages = data.messages || [];
    if (data.session) {
      const index = state.sessions.findIndex((item) => item.id === data.session.id);
      if (index >= 0) state.sessions[index] = data.session;
    }
    renderAll();
    renderInfo();
    renderSessions();
  } catch (error) {
    console.error('[DAGENT] reload messages failed', error);
  }
}

function recallLastUserMessage() {
  const last = [...(state.messages || [])].reverse().find((message) => message.role === 'user');
  if (!last) return;
  setInput(String(last.content || ''));
  focusInput();
}

/* ------------------------------------------------------------------ */
/* realtime stream                                                     */
/* ------------------------------------------------------------------ */

function wireStream() {
  stream.onStatus((status) => {
    renderStatus(status);
    state.ui.connected = status === 'online';
    if (status === 'offline') {
      if (!state.ui.offlineNotified) {
        state.ui.offlineNotified = true;
        notify.warn(t('toast.connection_lost'), t('status.reconnect'));
      }
    } else if (status === 'online' && state.ui.offlineNotified) {
      state.ui.offlineNotified = false;
      notify.ok(t('toast.connection_restored'));
    }
  });

  stream.on('hello', (data) => {
    state.info = data.info || state.info;
    state.system = data.system || state.system;
    (data.pending || []).forEach((request) => routePending(request));
    (data.active_runs || []).forEach((run) => {
      if (!run || run.session_id !== state.currentSessionId) return;
      state.run = run;
      bus.emit('run:state', run);
      updateSendButton();
      startLive();
    });
    renderInfo();
  });

  stream.on('run.start', (data) => {
    if (!sameSession(data)) return;
    state.run = data.run || state.run;
    bus.emit('run:state', state.run);
    updateSendButton();
    startLive();
    logActivity({
      title: t('monitor.run_started'),
      text: `${data.mode || ''} · ${data.protocol || ''} · ${(data.tools || []).length} ${t('monitor.tools')}`,
      icon: 'rocket',
      ok: true,
    });
    renderInfo();
  });

  stream.on('assistant.start', () => {
    if (!state.run) return;
    startLive();
  });

  stream.on('token', (data) => {
    if (!sameSession(data)) return;
    appendToken(data.text || '');
  });

  stream.on('reasoning', (data) => {
    if (!sameSession(data)) return;
    appendReasoning(data.text || '');
  });

  stream.on('status', (data) => {
    if (!sameSession(data)) return;
    setLiveStatus(data.text || '');
    if (data.iteration && state.run) {
      state.run = { ...state.run, iterations: data.iteration };
      bus.emit('run:state', state.run);
    }
    if (data.detail === 'compression') logActivity({ title: data.text, icon: 'layers' });
  });

  stream.on('context', (data) => {
    state.context = data;
    bus.emit('context', data);
  });

  stream.on('tool.start', (data) => {
    if (!sameSession(data)) return;
    addLiveTool({ ...data, status: 'running' });
    logActivity({ title: toolLabel(data.tool), text: shortArgs(data.args), tool: data.tool });
    if (state.run) {
      state.run = { ...state.run, tools_used: (state.run.tools_used || 0) + 1 };
      bus.emit('run:state', state.run);
    }
  });

  stream.on('tool.progress', (data, event) => {
    bus.emit('tool.progress', data, event);
    if (event && event.run_id && sameSession(data, event)) {
      setLiveStatus(`${data.tool || ''}: ${String(data.text || '').slice(-100)}`);
    }
  });

  stream.on('tool.result', (data) => {
    if (!sameSession(data)) return;
    updateTool(data);
    trackChange(data);
    logActivity({
      title: data.ok ? t('monitor.tool_ok') : t('monitor.tool_failed'),
      tool: data.tool,
      text: String(data.output || data.error || '').slice(0, 240),
      ok: Boolean(data.ok),
      icon: data.ok ? 'check' : 'alert',
    });
    if (data.tool === 'update_plan' && Array.isArray(data.data?.steps)) {
      state.plan = data.data.steps;
      bus.emit('plan', state.plan);
    }
    renderInfo();
  });

  stream.on('plan', (data) => {
    state.plan = data.steps || [];
    bus.emit('plan', state.plan);
  });

  stream.on('approval.required', (request) => routePending(request));
  stream.on('question.required', (request) => routePending(request));

  stream.on('message.saved', (data) => {
    const message = data.message;
    if (!message) return;
    if (message.session_id && message.session_id !== state.currentSessionId) {
      refreshSessions();
      updateTitle();
      return;
    }
    state.messages.push(message);
    if (message.role === 'assistant') stopLive();
    appendMessage(message);
    renderInfo();
  });

  stream.on('message.updated', (data) => {
    const message = data.message;
    if (!message) return;
    if (message.session_id && message.session_id !== state.currentSessionId) return;
    const index = state.messages.findIndex((item) => item.id === message.id);
    if (index >= 0) state.messages[index] = message;
    appendMessage(message);
  });

  stream.on('message.deleted', () => reloadMessages());

  stream.on('session.created', (data) => {
    refreshSessions();
    const session = data.session;
    if (session && !state.currentSessionId) openSession(session.id, { silent: true });
  });

  stream.on('session.updated', (data) => {
    const session = data.session;
    if (!session) return;
    const index = state.sessions.findIndex((item) => item.id === session.id);
    if (index >= 0) state.sessions[index] = session;
    else state.sessions.unshift(session);
    renderSessions();
    if (session.id === state.currentSessionId) {
      updateTitle();
      if (session.mode) renderModes();
    }
    renderInfo();
  });

  stream.on('session.deleted', () => refreshSessions());
  stream.on('session.cleared', () => reloadMessages());
  stream.on('session.truncated', () => reloadMessages());

  stream.on('models.changed', async () => {
    const models = await api.models();
    state.models = models.profiles || [];
    state.activeModel = state.models.find((item) => item.id === models.active_id) || state.activeModel;
    bus.emit('models:loaded', state.models);
    renderInfo();
  });

  stream.on('model.active', (data) => {
    if (data.profile) state.activeModel = data.profile;
    renderModelSwitch();
    renderInfo();
  });

  stream.on('terminal.command', (data) => {
    logActivity({ title: data.command || 'terminal', text: data.ok ? 'ok' : 'failed', ok: Boolean(data.ok), icon: 'terminal' });
  });

  stream.on('error', (data) => {
    if (!sameSession(data)) return;
    showRunError(data.message || '', data.hint || '');
    logActivity({ title: t('toast.run_error'), text: data.message || '', ok: false, icon: 'alert' });
  });

  stream.on('log', (data) => {
    if (data.level === 'error') console.error('[DAGENT]', data.text);
  });

  stream.on('run.end', (data) => {
    if (!sameSession(data)) {
      refreshSessions();
      return;
    }
    state.run = null;
    stopLive();
    clearPending();
    state.pending = [];
    updateSendButton();
    renderStatus('online');
    document.title = 'DAGENT';
    bus.emit('run:reset');

    if (data.session) {
      const index = state.sessions.findIndex((item) => item.id === data.session.id);
      if (index >= 0) state.sessions[index] = data.session;
      else state.sessions.unshift(data.session);
      renderSessions();
      updateTitle();
    }
    reloadMessages();
    renderInfo();
    loadTree();

    const status = data.run?.status;
    const detail = `${data.run?.iterations || 0} ${t('monitor.steps')} · ${data.run?.tools_used || 0} ${t('monitor.tools')} · ${data.elapsed_ms || 0} ms`;
    if (status === 'error') notify.error(t('toast.run_error'), data.stop_reason || data.run?.last_error || '');
    else if (status === 'stopped') notify.info(t('toast.run_stopped'), data.stop_reason || '');
    else notify.ok(t('toast.run_finished'), detail);
    if (setting('ui.sound', false)) beep(status === 'error' ? 'error' : 'done');
  });
}

function sameSession(data, event) {
  const sessionId = (event && event.session_id) || (data && (data.session_id || data.run?.session_id));
  if (!sessionId) return true;
  return sessionId === state.currentSessionId;
}

function routePending(request) {
  if (!request || !request.call_id) return;
  if (request.session_id && request.session_id !== state.currentSessionId) {
    openSession(request.session_id).then(() => routePending(request));
    return;
  }
  if ((state.pending || []).some((item) => item.call_id === request.call_id)) return;
  if (request.kind === 'question') showQuestion(request);
  else showApproval(request);
  if (setting('ui.sound', false)) beep('alert');
}

function toolLabel(tool) {
  const key = `tools.${tool}`;
  const label = t(key);
  return label === key ? String(tool || '') : label;
}

function shortArgs(args = {}) {
  const entries = Object.entries(args || {});
  if (!entries.length) return '';
  const [key, value] = entries[0];
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `${key}: ${String(text).slice(0, 110)}`;
}

/* ------------------------------------------------------------------ */
/* sessions                                                            */
/* ------------------------------------------------------------------ */

async function newSession() {
  try {
    const result = await api.createSession({
      mode: setting('agent.mode', 'assistant'),
      model_id: state.activeModel?.id || null,
      workspace: setting('workspace.root', ''),
    });
    const session = result.session || result;
    if (!state.sessions.some((item) => item.id === session.id)) state.sessions.unshift(session);
    await openSession(session.id);
    notify.ok(t('toast.session_created'), session.title || '');
    focusInput();
  } catch (error) {
    notify.error(t('common.error'), error.message);
  }
}

async function openSession(sessionId, options = {}) {
  if (!sessionId) return;
  const running = state.run;
  if (isRunning() && running?.session_id && running.session_id !== sessionId) {
    const ok = await confirmDialog({
      title: t('status.running'),
      text: t('chat.switch_running'),
      okText: t('common.stop'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.stopRun(running.run_id);
    } catch (error) {
      console.error(error);
    }
  }
  stopLive();
  clearPending();
  state.pending = [];
  try {
    await loadSession(sessionId);
    bus.emit('run:state', state.run);
    renderAll();
    renderSessions();
    updateTitle();
    renderModes();
    renderModelSwitch();
    renderPlan(state.plan || []);
    renderInfo();
    updateSendButton();
    if (!options.silent) focusInput();
  } catch (error) {
    notify.error(t('common.error'), error.message);
  }
}

async function clearSession() {
  const session = currentSession();
  if (!session) return;
  const ok = await confirmDialog({
    title: t('cmd.clear_session'),
    text: `${session.title || ''} - ${t('chat.clear_confirm')}`,
    okText: t('common.clear'),
    danger: true,
  });
  if (!ok) return;
  try {
    await api.clearSession(session.id);
    state.messages = [];
    state.plan = [];
    state.changedFiles = [];
    renderAll();
    renderPlan([]);
    notify.info(t('toast.cleared'));
  } catch (error) {
    notify.error(t('common.error'), error.message);
  }
}

async function summarizeSession() {
  const session = currentSession();
  if (!session) return;
  notify.info(t('common.loading'));
  try {
    const result = await api.summarizeSession(session.id);
    openDialog({
      title: t('cmd.summarize'),
      subtitle: session.title || '',
      icon: 'layers',
      size: 'medium',
      body: el('div', { class: 'md', html: markdown(String(result.summary || result.text || '')) }),
      footer: [
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn', text: t('common.close'), onclick: () => document.querySelector('#modalRoot .dialog [title^="Close"]')?.click() }),
      ],
    });
  } catch (error) {
    notify.error(t('common.error'), error.message);
  }
}

async function resendLast() {
  const session = currentSession();
  if (!session) return;
  if (isRunning()) {
    notify.warn(t('status.running'));
    return;
  }
  try {
    const result = await api.retryLast(session.id);
    bus.emit('run:started', result);
  } catch (error) {
    notify.error(t('common.error'), error.message);
  }
}

async function changeWorkspace() {
  const picked = await pickPath({
    mode: 'dir',
    title: t('settings.workspace_root'),
    start: setting('workspace.root', ''),
    okText: t('common.select'),
  });
  if (!picked) return;
  try {
    const result = await api.setWorkspace(picked);
    state.workspace = result.workspace || state.workspace;
    await setSetting('workspace.root', state.workspace.root || picked);
    bus.emit('workspace:changed', state.workspace);
    renderWorkspace();
    loadTree();
    renderQuickCards();
    notify.ok(t('toast.workspace_changed'), state.workspace.root || picked);
  } catch (error) {
    notify.error(t('common.error'), error.message);
  }
}

/* ------------------------------------------------------------------ */
/* empty state                                                         */
/* ------------------------------------------------------------------ */

const QUICK_CARDS = [
  { key: 'repo', icon: 'search' },
  { key: 'file', icon: 'fileCode' },
  { key: 'script', icon: 'code' },
  { key: 'cleanup', icon: 'layers' },
  { key: 'system', icon: 'terminal' },
  { key: 'web', icon: 'globe' },
];

function renderQuickCards() {
  const host = $('#quickCards');
  if (host) {
    clear(host);
    QUICK_CARDS.forEach((card) => {
      const text = t(`quick.${card.key}_text`);
      const node = el('button', { class: 'quick-card', title: text });
      node.append(el('span', { class: 'qc-title', html: `${icon(card.icon, 15)} ${esc(t(`quick.${card.key}`))}` }));
      node.append(el('span', { class: 'qc-text', text }));
      node.addEventListener('click', () => {
        setInput(text);
        focusInput();
      });
      node.addEventListener('dblclick', () => send(text));
      host.append(node);
    });
  }

  const checks = $('#emptyChecks');
  if (checks) {
    clear(checks);
    const hasModel = (state.models || []).length > 0;
    checks.append(checkChip(hasModel, hasModel ? t('check.model') : t('check.model_missing'), 'cpu', () => openSettings('models')));
    const hasWorkspace = Boolean(setting('workspace.root'));
    checks.append(checkChip(hasWorkspace, hasWorkspace ? t('check.workspace') : t('check.workspace_missing'), 'folder', () => changeWorkspace()));
    checks.append(checkChip(true, `${t('check.mode')}: ${t(`mode.${setting('agent.mode', 'assistant')}`)}`, 'wand', () => openSettings('agent')));
    if (!state.providers?.llama_cpp_installed) {
      checks.append(checkChip(false, t('check.llama_missing'), 'cpu', showInstallHelp));
    }
  }

  const title = $('#emptyTitle');
  if (title) title.textContent = t('chat.empty_title');
  const sub = $('#emptySub');
  if (sub) sub.textContent = t('chat.empty_sub');
}

function checkChip(done, label, iconName, onClick) {
  const node = el('button', { class: `check-chip${done ? ' done' : ''}` });
  node.append(el('span', { html: icon(done ? 'check' : iconName, 13, 2.4) }));
  node.append(el('span', { text: label }));
  if (!done && typeof onClick === 'function') node.addEventListener('click', onClick);
  return node;
}

function showInstallHelp() {
  const hint = state.providers?.llama_cpp_hint || 'pip install llama-cpp-python';
  openDialog({
    title: t('models.llama_missing'),
    subtitle: t('models.gguf_hint'),
    icon: 'cpu',
    size: 'medium',
    body: el('div', { class: 'col' }, [
      el('div', { class: 'approval-preview', text: hint }),
      el('div', { class: 'hint', text: t('models.gguf_server_hint') }),
    ]),
    footer: [
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn accent', html: `${icon('plus', 14)} ${esc(t('models.add'))}`, onclick: () => openModelEditor(null) }),
    ],
  });
}

/* ------------------------------------------------------------------ */
/* shortcuts                                                           */
/* ------------------------------------------------------------------ */

function matches(combo, event) {
  if (!combo) return false;
  const parts = String(combo).split('+').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return false;
  const key = parts[parts.length - 1];
  const wantCtrl = parts.some((part) => part.toLowerCase() === 'ctrl' || part.toLowerCase() === 'cmd' || part.toLowerCase() === 'meta');
  const wantAlt = parts.some((part) => part.toLowerCase() === 'alt');
  const wantShift = parts.some((part) => part.toLowerCase() === 'shift');
  const eventKey = event.key === ' ' ? 'Space' : event.key;
  if (eventKey.toLowerCase() !== String(key).toLowerCase()) return false;
  if (wantCtrl !== (event.ctrlKey || event.metaKey)) return false;
  if (wantAlt !== event.altKey) return false;
  if (wantShift !== event.shiftKey) return false;
  return true;
}

function installShortcuts() {
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing = Boolean(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable));
    const hk = setting('hotkeys', {}) || {};

    const map = [
      ['palette', () => togglePalette(), true],
      ['settings', () => openSettings(state.ui.settingsTab), true],
      ['new_session', () => newSession(), true],
      ['switch_model', () => openModelSwitcher($('#modelSwitchBtn')), true],
      ['stop_run', () => stopRun(), true],
      ['focus_input', () => focusInput(), true],
      ['toggle_sidebar', toggleSidebar, true],
      ['toggle_monitor', () => setMonitor(!state.ui.monitorOpen), true],
      ['search_sessions', () => $('#sessionSearch')?.focus(), false],
      ['regenerate', () => resendLast(), false],
    ];

    for (const [name, action, allowWhileTyping] of map) {
      if (!matches(hk[name], event)) continue;
      if (typing && !allowWhileTyping) continue;
      event.preventDefault();
      action();
      return;
    }

    if (event.key === 'Escape') {
      if ($('#paletteRoot')?.classList.contains('active')) togglePalette();
    }
  });

  window.addEventListener('wheel', debounce((event) => {
    if (!event.ctrlKey || !setting('ui.ctrl_zoom', true)) return;
    const current = Number(setting('ui.font_size', 14.5));
    const next = Math.round((current + (event.deltaY < 0 ? 0.5 : -0.5)) * 2) / 2;
    setSetting('ui.font_size', Math.min(20, Math.max(11.5, next)));
    theme.refresh(state.settings);
  }, 70), { passive: true });
}

/* ------------------------------------------------------------------ */

function start() {
  boot().catch((error) => {
    console.error('[DAGENT] boot failed', error);
    const host = document.getElementById('toasts');
    if (host) host.append(el('div', { class: 'toast error', text: String(error.message || error) }));
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
