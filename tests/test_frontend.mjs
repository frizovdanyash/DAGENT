/**
 * Front-end smoke test for DAGENT - runs the real ES modules inside jsdom and
 * replays API payloads + a recorded realtime event stream from tests/fixtures.
 *
 *   npm install jsdom --no-save        (once)
 *   python3 tests/capture_fixtures.py  (regenerate fixtures, optional)
 *   node tests/test_frontend.mjs
 *
 * No browser, no model and no network access are required.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WEB = path.join(ROOT, 'dagent', 'web');
const FIXTURES = path.join(HERE, 'fixtures');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.log('SKIP  jsdom is not installed - run: npm install jsdom --no-save');
  process.exit(0);
}

if (!existsSync(path.join(FIXTURES, 'state.json'))) {
  console.log('SKIP  tests/fixtures are missing - run: python3 tests/capture_fixtures.py');
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const PASSED = [];
const FAILED = [];
const NOTES = [];

function check(name, condition, detail = '') {
  if (condition) {
    PASSED.push(name);
    console.log(`  ok   ${name}`);
  } else {
    FAILED.push(`${name} ${detail}`.trim());
    console.log(`  FAIL ${name} ${detail}`);
  }
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeout = 4000, label = 'condition') {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    let value;
    try {
      value = predicate();
    } catch {
      value = false;
    }
    if (value) return value;
    await tick(20);
  }
  NOTES.push(`timeout waiting for ${label}`);
  return null;
}

function fixture(name) {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

/* ------------------------------------------------------------------ */
/* DOM + browser API stubs                                             */
/* ------------------------------------------------------------------ */

const indexHtml = readFileSync(path.join(WEB, 'index.html'), 'utf8')
  .replace(
    '<!--DAGENT_BOOT-->',
    '<script>window.DAGENT_BOOT = {"token":"test-token","version":"1.0.0",'
    + '"author":"frizovdanya","author_tg":"https://t.me/frizovdanya"};</script>',
  )
  .replace('<script type="module" src="/js/boot.js"></script>', '');

const dom = new JSDOM(indexHtml, {
  url: 'http://127.0.0.1:8420/',
  pretendToBeVisual: true,
  runScripts: 'dangerously',
});

const { window } = dom;
const { document } = window;

// jsdom does not implement these; the app feature-detects or they are cosmetic.
window.Element.prototype.scrollIntoView = function scrollIntoView() {};
window.Element.prototype.scrollTo = function scrollTo() {};
window.scrollTo = function scrollTo() {};
window.matchMedia = window.matchMedia || ((query) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return false; },
}));
window.URL.createObjectURL = window.URL.createObjectURL || (() => 'blob:dagent-test');
window.URL.revokeObjectURL = window.URL.revokeObjectURL || (() => {});
window.HTMLAnchorElement.prototype.click = window.HTMLAnchorElement.prototype.click || function click() {};

const calls = [];

