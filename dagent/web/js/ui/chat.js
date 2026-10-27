/**
 * Chat renderer: messages, streaming text, tool cards, approvals, questions.
 * All DOM for the conversation area is produced here.
 */

import { $, el, esc, clear, copyText, fmtTime, humanDuration, humanSize, isNearBottom, scrollToBottom, timeAgo, baseName } from '../dom.js';
import { icon, toolIcon, MODE_ICONS } from '../icons.js';
import { markdown } from '../markdown.js';
import { highlight, renderAnsi, renderDiff } from '../highlight.js';
import { t, getLanguage } from '../i18n.js';
import { bus, state, setting, currentMode, currentSession, modelById } from '../state.js';
import { api } from '../api.js';
import { notify } from './toast.js';
import { confirmDialog, promptDialog } from './modal.js';
import { openContextMenu } from './dropdown.js';

let live = null;                 // streaming bubble state
const nodes = new Map();         // message id -> element
const toolNodes = new Map();     // call id -> tool card element
let approvalNodes = new Map();   // call id -> approval card
let autoScroll = true;

export function initChat() {
  const scroll = $('#chatScroll');
  scroll?.addEventListener('scroll', () => {
    autoScroll = isNearBottom(scroll, 120);
    $('#scrollDownBtn')?.classList.toggle('show', !autoScroll && scroll.scrollTop > 200);
  });
  $('#scrollDownBtn')?.addEventListener('click', () => {
    autoScroll = true;
    scrollToBottom(scroll);
  });

  $('#messages')?.addEventListener('click', onMessagesClick);
  bus.on('theme:applied', () => { /* code blocks inherit CSS variables automatically */ });
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

export function renderAll() {
  const host = $('#messages');
  if (!host) return;
  clear(host);
  nodes.clear();
  toolNodes.clear();
  approvalNodes = new Map();
  const messages = state.messages || [];
  for (const message of messages) host.append(renderMessage(message));
  updateEmptyState();
  if (autoScroll) scrollToBottom($('#chatScroll'), 'auto');
}

export function updateEmptyState() {
  const empty = $('#emptyState');
  if (!empty) return;
  const hasMessages = (state.messages || []).length > 0 || live;
  empty.classList.toggle('hidden', hasMessages);
  $('#messages')?.classList.toggle('hidden', false);
}

export function appendMessage(message) {
  const host = $('#messages');
  if (!host) return;
  if (nodes.has(message.id)) {
    const existing = nodes.get(message.id);
    const fresh = renderMessage(message);
    existing.replaceWith(fresh);
    nodes.set(message.id, fresh);
    return fresh;
  }
  const node = renderMessage(message);
  host.append(node);
  nodes.set(message.id, node);
  updateEmptyState();
  if (autoScroll) scrollToBottom($('#chatScroll'));
  return node;
}

function messageAvatar(message) {
  if (message.role === 'user') {
    return el('div', { class: 'msg-avatar', text: (setting('ui.show_avatars', true) ? 'U' : '') });
  }
  return el('div', { class: 'msg-avatar', html: icon('bot', 17) });
}

export function renderMessage(message) {
  const isUser = message.role === 'user';
  const meta = message.meta || {};
  const node = el('article', {
    class: `msg msg-${message.role}${meta.error ? ' error' : ''}`,
    dataset: { id: message.id, role: message.role },
  });
  if (!isUser) node.append(messageAvatar(message));

  const body = el('div', { class: 'msg-body' });

  // header
  const head = el('div', { class: 'msg-head' });
  if (isUser) {
    if (setting('ui.show_timestamps', true)) head.append(el('span', { class: 'msg-time', text: fmtTime(message.created_at) }));
    head.append(el('span', { class: 'msg-author', text: t('chat.you') }));
  } else {
    head.append(el('span', { class: 'msg-author', text: t('chat.assistant') }));
    const model = meta.model || modelById(meta.model_id)?.model || '';
    if (model) head.append(el('span', { class: 'tag', text: String(model).slice(0, 28) }));
    if (meta.mode) {
      head.append(el('span', { class: 'tag', html: `${icon(MODE_ICONS[meta.mode] || 'wand', 11)} ${esc(meta.mode)}` }));
    }
    if (setting('ui.show_timestamps', true)) head.append(el('span', { class: 'msg-time', text: fmtTime(message.created_at) }));
    if (setting('ui.show_token_stats', true) && meta.usage?.total_tokens) {
      head.append(el('span', { class: 'msg-time', text: `${meta.usage.total_tokens} tok` }));
    }
    if (meta.error) head.append(el('span', { class: 'tag danger', text: t('chat.error_title') }));
    if (meta.partial) head.append(el('span', { class: 'tag warn', text: t('chat.stopped_by_user') }));
  }
  body.append(head);

  // attachments (user)
  if (isUser && (meta.attachments || []).length) {
    const row = el('div', { class: 'msg-attachments' });
    for (const attachment of meta.attachments) {
      row.append(
        el('span', {
          class: 'msg-attachment',
          html: `${icon('file', 12)} ${esc(attachment.name || 'file')} <span class="muted">${esc(humanSize(attachment.size || 0))}</span>`,
        }),
      );
    }
    body.append(row);
  }

  // reasoning
  if (!isUser && meta.reasoning && setting('agent.show_reasoning', true)) {
    const details = el('details', { class: 'reasoning' });
    details.append(el('summary', { html: `${icon('brain', 12)} ${esc(t('chat.reasoning'))}` }));
    details.append(el('div', { class: 'reasoning-text', text: meta.reasoning }));
    body.append(details);
  }

  // content
  const useMarkdown = !isUser && setting('ui.markdown', true);
  const content = el('div', { class: `msg-content${useMarkdown ? ' md' : ''}` });
  if (!useMarkdown) {
    content.style.whiteSpace = 'pre-wrap';
    content.textContent = message.content || '';
  } else {
    content.innerHTML = markdown(message.content || '');
  }
  if (meta.error && !message.content) {
    content.append(el('div', { class: 'tag danger', text: String(meta.error).slice(0, 400) }));
  }
  body.append(content);

  // tool cards
  const calls = meta.tool_calls || [];
  const results = meta.tool_results || [];
  if (calls.length || results.length) {
    body.append(renderTools(calls, results, message.id));
  }

  // actions
  body.append(renderActions(message));
  node.append(body);
  nodes.set(message.id, node);
  return node;
}

function renderTools(calls, results, messageId) {
  const wrap = el('div', { class: 'tools' });
  const resultMap = new Map(results.map((result) => [result.id, result]));
  const seen = new Set();
  for (const call of calls) {
    const result = resultMap.get(call.id) || null;
    const record = { ...call, ...(result || {}), status: result ? (result.ok ? 'done' : result.status || 'error') : 'pending' };
    const card = renderToolCard(record, messageId);
    wrap.append(card);
    toolNodes.set(call.id, card);
    seen.add(call.id);
  }
  for (const result of results) {
    if (seen.has(result.id)) continue;
    const card = renderToolCard(result, messageId);
    wrap.append(card);
    toolNodes.set(result.id, card);
  }
  return wrap;
}

function renderToolCard(record, messageId) {
  const status = record.status || (record.ok === undefined ? 'pending' : record.ok ? 'done' : 'error');
  const card = el('div', { class: 'tool-card', dataset: { status, callId: record.id || '', messageId: messageId || '' } });
  if (setting('ui.compact_tool_cards')) card.classList.add('compact');

  const head = el('div', { class: 'tool-head' });
  head.append(el('span', { class: `tool-icon${record.ok ? ' ok-green' : ''}`, html: icon(toolIcon(record.tool), 14) }));
  const title = el('div', { class: 'tool-title' });
  title.append(el('span', { class: 'tool-name', text: record.tool || 'tool' }));
  title.append(el('span', { class: 'tool-summary', text: summarizeTool(record) }));
  head.append(title);

  const right = el('div', { class: 'tool-right' });
  if (status === 'running' || status === 'pending') right.append(el('span', { class: 'spinner' }));
  if (record.risk && record.risk !== 'low') right.append(el('span', { class: `tag ${record.risk === 'high' || record.risk === 'blocked' ? 'danger' : 'warn'}`, text: t(`approval.risk.${record.risk}`) }));
  if (record.duration_ms) right.append(el('span', { class: 'tiny muted mono', text: humanDuration(record.duration_ms) }));
  right.append(el('span', { class: 'tool-chev', html: icon('chevronDown', 14) }));
  head.append(right);

  const body = el('div', { class: 'tool-body' });
  const inner = el('div', { class: 'tool-body-inner' });
  inner.append(renderToolBody(record));
  body.append(inner);

  card.append(head, body);
  head.addEventListener('click', () => card.classList.toggle('open'));
  if (status === 'error' || status === 'blocked' || status === 'denied') card.classList.add('open');
  return card;
}

export function summarizeTool(record) {
  const args = record.args || {};
  switch (record.tool) {
    case 'run_command': return String(args.command || record.data?.command || '');
    case 'python_run': return String(args.code || '').split('\n')[0].slice(0, 90);
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'delete_path':
    case 'create_dir':
    case 'file_info': return String(args.path || record.data?.path || '');
    case 'move_path':
    case 'copy_path': return `${args.source || ''} → ${args.destination || ''}`;
    case 'list_dir': return String(args.path || '.') + (args.recursive ? ' (recursive)' : '');
    case 'search_files': return `/${args.pattern || ''}/`;
    case 'web_fetch': return String(args.url || '');
    case 'ask_user': return String(args.question || '').slice(0, 90);
    case 'remember': return String(args.text || '').slice(0, 90);
    case 'update_plan': return `${(args.steps || []).length} steps`;
    case 'workspace_tree': return `depth ${args.depth || 3}`;
    default: {
      const first = Object.entries(args)[0];
      return first ? `${first[0]}: ${String(first[1]).slice(0, 70)}` : '';
    }
  }
}

function renderToolBody(record) {
  const wrap = el('div', { class: 'col' });
  const args = record.args || {};
  if (Object.keys(args).length) {
    const argsBox = el('div', { class: 'tool-args' });
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined || value === null || value === '') continue;
      const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      argsBox.append(
        el('div', { class: 'tool-arg' }, [
          el('span', { class: 'k', text: key }),
          el('span', { class: 'v', text: text.length > 1600 ? `${text.slice(0, 1600)}...` : text }),
        ]),
      );
    }
    wrap.append(argsBox);
  }

  const data = record.data || {};
  const output = String(record.output ?? '');
  const kind = record.render || 'text';

  if (kind === 'command') {
    const head = el('div', { class: 'row tiny muted' });
    head.append(el('span', { class: 'mono', text: `$ ${data.command || args.command || ''}` }));
    head.append(el('span', { class: 'spacer' }));
    if (data.exit_code !== undefined) {
      head.append(el('span', { class: `tag ${data.exit_code === 0 ? 'ok' : 'danger'}`, text: `exit ${data.exit_code}` }));
    }
    if (data.duration_ms) head.append(el('span', { class: 'mono', text: humanDuration(data.duration_ms) }));
    wrap.append(head);
    const out = el('div', { class: `tool-output${record.ok ? '' : ' err'}` });
    out.innerHTML = renderAnsi(data.output || output);
    wrap.append(out);
  } else if (kind === 'diff' && data.diff) {
    wrap.append(el('div', { class: 'row tiny muted' }, [
      el('span', { class: 'mono', text: data.path || '' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'tag', text: data.created ? 'created' : 'modified' }),
    ]));
    const diff = el('div', { class: 'diff' });
    diff.innerHTML = renderDiff(data.diff);
    wrap.append(diff);
  } else if (kind === 'file' && (data.content || data.content_preview)) {
    const language = data.language || 'text';
    const code = data.content || data.content_preview || '';
    wrap.append(el('div', { class: 'row tiny muted' }, [
      el('span', { class: 'mono', text: data.path || '' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'mono', text: `${data.lines || code.split('\n').length} lines · ${humanSize(data.size || code.length)}` }),
    ]));
    const block = el('div', { class: 'code-block' });
    block.innerHTML = `<div class="code-head"><span class="code-lang">${esc(language)}</span><span class="code-actions"></span></div>
      <div class="code-scroll"><pre><code>${highlight(code.slice(0, 20000), language)}</code></pre></div>`;
    wrap.append(block);
  } else if (kind === 'plan' && data.steps) {
    const list = el('div', { class: 'col' });
    data.steps.forEach((step, index) => {
      list.append(el('div', { class: 'plan-item', dataset: { status: step.status || 'pending' } }, [
        el('span', { class: 'plan-check', html: icon('check', 11, 3) }),
        el('div', {}, [
          el('div', { class: 'plan-title', text: `${index + 1}. ${step.title || ''}` }),
          step.detail ? el('div', { class: 'plan-detail', text: step.detail }) : null,
        ]),
      ]));
    });
    wrap.append(list);
  } else if (kind === 'question') {
    wrap.append(el('div', { class: 'question-text', text: data.question || args.question || '' }));
    if (data.answer) wrap.append(el('div', { class: 'tag accent', text: `→ ${data.answer}` }));
  } else if (kind === 'web') {
    wrap.append(el('div', { class: 'row tiny muted' }, [
      el('a', { href: data.url || args.url || '#', target: '_blank', rel: 'noopener noreferrer', text: data.url || args.url || '' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'tag', text: `HTTP ${data.status || ''}` }),
    ]));
    const out = el('div', { class: 'tool-output' });
    out.textContent = (data.text || output).slice(0, 8000);
    wrap.append(out);
  } else if (output) {
    const out = el('div', { class: `tool-output${record.ok ? '' : ' err'}` });
    if (output.length > 200 || output.includes('\n')) out.textContent = output.slice(0, 20000);
    else out.innerHTML = markdown(output);
    wrap.append(out);
  }

  if (record.error && record.ok === false) {
    wrap.append(el('div', { class: 'tag danger', text: String(record.error).slice(0, 300) }));
  }
  return wrap;
}

