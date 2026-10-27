/** Toast notifications (bottom-right stack). */

import { el, esc } from '../dom.js';
import { icon } from '../icons.js';

const ICONS = { ok: 'check', err: 'alert', warn: 'alert', info: 'info' };
let container = null;

function root() {
  if (!container) container = document.getElementById('toasts');
  return container;
}

/**
 * @param {string} title
 * @param {string} [text]
 * @param {'ok'|'err'|'warn'|'info'} [kind]
 * @param {Array<{label:string, onClick:Function, kind?:string}>} [actions]
 * @param {number} [timeout] ms, 0 keeps it until closed
 */
export function toast(title, text = '', kind = 'info', actions = [], timeout = 4200) {
  const host = root();
  if (!host) return null;
  const node = el('div', { class: `toast ${kind}`, role: 'status' });
  const iconWrap = el('div', { class: 't-icon', html: icon(ICONS[kind] || 'info', 14) });
  const body = el('div', { class: 't-body' });
  body.append(el('div', { class: 't-title', text: title }));
  if (text) body.append(el('div', { class: 't-text', html: esc(text).replace(/\n/g, '<br />') }));
  if (actions && actions.length) {
    const row = el('div', { class: 't-actions' });
    for (const action of actions) {
      row.append(
        el('button', {
          class: `btn tiny ${action.kind || 'ghost'}`,
          text: action.label,
          onclick: () => {
            action.onClick?.();
            close();
          },
        }),
      );
    }
    body.append(row);
  }
  const closeBtn = el('button', { class: 't-close', html: icon('x', 13), onclick: () => close(), title: 'Close' });
  node.append(iconWrap, body, closeBtn);
  host.append(node);

  let timer = null;
  function close() {
    if (timer) clearTimeout(timer);
    node.classList.add('hide');
    setTimeout(() => node.remove(), 220);
  }
  if (timeout > 0) timer = setTimeout(close, timeout);
  node.addEventListener('mouseenter', () => timer && clearTimeout(timer));
  return { close, node };
}

export const notify = {
  ok: (title, text, actions) => toast(title, text, 'ok', actions),
  error: (title, text, actions) => toast(title, text, 'err', actions, 7000),
  warn: (title, text, actions) => toast(title, text, 'warn', actions, 6000),
  info: (title, text, actions) => toast(title, text, 'info', actions),
};

export function beep(kind = 'done') {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = kind === 'done' ? 660 : 320;
    gain.gain.value = 0.045;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.28);
    osc.stop(ctx.currentTime + 0.3);
    setTimeout(() => ctx.close(), 600);
  } catch (error) {
    /* audio is a nice-to-have */
  }
}
