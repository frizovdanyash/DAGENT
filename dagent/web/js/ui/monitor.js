/** Right-hand monitor panel: live activity, plan, changed files, terminal, info. */

import { $, el, esc, clear, fmtTime, humanSize, humanDuration, baseName } from '../dom.js';
import { icon, toolIcon, MODE_ICONS } from '../icons.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { bus, state, setting, currentSession, currentMode, isRunning } from '../state.js';
import { renderAnsi } from '../highlight.js';
import { notify } from './toast.js';

const MAX_ACTIVITY = 220;

export function initMonitor() {
  document.querySelectorAll('#monitorTabs .mtab').forEach((tab) => {
    tab.addEventListener('click', () => setTab(tab.dataset.tab));
  });
  $('#closeMonitor')?.addEventListener('click', () => bus.emit('ui:toggle-monitor'));
  $('#clearActivity')?.addEventListener('click', () => {
    state.activity = [];
    renderActivity();
  });
  $('#refreshTree')?.addEventListener('click', loadTree);

  initTerminal();
  setTab(state.ui.monitorTab || 'activity');
  renderInfo();

  bus.on('activity', renderActivityItem);
  // A finished run keeps its plan and its change log - they describe the session.
  bus.on('run:reset', () => {
    renderInfo();
  });
  bus.on('plan', renderPlan);
  bus.on('session:loaded', () => {
    state.changedFiles = [];
    renderChanged();
    renderPlan(state.plan || []);
    renderInfo();
    loadTree();
  });
  bus.on('boot', () => {
    renderInfo();
    loadTree();
  });
  bus.on('run:state', renderInfo);
}

export function setTab(name) {
  state.ui.monitorTab = name;
  document.querySelectorAll('#monitorTabs .mtab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
  document.querySelectorAll('.mpane').forEach((pane) => pane.classList.toggle('active', pane.dataset.pane === name));
  if (name === 'terminal') setTimeout(() => $('#termInput')?.focus(), 60);
  if (name === 'files') loadTree();
  if (name === 'info') renderInfo();
}

/* ------------------------------ activity ------------------------------ */

export function logActivity(entry) {
  state.activity.unshift({ id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), ...entry });
  if (state.activity.length > MAX_ACTIVITY) state.activity.length = MAX_ACTIVITY;
  renderActivityItem(entry);
}

function renderActivity() {
  const host = $('#activityList');
  if (!host) return;
  clear(host);
  if (!state.activity.length) {
    host.append(el('div', { class: 'act-empty', text: t('monitor.empty_activity') }));
    return;
  }
  state.activity.slice(0, 80).forEach((entry) => host.append(activityNode(entry)));
}

function renderActivityItem(entry) {
  const host = $('#activityList');
  if (!host) return;
  const empty = host.querySelector('.act-empty');
  if (empty) empty.remove();
  host.prepend(activityNode({ at: Date.now(), ...entry }));
  while (host.children.length > 80) host.lastElementChild.remove();
}

function activityNode(entry) {
  const kindClass = entry.ok === false ? 'err' : entry.ok ? 'ok' : '';
  const node = el('div', { class: `act-item ${kindClass}` });
  node.append(el('span', { class: 'act-ic', html: icon(entry.icon || toolIcon(entry.tool || '') || 'activity', 12) }));
  const main = el('div', { class: 'act-main' });
  const title = el('div', { class: 'act-title' });
  title.append(el('span', { text: entry.title || '' }));
  if (entry.tool) title.append(el('span', { class: 'mono muted', text: entry.tool }));
  main.append(title);
  if (entry.text) main.append(el('div', { class: 'act-text', text: String(entry.text).slice(0, 400) }));
  node.append(main);
  node.append(el('span', { class: 'act-time', text: fmtTime(entry.at ? entry.at / 1000 : Date.now() / 1000) }));
  return node;
}

/* ------------------------------ plan ------------------------------ */

export function renderPlan(steps = state.plan) {
  state.plan = steps || [];
  const host = $('#planList');
  const progress = $('#planProgress');
  if (!host) return;
  clear(host);
  const items = state.plan || [];
  if (!items.length) {
    host.append(el('div', { class: 'act-empty', text: t('monitor.empty_plan') }));
    if (progress) progress.textContent = '0/0';
    return;
  }
  const done = items.filter((item) => item.status === 'done').length;
  if (progress) progress.textContent = `${done}/${items.length}`;
  items.forEach((step) => {
    host.append(
      el('div', { class: 'plan-item', dataset: { status: step.status || 'pending' } }, [
        el('span', { class: 'plan-check', html: icon('check', 11, 3) }),
        el('div', { class: 'grow' }, [
          el('div', { class: 'plan-title', text: step.title || '' }),
          step.detail ? el('div', { class: 'plan-detail', text: step.detail }) : null,
        ]),
      ]),
    );
  });
}