function renderActions(message) {
  const bar = el('div', { class: 'msg-actions' });
  const push = (title, iconName, handler, extraClass = '') => {
    bar.append(el('button', { class: `icon-btn tiny ${extraClass}`, title, html: icon(iconName, 14), onclick: (event) => { event.stopPropagation(); handler(); } }));
  };
  push(t('chat.copy_message'), 'copy', async () => {
    const ok = await copyText(message.content || '');
    notify[ok ? 'ok' : 'error'](ok ? t('toast.copied') : t('common.error'));
  });
  if (message.role === 'user') {
    push(t('chat.edit_message'), 'pencil', async () => {
      const value = await promptDialog({ title: t('chat.edit_message'), value: message.content || '', multiline: true, okText: t('common.save') });
      if (value === null) return;
      await api.editMessage(message.id, value, false);
      bus.emit('message:edited', { id: message.id, content: value });
    });
    push(t('common.delete'), 'trash', async () => {
      const cascade = await confirmDialog({ title: t('chat.delete_message_cascade'), text: '', okText: t('common.delete'), danger: true });
      await api.deleteMessage(message.id, cascade);
      bus.emit('messages:changed');
    }, 'danger');
  } else {
    push(t('chat.regenerate'), 'refresh', async () => {
      const run = await api.regenerate(message.id);
      bus.emit('run:started', run);
    });
    push(t('common.delete'), 'trash', async () => {
      await api.deleteMessage(message.id, false);
      bus.emit('messages:changed');
    }, 'danger');
  }
  return bar;
}

