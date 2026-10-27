/**
 * Inline SVG icon set (no external icon fonts, works offline).
 * Every icon is a 24x24 stroke path so it inherits currentColor.
 */

const P = {
  chat: '<path d="M21 12a8 8 0 0 1-8 8H8l-4 3v-5.5A8 8 0 1 1 21 12z"/>',
  wand: '<path d="M5 19L16 8M14 4l1 2.5L17.5 8 15 9l-1 2.5L13 9l-2.5-1L13 6.5zM19 13l.7 1.8L21.5 15l-1.8.7L19 17.5l-.7-1.8L16.5 15l1.8-.7zM8 3l.6 1.4L10 5l-1.4.6L8 7l-.6-1.4L6 5l1.4-.6z"/>',
  rocket: '<path d="M13.5 4.5c3-3 7-2.5 7-2.5s.5 4-2.5 7l-3.2 3.2-4-4zM10.8 12.2L6 13l-2 4 3-1 1 3 4-2 .8-4.8M8 16l-3 3"/>',
  code: '<path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  trash: '<path d="M4 7h16M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7M10 11v6M14 11v6"/>',
  pencil: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M14.5 6.5l3 3"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.4"/><path d="M6 15H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2a2 2 0 0 1 1.5.7l1 1.2a2 2 0 0 0 1.5.7h5.8A2.5 2.5 0 0 1 21 10v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17z"/>',
  folderOpen: '<path d="M3 8V6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h7A1.5 1.5 0 0 1 19 9v1.5M3 8h18l-2 9.5a1.5 1.5 0 0 1-1.5 1.2h-13A1.5 1.5 0 0 1 3 17.5z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  fileCode: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M10 13l-2 2 2 2M14 13l2 2-2 2"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2.4"/><rect x="9.5" y="9.5" width="5" height="5" rx="1.2"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  cloud: '<path d="M7 18a4.5 4.5 0 0 1-.4-9A6 6 0 0 1 18 9.6 3.7 3.7 0 0 1 17.5 18z"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  download: '<path d="M12 4v11M7.5 11l4.5 4.5 4.5-4.5M5 20h14"/>',
  upload: '<path d="M12 19V8M7.5 12L12 7.5 16.5 12M5 4h14"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M19.6 14.2a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3.6a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3.6a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.8 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.3a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.5 1z"/>',
  palette: '<path d="M12 21a9 9 0 1 1 9-9c0 1.7-1.3 3-3 3h-1.6a2 2 0 0 0-1.4 3.4c.4.4.6.9.6 1.4A2.2 2.2 0 0 1 12 21z"/><circle cx="8" cy="10" r="1.2"/><circle cx="12" cy="7.5" r="1.2"/><circle cx="16" cy="10" r="1.2"/>',
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.4"/>',
  pause: '<rect x="7" y="5.5" width="3.6" height="13" rx="1.4"/><rect x="13.4" y="5.5" width="3.6" height="13" rx="1.4"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  pin: '<path d="M9 3h6l-1 6 4 3v2H6v-2l4-3-1-6zM12 14v7"/>',
  export: '<path d="M12 3v12M8 7l4-4 4 4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.6v.8"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4.5M12 17.4v.6"/>',
  shield: '<path d="M12 3l7.5 3v6c0 4.4-3.1 8.2-7.5 9.4C7.6 20.2 4.5 16.4 4.5 12V6z"/><path d="M9.2 12.2l2 2 3.6-3.8"/>',
  key: '<circle cx="8" cy="14" r="4"/><path d="M11 11.5L20 3M17 6l2 2M14.5 8.5l2 2"/>',
  gauge: '<path d="M4 18a9 9 0 1 1 16 0"/><path d="M12 14l4-4"/><circle cx="12" cy="15" r="1.6"/>',
  bell: '<path d="M18 15V10a6 6 0 1 0-12 0v5l-2 3h16zM10 21h4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
  brush: '<path d="M4 20c2 0 3-1 3-3 0-1.5 1-2.5 2.5-2.5S12 15.5 12 17M14.5 3.5l6 6-8 8-6-6z"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.4"/><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M8 14h8"/>',
  database: '<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>',
  link: '<path d="M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 1 0-5.7-5.7l-1 1"/><path d="M14 10.5a4 4 0 0 0-5.7 0L5.5 13.3a4 4 0 1 0 5.7 5.7l1-1"/>',
  git: '<circle cx="7" cy="6" r="2.4"/><circle cx="7" cy="18" r="2.4"/><circle cx="17" cy="9" r="2.4"/><path d="M7 8.4v7.2M17 11.4c0 3-3.2 3.6-5.6 4.2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.5l3.5 2"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  more: '<circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2.4"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/>',
  zap: '<path d="M13 2L5 13.5h6L11 22l8-11.5h-6z"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H19v3H6.5A2.5 2.5 0 0 1 4 20.5z"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5M3 17l9 5 9-5" opacity=".55"/>',
  filter: '<path d="M4 5h16l-6.2 7.4V19L10.2 21v-8.6z"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  undo: '<path d="M4 9h11a5 5 0 0 1 0 10H9M4 9l4-4M4 9l4 4"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  send: '<path d="M5 12h13M12 5l7 7-7 7"/>',
  attach: '<path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.4 3.4 0 0 1 4.8 4.8L9.6 17.4a1.8 1.8 0 0 1-2.5-2.5l7.8-7.8"/>',
  slash: '<path d="M14 4l-4 16"/>',
  brain: '<path d="M9 4.5A3 3 0 0 0 6 7.5a2.6 2.6 0 0 0-1.5 4.6A3 3 0 0 0 6 17.5 3 3 0 0 0 9 20.5c1.5 0 3-1 3-2.5V6.5c0-1.3-1.4-2-3-2z"/><path d="M15 4.5A3 3 0 0 1 18 7.5a2.6 2.6 0 0 1 1.5 4.6A3 3 0 0 1 18 17.5a3 3 0 0 1-3 3c-1.5 0-3-1-3-2.5"/>' ,
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  edit: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z"/>',
  branch: '<circle cx="7" cy="6" r="2.4"/><circle cx="7" cy="18" r="2.4"/><circle cx="17" cy="12" r="2.4"/><path d="M7 8.4v7.2M9.4 12H14.6M15.6 10.4L9.4 7M15.6 13.6L9.4 17"/>',
  diff: '<path d="M6 3v12M6 21v-3M18 9v12M18 3v3"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="6" r="2.4"/><path d="M9 12h6" opacity=".5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3.5 9h17M3.5 15h17M12 3a15 15 0 0 1 0 18A15 15 0 0 1 12 3z"/>',
  monitor: '<rect x="2.5" y="4" width="19" height="12.5" rx="2.4"/><path d="M8.5 20.5h7M12 16.5v4"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 4.5V9H8"/><path d="M12 7.5V12l3 2"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/>',
  bot: '<rect x="4" y="7" width="16" height="12" rx="3.4"/><path d="M12 3v4M8.5 12.5v1.6M15.5 12.5v1.6M9.5 16.5h5"/><path d="M2 12v3M22 12v3"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4A2.5 2.5 0 0 1 14.5 10c0 1.7-2.5 2-2.5 3.8M12 17.2v.5"/>',
  flag: '<path d="M5 21V4M5 5h11l-1.6 3.4L16 12H5"/>',
  star: '<path d="M12 3.5l2.7 5.6 6.1.9-4.4 4.3 1 6.2-5.4-2.9-5.4 2.9 1-6.2L3.2 10l6.1-.9z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  eyeOff: '<path d="M3 3l18 18M10.5 6.2A9.7 9.7 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3.3 4M6.4 8.2A16.6 16.6 0 0 0 2.5 12S6 18 12 18a9.6 9.6 0 0 0 3.6-.7"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  drag: '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
  telegram: '<path d="M21 4.5L2.8 11.3l5.2 1.8 1.6 5.4 2.6-3 4.4 3.3z"/><path d="M8 13.1L18 6l-7.6 8.4"/>',
  github: '<path d="M9 19c-4 1.4-4-2.2-5.6-2.8M15 21v-3.4a3 3 0 0 0-.8-2.3c2.7-.3 5.5-1.3 5.5-6a4.7 4.7 0 0 0-1.3-3.3 4.4 4.4 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6 0C6.5 2.5 5.4 2.8 5.4 2.8a4.4 4.4 0 0 0-.1 3.2A4.7 4.7 0 0 0 4 9.3c0 4.6 2.8 5.7 5.5 6a3 3 0 0 0-.8 2.2V21"/>',
  box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
  wrench: '<path d="M20 6.5a5 5 0 0 1-6.6 6.6L7 19.5a2.1 2.1 0 0 1-3-3l6.4-6.4A5 5 0 0 1 17 3.5l-3 3 1.5 3 3-3z"/>',
  eyeSmall: '<path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>',
};

export const ICON_NAMES = Object.keys(P);

/**
 * Build an SVG icon string.
 * @param {string} name icon key
 * @param {number} [size] px size (default 16)
 * @param {number} [width] stroke width
 */
export function icon(name, size = 16, width = 1.9) {
  const body = P[name] || P.info;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/** Mode icons mapping used by the topbar and cards. */
export const MODE_ICONS = {
  chat: 'chat',
  assistant: 'wand',
  autopilot: 'rocket',
  code: 'code',
  terminal: 'terminal',
  analyst: 'search',
};

/** Tool icons mapping used by tool cards / activity feed. */
export const TOOL_ICONS = {
  run_command: 'terminal',
  python_run: 'cpu',
  read_file: 'eyeSmall',
  write_file: 'save',
  edit_file: 'edit',
  delete_path: 'trash',
  create_dir: 'folder',
  move_path: 'drag',
  copy_path: 'copy',
  list_dir: 'list',
  file_info: 'info',
  search_files: 'search',
  workspace_tree: 'layers',
  web_fetch: 'globe',
  ask_user: 'question',
  remember: 'book',
  update_plan: 'flag',
};

export function toolIcon(name) {
  return TOOL_ICONS[name] || 'wrench';
}