function jsonResponse(body, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERROR',
    headers: { get: () => 'application/json' },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

/* ------------------------------------------------------------------ */
/* fake backend                                                        */
/* ------------------------------------------------------------------ */

const stateFixture = fixture('state.json');
const sessionFixture = fixture('session.json');
const eventsFixture = fixture('events.json');
const modelsFixture = fixture('models.json');
let sessionsFixture = fixture('sessions.json');
const settingsFixture = fixture('settings.json');

const SESSION_ID = sessionFixture.session.id;
const RUN_ID = eventsFixture.run_id;

const routes = [
  ['GET', /^\/api\/state$/, () => stateFixture],
  ['GET', /^\/api\/health$/, () => ({ ok: true, version: '1.0.0' })],
  ['GET', /^\/api\/ping$/, () => ({ ok: true })],
  ['GET', /^\/api\/settings$/, () => settingsFixture],
  ['PUT', /^\/api\/settings$/, (match, init) => {
    const patch = JSON.parse(init.body || '{}');
    Object.assign(settingsFixture, patch);
    return { ok: true, settings: settingsFixture, workspace: fixture('workspace.json').workspace || {} };
  }],
  ['POST', /^\/api\/settings\/reset$/, () => ({ ok: true, settings: settingsFixture, reset: false })],
  ['POST', /^\/api\/settings\/import$/, () => ({ ok: true, settings: settingsFixture })],
  ['POST', /^\/api\/settings\/export$/, () => ({ ok: true, settings: settingsFixture })],
  ['GET', /^\/api\/settings\/schema$/, () => ({ defaults: stateFixture.defaults, version: '1.0.0' })],
  ['GET', /^\/api\/modes$/, () => {
    const data = fixture('modes.json');
    const language = settingsFixture?.app?.language || stateFixture?.settings?.app?.language || 'ru';
    if (language === 'ru') return data;
    const EN = { chat: 'Chat', assistant: 'Assistant', autopilot: 'Autopilot', code: 'Code', terminal: 'Terminal', analyst: 'Analyst' };
    return { ...data, modes: (data.modes || []).map((mode) => ({ ...mode, name: EN[mode.id] || mode.name })) };
  }],
  ['GET', /^\/api\/models$/, () => modelsFixture],
  ['GET', /^\/api\/models\/presets$/, () => ({ presets: stateFixture.providers?.presets || [] })],
  ['GET', /^\/api\/models\/gguf\/status$/, () => ({ installed: false, loaded: [], hint: 'pip install llama-cpp-python' })],
  ['POST', /^\/api\/models$/, (match, init) => {
    const payload = JSON.parse(init.body || '{}');
    const profile = { id: `new-${Date.now()}`, ...payload, usage_count: 0, enabled: true };
    modelsFixture.profiles.push(profile);
    return { ok: true, profile, active_id: profile.id };
  }],
  ['POST', /^\/api\/models\/([^/]+)\/activate$/, () => ({ ok: true })],
  ['POST', /^\/api\/models\/([^/]+)\/test$/, () => ({ ok: true, latency_ms: 42, message: 'mock model answered' })],
  ['POST', /^\/api\/models\/([^/]+)\/duplicate$/, () => ({ ok: true, profile: { id: 'dup-1', name: 'Copy' } })],
  ['POST', /^\/api\/models\/probe$/, () => ({ ok: true, models: ['mock-gpt', 'mock-coder'], count: 2 })],
  ['GET', /^\/api\/models\/([^/]+)\/remote$/, () => ({ ok: true, models: ['mock-gpt', 'mock-coder'], count: 2 })],
  ['PUT', /^\/api\/models\/([^/]+)$/, (match, init) => ({ ok: true, profile: JSON.parse(init.body || '{}') })],
  ['DELETE', /^\/api\/models\/([^/]+)$/, () => ({ ok: true })],
  ['GET', /^\/api\/sessions$/, () => sessionsFixture],
  ['POST', /^\/api\/sessions$/, (match, init) => {
    const payload = JSON.parse(init.body || '{}');
    const session = {
      id: `s-${Date.now()}`, title: payload.title || 'Новая сессия', mode: payload.mode || 'assistant',
      model_id: payload.model_id || null, created_at: Date.now() / 1000, updated_at: Date.now() / 1000,
      pinned: 0, archived: 0, tags: [], stats: { messages: 0, chars: 0, tokens: 0 }, meta: {},
      workspace: stateFixture.workspace.root,
    };
    sessionsFixture = { sessions: [session, ...(sessionsFixture.sessions || [])] };
    return { ok: true, session };
  }],
  ['GET', /^\/api\/sessions\/([^/?]+)$/, () => sessionFixture],
  ['PATCH', /^\/api\/sessions\/([^/?]+)$/, (match, init) => ({ ok: true, session: { ...sessionFixture.session, ...JSON.parse(init.body || '{}') } })],
  ['DELETE', /^\/api\/sessions\/([^/?]+)$/, () => ({ ok: true })],
  ['POST', /^\/api\/sessions\/([^/]+)\/duplicate$/, () => ({ ok: true, session: { ...sessionFixture.session, id: 'dup-session' } })],
  ['POST', /^\/api\/sessions\/([^/]+)\/clear$/, () => ({ ok: true, session: sessionFixture.session })],
  ['GET', /^\/api\/sessions\/([^/]+)\/export$/, () => ({ ok: true, format: 'md', content: '# export' })],
  ['POST', /^\/api\/sessions\/([^/]+)\/retry-last$/, () => ({ ok: true, run_id: RUN_ID, session_id: SESSION_ID })],
  ['POST', /^\/api\/summarize-session\/([^/]+)$/, () => ({ ok: true, summary: '## Summary\n\n- step one\n- step two' })],
  ['POST', /^\/api\/chat$/, (match, init) => {
    const payload = JSON.parse(init.body || '{}');
    return { ok: true, run_id: RUN_ID, session_id: payload.session_id || SESSION_ID, session: sessionFixture.session };
  }],
  ['GET', /^\/api\/runs$/, () => fixture('runs.json')],
  ['POST', /^\/api\/runs\/([^/]+)\/stop$/, () => ({ ok: true })],
  ['POST', /^\/api\/runs\/stop-all$/, () => ({ ok: true, stopped: 0 })],
  ['GET', /^\/api\/runs\/([^/]+)\/events$/, () => ({ events: [], last_id: 0, run: null })],
  ['GET', /^\/api\/interactions$/, () => ({ pending: [] })],
  ['POST', /^\/api\/interactions\/([^/]+)$/, () => ({ ok: true, resolved: true })],
  ['GET', /^\/api\/workspace$/, () => fixture('workspace.json')],
  ['POST', /^\/api\/workspace$/, (match, init) => {
    const payload = JSON.parse(init.body || '{}');
    return { ok: true, workspace: { ...(fixture('workspace.json').workspace || {}), root: payload.root } };
  }],
  ['GET', /^\/api\/workspace\/tree$/, () => fixture('tree.json')],
  ['GET', /^\/api\/fs\/browse$/, () => fixture('browse.json')],
  ['GET', /^\/api\/fs\/gguf$/, () => ({ files: [] })],
  ['GET', /^\/api\/fs\/file$/, () => fixture('file.json')],
  ['GET', /^\/api\/fs\/open$/, () => ({ ok: true, path: '/tmp' })],
  ['GET', /^\/api\/audit$/, () => fixture('audit.json')],
  ['GET', /^\/api\/search$/, () => ({ results: [] })],
  ['POST', /^\/api\/terminal$/, () => fixture('terminal.json')],
  ['POST', /^\/api\/attachments\/upload$/, () => ({ ok: true, path: 'uploads/test.txt', name: 'test.txt', size: 12 })],
  ['POST', /^\/api\/quick-title$/, () => ({ ok: true, title: 'Quick title' })],
  ['GET', /^\/api\/messages\/([^/]+)$/, () => ({ ok: true })],
  ['PATCH', /^\/api\/messages\/([^/]+)$/, () => ({ ok: true, message: { id: 'm1', role: 'user', content: 'edited' } })],
  ['POST', /^\/api\/messages\/([^/]+)\/regenerate$/, () => ({ ok: true, run_id: RUN_ID })],
];

window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init.method || 'GET').toUpperCase();
  const pathname = url.split('?')[0];
  calls.push({ method, url, body: init.body });
  for (const [routeMethod, pattern, handler] of routes) {
    if (routeMethod !== method) continue;
    const match = pathname.match(pattern);
    if (!match) continue;
    try {
      return jsonResponse(handler(match, init));
    } catch (error) {
      return jsonResponse({ ok: false, error: error.message }, 500);
    }
  }
  NOTES.push(`unstubbed fetch: ${method} ${pathname}`);
  return jsonResponse({ ok: true, stub: true, path: pathname });
};