function onMessagesClick(event) {
  const copyBtn = event.target.closest('[data-action="copy-code"]');
  if (copyBtn) {
    const block = copyBtn.closest('.code-block');
    const code = block?.querySelector('pre code')?.innerText || '';
    copyText(code).then((ok) => notify[ok ? 'ok' : 'error'](ok ? t('toast.copied') : t('common.error')));
    return;
  }
  const link = event.target.closest('a[href]');
  if (link) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
}

/* ------------------------------------------------------------------ */
/* streaming                                                           */
/* ------------------------------------------------------------------ */

export function startLive() {
  stopLive();
  const host = $('#messages');
  if (!host) return;
  const node = el('article', { class: 'msg msg-assistant live' });
  node.append(messageAvatar({ role: 'assistant' }));
  const body = el('div', { class: 'msg-body' });
  const head = el('div', { class: 'msg-head' });
  head.append(el('span', { class: 'msg-author', text: t('chat.assistant') }));
  const model = state.activeModel;
  if (model) head.append(el('span', { class: 'tag', text: String(model.model || model.name || '').slice(0, 28) }));
  head.append(el('span', { class: 'msg-time live-status', text: t('chat.thinking') }));
  body.append(head);
  const content = el('div', { class: 'msg-content md' });
  content.append(el('span', { class: 'typing', html: '<i></i><i></i><i></i>' }));
  body.append(content);
  const tools = el('div', { class: 'tools' });
  body.append(tools);
  node.append(body);
  host.append(node);
  live = { node, content, tools, text: '', reasoning: '', startedAt: Date.now(), rendered: 0 };
  updateEmptyState();
  autoScroll = true;
  scrollToBottom($('#chatScroll'));
}

