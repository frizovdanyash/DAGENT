/** Dialog system: generic modal, confirm, prompt and sheet builders. */

import { el, trapFocus } from '../dom.js';
import { icon } from '../icons.js';

const stack = [];

function host() {
  return document.getElementById('modalRoot');
}

/**
 * Open a dialog.
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.subtitle]
 * @param {string} [options.icon]
 * @param {Node|string} [options.body]
 * @param {Node[]} [options.footer]
 * @param {'narrow'|'medium'|'wide'} [options.size]
 * @param {boolean} [options.dismissable]
 * @param {Function} [options.onClose]
 * @param {Function} [options.onMount]
 */
export function openDialog(options = {}) {
  const {
    title = '', subtitle = '', icon: iconName = '', body = null, footer = [],
    size = 'medium', dismissable = true, onClose = null, onMount = null, bodyClass = '',
  } = options;

  const root = host();
  if (!root) return null;

  const overlay = el('div', { class: 'overlay' });
  const dialog = el('div', { class: `dialog ${size === 'wide' ? '' : size}`, role: 'dialog', 'aria-modal': 'true' });

  const head = el('div', { class: 'dialog-head' });
  const titleWrap = el('div', { class: 'grow' });
  const titleNode = el('div', { class: 'dialog-title' });
  if (iconName) titleNode.append(el('span', { html: icon(iconName, 19) }));
  titleNode.append(el('span', { text: title }));
  titleWrap.append(titleNode);
  if (subtitle) titleWrap.append(el('div', { class: 'dialog-sub', text: subtitle }));
  head.append(titleWrap);
  const closeBtn = el('button', { class: 'icon-btn ghost', 'data-close': true, html: icon('x', 16), title: 'Close (Esc)', onclick: () => close() });
  head.append(closeBtn);

  const bodyNode = el('div', { class: `dialog-body ${bodyClass}` });
  if (typeof body === 'string') bodyNode.innerHTML = body;
  else if (body) bodyNode.append(body);

  dialog.append(head, bodyNode);
  if (footer && footer.length) {
    const foot = el('div', { class: 'dialog-foot' });
    footer.forEach((node) => foot.append(node));
    dialog.append(foot);
  }
  overlay.append(dialog);
  root.append(overlay);
  root.classList.add('active');

  const releaseFocus = trapFocus(dialog);
  const entry = { overlay, dialog, onClose, releaseFocus, dismissable };
  stack.push(entry);

  const onKey = (event) => {
    if (stack[stack.length - 1] !== entry) return;
    if (event.key === 'Escape' && dismissable) {
      event.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  entry.onKey = onKey;

  if (dismissable) {
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) close();
    });
  }

  function close(result) {
    const index = stack.indexOf(entry);
    if (index === -1) return;
    stack.splice(index, 1);
    document.removeEventListener('keydown', onKey, true);
    releaseFocus();
    overlay.style.animation = 'fade-out 160ms var(--ease) forwards';
    setTimeout(() => {
      overlay.remove();
      if (!stack.length) root.classList.remove('active');
    }, 150);
    onClose?.(result);
  }

  setTimeout(() => {
    const focusTarget = dialog.querySelector('[data-autofocus]') || dialog.querySelector('input, textarea, select, button');
    focusTarget?.focus();
    onMount?.({ close, dialog, body: bodyNode });
  }, 30);

  return { close, dialog, body: bodyNode };
}

export function closeTop(result) {
  const entry = stack[stack.length - 1];
  if (!entry) return false;
  const button = entry.overlay.querySelector('[data-close]');
  if (button) button.click();
  else entry.close?.(result);
  return true;
}

export function dialogsOpen() {
  return stack.length;
}

/** Yes/No dialog resolving to a boolean. */
export function confirmDialog({ title = '', text = '', okText = 'OK', cancelText = 'Cancel', danger = false, details = '' }) {
  return new Promise((resolve) => {
    const body = el('div', { class: 'col' });
    body.append(el('p', { class: 'dim', text }));
    if (details) {
      body.append(el('div', { class: 'approval-preview', text: details }));
    }
    let settled = false;
    const handle = openDialog({
      title,
      icon: danger ? 'alert' : 'question',
      size: 'narrow',
      body,
      onClose: () => {
        if (!settled) resolve(false);
      },
      footer: [
        el('div', { class: 'spacer' }),
        el('button', {
          class: 'btn',
          text: cancelText,
          onclick: () => {
            settled = true;
            handle.close(false);
            resolve(false);
          },
        }),
        el('button', {
          class: `btn ${danger ? 'danger' : 'accent'}`,
          text: okText,
          'data-autofocus': true,
          onclick: () => {
            settled = true;
            handle.close(true);
            resolve(true);
          },
        }),
      ],
    });
  });
}

/** Text input dialog resolving to a string (or null when cancelled). */
export function promptDialog({ title = '', label = '', value = '', placeholder = '', okText = 'OK', multiline = false, hint = '' }) {
  return new Promise((resolve) => {
    const input = multiline
      ? el('textarea', { class: 'input-t', placeholder, 'data-autofocus': true })
      : el('input', { class: 'input-t', type: 'text', value, placeholder, 'data-autofocus': true });
    if (multiline) input.value = value;
    const body = el('div', { class: 'col' });
    if (label) body.append(el('div', { class: 'label', text: label }));
    body.append(input);
    if (hint) body.append(el('div', { class: 'hint', text: hint }));
    let settled = false;
    const submit = () => {
      settled = true;
      handle.close();
      resolve(input.value);
    };
    const handle = openDialog({
      title,
      icon: 'pencil',
      size: 'narrow',
      body,
      onClose: () => {
        if (!settled) resolve(null);
      },
      footer: [
        el('div', { class: 'spacer' }),
        el('button', {
          class: 'btn',
          text: 'Cancel',
          onclick: () => {
            settled = true;
            handle.close();
            resolve(null);
          },
        }),
        el('button', { class: 'btn accent', text: okText, onclick: submit }),
      ],
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (!multiline || event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submit();
      }
    });
  });
}