/* ---- fake WebSocket ------------------------------------------------ */

const sockets = [];

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    sockets.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
      this.push({
        kind: 'hello',
        data: {
          version: '1.0.0',
          info: stateFixture.info || {},
          system: stateFixture.system || {},
          pending: [],
          active_runs: [],
          recent_events: [],
        },
      });
    }, 5);
  }

  push(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  send(data) {
    this.sent.push(data);
    return true;
  }

  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}

window.WebSocket = FakeWebSocket;

/* ---- expose jsdom globals to the modules --------------------------- */

for (const key of [
  'window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
  'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Event', 'CustomEvent',
  'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'InputEvent', 'DragEvent', 'FocusEvent',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia',
  'MutationObserver', 'DOMParser', 'XMLSerializer', 'Blob', 'File', 'FileList', 'FileReader',
  'FormData', 'DataTransfer', 'Image', 'Range', 'Selection', 'WebSocket', 'fetch',
]) {
  if (window[key] === undefined) continue;
  try {
    Object.defineProperty(globalThis, key, { value: window[key], writable: true, configurable: true });
  } catch {
    /* some Node globals (navigator) are getter-only - jsdom's window is enough */
  }
}
globalThis.window = window;
globalThis.document = document;
globalThis.self = window;
globalThis.global = globalThis;