let renderTimer = null;
export function appendToken(text) {
  if (!live) startLive();
  if (!live) return;
  live.text += text;
  if (!setting('ui.stream_smooth', true)) {
    renderLive();
    return;
  }
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderLive();
  }, 55);
}

export function appendReasoning(text) {
  if (!live) startLive();
  if (!live) return;
  live.reasoning += text;
  renderLive();
}

function renderLive() {
  if (!live) return;
  const { content } = live;
  clear(content);
  if (live.reasoning && setting('agent.show_reasoning', true)) {
    const details = el('details', { class: 'reasoning', open: true });
    details.append(el('summary', { html: `${icon('brain', 12)} ${esc(t('chat.reasoning'))}` }));
    details.append(el('div', { class: 'reasoning-text', text: live.reasoning.slice(-4000) }));
    content.append(details);
  }
  if (live.text) {
    const md = el('div', { class: 'md' });
    md.innerHTML = `${markdown(live.text)}<span class="caret"></span>`;
    content.append(md);
  } else {
    content.append(el('span', { class: 'typing', html: '<i></i><i></i><i></i>' }));
  }
  if (autoScroll) scrollToBottom($('#chatScroll'));
}

export function addLiveTool(record) {
  if (!live) startLive();
  if (!live) return;
  const card = renderToolCard({ ...record, status: 'running' }, '');
  live.tools.append(card);
  if (record.id) toolNodes.set(record.id, card);
  if (autoScroll) scrollToBottom($('#chatScroll'));
}

