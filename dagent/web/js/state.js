/**
 * Central app state + a tiny event bus.
 * Modules read from `state` and listen to bus events instead of talking to each other.
 */

import { api } from './api.js';

class Emitter {
  constructor() {
    this.listeners = new Map();
  }

  on(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
    return () => this.listeners.get(name)?.delete(fn);
  }

  emit(name, ...args) {
    const set = this.listeners.get(name);
    if (set) {
      set.forEach((fn) => {
        try { fn(...args); } catch (error) { console.error(`[DAGENT] listener "${name}" failed`, error); }
      });
    }
    const wildcard = this.listeners.get('*');
    if (wildcard) wildcard.forEach((fn) => fn({ name, payload: args[0] }));
  }
}

export const bus = new Emitter();

export const state = {
  booted: false,
  version: '',
  author: 'frizovdanya',
  authorTg: 'https://t.me/frizovdanya',

  settings: {},
  defaults: {},
  modes: [],
  tools: [],
  providers: {},
  system: {},
  workspace: {},
  info: {},

  models: [],
  activeModel: null,

  sessions: [],
  currentSessionId: null,
  messages: [],

  run: null,                 // current run state from the server
  streaming: null,           // { text, reasoning, toolCalls, startedAt }
  pending: [],               // approvals / questions waiting for the user

  plan: [],
  activity: [],
  changedFiles: [],
  context: null,

  attachments: [],

  ui: {
    sidebarCollapsed: false,
    monitorOpen: true,
    monitorTab: 'activity',
    paletteOpen: false,
    settingsOpen: false,
    settingsTab: 'models',
    onboarding: false,
    themeName: 'midnight',
    connected: false,
    sessionFilter: '',
    terminalHistory: [],
    terminalIndex: -1,
  },
};

/* ------------------------------ helpers ------------------------------ */

export function get(key, fallback) {
  return key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), state) ?? fallback;
}

export function setting(key, fallback) {
  return key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), state.settings) ?? fallback;
}

export function setSetting(key, value, save = true) {
  const parts = key.split('.');
  let node = state.settings;
  for (const part of parts.slice(0, -1)) {
    if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
    node = node[part];
  }
  node[parts[parts.length - 1]] = value;
  bus.emit('settings:changed', { key, value });
  if (save) {
    const patch = {};
    let target = patch;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) target[part] = value;
      else {
        target[part] = {};
        target = target[part];
      }
    });
    return api.saveSettings(patch).catch((error) => {
      console.error('[DAGENT] settings save failed', error);
      bus.emit('error', error);
    });
  }
  return Promise.resolve();
}

export function currentSession() {
  return state.sessions.find((item) => item.id === state.currentSessionId) || null;
}

export function currentMode() {
  const session = currentSession();
  const id = (session && session.mode) || setting('agent.mode', 'assistant');
  return state.modes.find((mode) => mode.id === id) || state.modes[0] || { id: 'assistant' };
}

export function modelById(id) {
  return state.models.find((model) => model.id === id) || null;
}

export function activeModelName() {
  const model = state.activeModel;
  if (!model) return '';
  return model.name || model.model || 'model';
}

export function isRunning() {
  return Boolean(state.run && ['running', 'waiting'].includes(state.run.status));
}

export function pushActivity(entry) {
  state.activity.unshift({ id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, at: Date.now(), ...entry });
  if (state.activity.length > 400) state.activity.length = 400;
  bus.emit('activity', entry);
}

export function resetRunUi() {
  state.streaming = null;
  state.plan = [];
  state.changedFiles = [];
  state.context = null;
  bus.emit('run:reset');
}

/** Load (or reload) the whole bootstrap document into the state. */
export async function loadBootstrap() {
  const data = await api.state();
  state.version = data.version;
  state.settings = data.settings || {};
  state.defaults = data.defaults || {};
  state.modes = data.modes || [];
  state.tools = data.tools || [];
  state.providers = data.providers || {};
  state.system = data.system || {};
  state.workspace = data.workspace || {};
  state.info = data.info || {};
  state.models = data.models || [];
  state.activeModel = data.active_model || null;
  state.sessions = data.sessions || [];
  state.pending = data.pending || [];
  state.ui.monitorOpen = Boolean(setting('ui.show_monitor', true));
  state.ui.sidebarCollapsed = Boolean(setting('ui.sidebar_collapsed', false));
  state.ui.monitorTab = setting('ui.monitor_tab', 'activity');
  state.booted = true;
  bus.emit('boot', data);
  return data;
}

export async function loadSession(sessionId) {
  if (!sessionId) {
    state.currentSessionId = null;
    state.messages = [];
    bus.emit('session:loaded', null);
    return null;
  }
  const data = await api.session(sessionId);
  state.currentSessionId = sessionId;
  state.messages = data.messages || [];
  const index = state.sessions.findIndex((item) => item.id === sessionId);
  if (index >= 0) state.sessions[index] = data.session;
  else if (data.session) state.sessions.unshift(data.session);
  state.plan = (data.session?.meta || {}).plan || [];
  state.run = data.run || null;
  bus.emit('session:loaded', data);
  return data;
}

export async function refreshSessions(query = '') {
  const data = await api.sessions(query);
  state.sessions = data.sessions || [];
  bus.emit('sessions:loaded', state.sessions);
  return state.sessions;
}

export async function refreshModels() {
  const data = await api.models();
  state.models = data.profiles || [];
  state.activeModel = state.models.find((item) => item.id === data.active_id) || state.models[0] || null;
  state.providers = data.status || state.providers;
  bus.emit('models:loaded', state.models);
  return state.models;
}