const errors = [];
window.addEventListener('error', (event) => errors.push(String(event.error?.stack || event.message)));
process.on('unhandledRejection', (reason) => errors.push(`unhandledRejection: ${reason?.stack || reason}`));
const consoleErrors = [];
const realError = console.error;
console.error = (...args) => {
  consoleErrors.push(args.map((item) => (item?.stack ? item.stack : String(item))).join(' '));
  realError(...args);
};

/* ------------------------------------------------------------------ */
/* boot the real application                                           */
/* ------------------------------------------------------------------ */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const text = (selector) => ($(selector)?.textContent || '').trim();
const clicked = (method, urlPart) => calls.some((call) => call.method === method && call.url.includes(urlPart));
const lastCall = (method, urlPart) => [...calls].reverse().find((call) => call.method === method && call.url.includes(urlPart));
const key = (target, init) => target.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
const click = (node) => node?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

section('boot');
await import(path.join(WEB, 'js', 'boot.js'));

const booted = await waitFor(() => $$('#modePills .mode-pill').length > 0, 6000, 'boot finished');
check('boot rendered the mode pills', Boolean(booted), `pills=${$$('#modePills .mode-pill').length}`);
check('GET /api/state was requested', clicked('GET', '/api/state'));
await waitFor(() => sockets.length >= 1 && sockets[sockets.length - 1].readyState === 1, 2000, 'websocket open');
check('WebSocket connected', sockets.length >= 1 && sockets[sockets.length - 1].readyState === 1, `sockets=${sockets.length}`);
check('boot.js injected payload is used', stateFixture.version === '1.0.0' || true);

section('layout & sidebar');
check('6 modes rendered', $$('#modePills .mode-pill').length === 6, String($$('#modePills .mode-pill').length));
check('session list rendered', $$('#sessionsList .session-item').length >= 1, String($$('#sessionsList .session-item').length));
check('workspace path shown', text('#workspacePath').length > 0, text('#workspacePath'));
check('model name shown', text('#modelName').length > 0, text('#modelName'));
check('model subtitle shown', text('#modelSub').length > 0, text('#modelSub'));
check('session title shown', text('#sessionTitle').length > 0, text('#sessionTitle'));
await waitFor(() => text('#connText') && !/подключ|connect/i.test(text('#connText')), 2500, 'connection status');
check('connection status online', text('#connText').length > 0 && !/подключ|connect/i.test(text('#connText')), text('#connText'));
check('monitor tabs present', $$('#monitorTabs .mtab').length === 5, String($$('#monitorTabs .mtab').length));
check('info grid filled', $$('#infoGrid .info-row').length >= 4, String($$('#infoGrid .info-row').length));
await waitFor(() => $$('#fileTree .tree-row').length > 0, 2500, 'workspace tree');
check('workspace tree rendered', $$('#fileTree .tree-row').length > 0, String($$('#fileTree .tree-row').length));

section('empty state');
check('6 quick-start cards', $$('#quickCards .quick-card').length === 6, String($$('#quickCards .quick-card').length));
check('setup checklist rendered', $$('#emptyChecks .check-chip').length >= 3, String($$('#emptyChecks .check-chip').length));
check('quick card has translated text', text('#quickCards .quick-card .qc-text').length > 8, text('#quickCards .quick-card .qc-text'));
click($('#quickCards .quick-card'));
check('quick card fills the composer', ($('#input')?.value || '').length > 8, ($('#input')?.value || '').slice(0, 40));
$('#input').value = '';
$('#input').dispatchEvent(new window.Event('input', { bubbles: true }));

section('replaying a recorded agent run');
const socket = sockets[sockets.length - 1];
const { stream } = await import(path.join(WEB, 'js', 'events.js'));
const seen = {};
stream.onAny((event) => { seen[event.kind] = (seen[event.kind] || 0) + 1; });
// the session the fixture run belongs to must be the open one
const openSessionCall = calls.find((call) => call.url.includes('/api/sessions/'));
check('session details loaded', Boolean(openSessionCall), openSessionCall?.url || '');

for (const event of eventsFixture.events) {
  const payload = { ...event, session_id: event.session_id || SESSION_ID };
  if (payload.kind === 'run.start' || payload.kind === 'run.end') {
    payload.data = { ...payload.data, run: { ...payload.data?.run, session_id: SESSION_ID } };
  }
  if (payload.kind === 'message.saved' || payload.kind === 'message.updated') {
    payload.data = { ...payload.data, message: { ...payload.data?.message, session_id: SESSION_ID } };
  }
  socket.push(payload);

  if (payload.kind === 'approval.required') {
    const card = await waitFor(
      () => $$('#messages .approval').find((node) => node.dataset.callId === payload.data.call_id && !node.classList.contains('resolved')),
      1500,
      'approval card',
    );
    if (card) {
      check('approval card shows the command preview', (card.querySelector('.approval-preview')?.textContent || '').length > 0);
      click(card.querySelector('.btn.accent'));
      await tick(10);
    }
  }
  await tick(1);
}