export function updateTool(record) {
  const card = toolNodes.get(record.id);
  if (!card) {
    addLiveTool({ ...record, status: record.ok ? 'done' : 'error' });
    return;
  }
  const status = record.status || (record.ok ? 'done' : 'error');
  card.dataset.status = status;
  const body = card.querySelector('.tool-body .tool-body-inner');
  if (body) {
    clear(body);
    body.append(renderToolBody(record));
  }
  const right = card.querySelector('.tool-right');
  if (right) {
    right.querySelectorAll('.spinner').forEach((node) => node.remove());
    if (record.duration_ms && !right.querySelector('.mono')) {
      right.insertBefore(el('span', { class: 'tiny muted mono', text: humanDuration(record.duration_ms) }), right.lastElementChild);
    }
  }
  const iconNode = card.querySelector('.tool-icon');
  if (iconNode && record.ok) iconNode.classList.add('ok-green');
  const summary = card.querySelector('.tool-summary');
  if (summary) summary.textContent = summarizeTool(record);
}

export function stopLive() {
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
  if (live) {
    live.node.remove();
    live = null;
  }
  updateEmptyState();
}

export function liveActive() {
  return Boolean(live);
}

export function setLiveStatus(text) {
  if (!live) return;
  const node = live.node.querySelector('.live-status');
  if (node) node.textContent = text;
}

