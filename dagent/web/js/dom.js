/** Small DOM + formatting helpers used across the interface. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  appendChildren(node, children);
  return node;
}

export function appendChildren(node, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false || child === '') continue;
    if (Array.isArray(child)) appendChildren(node, child);
    else node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function on(node, event, handler, options) {
  if (!node) return () => {};
  node.addEventListener(event, handler, options);
  return () => node.removeEventListener(event, handler, options);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function debounce(fn, wait = 220) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function throttle(fn, wait = 120) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const now = Date.now();
    const rest = wait - (now - last);
    if (rest <= 0) {
      last = now;
      fn(...args);
    } else {
      clearTimeout(timer);
      timer = setTimeout(() => {
        last = Date.now();
        fn(...args);
      }, rest);
    }
  };
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

/* ------------------------------ formatting ------------------------------ */

export function humanSize(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(Number(bytes))) return '';
  let size = Number(bytes);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}

export function humanDuration(ms) {
  if (!ms && ms !== 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function fmtTime(ts) {
  if (!ts) return '';
  const date = new Date(ts > 1e12 ? ts : ts * 1000);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function fmtDate(ts) {
  if (!ts) return '';
  const date = new Date(ts > 1e12 ? ts : ts * 1000);
  return date.toLocaleDateString([], { day: '2-digit', month: 'short' });
}

export function timeAgo(ts, labels = { just: 'just now', min: 'min', hour: 'h', day: 'd' }) {
  if (!ts) return '';
  const date = new Date(ts > 1e12 ? ts : ts * 1000);
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return labels.just;
  if (diff < 3600) return `${Math.floor(diff / 60)} ${labels.min}`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} ${labels.hour}`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} ${labels.day}`;
  return fmtDate(ts);
}

export function dayGroup(ts, labels = { today: 'Today', yesterday: 'Yesterday', week: 'Previous 7 days', older: 'Older' }) {
  const date = new Date(ts > 1e12 ? ts : ts * 1000);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const value = date.getTime();
  if (value >= startOfToday) return labels.today;
  if (value >= startOfToday - 86400000) return labels.yesterday;
  if (value >= startOfToday - 7 * 86400000) return labels.week;
  return labels.older;
}

export function truncate(text, limit = 80) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

export function baseName(path) {
  const value = String(path || '').replace(/\\/g, '/');
  return value.split('/').filter(Boolean).pop() || value;
}

/* ------------------------------ clipboard ------------------------------ */

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch (error) {
    return false;
  }
}

export function downloadFile(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ------------------------------ scroll ------------------------------ */

export function isNearBottom(node, threshold = 90) {
  if (!node) return true;
  return node.scrollHeight - node.scrollTop - node.clientHeight < threshold;
}

export function scrollToBottom(node, behavior = 'smooth') {
  if (!node) return;
  if (typeof node.scrollTo === 'function') node.scrollTo({ top: node.scrollHeight, behavior });
  else node.scrollTop = node.scrollHeight;
}

/** Animate a number inside an element (used for token counters). */
export function animateNumber(node, to, duration = 420) {
  const from = Number(String(node.textContent).replace(/[^\d.]/g, '')) || 0;
  if (from === to) {
    node.textContent = String(to);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    node.textContent = String(Math.round(from + (to - from) * eased));
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Trap Tab focus inside a container (modals). */
export function trapFocus(container) {
  const selector = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';
  const handler = (event) => {
    if (event.key !== 'Tab') return;
    const items = Array.from(container.querySelectorAll(selector)).filter((node) => node.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  container.addEventListener('keydown', handler);
  return () => container.removeEventListener('keydown', handler);
}