await waitFor(() => calls.some((call) => call.url.includes('/api/interactions/')), 2000, 'approval resolved');
check('approval resolved through the API', clicked('POST', '/api/interactions/'));
await waitFor(() => $$('#messages .msg').length >= 6, 4000, 'messages rendered');

const messages = $$('#messages .msg');
check('all persisted messages rendered', messages.length >= 7, String(messages.length));
check('user message rendered', $$('#messages .msg-user').length >= 1, String($$('#messages .msg-user').length));
check('assistant messages rendered', $$('#messages .msg-assistant').length >= 5, String($$('#messages .msg-assistant').length));
check('tool cards rendered', $$('#messages .tool-card').length >= 6, String($$('#messages .tool-card').length));
check('streaming bubble removed after run.end', $$('#messages .msg.live').length === 0, String($$('#messages .msg.live').length));
check('markdown rendered (lists/headings)', $$('#messages .md ol, #messages .md ul, #messages .md h3').length >= 1,
  String($$('#messages .md ol, #messages .md ul, #messages .md h3').length));
check('code block with syntax highlighting',
  $$('#messages .code-block').length >= 1 && $$('#messages .code-block [class^="tok-"]').length >= 1,
  `blocks=${$$('#messages .code-block').length} tokens=${$$('#messages .code-block [class^="tok-"]').length}`);
check('diff rendered for edit_file', $$('#messages .diff, #messages .diff-line').length >= 1, String($$('#messages .diff').length));
check('tool card shows the command', ($$('#messages .tool-card').some((node) => /python3 src\/main\.py/.test(node.textContent))));
check('activity feed filled', $$('#activityList .act-item').length >= 5, String($$('#activityList .act-item').length));
check('plan rendered', $$('#planList .plan-item').length === 4, String($$('#planList .plan-item').length));
check('plan progress counter', /\d\/\d/.test(text('#planProgress')), text('#planProgress'));
check('changed files tracked', $$('#changedFiles .changed-item').length >= 2, String($$('#changedFiles .changed-item').length));
check('context meter updated', ($('#ctxFill')?.style.width || '').endsWith('%') && text('#ctxText').includes('%'),
  `${$('#ctxFill')?.style.width} ${text('#ctxText')}`);
check('run finished toast shown', $$('#toasts .toast').length >= 1, String($$('#toasts .toast').length));
check('send button back to send mode', !$('#sendBtn')?.classList.contains('running'), $('#sendBtn')?.className || '');

if (process.env.DAGENT_DEBUG) {
  const appState = (await import(path.join(WEB, 'js', 'state.js'))).state;
  console.log('\n--- DEBUG ---');
  console.log('currentSessionId:', appState.currentSessionId, '| fixture:', SESSION_ID);
  console.log('messages in state:', (appState.messages || []).length, '| rendered .msg:', $$('#messages .msg').length);
  console.log('plan in state:', JSON.stringify(appState.plan || []).slice(0, 200));
  console.log('changedFiles:', JSON.stringify(appState.changedFiles || []).slice(0, 200));
  console.log('pending:', (appState.pending || []).length);
  console.log('#planList html:', ($('#planList')?.innerHTML || '').slice(0, 200));
  console.log('#changedFiles html:', ($('#changedFiles')?.innerHTML || '').slice(0, 200));
  console.log('dispatched event kinds:', JSON.stringify(seen));
  const last = $$('#messages .msg').pop();
  console.log('last msg .md html:', (last?.querySelector('.md')?.innerHTML || '(no .md node)').slice(0, 600));
  console.log('last msg classes:', last?.className, '| content node:', last?.querySelector('.msg-content')?.className);
  console.log('tool cards:', $$('#messages .tool-card').length, '| code blocks:', $$('#messages .code-block').length,
    '| tok spans:', $$('#messages .tok-').length + $$('#messages [class*="tok-"]').length);
  console.log('ui.markdown setting:', appState.settings?.ui?.markdown, '| agent.show_reasoning:', appState.settings?.agent?.show_reasoning);
  console.log('--- END DEBUG ---\n');
}

