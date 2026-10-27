/** Message composer: input, attachments, slash commands, send/stop. */

import { $, el, esc, clear, debounce, humanSize, baseName } from '../dom.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { bus, state, setting, currentSession, currentMode, isRunning } from '../state.js';
import { notify } from './toast.js';
import { openDropdown } from './dropdown.js';
import { confirmDialog } from './modal.js';

let attachments = [];
let slashItems = [];

export function initComposer() {
  const input = $('#input');
  const sendBtn = $('#sendBtn');
  if (!input || !sendBtn) return;

  input.addEventListener('input', () => {
    autosize(input);
    updateStats();
    maybeSlash(input);
  });
  input.addEventListener('keydown', (event) => {
    const sendKey = String(setting('hotkeys.send', 'Enter')).toLowerCase();
    const isEnter = event.key === 'Enter';
    const wantsNewline = event.shiftKey || event.altKey || event.ctrlKey || event.metaKey;
    if (isEnter && !wantsNewline && sendKey === 'enter' && !event.isComposing) {
      event.preventDefault();
      send();
      return;
    }
    if (isEnter && (event.ctrlKey || event.metaKey) && sendKey !== 'enter') {
      event.preventDefault();
      send();
      return;
    }
    if (event.key === 'Escape' && input.value) {
      event.stopPropagation();
    }
    if (event.key === 'ArrowUp' && !input.value) {
      event.preventDefault();
      bus.emit('ui:focus-last-user-message');
    }
  });
  input.addEventListener('paste', (event) => {
    const files = Array.from(event.clipboardData?.files || []);
    if (files.length) {
      event.preventDefault();
      files.forEach(addAttachment);
    }
  });

  sendBtn.addEventListener('click', () => {
    if (isRunning()) stopRun();
    else send();
  });
  sendBtn.dataset.stopLabel = t('common.stop');

  $('#attachBtn')?.addEventListener('click', () => $('#fileInput')?.click());
  $('#fileInput')?.addEventListener('change', (event) => {
    Array.from(event.target.files || []).forEach(addAttachment);
    event.target.value = '';
  });
  $('#slashBtn')?.addEventListener('click', () => {
    setInput('/');
    maybeSlash($('#input'), true);
  });

  // drag & drop
  const composer = $('#composer');
  ['dragenter', 'dragover'].forEach((type) => {
    composer?.addEventListener(type, (event) => {
      event.preventDefault();
      composer.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((type) => {
    composer?.addEventListener(type, (event) => {
      event.preventDefault();
      composer.classList.remove('dragover');
    });
  });
  composer?.addEventListener('drop', (event) => {
    Array.from(event.dataTransfer?.files || []).forEach(addAttachment);
  });
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', (event) => event.preventDefault());

  bus.on('run:state', () => updateSendButton());
  bus.on('session:loaded', () => {
    attachments = [];
    renderAttachments();
    updateComposerMode();
  });
  bus.on('ui:set-input', (text) => setInput(text));
  bus.on('ui:focus-input', () => focus());

  autosize(input);
  updateStats();
  updateComposerMode();
  updateSendButton();
}

export function focus() {
  const input = $('#input');
  input?.focus();
  input?.setSelectionRange(input.value.length, input.value.length);
}

export function setInput(text, keepFocus = true) {
  const input = $('#input');
  if (!input) return;
  input.value = text ?? '';
  autosize(input);
  updateStats();
  if (keepFocus) focus();
}

export function getInput() {
  return $('#input')?.value || '';
}

function autosize(input) {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.42)}px`;
}

function updateStats() {
  const value = getInput();
  const stats = $('#composerStats');
  if (!stats) return;
  if (!value) {
    stats.textContent = '';
    return;
  }
  const chars = value.length;
  const tokens = Math.max(1, Math.round(chars / 3.6));
  stats.textContent = `${chars} ch · ~${tokens} tok`;
}

export function updateComposerMode() {
  const mode = currentMode();
  const label = $('#composerModeLabel');
  if (label && mode) {
    label.innerHTML = `${icon(mode.icon || 'wand', 12)} ${esc(mode.name || mode.id)}`;
    label.classList.remove('muted');
  }
  const input = $('#input');
  if (input) {
    input.placeholder = mode?.id === 'chat'
      ? (getLanguageRu() ? 'Напишите сообщение...' : 'Write a message...')
      : t('composer.placeholder');
  }
}

function getLanguageRu() {
  return setting('app.language', 'ru') === 'ru';
}

export function updateSendButton() {
  const button = $('#sendBtn');
  if (!button) return;
  const running = isRunning();
  button.classList.toggle('running', running);
  button.title = running ? `${t('common.stop')} (Ctrl+.)` : `${t('composer.send')} (Enter)`;
  button.dataset.stopLabel = t('common.stop');
}

/* ------------------------------ attachments ------------------------------ */

export async function addAttachment(file) {
  const limit = Number(setting('chat.max_attachment_bytes', 400000));
  if (file.size > limit) {
    notify.warn(t('toast.attachment_large'), `${file.name}: ${humanSize(file.size)} > ${humanSize(limit)}`);
    return;
  }
  try {
    const result = await api.upload(file);
    attachments.push(result.attachment);
    renderAttachments();
  } catch (error) {
    // Fallback: read the file in the browser (works for text files)
    const text = await file.text?.().catch(() => null);
    if (text === null) {
      notify.error(t('common.error'), error.message);
      return;
    }
    attachments.push({ name: file.name, size: file.size, content: text });
    renderAttachments();
  }
}

export function addAttachmentFromPath(path) {
  attachments.push({ name: baseName(path), path, abs_path: path });
  renderAttachments();
}

function renderAttachments() {
  const host = $('#attachments');
  if (!host) return;
  clear(host);
  attachments.forEach((attachment, index) => {
    const chip = el('div', { class: 'attachment-chip' });
    chip.append(el('span', { html: icon('file', 13) }));
    chip.append(el('span', { class: 'att-name', text: attachment.name || 'file' }));
    if (attachment.size) chip.append(el('span', { class: 'muted tiny', text: humanSize(attachment.size) }));
    chip.append(el('button', {
      html: icon('x', 13),
      title: t('common.delete'),
      onclick: () => {
        attachments.splice(index, 1);
        renderAttachments();
      },
    }));
    host.append(chip);
  });
  state.attachments = attachments;
}

export function clearAttachments() {
  attachments = [];
  renderAttachments();
}

/* ------------------------------ slash commands ------------------------------ */

const SLASH_COMMANDS = [
  { cmd: '/new', icon: 'plus', run: () => bus.emit('ui:new-session') },
  { cmd: '/model', icon: 'cpu', run: () => bus.emit('ui:model-switcher') },
  { cmd: '/mode', icon: 'wand', run: () => bus.emit('ui:mode-picker') },
  { cmd: '/clear', icon: 'trash', run: () => bus.emit('ui:clear-session') },
  { cmd: '/stop', icon: 'stop', run: () => stopRun() },
  { cmd: '/settings', icon: 'settings', run: () => bus.emit('ui:open-settings', 'agent') },
  { cmd: '/workspace', icon: 'folder', run: () => bus.emit('ui:change-workspace') },
  { cmd: '/export', icon: 'export', run: () => bus.emit('ui:export-session') },
  { cmd: '/summarize', icon: 'layers', run: () => bus.emit('ui:summarize-session') },
  { cmd: '/terminal', icon: 'terminal', run: () => bus.emit('ui:open-terminal') },
  { cmd: '/palette', icon: 'palette', run: () => bus.emit('ui:palette') },
  { cmd: '/help', icon: 'info', run: () => bus.emit('ui:about') },
];

function maybeSlash(input, force = false) {
  const value = input.value;
  if (!force && !value.startsWith('/')) return;
  if (value.includes(' ') && !force) return;
  const query = value.slice(1).toLowerCase();
  const matches = SLASH_COMMANDS.filter((item) => item.cmd.slice(1).startsWith(query));
  if (!matches.length && !force) return;
  const ru = getLanguageRu();
  const items = matches.map((item) => ({
    id: item.cmd,
    title: item.cmd,
    sub: ru ? SLASH_RU[item.cmd] || '' : SLASH_EN[item.cmd] || '',
    icon: item.icon,
    onClick: () => {
      setInput('');
      item.run();
    },
  }));
  slashItems = items;
  openDropdown({
    anchor: input,
    items,
    align: 'left',
    width: 380,
    emptyText: ru ? 'Нет такой команды' : 'No such command',
  });
}

const SLASH_RU = {
  '/new': 'Новая сессия',
  '/model': 'Сменить модель',
  '/mode': 'Сменить режим',
  '/clear': 'Очистить историю',
  '/stop': 'Остановить агента',
  '/settings': 'Открыть настройки',
  '/workspace': 'Сменить рабочую папку',
  '/export': 'Экспорт сессии',
  '/summarize': 'Сжать историю (экономия контекста)',
  '/terminal': 'Открыть терминал',
  '/palette': 'Палитра команд',
  '/help': 'О программе и горячие клавиши',
};

const SLASH_EN = {
  '/new': 'New session',
  '/model': 'Switch model',
  '/mode': 'Switch mode',
  '/clear': 'Clear history',
  '/stop': 'Stop the agent',
  '/settings': 'Open settings',
  '/workspace': 'Change workspace',
  '/export': 'Export session',
  '/summarize': 'Compress history (save context)',
  '/terminal': 'Open terminal',
  '/palette': 'Command palette',
  '/help': 'About and hotkeys',
};

/* ------------------------------ send / stop ------------------------------ */

export async function send(textOverride) {
  const input = $('#input');
  const text = (textOverride ?? input?.value ?? '').trim();
  if (!text && !attachments.length) return;
  if (isRunning()) {
    notify.warn(t('status.running'), t('common.stop'));
    return;
  }
  if (!state.models.length) {
    notify.error(t('chat.no_model_title'), t('chat.no_model_text'), [
      { label: t('models.add'), kind: 'accent', onClick: () => bus.emit('ui:open-settings', 'models') },
    ]);
    bus.emit('ui:open-settings', 'models');
    return;
  }
  const payload = {
    session_id: state.currentSessionId || '',
    text,
    attachments: attachments.map((item) => ({ ...item })),
    mode: currentSession()?.mode || setting('agent.mode', 'assistant'),
    model_id: state.activeModel?.id || null,
  };
  setInput('');
  clearAttachments();
  updateSendButton();
  try {
    const result = await api.chat(payload);
    bus.emit('run:started', result);
  } catch (error) {
    setInput(text);
    renderAttachments();
    if (error.status === 409) {
      notify.error(t('chat.no_model_title'), error.message, [
        { label: t('models.add'), kind: 'accent', onClick: () => bus.emit('ui:open-settings', 'models') },
      ]);
      bus.emit('ui:maybe-onboarding');
    } else {
      notify.error(t('common.error'), error.message);
    }
  }
}

export async function stopRun() {
  const run = state.run;
  try {
    if (run?.run_id) await api.stopRun(run.run_id);
    else await api.stopAll();
    notify.info(t('toast.run_stopped'));
  } catch (error) {
    notify.error(t('common.error'), error.message);
  }
}

export async function resendLast() {
  const session = currentSession();
  if (!session) return;
  try {
    const result = await api.retryLast(session.id);
    bus.emit('run:started', result);
  } catch (error) {
    notify.error(t('common.error'), error.message);
  }
}
