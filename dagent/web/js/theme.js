/** Theme & appearance engine: everything visual is applied through CSS variables. */

import { bus, state } from './state.js';

export const THEMES = [
  { id: 'midnight', label: 'Midnight', scheme: 'dark', colors: ['#0b0e17', '#7c5cff', '#34d3ff'] },
  { id: 'obsidian', label: 'Obsidian', scheme: 'dark', colors: ['#0a0a0b', '#a3a3ad', '#00e0c6'] },
  { id: 'nebula', label: 'Nebula', scheme: 'dark', colors: ['#100a1c', '#b14bff', '#ff5ca8'] },
  { id: 'forest', label: 'Forest', scheme: 'dark', colors: ['#08120f', '#21c07a', '#7ce0ff'] },
  { id: 'nord', label: 'Nord', scheme: 'dark', colors: ['#22272e', '#88c0d0', '#a3be8c'] },
  { id: 'daylight', label: 'Daylight', scheme: 'light', colors: ['#f4f6fb', '#4ea1ff', '#7c5cff'] },
  { id: 'paper', label: 'Paper', scheme: 'light', colors: ['#faf6ef', '#c48434', '#7a9b76'] },
];

export const ACCENTS = [
  { id: 'violet', color: '#7c5cff', label: 'Violet' },
  { id: 'blue', color: '#4ea1ff', label: 'Blue' },
  { id: 'cyan', color: '#00c2a8', label: 'Cyan' },
  { id: 'green', color: '#35d07f', label: 'Green' },
  { id: 'amber', color: '#f5b942', label: 'Amber' },
  { id: 'orange', color: '#ff7a45', label: 'Orange' },
  { id: 'pink', color: '#ff5c9e', label: 'Pink' },
  { id: 'red', color: '#ff4d5e', label: 'Red' },
];

export const FONTS = [
  { id: 'system', label: 'System', value: 'var(--font)' },
  { id: 'inter', label: 'Inter / SF', value: '"Inter","SF Pro Text",-apple-system,"Segoe UI",Roboto,sans-serif' },
  { id: 'georgia', label: 'Georgia (serif)', value: 'Georgia,"Times New Roman",serif' },
  { id: 'mono', label: 'Monospace', value: '"JetBrains Mono",ui-monospace,Menlo,Consolas,monospace' },
];

export const MONO_FONTS = [
  { id: 'mono', label: 'Default mono', value: '"JetBrains Mono","SF Mono","Cascadia Code",ui-monospace,Menlo,Consolas,monospace' },
  { id: 'jetbrains', label: 'JetBrains Mono', value: '"JetBrains Mono",ui-monospace,monospace' },
  { id: 'fira', label: 'Fira Code', value: '"Fira Code",ui-monospace,monospace' },
  { id: 'cascadia', label: 'Cascadia', value: '"Cascadia Code",Consolas,monospace' },
  { id: 'consolas', label: 'Consolas', value: 'Consolas,"Courier New",monospace' },
];

export const FX = [
  { id: 'aurora', labelKey: 'settings.fx.aurora' },
  { id: 'waves', labelKey: 'settings.fx.waves' },
  { id: 'grid', labelKey: 'settings.fx.grid' },
  { id: 'stars', labelKey: 'settings.fx.stars' },
  { id: 'none', labelKey: 'settings.fx.none' },
];

let customStyleEl = null;
let starsTimer = null;

export function themeById(id) {
  return THEMES.find((theme) => theme.id === id) || THEMES[0];
}

export function accentById(id) {
  return ACCENTS.find((accent) => accent.id === id) || null;
}