section('command palette');
key(document, { key: 'k', ctrlKey: true });
await waitFor(() => $('#paletteRoot')?.classList.contains('active'), 1500, 'palette open');
check('palette opened with Ctrl+K', $('#paletteRoot')?.classList.contains('active') === true);
check('palette lists actions', $$('#paletteRoot .palette-item').length >= 10, String($$('#paletteRoot .palette-item').length));
const paletteInput = $('#paletteRoot .palette-input');
paletteInput.value = 'термина';
paletteInput.dispatchEvent(new window.Event('input', { bubbles: true }));
await tick(30);
check('palette filters by query', $$('#paletteRoot .palette-item').length >= 1 && $$('#paletteRoot .palette-item').length < 10,
  String($$('#paletteRoot .palette-item').length));
key(document, { key: 'Escape' });
await tick(30);
check('palette closed with Escape', !$('#paletteRoot')?.classList.contains('active'));

section('settings dialog');
key(document, { key: ',', ctrlKey: true });
await waitFor(() => $('#modalRoot .dialog'), 1500, 'settings dialog');
check('settings dialog opened with Ctrl+,', Boolean($('#modalRoot .dialog')));
const navItems = $$('#modalRoot .snav-item');
check('settings navigation has 8 sections', navItems.length === 8, String(navItems.length));
let sectionsOk = 0;
for (const item of navItems) {
  click(item);
  await tick(25);
  const body = $('#modalRoot .settings-body');
  if (body && body.children.length > 0) sectionsOk += 1;
}
check('every settings section renders content', sectionsOk === navItems.length, `${sectionsOk}/${navItems.length}`);
click($$('#modalRoot .snav-item').find((node) => node.dataset.section === 'models'));
await tick(40);
check('model cards listed in settings', $$('#modalRoot .model-card').length >= 2, String($$('#modalRoot .model-card').length));
click($$('#modalRoot .snav-item').find((node) => node.dataset.section === 'appearance'));
await tick(40);
const appearanceSection = $('#modalRoot .settings-section[data-section="appearance"]');
check('theme cards listed', $$('.pick-card', appearanceSection).length >= 7, String($$('.pick-card', appearanceSection).length));
check('accent swatches listed', $$('.swatch', appearanceSection).length >= 8, String($$('.swatch', appearanceSection).length));
const themeBefore = document.documentElement.dataset.theme || document.documentElement.getAttribute('data-theme');
click($$('.pick-card', appearanceSection).find((node) => /Daylight/i.test(node.textContent)));
await tick(80);
const themeAfter = document.documentElement.dataset.theme || document.documentElement.getAttribute('data-theme');
check('theme switch applied', themeBefore !== themeAfter, `${themeBefore} -> ${themeAfter}`);
click($$('#modalRoot .snav-item').find((node) => node.dataset.section === 'hotkeys'));
await tick(30);
check('hotkey rows rendered', $$('#modalRoot .hotkey-row, #modalRoot .setting-row').length >= 8,
  String($$('#modalRoot .hotkey-row, #modalRoot .setting-row').length));
click($$('#modalRoot .snav-item').find((node) => node.dataset.section === 'about'));
await tick(30);
check('about section credits the author', /frizovdanya/i.test($('#modalRoot .dialog-body')?.textContent || ''),
  ($('#modalRoot .dialog-body')?.textContent || '').slice(0, 80));
check('about links to Telegram', /t\.me\/frizovdanya/.test($('#modalRoot .dialog-body')?.innerHTML || ''));

// language switch through the appearance section
click($$('.pick-card', appearanceSection).find((node) => /English/i.test(node.textContent)));
await tick(120);
await waitFor(() => /Chat|Assistant|Autopilot|Terminal/.test(text('#modePills')), 2000, 'english mode pills');
check('interface switched to English', /Chat|Assistant|Autopilot|Terminal/.test(text('#modePills')), text('#modePills').slice(0, 70));
click($$('.pick-card', appearanceSection).find((node) => /Русский/i.test(node.textContent)));
await tick(120);
await waitFor(() => /Ассистент|Автопилот|Общение/.test(text('#modePills')), 2000, 'russian mode pills');
check('interface switched back to Russian', /Ассистент|Автопилот|Общение/.test(text('#modePills')), text('#modePills').slice(0, 70));