/* ------------------------------ files ------------------------------ */

export function trackChange(record) {
  const path = record?.data?.path || record?.args?.path || record?.data?.to;
  if (!path) return;
  let kind = 'modified';
  if (record.tool === 'delete_path') kind = 'deleted';
  else if (record.tool === 'create_dir') kind = 'created';
  else if (record.data?.created) kind = 'created';
  else if (record.tool === 'move_path') kind = 'modified';
  const existing = state.changedFiles.find((item) => item.path === path);
  if (existing) existing.kind = kind === 'deleted' ? 'deleted' : existing.kind;
  else state.changedFiles.unshift({ path, kind, tool: record.tool, at: Date.now() });
  renderChanged();
}

export function renderChanged() {
  const host = $('#changedFiles');
  if (!host) return;
  clear(host);
  if (!state.changedFiles.length) {
    host.append(el('div', { class: 'act-empty', text: t('monitor.empty_files') }));
    return;
  }
  state.changedFiles.slice(0, 60).forEach((item) => {
    const node = el('div', { class: 'changed-item', title: item.path });
    node.append(el('span', { class: `kind ${item.kind}`, text: item.kind.slice(0, 3).toUpperCase() }));
    node.append(el('span', { class: 'path grow', text: item.path }));
    node.append(el('span', { class: 'act-time', text: fmtTime(item.at / 1000) }));
    node.addEventListener('click', () => bus.emit('ui:preview-file', item.path));
    host.append(node);
  });
}

export async function loadTree() {
  const host = $('#fileTree');
  if (!host) return;
  try {
    const data = await api.workspaceTree(3);
    clear(host);
    const nodes = data.nodes || [];
    if (!nodes.length) {
      host.append(el('div', { class: 'act-empty', text: t('monitor.empty_files') }));
      return;
    }
    for (const node of nodes.slice(0, 700)) {
      const row = el('div', { class: `tree-row ${node.type}`, style: { paddingLeft: `${(node.depth - 1) * 12 + 4}px` }, title: node.path });
      row.append(el('span', { html: icon(node.type === 'dir' ? 'folder' : 'file', 12) }));
      row.append(el('span', { class: 'tname', text: node.name }));
      if (node.type === 'file') row.append(el('span', { class: 'tsize', text: humanSize(node.size) }));
      row.addEventListener('click', () => {
        if (node.type === 'file') bus.emit('ui:preview-file', node.path);
      });
      host.append(row);
    }
    if (data.truncated) host.append(el('div', { class: 'act-empty', text: '...' }));
  } catch (error) {
    host.textContent = error.message;
  }
}

/* ------------------------------ info ------------------------------ */

export function renderInfo() {
  const host = $('#infoGrid');
  if (!host) return;
  clear(host);
  const session = currentSession();
  const mode = currentMode();
  const model = state.activeModel;
  const run = state.run;

  const sessionBlock = el('div', { class: 'info-block' });
  sessionBlock.append(el('h4', { text: t('monitor.session') }));
  sessionBlock.append(infoRow(t('monitor.mode'), mode?.name || mode?.id || '-'));
  sessionBlock.append(infoRow(t('monitor.model'), model ? (model.name || model.model) : t('models.none')));
  sessionBlock.append(infoRow(t('chat.messages'), String(state.messages?.length || 0)));
  if (run) {
    sessionBlock.append(infoRow(t('monitor.steps'), `${run.iterations || 0}/${run.max_iterations || 0}`));
    sessionBlock.append(infoRow(t('monitor.tools'), String(run.tools_used || 0)));
    sessionBlock.append(infoRow(t('monitor.tokens'), String(run.total_tokens || 0)));
    sessionBlock.append(infoRow(t('monitor.time'), humanDuration(run.elapsed_ms || 0)));
    sessionBlock.append(infoRow('status', run.status));
  }
  host.append(sessionBlock);

  const ctx = state.context;
  if (ctx) {
    const ctxBlock = el('div', { class: 'info-block' });
    ctxBlock.append(el('h4', { text: t('settings.context') }));
    ctxBlock.append(infoRow('tokens', `${ctx.estimated_tokens || 0} / ${ctx.context_window || 0}`));
    ctxBlock.append(infoRow('history', String(ctx.history_messages || 0)));
    ctxBlock.append(infoRow('compressed', ctx.compressed ? t('common.yes') : t('common.no')));
    host.append(ctxBlock);
  }

  const wsBlock = el('div', { class: 'info-block' });
  wsBlock.append(el('h4', { text: t('monitor.workspace') }));
  wsBlock.append(infoRow('root', state.workspace?.root || '-'));
  wsBlock.append(infoRow('sandbox', setting('workspace.sandbox', true) ? t('common.enabled') : t('common.disabled')));
  wsBlock.append(infoRow('shell', setting('security.shell', 'auto')));
  host.append(wsBlock);

  const sys = state.system || {};
  const sysBlock = el('div', { class: 'info-block' });
  sysBlock.append(el('h4', { text: t('monitor.system') }));
  sysBlock.append(infoRow('OS', `${sys.os || ''} ${sys.os_release || ''}`.trim()));
  sysBlock.append(infoRow('CPU', `${sys.cpu_count || '?'} cores`));
  if (sys.memory?.total_mb) sysBlock.append(infoRow('RAM', `${Math.round((sys.memory.available_mb || 0) / 1024)} / ${Math.round(sys.memory.total_mb / 1024)} GB free`));
  if (sys.disk?.free_gb) sysBlock.append(infoRow('Disk', `${sys.disk.free_gb} / ${sys.disk.total_gb} GB free`));
  sysBlock.append(infoRow('Python', sys.python || ''));
  sysBlock.append(infoRow('DAGENT', state.version || ''));
  sysBlock.append(infoRow('data dir', sys.data_dir || ''));
  host.append(sysBlock);

  const prov = state.providers || {};
  const depBlock = el('div', { class: 'info-block' });
  depBlock.append(el('h4', { text: 'GGUF / llama.cpp' }));
  depBlock.append(infoRow('installed', prov.llama_cpp_installed ? `${t('common.yes')} (${prov.llama_cpp_version || ''})` : t('common.no')));
  depBlock.append(infoRow('loaded', String((prov.loaded_gguf || []).length)));
  host.append(depBlock);
}

