/** REST client for the local DAGENT server. */

const boot = (typeof window !== 'undefined' && window.DAGENT_BOOT) || {};
export const TOKEN = boot.token || '';

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data || {};
  }
}

function headers(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'X-DAGENT-Token': TOKEN,
    ...extra,
  };
}

async function request(method, path, body, options = {}) {
  const init = { method, headers: headers(options.headers), cache: 'no-store' };
  if (body !== undefined && body !== null) {
    init.body = body instanceof FormData ? body : JSON.stringify(body);
    if (body instanceof FormData) delete init.headers['Content-Type'];
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    throw new ApiError('Network error: ' + error.message, 0, {});
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = { raw: text };
    }
  }
  if (!response.ok) {
    const message = (data && (data.detail || data.error || data.message)) || `HTTP ${response.status}`;
    throw new ApiError(typeof message === 'string' ? message : JSON.stringify(message), response.status, data || {});
  }
  return data;
}

export const api = {
  get: (path, options) => request('GET', path, null, options),
  post: (path, body, options) => request('POST', path, body ?? {}, options),
  put: (path, body, options) => request('PUT', path, body ?? {}, options),
  patch: (path, body, options) => request('PATCH', path, body ?? {}, options),
  del: (path, options) => request('DELETE', path, null, options),
  raw: request,

  // ---- bootstrap & settings
  state: () => request('GET', '/api/state'),
  health: () => request('GET', '/api/health'),
  getSettings: () => request('GET', '/api/settings'),
  saveSettings: (patch) => request('PUT', '/api/settings', patch),
  resetSettings: (keepModels = true) => request('POST', '/api/settings/reset', { keep_models: keepModels }),
  importSettings: (settings) => request('POST', '/api/settings/import', { settings }),
  audit: (limit = 200) => request('GET', `/api/audit?limit=${limit}`),
  searchAll: (q, limit = 60) => request('GET', `/api/search?q=${encodeURIComponent(q)}&limit=${limit}`),

  // ---- workspace & files
  workspace: () => request('GET', '/api/workspace'),
  setWorkspace: (root) => request('POST', '/api/workspace', { root }),
  workspaceTree: (depth = 3) => request('GET', `/api/workspace/tree?depth=${depth}`),
  browse: (path = '', showHidden = false) => request('GET', `/api/fs/browse?path=${encodeURIComponent(path)}&show_hidden=${showHidden}`),
  readFile: (path) => request('GET', `/api/fs/file?path=${encodeURIComponent(path)}`),
  openPath: (path) => request('GET', `/api/fs/open?path=${encodeURIComponent(path)}`),
  scanGguf: (dirs = [], recursive = true, saveDirs = false) =>
    request('POST', '/api/models/gguf/scan', { dirs, recursive, save_dirs: saveDirs }),
  ggufStatus: () => request('GET', '/api/models/gguf/status'),

  // ---- models
  models: () => request('GET', '/api/models'),
  createModel: (payload) => request('POST', '/api/models', payload),
  updateModel: (id, payload) => request('PUT', `/api/models/${id}`, payload),
  deleteModel: (id) => request('DELETE', `/api/models/${id}`),
  duplicateModel: (id) => request('POST', `/api/models/${id}/duplicate`),
  activateModel: (id, sessionId = '') => request('POST', `/api/models/${id}/activate`, { session_id: sessionId }),
  testModel: (id, apiKey = '') => request('POST', `/api/models/${id}/test`, { api_key: apiKey }),
  probeModel: (payload) => request('POST', '/api/models/probe', payload),
  remoteModels: (id) => request('GET', `/api/models/${id}/remote`),
  preloadGguf: (id) => request('POST', '/api/models/gguf/preload', { profile_id: id }),
  unloadGguf: () => request('POST', '/api/models/gguf/unload'),

  // ---- sessions
  sessions: (q = '') => request('GET', `/api/sessions?q=${encodeURIComponent(q)}`),
  createSession: (payload = {}) => request('POST', '/api/sessions', payload),
  session: (id) => request('GET', `/api/sessions/${id}`),
  patchSession: (id, payload) => request('PATCH', `/api/sessions/${id}`, payload),
  deleteSession: (id) => request('DELETE', `/api/sessions/${id}`),
  duplicateSession: (id) => request('POST', `/api/sessions/${id}/duplicate`),
  clearSession: (id) => request('POST', `/api/sessions/${id}/clear`),
  exportSessionUrl: (id, fmt = 'json') => `/api/sessions/${id}/export?fmt=${fmt}&token=${encodeURIComponent(TOKEN)}`,
  importSession: (data) => request('POST', '/api/sessions/import', { data }),
  summarizeSession: (id) => request('POST', `/api/summarize-session/${id}`),

  // ---- chat
  chat: (payload) => request('POST', '/api/chat', payload),
  stopRun: (runId) => request('POST', `/api/runs/${runId}/stop`),
  stopAll: () => request('POST', '/api/runs/stop-all'),
  runs: () => request('GET', '/api/runs'),
  runEvents: (runId, since = 0, wait = 25) => request('GET', `/api/runs/${runId}/events?since=${since}&wait=${wait}`),
  editMessage: (id, content, rerun = false) => request('PATCH', `/api/messages/${id}`, { content, rerun }),
  deleteMessage: (id, cascade = false) => request('DELETE', `/api/messages/${id}?cascade=${cascade}`),
  regenerate: (id) => request('POST', `/api/messages/${id}/regenerate`),
  retryLast: (sessionId) => request('POST', `/api/sessions/${sessionId}/retry-last`),
  resolve: (callId, decision) => request('POST', `/api/interactions/${callId}`, decision),
  interactions: () => request('GET', '/api/interactions'),
  quickTitle: (text) => request('POST', '/api/quick-title', { text }),

  // ---- terminal
  terminal: (command, cwd = '', sessionId = '') => request('POST', '/api/terminal', { command, cwd, session_id: sessionId }, { timeout: 0 }),

  // ---- misc
  modes: () => request('GET', '/api/modes'),
  upload: (file) => {
    const form = new FormData();
    form.append('file', file);
    return request('POST', '/api/attachments/upload', form);
  },
};

export const wsUrl = () => {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws?token=${encodeURIComponent(TOKEN)}`;
};