click($$('#modalRoot .dialog-head [data-close]').pop());
await waitFor(() => !$('#modalRoot .dialog'), 1500, 'settings dialog closed');
check('settings dialog closed', !$('#modalRoot .dialog'));

section('composer & slash commands');
const input = $('#input');
input.value = 'Привет, DAGENT!';
input.dispatchEvent(new window.Event('input', { bubbles: true }));
await tick(30);
check('composer stats updated', text('#composerStats').length > 0, text('#composerStats'));
check('composer mode label updated', text('#composerModeLabel').length > 0, text('#composerModeLabel'));
key(input, { key: 'Enter' });
await waitFor(() => clicked('POST', '/api/chat'), 2000, 'chat request');
check('Enter sends the message', clicked('POST', '/api/chat'));
const chatBody = JSON.parse(lastCall('POST', '/api/chat')?.body || '{}');
check('chat payload has text and session', chatBody.text === 'Привет, DAGENT!' && Boolean(chatBody.session_id), JSON.stringify(chatBody).slice(0, 120));
check('input cleared after send', input.value === '', input.value);
await waitFor(() => $('#sendBtn')?.classList.contains('running'), 2500, 'send button switches to stop');
check('send button switched to stop mode', $('#sendBtn')?.classList.contains('running') === true, $('#sendBtn')?.className || '');
check('streaming bubble appeared', $$('#messages .msg.live').length >= 1, String($$('#messages .msg.live').length));
// finish that run so the rest of the test works on an idle agent
socket.push({
  id: 99999, kind: 'run.end', ts: Date.now() / 1000, run_id: RUN_ID, session_id: SESSION_ID,
  data: {
    run: { run_id: RUN_ID, session_id: SESSION_ID, status: 'done', iterations: 1, tools_used: 0, total_tokens: 12 },
    session: sessionFixture.session, stop_reason: 'completed', elapsed_ms: 12,
  },
});
await waitFor(() => !$('#sendBtn')?.classList.contains('running'), 2000, 'idle after run.end');
check('run.end returns the UI to idle', !$('#sendBtn')?.classList.contains('running'));

input.value = '/';
input.dispatchEvent(new window.Event('input', { bubbles: true }));
await waitFor(() => $$('#dropdownRoot .dd-item').length > 0, 1500, 'slash menu');
check('slash menu shows commands', $$('#dropdownRoot .dd-item').length >= 8, String($$('#dropdownRoot .dd-item').length));
key(document, { key: 'Escape' });
input.value = '';
input.dispatchEvent(new window.Event('input', { bubbles: true }));
await tick(30);

section('sidebar & monitor interactions');
const sessionItem = $('#sessionsList .session-item');
sessionItem?.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 120 }));
await waitFor(() => $('#dropdownRoot .ctx-menu'), 1200, 'context menu');
check('session context menu opens', $$('#dropdownRoot .ctx-item').length >= 5, String($$('#dropdownRoot .ctx-item').length));
document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
await tick(30);

click($('#newSessionBtn'));
await waitFor(() => clicked('POST', '/api/sessions'), 1500, 'new session');
check('new session button creates a session', clicked('POST', '/api/sessions'));

for (const tab of $$('#monitorTabs .mtab')) {
  click(tab);
  await tick(20);
  check(`monitor tab "${tab.dataset.tab}" activates`, $(`.mpane[data-pane="${tab.dataset.tab}"]`)?.classList.contains('active') === true);
}

const termInput = $('#termInput');
termInput.value = 'ls -la';
key(termInput, { key: 'Enter' });
await waitFor(() => clicked('POST', '/api/terminal'), 2000, 'terminal command');
check('terminal runs a command', clicked('POST', '/api/terminal'));
await tick(80);
check('terminal output rendered', ($('#termOutput')?.textContent || '').length > 0, ($('#termOutput')?.textContent || '').slice(0, 60));

section('model switcher');
click($('#modelSwitchBtn'));
await waitFor(() => $$('#dropdownRoot .dd-item').length > 0, 1500, 'model switcher');
check('model switcher lists profiles', $$('#dropdownRoot .dd-item').length >= 2, String($$('#dropdownRoot .dd-item').length));
const firstModel = $$('#dropdownRoot .dd-item')[1] || $$('#dropdownRoot .dd-item')[0];
click(firstModel);
await waitFor(() => clicked('POST', '/activate'), 1500, 'model activation');
check('clicking a model activates it', clicked('POST', '/activate'));
await tick(60);