function infoRow(key, value) {
  return el('div', { class: 'info-row' }, [
    el('span', { class: 'k', text: key }),
    el('span', { class: 'v', text: String(value ?? '') }),
  ]);
}

/* ------------------------------ terminal ------------------------------ */

let termBusy = false;

function initTerminal() {
  const input = $('#termInput');
  const output = $('#termOutput');
  if (!input || !output) return;
  input.placeholder = t('terminal.placeholder');
  const history = state.ui.terminalHistory;

  bus.on('tool.progress', (data, event) => {
    if (event.run_id) return; // agent output belongs to the chat
    appendTerm(data.text || '', data.stream === 'stderr' ? 'term-err' : 'term-ok');
  });

  input.addEventListener('keydown', async (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const command = input.value.trim();
      if (!command || termBusy) return;
      input.value = '';
      history.unshift(command);
      state.ui.terminalIndex = -1;
      await runCommand(command);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      state.ui.terminalIndex = Math.min(history.length - 1, state.ui.terminalIndex + 1);
      if (state.ui.terminalIndex >= 0) input.value = history[state.ui.terminalIndex] || '';
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      state.ui.terminalIndex = Math.max(-1, state.ui.terminalIndex - 1);
      input.value = state.ui.terminalIndex >= 0 ? history[state.ui.terminalIndex] || '' : '';
    } else if (event.key === 'l' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      clear(output);
    }
  });
}

async function runCommand(command) {
  const output = $('#termOutput');
  termBusy = true;
  const promptText = `${baseName(state.workspace?.root || '~')}$`;
  appendTerm(`\n${promptText} `, 'term-prompt');
  appendTerm(command, 'term-cmd');
  appendTerm('\n');
  try {
    const result = await api.terminal(command, '', state.currentSessionId || '');
    if (result.blocked) {
      appendTerm(`${t('terminal.blocked')}: ${result.reason}\n`, 'term-err');
      return;
    }
    const data = result.result?.data || {};
    const text = data.output || result.result?.output || '';
    appendTerm(`${text}\n`, result.ok ? 'term-ok' : 'term-err');
    appendTerm(`[exit ${data.exit_code ?? '?'} · ${humanDuration(data.duration_ms || 0)}]\n`, 'term-meta');
    logActivity({ title: 'terminal', tool: command.slice(0, 40), text: `exit ${data.exit_code}`, ok: result.ok, icon: 'terminal' });
  } catch (error) {
    appendTerm(`${error.message}\n`, 'term-err');
  } finally {
    termBusy = false;
    output.scrollTop = output.scrollHeight;
    $('#termInput')?.focus();
  }
}

export function appendTerm(text, className = '') {
  const output = $('#termOutput');
  if (!output || !text) return;
  if (className) {
    const span = el('span', { class: className });
    span.innerHTML = renderAnsi(text);
    output.append(span);
  } else {
    const span = el('span');
    span.innerHTML = renderAnsi(text);
    output.append(span);
  }
  const near = output.scrollHeight - output.scrollTop - output.clientHeight < 200;
  if (near) output.scrollTop = output.scrollHeight;
}

export function openTerminal(command = '') {
  bus.emit('ui:show-monitor', true);
  setTab('terminal');
  if (command) {
    const input = $('#termInput');
    if (input) {
      input.value = command;
      input.focus();
    }
  }
}