/* ------------------------------------------------------------------ */
/* approvals & questions                                               */
/* ------------------------------------------------------------------ */

export function showApproval(request) {
  const host = live?.tools || $('#messages');
  const payload = request.payload || {};
  const card = el('div', { class: 'approval', dataset: { risk: payload.risk || 'medium', callId: request.call_id } });

  const head = el('div', { class: 'approval-head' });
  head.append(el('span', { class: 'tool-icon', html: icon(payload.tool === 'ask_user' ? 'question' : toolIcon(payload.tool), 15) }));
  const titleWrap = el('div', { class: 'grow' });
  titleWrap.append(el('div', { class: 'approval-title', html: `${icon('shield', 16)} ${esc(t('approval.title'))}` }));
  titleWrap.append(el('div', { class: 'approval-reason', text: `${payload.tool || ''} · ${payload.reason || ''}` }));
  head.append(titleWrap);
  head.append(el('span', { class: `tag ${payload.risk === 'high' ? 'danger' : 'warn'}`, text: t(`approval.risk.${payload.risk || 'medium'}`) }));
  const timer = el('span', { class: 'approval-timer' });
  head.append(timer);
  card.append(head);

  const preview = payload.preview || JSON.stringify(payload.args || {}, null, 2);
  const previewBox = el('div', { class: 'approval-preview' });
  if (payload.tool === 'run_command') previewBox.innerHTML = highlight(String(preview), 'bash');
  else if (payload.tool === 'python_run') previewBox.innerHTML = highlight(String(preview), 'python');
  else previewBox.textContent = preview;
  card.append(previewBox);

  const note = el('input', { class: 'input-t', type: 'text', placeholder: t('approval.note') });
  card.append(note);

  const actions = el('div', { class: 'approval-actions' });
  const approveBtn = el('button', { class: 'btn accent', html: `${icon('check', 15, 2.4)} ${esc(t('approval.approve'))}`, 'data-autofocus': true });
  const denyBtn = el('button', { class: 'btn danger', html: `${icon('x', 15, 2.4)} ${esc(t('approval.deny'))}` });
  const allowSession = el('button', { class: 'btn ghost', text: t('approval.allow_session') });
  const allowTool = el('button', { class: 'btn ghost', text: t('approval.allow_tool') });
  actions.append(approveBtn, denyBtn, allowSession, allowTool);
  card.append(actions);

  const timeout = Number(setting('security.confirm_timeout', 300)) || 300;
  const deadline = Date.now() + timeout * 1000;
  const tick = setInterval(() => {
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    timer.textContent = `${left}s`;
    if (left <= 0) clearInterval(tick);
  }, 1000);
  timer.textContent = `${timeout}s`;

  const resolve = async (approved, scope = 'once') => {
    clearInterval(tick);
    card.classList.add('resolved');
    actions.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    note.disabled = true;
    try {
      await api.resolve(request.call_id, { approved, scope, note: note.value || '' });
    } catch (error) {
      notify.error(t('common.error'), error.message);
    }
    card.querySelector('.approval-title').innerHTML = `${icon(approved ? 'check' : 'x', 16)} ${esc(approved ? t('approval.approved') : t('approval.denied'))}`;
    setTimeout(() => card.remove(), 2600);
    approvalNodes.delete(request.call_id);
    state.pending = state.pending.filter((item) => item.call_id !== request.call_id);
    bus.emit('pending:changed', state.pending);
  };

  approveBtn.addEventListener('click', () => resolve(true, 'once'));
  denyBtn.addEventListener('click', () => resolve(false, 'once'));
  allowSession.addEventListener('click', () => resolve(true, payload.tool === 'run_command' ? 'session_command' : 'session_folder'));
  allowTool.addEventListener('click', () => resolve(true, 'session_tool'));
  note.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') resolve(true, 'once');
  });

  host.append(card);
  approvalNodes.set(request.call_id, card);
  state.pending.push(request);
  bus.emit('pending:changed', state.pending);
  autoScroll = true;
  scrollToBottom($('#chatScroll'));
  return card;
}