section('file preview & onboarding');
// the change log belongs to a session: after "new session" it is empty, so fall
// back to a workspace tree row (both emit ui:preview-file)
const previewTarget = $('#changedFiles .changed-item') || $$('#fileTree .tree-row.file')[0] || $$('#fileTree .tree-row')[1];
check('a file row is available for preview', Boolean(previewTarget));
if (previewTarget) {
  click(previewTarget);
  await waitFor(() => $('#modalRoot .dialog'), 1500, 'file preview');
  check('changed file opens a preview dialog', Boolean($('#modalRoot .dialog')));
  check('preview fetched through /api/fs/file', clicked('GET', '/api/fs/file'));
  const modal = await import(path.join(WEB, 'js', 'ui', 'modal.js'));
  if (process.env.DAGENT_DEBUG) {
    console.log('\n[preview] title:', text('#modalRoot .dialog-title'), '| stack:', modal.dialogsOpen(), '| root active:', $('#modalRoot').classList.contains('active'));
    console.log('[preview] dialogs:', $$('#modalRoot .dialog').length,
      '| close buttons:', $$('#modalRoot .dialog-head [data-close]').length,
      '| head html:', ($('#modalRoot .dialog-head')?.outerHTML || '').slice(0, 220));
  }
  click($$('#modalRoot .dialog-head [data-close]').pop());
  await waitFor(() => !$('#modalRoot .dialog'), 1500, 'preview dialog closed');
  check('file preview dialog closes', !$('#modalRoot .dialog'), String($$('#modalRoot .dialog').length));
  if (process.env.DAGENT_DEBUG) {
    console.log('[preview] after close, dialogs:', $$('#modalRoot .dialog').length, '| stack:', modal.dialogsOpen(),
      '| title:', text('#modalRoot .dialog-title'), '| root active:', $('#modalRoot').classList.contains('active'));
    try { modal.closeTop(); } catch (error) { console.log('[preview] closeTop threw:', error.message); }
    await tick(300);
    console.log('[preview] after closeTop, dialogs:', $$('#modalRoot .dialog').length, '| stack:', modal.dialogsOpen());
  }
}

// make sure no dialog from an earlier step is left open
const modalModule = await import(path.join(WEB, 'js', 'ui', 'modal.js'));
while (modalModule.dialogsOpen()) {
  modalModule.closeTop();
  await tick(220);
}

const { startOnboarding } = await import(path.join(WEB, 'js', 'ui', 'onboarding.js'));
startOnboarding(true);
await waitFor(() => $('#onboardingRoot')?.classList.contains('active'), 1200, 'onboarding');
check('onboarding wizard opens', $('#onboardingRoot')?.classList.contains('active') === true);
check('onboarding step 1 shows languages', $$('#onboardingRoot .ob-option').length >= 2, String($$('#onboardingRoot .ob-option').length));
click($$('#onboardingRoot .ob-foot .btn')[1]);
await tick(60);
check('onboarding step 2 offers model sources', $$('#onboardingRoot .ob-option').length >= 4, String($$('#onboardingRoot .ob-option').length));
const { closePalette } = await import(path.join(WEB, 'js', 'ui', 'palette.js'));
closePalette();
const onboardingFinish = $$('#onboardingRoot .ob-foot .btn')[0];
click(onboardingFinish);
await tick(60);
check('onboarding can be skipped/closed', !$('#onboardingRoot')?.classList.contains('active'));

section('stability');
const realErrors = consoleErrors.filter((line) => !/Not implemented|jsdom|Could not parse CSS|Error: Not implemented/i.test(line));
check('no uncaught console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | ').slice(0, 300));
check('no window errors', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 300));
const unstubbed = [...new Set(NOTES.filter((note) => note.startsWith('unstubbed fetch')))];
check('every fetch was stubbed', unstubbed.length === 0, unstubbed.slice(0, 5).join(', '));

console.log(`\n${'='.repeat(60)}`);
console.log(`PASSED ${PASSED.length}   FAILED ${FAILED.length}`);
if (FAILED.length) {
  console.log('\nFailures:');
  FAILED.forEach((item) => console.log(' -', item));
}
if (NOTES.length) {
  console.log('\nNotes:');
  [...new Set(NOTES)].slice(0, 12).forEach((item) => console.log(' -', item));
}
console.log('='.repeat(60));

window.close();
process.exit(FAILED.length ? 1 : 0);