/** Apply every appearance setting to <html> / custom properties. */
export function applyAppearance(settings) {
  const ui = settings?.ui || {};
  const root = document.documentElement;

  const theme = themeById(ui.theme || 'midnight');
  root.dataset.theme = theme.id;
  root.dataset.scheme = theme.scheme;

  const accent = ui.accent || '#7c5cff';
  if (accent.startsWith('#')) {
    root.dataset.accent = 'custom';
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-2', shiftHue(accent, 38));
    root.style.setProperty('--accent-soft', hexToRgba(accent, 0.16));
    root.style.setProperty('--accent-border', hexToRgba(accent, 0.42));
    root.style.setProperty('--on-accent', readableOn(accent));
  } else {
    root.dataset.accent = accent;
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-2');
    root.style.removeProperty('--accent-soft');
    root.style.removeProperty('--accent-border');
  }

  root.dataset.density = ui.density || 'comfortable';
  root.dataset.anim = ui.animations === false ? 'off' : 'on';
  root.dataset.fx = ui.background_fx || 'aurora';
  root.dataset.blur = ui.blur === false ? 'off' : 'on';
  root.dataset.codewrap = ui.code_wrap ? 'on' : 'off';

  root.style.setProperty('--fs', `${Number(ui.font_size || 14.5)}px`);
  root.style.setProperty('--radius', `${Number(ui.corner_radius ?? 14)}px`);
  root.style.setProperty('--radius-sm', `${Math.max(4, Number(ui.corner_radius ?? 14) - 4)}px`);
  root.style.setProperty('--radius-lg', `${Number(ui.corner_radius ?? 14) + 6}px`);
  root.style.setProperty('--content-w', `${Number(ui.content_width || 860)}px`);
  root.style.setProperty('--msg-gap', `${Number(ui.message_spacing || 18)}px`);

  const font = FONTS.find((item) => item.id === ui.font_family);
  if (font && font.id !== 'system') root.style.setProperty('--font', font.value);
  else root.style.removeProperty('--font');
  const mono = MONO_FONTS.find((item) => item.id === ui.mono_font);
  if (mono && mono.id !== 'mono') root.style.setProperty('--mono', mono.value);
  else root.style.removeProperty('--mono');

  applyCustomCss(ui.custom_css || '');
  manageStars(root.dataset.fx === 'stars' && ui.animations !== false);
  document.body.style.opacity = '1';
  bus.emit('theme:applied', { theme, accent });
}

export function applyCustomCss(css) {
  if (!customStyleEl) {
    customStyleEl = document.createElement('style');
    customStyleEl.id = 'dagent-custom-css';
    document.head.append(customStyleEl);
  }
  customStyleEl.textContent = css || '';
}

/* ------------------------------ colour utils ------------------------------ */

export function hexToRgba(hex, alpha = 1) {
  const value = String(hex || '').replace('#', '').trim();
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) return `rgba(124,92,255,${alpha})`;
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

export function shiftHue(hex, degrees) {
  const value = String(hex || '').replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) return hex;
  let [h, s, l] = rgbToHsl((num >> 16) & 255, (num >> 8) & 255, num & 255);
  h = (h + degrees / 360) % 1;
  if (h < 0) h += 1;
  const [r, g, b] = hslToRgb(h, Math.min(1, s * 1.05), l);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

export function readableOn(hex) {
  const value = String(hex || '').replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) return '#fff';
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? '#10131c' : '#ffffff';
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p, q, t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

/* ------------------------------ starfield FX ------------------------------ */

export function manageStars(enabled) {
  const canvas = document.getElementById('bgCanvas');
  if (!canvas) return;
  if (!enabled) {
    if (starsTimer) cancelAnimationFrame(starsTimer);
    starsTimer = null;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  if (starsTimer) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  let stars = [];
  const resize = () => {
    canvas.width = window.innerWidth * devicePixelRatio;
    canvas.height = window.innerHeight * devicePixelRatio;
    const count = Math.min(160, Math.round((window.innerWidth * window.innerHeight) / 12000));
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 1.6 * devicePixelRatio + 0.3,
      a: Math.random(),
      s: Math.random() * 0.012 + 0.002,
      d: Math.random() > 0.5 ? 1 : -1,
    }));
  };
  resize();
  window.addEventListener('resize', resize);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#7c5cff';
  const draw = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const star of stars) {
      star.a += star.s * star.d;
      if (star.a > 1 || star.a < 0.05) star.d *= -1;
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(accent.startsWith('#') ? accent : '#8ea2ff', Math.max(0.05, star.a) * 0.55);
      ctx.fill();
    }
    starsTimer = requestAnimationFrame(draw);
  };
  draw();
}

/** Re-apply appearance from the live settings object (call after any ui.* change). */
export function refresh(settings) {
  applyAppearance(settings || state.settings);
}

export function init(settings) {
  applyAppearance(settings);
}