export function showQuestion(request) {
  const payload = request.payload || {};
  const host = live?.tools || $('#messages');
  const card = el('div', { class: 'question-card', dataset: { callId: request.call_id } });
  card.append(el('div', { class: 'approval-title', html: `${icon('question', 16)} ${esc(t('approval.question_title'))}` }));
  card.append(el('div', { class: 'question-text', text: payload.question || '' }));
  if ((payload.options || []).length) {
    const row = el('div', { class: 'question-options' });
    payload.options.forEach((option) => {
      row.append(el('button', { class: 'btn', text: String(option), onclick: () => answer(String(option)) }));
    });
    card.append(row);
  }
  const input = el('input', { class: 'input-t', type: 'text', placeholder: t('approval.answer_placeholder'), 'data-autofocus': true });
  card.append(input);
  const actions = el('div', { class: 'approval-actions' });
  const sendBtn = el('button', { class: 'btn accent', html: `${icon('send', 15)} ${esc(t('composer.send'))}` });
  const skipBtn = el('button', { class: 'btn ghost', text: t('common.skip') });
  actions.append(sendBtn, skipBtn);
  card.append(actions);
  host.append(card);

  const answer = async (value) => {
    sendBtn.disabled = true;
    skipBtn.disabled = true;
    input.disabled = true;
    try {
      await api.resolve(request.call_id, { approved: true, answer: value });
    } catch (error) {
      notify.error(t('common.error'), error.message);
    }
    card.classList.add('resolved');
    card.append(el('div', { class: 'tag accent', text: `→ ${value}` }));
    setTimeout(() => card.remove(), 2600);
    state.pending = state.pending.filter((item) => item.call_id !== request.call_id);
    bus.emit('pending:changed', state.pending);
  };
  sendBtn.addEventListener('click', () => answer(input.value.trim() || ''));
  skipBtn.addEventListener('click', () => answer(''));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') answer(input.value.trim());
  });
  autoScroll = true;
  scrollToBottom($('#chatScroll'));
  return card;
}

export function clearPending() {
  approvalNodes.forEach((node) => node.remove());
  approvalNodes = new Map();
}

/* ------------------------------------------------------------------ */
/* misc UI updates                                                     */
/* ------------------------------------------------------------------ */

export function showStatusLine(text, iconName = 'activity') {
  let node = $('#liveStatusLine');
  if (!text) {
    node?.remove();
    return;
  }
  if (!node) {
    node = el('div', { class: 'msg-status', id: 'liveStatusLine' });
    const host = live?.node?.querySelector('.msg-body') || $('#messages');
    host?.append(node);
  }
  clear(node);
  node.append(el('span', { class: 'spinner' }));
  node.append(el('span', { text }));
}

export function showRunError(message, hint = '') {
  const host = $('#messages');
  if (!host) return;
  const card = el('div', { class: 'approval resolved', dataset: { risk: 'high' } });
  card.append(el('div', { class: 'approval-title', html: `${icon('alert', 16)} ${esc(t('chat.error_title'))}` }));
  card.append(el('div', { class: 'approval-preview', text: String(message || '') }));
  if (hint) card.append(el('div', { class: 'hint', text: hint }));
  const actions = el('div', { class: 'approval-actions' });
  actions.append(el('button', {
    class: 'btn',
    html: `${icon('settings', 15)} ${esc(t('nav.models'))}`,
    onclick: () => bus.emit('ui:open-settings', 'models'),
  }));
  actions.append(el('button', { class: 'btn ghost', text: t('common.close'), onclick: () => card.remove() }));
  card.append(actions);
  host.append(card);
  scrollToBottom($('#chatScroll'));
}

export function scrollBottom(force = false) {
  if (force) autoScroll = true;
  if (autoScroll) scrollToBottom($('#chatScroll'));
}

export function exportCurrentSession(format = 'md') {
  const session = currentSession();
  if (!session) {
    notify.warn(t('common.error'), 'No session');
    return;
  }
  window.open(api.exportSessionUrl(session.id, format), '_blank');
}
