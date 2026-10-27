/**
 * Settings dialog: models, agent, security, workspace, appearance,
 * hotkeys, data and about. Every control writes straight into the settings
 * store and takes effect immediately.
 */

import { $, el, esc, clear, clamp, truncate, downloadFile, humanSize } from '../dom.js';
import { icon, MODE_ICONS, TOOL_ICONS } from '../icons.js';
import { t, setLanguage, applyTranslations, LANGUAGES } from '../i18n.js';
import { api, TOKEN } from '../api.js';
import { bus, state, setting, setSetting } from '../state.js';
import * as theme from '../theme.js';
import { notify } from './toast.js';
import { openDialog, confirmDialog, promptDialog } from './modal.js';
import { renderModelList, openModelEditor, refreshModels } from './models.js';
import { pickPath } from './filepicker.js';

const SECTIONS = [
  { id: 'models', icon: 'cpu', labelKey: 'settings.models' },
  { id: 'agent', icon: 'bot', labelKey: 'settings.agent' },
  { id: 'security', icon: 'shield', labelKey: 'settings.security' },
  { id: 'workspace', icon: 'folder', labelKey: 'settings.workspace' },
  { id: 'appearance', icon: 'brush', labelKey: 'settings.appearance' },
  { id: 'hotkeys', icon: 'keyboard', labelKey: 'settings.hotkeys' },
  { id: 'data', icon: 'database', labelKey: 'settings.data' },
  { id: 'about', icon: 'info', labelKey: 'settings.about' },
];

let dialogHandle = null;

export function openSettings(section = 'models') {
  if (dialogHandle) return dialogHandle;
  const body = el('div', { class: 'settings-body' });
  const nav = el('nav', { class: 'settings-nav' });
  const pane = el('div', { class: 'settings-pane' });
  body.append(nav, pane);

  const sections = {};
  for (const item of SECTIONS) {
    const button = el('button', {
      class: `snav-item${item.id === section ? ' active' : ''}`,
      dataset: { section: item.id },
      html: `${icon(item.icon, 16)} <span>${esc(t(item.labelKey))}</span>`,
      onclick: () => show(item.id),
    });
    nav.append(button);
    const node = el('section', { class: `settings-section${item.id === section ? ' active' : ''}`, dataset: { section: item.id } });
    sections[item.id] = node;
    pane.append(node);
  }

  dialogHandle = openDialog({
    title: t('settings.title'),
    subtitle: t('settings.subtitle'),
    icon: 'settings',
    size: 'wide',
    body,
    bodyClass: 'no-pad',
    onClose: () => {
      dialogHandle = null;
      bus.emit('settings:closed');
    },
    footer: [
      el('div', { class: 'hint grow', text: `DAGENT v${state.version || ''} · ${state.system?.data_dir || '~/.dagent'}` }),
      el('button', { class: 'btn ghost', text: t('common.close'), onclick: () => dialogHandle?.close() }),
    ],
  });

  // build every section lazily on first show
  const built = new Set();
  function show(id) {
    nav.querySelectorAll('.snav-item').forEach((node) => node.classList.toggle('active', node.dataset.section === id));
    Object.entries(sections).forEach(([key, node]) => node.classList.toggle('active', key === id));
    if (!built.has(id)) {
      built.add(id);
      BUILDERS[id](sections[id]);
    }
    pane.scrollTop = 0;
    state.ui.settingsTab = id;
  }
  show(section);
  return dialogHandle;
}

/* ------------------------------------------------------------------ */
/* control builders                                                    */
/* ------------------------------------------------------------------ */

function header(title, subtitle = '') {
  const wrap = el('div', {});
  wrap.append(el('div', { class: 'section-title', text: title }));
  if (subtitle) wrap.append(el('div', { class: 'section-sub', text: subtitle }));
  return wrap;
}

function block(title) {
  const node = el('div', { class: 'setting-block' });
  if (title) node.append(el('h4', { text: title }));
  return node;
}

function row(name, hint, control, stacked = false) {
  const node = el('div', { class: `setting-row${stacked ? ' stacked' : ''}` });
  const text = el('div', { class: 'sr-text' });
  text.append(el('div', { class: 'sr-name', text: name }));
  if (hint) text.append(el('div', { class: 'sr-hint', html: esc(hint) }));
  node.append(text);
  const ctl = el('div', { class: 'sr-ctl' });
  if (Array.isArray(control)) control.forEach((item) => item && ctl.append(item));
  else if (control) ctl.append(control);
  node.append(ctl);
  return node;
}

function toggle(key, onChange) {
  const input = el('input', { type: 'checkbox' });
  input.checked = Boolean(setting(key, false));
  input.addEventListener('change', async () => {
    await setSetting(key, input.checked);
    onChange?.(input.checked);
  });
  return el('label', { class: 'switch' }, [
    input,
    el('span', { class: 'track' }, [el('span', { class: 'thumb' })]),
  ]);
}

function numberControl(key, { min = 0, max = 1e9, step = 1, width = 120, onChange } = {}) {
  const input = el('input', { class: 'input-t', type: 'number', min: String(min), max: String(max), step: String(step), style: { width: `${width}px` } });
  input.value = String(setting(key, min));
  input.addEventListener('change', async () => {
    const value = clamp(Number(input.value || min), min, max);
    input.value = String(value);
    await setSetting(key, value);
    onChange?.(value);
  });
  return input;
}

function rangeControl(key, { min = 0, max = 1, step = 0.05, format = (v) => v, onChange } = {}) {
  const wrap = el('div', { class: 'row', style: { width: '210px' } });
  const input = el('input', { class: 'range', type: 'range', min: String(min), max: String(max), step: String(step) });
  const label = el('span', { class: 'mono tiny', style: { width: '44px', textAlign: 'right' } });
  const sync = () => {
    const value = Number(input.value);
    input.style.setProperty('--fill', `${((value - min) / (max - min)) * 100}%`);
    label.textContent = format(value);
  };
  input.value = String(setting(key, min));
  sync();
  input.addEventListener('input', sync);
  input.addEventListener('change', async () => {
    const value = Number(input.value);
    await setSetting(key, value);
    onChange?.(value);
  });
  wrap.append(input, label);
  return wrap;
}

function selectControl(key, options, onChange) {
  const select = el('select', { class: 'input-t' });
  const current = String(setting(key, ''));
  options.forEach((option) => {
    const value = option.value ?? option.id ?? option;
    const node = el('option', { value: String(value), text: option.label ?? option });
    if (String(value) === current) node.selected = true;
    select.append(node);
  });
  select.addEventListener('change', async () => {
    await setSetting(key, select.value);
    onChange?.(select.value);
  });
  return select;
}

function textControl(key, { placeholder = '', mono = false, width = 220, onChange } = {}) {
  const input = el('input', { class: `input-t${mono ? ' mono' : ''}`, type: 'text', placeholder, style: { width: `${width}px` }, value: String(setting(key, '') ?? '') });
  input.addEventListener('change', async () => {
    await setSetting(key, input.value);
    onChange?.(input.value);
  });
  return input;
}

function textareaControl(key, { rows = 5, placeholder = '', onChange, transform = (v) => v } = {}) {
  const area = el('textarea', { class: 'input-t', rows: String(rows), placeholder });
  const value = setting(key, '');
  area.value = Array.isArray(value) ? value.join('\n') : String(value || '');
  area.addEventListener('change', async () => {
    await setSetting(key, transform(area.value));
    onChange?.(area.value);
  });
  return area;
}

const linesTransform = (value) => String(value).split('\n').map((line) => line.trim()).filter(Boolean);

/* ------------------------------------------------------------------ */
/* sections                                                            */
/* ------------------------------------------------------------------ */

const BUILDERS = {
  models(host) {
    host.append(header(t('settings.models'), t('models.subtitle')));

    const list = el('div', { class: 'col' });
    renderModelList(list, {
      onSaved: () => renderModelList(list, {}),
      onActivate: () => renderModelList(list, {}),
    });
    host.append(list);

    const ggufBlock = block('GGUF / llama.cpp');
    const status = state.providers || {};
    const statusRow = el('div', { class: 'row wrap' });
    statusRow.append(el('span', { class: `tag ${status.llama_cpp_installed ? 'ok' : 'warn'}`, text: status.llama_cpp_installed ? `installed ${status.llama_cpp_version || ''}` : 'not installed' }));
    statusRow.append(el('span', { class: 'tag', text: `loaded: ${(status.loaded_gguf || []).length}` }));
    ggufBlock.append(statusRow);
    if (!status.llama_cpp_installed) {
      ggufBlock.append(el('div', { class: 'approval-preview', style: { marginTop: '8px' }, text: status.llama_cpp_hint || 'pip install llama-cpp-python' }));
    }
    ggufBlock.append(row('Default context (n_ctx)', 'Used by new GGUF profiles', numberControl('gguf.n_ctx', { min: 512, step: 512 })));
    ggufBlock.append(row('GPU layers', '-1 = all layers on GPU', numberControl('gguf.n_gpu_layers', { min: -1, max: 200 })));
    ggufBlock.append(row('Threads', '0 = automatic', numberControl('gguf.n_threads', { min: 0, max: 128 })));
    ggufBlock.append(row('mmap', 'Memory-map the file (faster load, less RAM copy)', toggle('gguf.use_mmap')));
    ggufBlock.append(row('mlock', 'Lock the model in RAM (prevents swapping)', toggle('gguf.use_mlock')));
    ggufBlock.append(row('Verbose llama.cpp logs', 'Print backend logs to the server console', toggle('gguf.verbose')));
    const scanRow = el('div', { class: 'row' });
    const scanInput = el('input', { class: 'input-t mono', type: 'text', value: (setting('gguf.scan_dirs', []) || []).join(', '), placeholder: '~/models, ~/Downloads' });
    scanInput.style.width = '320px';
    scanRow.append(scanInput);
    scanRow.append(el('button', {
      class: 'btn',
      text: t('common.save'),
      onclick: async () => {
        const dirs = scanInput.value.split(',').map((item) => item.trim()).filter(Boolean);
        await setSetting('gguf.scan_dirs', dirs);
        notify.ok(t('common.saved'));
      },
    }));
    scanRow.append(el('button', {
      class: 'btn ghost',
      html: `${icon('search', 14)} ${esc(t('models.scan'))}`,
      onclick: async (event) => {
        const dirs = scanInput.value.split(',').map((item) => item.trim()).filter(Boolean);
        const result = await api.scanGguf(dirs, true, true);
        notify.info(t('models.scan'), `${result.count} .gguf`);
      },
    }));
    ggufBlock.append(row('Scan folders', 'Comma separated; used by the GGUF picker', scanRow, true));
    host.append(ggufBlock);
  },

  agent(host) {
    host.append(header(t('settings.agent'), t('modes.hint')));

    const modeBlock = block(t('settings.mode_default'));
    const cards = el('div', { class: 'cards-grid' });
    (state.modes || []).forEach((mode) => {
      const card = el('button', {
        class: `pick-card${setting('agent.mode') === mode.id ? ' active' : ''}`,
        onclick: async () => {
          await setSetting('agent.mode', mode.id);
          cards.querySelectorAll('.pick-card').forEach((node) => node.classList.remove('active'));
          card.classList.add('active');
          bus.emit('mode:changed', mode.id);
        },
      });
      card.append(el('span', { class: 'pc-title', html: `${icon(MODE_ICONS[mode.id] || 'wand', 15)} ${esc(mode.name)}` }));
      card.append(el('span', { class: 'pc-sub', text: mode.tagline || '' }));
      cards.append(card);
    });
    modeBlock.append(cards);
    host.append(modeBlock);

    const behaviour = block(t('settings.behaviour'));
    behaviour.append(row(t('settings.max_iterations'), t('settings.max_iterations_hint'), numberControl('agent.max_iterations', { min: 1, max: 100 })));
    behaviour.append(row(t('settings.tool_protocol'), 'Native = function calling, JSON = text protocol for any model', selectControl('agent.tool_protocol', [
      { value: 'auto', label: t('settings.protocol.auto') },
      { value: 'native', label: t('settings.protocol.native') },
      { value: 'json', label: t('settings.protocol.json') },
    ], () => bus.emit('settings:applied'))));
    behaviour.append(row('Streaming', 'Show tokens as they arrive', toggle('agent.stream')));
    behaviour.append(row(t('settings.show_reasoning'), 'Show <thinking> blocks in a collapsible area', toggle('agent.show_reasoning')));
    behaviour.append(row(t('settings.auto_title'), 'Ask the model for a short session title', toggle('agent.auto_title')));
    behaviour.append(row(t('settings.include_environment'), 'OS, shell, workspace, git branch in the system prompt', toggle('agent.include_environment')));
    behaviour.append(row(t('settings.include_tree'), 'Adds a short file tree to every prompt (costs tokens)', toggle('agent.include_tree')));
    behaviour.append(row(t('settings.retry'), 'Retries when the provider returns an error', numberControl('agent.retry_on_error', { min: 0, max: 6 })));
    behaviour.append(row(t('settings.request_timeout'), '', numberControl('agent.request_timeout', { min: 20, max: 3600, step: 10 })));
    host.append(behaviour);

    const generation = block(t('settings.generation'));
    generation.append(row(t('settings.temperature'), 'Lower = more deterministic', rangeControl('agent.temperature', { min: 0, max: 2, step: 0.05, format: (v) => v.toFixed(2) })));
    generation.append(row(t('settings.top_p'), '', rangeControl('agent.top_p', { min: 0.1, max: 1, step: 0.01, format: (v) => v.toFixed(2) })));
    generation.append(row(t('settings.max_tokens'), 'Maximum tokens per model reply', numberControl('agent.max_tokens', { min: 64, max: 32768, step: 64 })));
    generation.append(row(t('settings.context_window'), 'Fallback when a profile does not define one', numberControl('agent.context_window', { min: 1024, max: 1000000, step: 1024 })));
    generation.append(row(t('settings.stop_sequences'), 'Comma separated', textControl('agent.stop_sequences', { placeholder: '</s>, ###', width: 240, onChange: (value) => setSetting('agent.stop_sequences', value.split(',').map((item) => item.trim()).filter(Boolean)) })));
    host.append(generation);

    const context = block(t('settings.context'));
    context.append(row(t('settings.compress_history'), 'Summarise old messages when the context fills up', toggle('agent.compress_history')));
    context.append(row(t('settings.compress_ratio'), 'Compress when used tokens exceed this share of the window', rangeControl('agent.compress_ratio', { min: 0.3, max: 0.95, step: 0.05, format: (v) => `${Math.round(v * 100)}%` })));
    host.append(context);

    const memory = block(t('settings.memory'));
    memory.append(row(t('settings.memory'), t('settings.memory_hint'), toggle('agent.memory_enabled')));
    memory.append(row(t('settings.memory_file'), 'Relative to the workspace', textControl('agent.memory_file', { placeholder: 'DAGENT_MEMORY.md', mono: true })));
    host.append(memory);

    const prompt = block(t('settings.extra_system_prompt'));
    prompt.append(row(t('settings.extra_system_prompt'), t('settings.extra_system_prompt_hint'), textareaControl('agent.extra_system_prompt', { rows: 6, placeholder: 'Always answer in Russian. Never touch the /prod folder. Prefer pytest.' }), true));
    host.append(prompt);
  },

  security(host) {
    host.append(header(t('settings.security'), t('settings.security_intro')));

    const main = block();
    main.append(row(t('settings.auto_approve'), t('settings.auto_approve_hint'), toggle('security.auto_approve')));
    main.append(row(t('settings.auto_approve_reads'), 'Reads, listings and safe commands run without asking', toggle('security.auto_approve_reads')));
    main.append(row(t('settings.confirm_timeout'), 'After this time a pending action is cancelled', numberControl('security.confirm_timeout', { min: 15, max: 3600, step: 15 })));
    main.append(row(t('settings.sandbox'), t('settings.sandbox_hint'), toggle('workspace.sandbox')));
    main.append(row(t('settings.allow_read_outside'), 'Let read-only tools look outside the workspace', toggle('workspace.allow_read_outside')));
    main.append(row(t('settings.allow_write_outside'), 'Dangerous: writes anywhere the user can write', toggle('security.allow_write_outside_workspace')));
    main.append(row(t('settings.allow_delete'), '', toggle('security.allow_delete')));
    main.append(row(t('settings.confirm_delete'), '', toggle('security.confirm_delete')));
    main.append(row(t('settings.allow_python'), 'python_run tool', toggle('security.allow_python_exec')));
    main.append(row(t('settings.allow_network'), 'web_fetch tool', toggle('security.allow_network_tools')));
    main.append(row(t('settings.audit'), 'Write every action to ~/.dagent/logs/audit.log and the database', toggle('security.audit_log')));
    main.append(row(t('settings.allowed_origins'), t('settings.allowed_origins_hint'),
      textareaControl('app.allowed_origins', { rows: 2, placeholder: 'https://my-tunnel.example.com', transform: linesTransform })));
    host.append(main);

    const exec = block(t('nav.terminal'));
    exec.append(row(t('settings.shell'), 'auto = bash/sh on Linux & macOS, PowerShell on Windows', selectControl('security.shell', [
      { value: 'auto', label: 'auto' },
      { value: 'bash', label: 'bash' },
      { value: 'powershell', label: 'powershell' },
      { value: 'cmd', label: 'cmd' },
      { value: 'custom', label: 'custom' },
    ])));
    exec.append(row(t('settings.custom_shell'), 'Used when shell = custom', textControl('security.custom_shell', { placeholder: '/usr/bin/zsh', mono: true })));
    exec.append(row(t('settings.command_timeout'), '', numberControl('security.command_timeout', { min: 5, max: 3600, step: 5 })));
    exec.append(row(t('settings.max_output'), '', numberControl('security.max_output_chars', { min: 1000, max: 2000000, step: 1000 })));
    exec.append(row(t('settings.max_file_read'), '', numberControl('security.max_file_read_bytes', { min: 10000, max: 50000000, step: 10000 })));
    exec.append(row(t('settings.max_file_write'), '', numberControl('security.max_file_write_bytes', { min: 10000, max: 100000000, step: 10000 })));
    host.append(exec);

    const rules = block('Rules');
    rules.append(row(t('settings.denied_commands'), 'Regex patterns; matched commands are never executed', textareaControl('security.denied_commands', { rows: 7, transform: linesTransform }), true));
    rules.append(row(t('settings.allowed_commands'), 'Command prefixes that never need approval', textareaControl('security.always_allow_commands', { rows: 5, transform: linesTransform }), true));
    rules.append(row(t('settings.sensitive_paths'), 'Paths the agent may never touch', textareaControl('security.sensitive_paths', { rows: 5, transform: linesTransform }), true));
    host.append(rules);

    const audit = block(t('settings.audit_log'));
    const auditList = el('div', { class: 'col' });
    const loadAudit = async () => {
      clear(auditList);
      try {
        const data = await api.audit(60);
        if (!data.entries.length) {
          auditList.append(el('div', { class: 'empty-mini', text: t('settings.audit_empty') }));
          return;
        }
        data.entries.forEach((entry) => {
          auditList.append(el('div', { class: 'act-item' }, [
            el('span', { class: `act-ic ${entry.ok === 0 ? 'err' : 'ok'}`, html: icon(entry.kind === 'command' ? 'terminal' : entry.kind === 'blocked' ? 'shield' : 'activity', 12) }),
            el('div', { class: 'act-main' }, [
              el('div', { class: 'act-title', html: `${esc(entry.kind)} <span class="mono muted">${esc(entry.tool || '')}</span>` }),
              el('div', { class: 'act-text', text: truncate(entry.detail || '', 160) }),
            ]),
            el('span', { class: 'act-time', text: new Date(entry.created_at * 1000).toLocaleString() }),
          ]));
        });
      } catch (error) {
        auditList.append(el('div', { class: 'empty-mini', text: error.message }));
      }
    };
    audit.append(el('div', { class: 'row' }, [
      el('button', { class: 'btn tiny', html: `${icon('refresh', 13)} ${esc(t('common.refresh'))}`, onclick: loadAudit }),
      el('button', {
        class: 'btn tiny ghost',
        text: t('common.export'),
        onclick: async () => {
          const data = await api.audit(1000);
          downloadFile('dagent-audit.json', JSON.stringify(data.entries, null, 2), 'application/json');
        },
      }),
    ]));
    audit.append(auditList);
    loadAudit();
    host.append(audit);
  },

  workspace(host) {
    host.append(header(t('settings.workspace'), t('settings.workspace_hint')));

    const main = block();
    const pathRow = el('div', { class: 'row' });
    const pathInput = el('input', { class: 'input-t mono', type: 'text', value: setting('workspace.root', ''), style: { width: '360px' } });
    pathRow.append(pathInput);
    pathRow.append(el('button', {
      class: 'btn',
      html: `${icon('folderOpen', 14)} ${esc(t('models.browse'))}`,
      onclick: async () => {
        const picked = await pickPath({ mode: 'dir', title: t('settings.workspace_root') });
        if (!picked) return;
        pathInput.value = picked;
        await applyWorkspace(picked);
      },
    }));
    pathRow.append(el('button', {
      class: 'btn accent',
      text: t('common.apply'),
      onclick: () => applyWorkspace(pathInput.value.trim()),
    }));
    main.append(row(t('settings.workspace_root'), t('settings.workspace_hint'), pathRow, true));

    const recent = setting('workspace.recent', []) || [];
    if (recent.length) {
      const recentRow = el('div', { class: 'row wrap' });
      recent.forEach((path) => {
        recentRow.append(el('button', {
          class: 'btn tiny ghost',
          html: `${icon('history', 12)} ${esc(truncate(path, 34))}`,
          onclick: () => {
            pathInput.value = path;
            applyWorkspace(path);
          },
        }));
      });
      main.append(row(t('settings.recent'), '', recentRow, true));
    }

    main.append(row(t('settings.hidden_entries'), 'Folder/file names hidden in the tree and searches', textareaControl('workspace.hidden_entries', { rows: 4, transform: linesTransform }), true));
    main.append(row(t('settings.max_tree_files'), '', numberControl('workspace.max_tree_files', { min: 100, max: 50000, step: 100 })));
    host.append(main);

    const info = block(t('monitor.workspace'));
    const infoHost = el('div', { class: 'col' });
    info.append(infoHost);
    host.append(info);
    const fill = async () => {
      clear(infoHost);
      try {
        const data = await api.workspace();
        infoHost.append(el('div', { class: 'info-row' }, [el('span', { class: 'k', text: 'root' }), el('span', { class: 'v', text: data.root })]));
        infoHost.append(el('div', { class: 'info-row' }, [el('span', { class: 'k', text: 'exists' }), el('span', { class: 'v', text: String(data.exists) })]));
        infoHost.append(el('div', { class: 'info-row' }, [el('span', { class: 'k', text: 'entries' }), el('span', { class: 'v', text: String(data.entries ?? '-') })]));
        infoHost.append(el('div', { class: 'info-row' }, [el('span', { class: 'k', text: 'git' }), el('span', { class: 'v', text: String(data.is_git) })]));
        infoHost.append(el('div', { class: 'info-row' }, [el('span', { class: 'k', text: 'size' }), el('span', { class: 'v', text: humanSize(data.size_bytes || 0) })]));
      } catch (error) {
        infoHost.append(el('div', { class: 'empty-mini', text: error.message }));
      }
    };
    fill();
    bus.on('workspace:changed', fill);
  },

  appearance(host) {
    host.append(header(t('settings.appearance'), 'Тема, акцент, шрифты, плотность и эффекты - всё применяется мгновенно.'));

    const langBlock = block(t('settings.language'));
    const langCards = el('div', { class: 'cards-grid' });
    LANGUAGES.forEach((lang) => {
      const card = el('button', {
        class: `pick-card${setting('app.language') === lang.id ? ' active' : ''}`,
        onclick: async () => {
          await setSetting('app.language', lang.id);
          setLanguage(lang.id);
          applyTranslations(document);
          langCards.querySelectorAll('.pick-card').forEach((node) => node.classList.remove('active'));
          card.classList.add('active');
          bus.emit('language:changed', lang.id);
          notify.info('OK', lang.label);
        },
      });
      card.append(el('span', { class: 'pc-title', html: `${icon('globe', 15)} ${esc(lang.label)}` }));
      card.append(el('span', { class: 'pc-sub', text: lang.id.toUpperCase() }));
      langCards.append(card);
    });
    langBlock.append(langCards);
    host.append(langBlock);

    const themeBlock = block(t('settings.theme'));
    const themeCards = el('div', { class: 'cards-grid' });
    theme.THEMES.forEach((item) => {
      const card = el('button', {
        class: `pick-card${setting('ui.theme') === item.id ? ' active' : ''}`,
        onclick: async () => {
          await setSetting('ui.theme', item.id);
          theme.refresh(state.settings);
          themeCards.querySelectorAll('.pick-card').forEach((node) => node.classList.remove('active'));
          card.classList.add('active');
        },
      });
      const preview = el('span', { class: 'row', style: { gap: '4px' } });
      item.colors.forEach((color) => preview.append(el('span', { style: { width: '16px', height: '16px', borderRadius: '5px', background: color, border: '1px solid rgba(128,128,128,.35)' } })));
      card.append(el('span', { class: 'pc-title', html: `${icon(item.scheme === 'dark' ? 'moon' : 'sun', 15)} ${esc(item.label)}` }));
      card.append(preview);
      themeCards.append(card);
    });
    themeBlock.append(themeCards);
    host.append(themeBlock);

    const accentBlock = block(t('settings.accent'));
    const swatches = el('div', { class: 'swatches' });
    theme.ACCENTS.forEach((accent) => {
      const node = el('button', {
        class: `swatch${setting('ui.accent') === accent.color || setting('ui.accent') === accent.id ? ' active' : ''}`,
        style: { background: accent.color },
        title: accent.label,
        onclick: async () => {
          await setSetting('ui.accent', accent.color);
          theme.refresh(state.settings);
          swatches.querySelectorAll('.swatch').forEach((item) => item.classList.remove('active'));
          node.classList.add('active');
        },
      });
      swatches.append(node);
    });
    const customColor = el('input', { type: 'color', value: setting('ui.accent', '#7c5cff').startsWith('#') ? setting('ui.accent', '#7c5cff') : '#7c5cff', style: { width: '40px', height: '30px', border: 'none', background: 'transparent', cursor: 'pointer' } });
    customColor.addEventListener('change', async () => {
      await setSetting('ui.accent', customColor.value);
      theme.refresh(state.settings);
    });
    swatches.append(customColor);
    accentBlock.append(swatches);
    host.append(accentBlock);

    const typo = block('Typography');
    typo.append(row(t('settings.font_family'), '', selectControl('ui.font_family', theme.FONTS.map((font) => ({ value: font.id, label: font.label })), () => theme.refresh(state.settings))));
    typo.append(row(t('settings.mono_font'), '', selectControl('ui.mono_font', theme.MONO_FONTS.map((font) => ({ value: font.id, label: font.label })), () => theme.refresh(state.settings))));
    typo.append(row(t('settings.font_size'), '', rangeControl('ui.font_size', { min: 12, max: 20, step: 0.5, format: (v) => `${v}px`, onChange: () => theme.refresh(state.settings) })));
    typo.append(row(t('settings.density'), '', (() => {
      const segmented = el('div', { class: 'segmented' });
      ['compact', 'comfortable', 'cozy'].forEach((value) => {
        const button = el('button', {
          class: setting('ui.density') === value ? 'active' : '',
          text: t(`settings.density.${value}`),
          onclick: async () => {
            await setSetting('ui.density', value);
            theme.refresh(state.settings);
            segmented.querySelectorAll('button').forEach((node) => node.classList.remove('active'));
            button.classList.add('active');
          },
        });
        segmented.append(button);
      });
      return segmented;
    })()));
    host.append(typo);

    const effects = block('Effects');
    effects.append(row(t('settings.animations'), t('settings.animations_hint'), toggle('ui.animations', () => theme.refresh(state.settings))));
    effects.append(row(t('settings.background'), '', selectControl('ui.background_fx', theme.FX.map((fx) => ({ value: fx.id, label: t(fx.labelKey) })), () => theme.refresh(state.settings))));
    effects.append(row(t('settings.blur'), 'Frosted glass panels (may cost GPU)', toggle('ui.blur', () => theme.refresh(state.settings))));
    effects.append(row(t('settings.radius'), '', rangeControl('ui.corner_radius', { min: 0, max: 26, step: 1, format: (v) => `${v}px`, onChange: () => theme.refresh(state.settings) })));
    effects.append(row(t('settings.content_width'), '', rangeControl('ui.content_width', { min: 560, max: 1400, step: 20, format: (v) => `${v}px`, onChange: () => theme.refresh(state.settings) })));
    effects.append(row(t('settings.message_spacing'), '', rangeControl('ui.message_spacing', { min: 6, max: 48, step: 1, format: (v) => `${v}px`, onChange: () => theme.refresh(state.settings) })));
    effects.append(row(t('settings.sound'), 'Short sound when a run finishes', toggle('ui.sound')));
    host.append(effects);

    const chat = block('Chat');
    chat.append(row(t('settings.show_monitor'), 'Right panel with activity, plan, files and terminal', toggle('ui.show_monitor', (value) => bus.emit('ui:set-monitor', value))));
    chat.append(row(t('settings.timestamps'), '', toggle('ui.show_timestamps', () => bus.emit('messages:changed'))));
    chat.append(row(t('settings.avatars'), '', toggle('ui.show_avatars', () => bus.emit('messages:changed'))));
    chat.append(row(t('settings.token_stats'), '', toggle('ui.show_token_stats', () => bus.emit('messages:changed'))));
    chat.append(row(t('settings.markdown'), '', toggle('ui.markdown', () => bus.emit('messages:changed'))));
    chat.append(row(t('settings.stream_smooth'), 'Throttled re-render while streaming', toggle('ui.stream_smooth')));
    chat.append(row(t('settings.code_wrap'), '', toggle('ui.code_wrap', () => theme.refresh(state.settings))));
    chat.append(row(t('settings.code_lines'), '', toggle('ui.code_line_numbers')));
    chat.append(row(t('settings.compact_tools'), '', toggle('ui.compact_tool_cards', () => bus.emit('messages:changed'))));
    chat.append(row(t('settings.confirm_close'), '', toggle('ui.confirm_on_close')));
    host.append(chat);

    const css = block(t('settings.custom_css'));
    css.append(row(t('settings.custom_css'), t('settings.custom_css_hint'), textareaControl('ui.custom_css', { rows: 7, placeholder: '.msg-user .msg-content { border-radius: 18px; }', onChange: (value) => theme.applyCustomCss(value) }), true));
    css.append(el('div', { class: 'row' }, [
      el('button', {
        class: 'btn ghost',
        text: t('common.reset'),
        onclick: async () => {
          await setSetting('ui.custom_css', '');
          theme.applyCustomCss('');
          clear(host);
          BUILDERS.appearance(host);
        },
      }),
    ]));
    host.append(css);
  },

  hotkeys(host) {
    host.append(header(t('settings.hotkeys'), t('settings.hotkeys_hint')));
    const list = block();
    const hotkeys = setting('hotkeys', {}) || {};
    Object.entries(hotkeys).forEach(([key, value]) => {
      const label = t(`settings.hotkey.${key}`) === `settings.hotkey.${key}` ? key : t(`settings.hotkey.${key}`);
      const button = el('button', { class: 'btn mono', text: value, style: { minWidth: '140px' } });
      button.addEventListener('click', () => {
        button.textContent = '...';
        button.classList.add('loading');
        const handler = async (event) => {
          event.preventDefault();
          const parts = [];
          if (event.ctrlKey) parts.push('Ctrl');
          if (event.metaKey) parts.push('Cmd');
          if (event.altKey) parts.push('Alt');
          if (event.shiftKey) parts.push('Shift');
          const keyName = event.key.length === 1 ? event.key.toUpperCase() : event.key;
          if (!['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) parts.push(keyName);
          if (parts.length && !['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) {
            const combo = parts.join('+');
            await setSetting(`hotkeys.${key}`, combo);
            button.textContent = combo;
            button.classList.remove('loading');
            document.removeEventListener('keydown', handler, true);
            bus.emit('hotkeys:changed');
            notify.ok(t('common.saved'), `${label}: ${combo}`);
          }
        };
        const cancel = (event) => {
          if (event.key === 'Escape') {
            button.textContent = value;
            button.classList.remove('loading');
            document.removeEventListener('keydown', handler, true);
            document.removeEventListener('keydown', cancel, true);
          }
        };
        document.addEventListener('keydown', handler, true);
        document.addEventListener('keydown', cancel, true);
      });
      list.append(row(label, '', button));
    });
    list.append(el('div', { class: 'row', style: { marginTop: '10px' } }, [
      el('button', {
        class: 'btn ghost',
        text: t('settings.hotkey.reset'),
        onclick: async () => {
          await setSetting('hotkeys', state.defaults?.hotkeys || {});
          bus.emit('hotkeys:changed');
          notify.ok(t('common.saved'));
          clear(host);
          BUILDERS.hotkeys(host);
        },
      }),
    ]));
    host.append(list);
  },

  data(host) {
    host.append(header(t('settings.data'), t('settings.data_hint')));

    const stats = block(t('settings.stats'));
    stats.append(el('div', { class: 'info-row' }, [el('span', { class: 'k', text: t('settings.data_dir') }), el('span', { class: 'v', text: state.system?.data_dir || '~/.dagent' })]));
    stats.append(el('div', { class: 'info-row' }, [el('span', { class: 'k', text: t('settings.sessions_count') }), el('span', { class: 'v', text: String(state.info?.sessions ?? state.sessions?.length ?? 0) })]));
    stats.append(el('div', { class: 'info-row' }, [el('span', { class: 'k', text: t('settings.messages_count') }), el('span', { class: 'v', text: String(state.info?.messages ?? 0) })]));
    stats.append(el('div', { class: 'info-row' }, [el('span', { class: 'k', text: 'Runs' }), el('span', { class: 'v', text: String(state.info?.runs ?? 0) })]));
    host.append(stats);

    const sessions = block('Sessions');
    sessions.append(el('div', { class: 'row wrap' }, [
      el('button', {
        class: 'btn',
        html: `${icon('export', 14)} ${esc(t('settings.export_all'))}`,
        onclick: async () => {
          const data = await api.sessions('');
          const payload = [];
          for (const session of data.sessions || []) {
            const full = await api.session(session.id);
            payload.push({ session: full.session, messages: full.messages });
          }
          downloadFile(`dagent-sessions-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ sessions: payload }, null, 2), 'application/json');
          notify.ok(t('common.export'), `${payload.length} sessions`);
        },
      }),
      (() => {
        const input = el('input', { type: 'file', accept: '.json', style: { display: 'none' } });
        input.addEventListener('change', async () => {
          const file = input.files?.[0];
          if (!file) return;
          try {
            const parsed = JSON.parse(await file.text());
            const items = parsed.sessions || [parsed];
            let count = 0;
            for (const item of items) {
              if (!item.messages) continue;
              await api.importSession(item);
              count += 1;
            }
            notify.ok(t('common.import'), `${count} sessions`);
            const data = await api.sessions('');
            state.sessions = data.sessions || [];
            bus.emit('sessions:loaded', state.sessions);
          } catch (error) {
            notify.error(t('common.error'), error.message);
          }
        });
        return [el('button', { class: 'btn', html: `${icon('upload', 14)} ${esc(t('settings.import_data'))}`, onclick: () => input.click() }), input];
      })(),
      el('button', {
        class: 'btn danger',
        html: `${icon('trash', 14)} ${esc(t('settings.delete_all'))}`,
        onclick: async () => {
          const ok = await confirmDialog({ title: t('settings.delete_all_confirm'), text: '', okText: t('common.delete'), danger: true });
          if (!ok) return;
          const data = await api.sessions('');
          for (const session of data.sessions || []) await api.deleteSession(session.id);
          state.sessions = [];
          state.currentSessionId = null;
          state.messages = [];
          bus.emit('sessions:loaded', []);
          bus.emit('messages:changed');
          notify.info(t('toast.session_deleted'));
        },
      }),
    ]));
    host.append(sessions);

    const settingsBlock = block('Settings');
    settingsBlock.append(el('div', { class: 'row wrap' }, [
      el('button', {
        class: 'btn',
        html: `${icon('export', 14)} ${esc(t('settings.export_settings'))}`,
        onclick: async () => {
          const data = await api.getSettings();
          downloadFile('dagent-settings.json', JSON.stringify(data, null, 2), 'application/json');
        },
      }),
      (() => {
        const input = el('input', { type: 'file', accept: '.json', style: { display: 'none' } });
        input.addEventListener('change', async () => {
          const file = input.files?.[0];
          if (!file) return;
          try {
            const parsed = JSON.parse(await file.text());
            await api.importSettings(parsed);
            const fresh = await api.getSettings();
            state.settings = fresh;
            setLanguage(fresh.app?.language || 'ru');
            applyTranslations(document);
            theme.refresh(state.settings);
            notify.ok(t('common.import'));
            bus.emit('settings:imported', fresh);
          } catch (error) {
            notify.error(t('common.error'), error.message);
          }
        });
        return [el('button', { class: 'btn', html: `${icon('upload', 14)} ${esc(t('settings.import_settings'))}`, onclick: () => input.click() }), input];
      })(),
      el('button', {
        class: 'btn danger',
        html: `${icon('undo', 14)} ${esc(t('settings.reset_settings'))}`,
        onclick: async () => {
          const ok = await confirmDialog({ title: t('settings.reset_confirm'), text: '', okText: t('common.reset'), danger: true });
          if (!ok) return;
          const result = await api.resetSettings(true);
          state.settings = result.settings;
          setLanguage(state.settings.app?.language || 'ru');
          applyTranslations(document);
          theme.refresh(state.settings);
          bus.emit('settings:imported', state.settings);
          notify.ok(t('common.reset'));
          dialogHandle?.close();
        },
      }),
    ]));
    host.append(settingsBlock);
  },

  about(host) {
    const hero = el('div', { class: 'about-hero' });
    hero.append(el('div', { class: 'logo-big', html: `<svg viewBox="0 0 64 64" width="86" height="86"><defs><linearGradient id="abg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="var(--accent)"/><stop offset="100%" stop-color="var(--accent-2)"/></linearGradient></defs><path d="M32 5 56 18.5v27L32 59 8 45.5v-27z" fill="none" stroke="url(#abg)" stroke-width="2.6" stroke-linejoin="round"/><circle cx="32" cy="32" r="8.5" fill="url(#abg)" opacity=".9"/><path d="M32 13v8M32 43v8M15 22l7 4M42 38l7 4M49 22l-7 4M22 38l-7 4" stroke="url(#abg)" stroke-width="2.4" stroke-linecap="round" opacity=".8"/></svg>` }));
    hero.append(el('h2', { class: 'empty-title', text: 'DAGENT' }));
    hero.append(el('div', { class: 'row wrap', style: { justifyContent: 'center' } }, [
      el('span', { class: 'tag accent', text: `v${state.version || '1.0.0'}` }),
      el('span', { class: 'tag', text: `${t('settings.creator')}: @frizovdanya` }),
      el('span', { class: 'tag', text: 'MIT' }),
    ]));
    hero.append(el('p', { class: 'dim', style: { maxWidth: '62ch', marginTop: '8px' }, text: t('settings.about_text') }));
    const links = el('div', { class: 'about-links' });
    links.append(el('a', { class: 'btn accent', href: 'https://t.me/frizovdanya', target: '_blank', rel: 'noopener noreferrer', html: `${icon('telegram', 15)} @frizovdanya` }));
    links.append(el('a', { class: 'btn', href: 'https://github.com/frizovdanyash/DAGENT', target: '_blank', rel: 'noopener noreferrer', html: `${icon('github', 15)} GitHub` }));
    hero.append(links);
    host.append(hero);

    const toolsBlock = block(`Tools (${(state.tools || []).length})`);
    const grid = el('div', { class: 'cards-grid' });
    (state.tools || []).forEach((tool) => {
      const card = el('div', { class: 'pick-card', style: { cursor: 'default' } });
      card.append(el('span', { class: 'pc-title', html: `${icon(TOOL_ICONS[tool.name] || 'wrench', 15)} ${esc(tool.name)}` }));
      card.append(el('span', { class: 'pc-sub', text: truncate(tool.description, 120) }));
      grid.append(card);
    });
    toolsBlock.append(grid);
    host.append(toolsBlock);

    const modesBlock = block(t('modes.title'));
    const modeGrid = el('div', { class: 'cards-grid' });
    (state.modes || []).forEach((mode) => {
      const card = el('div', { class: 'pick-card', style: { cursor: 'default' } });
      card.append(el('span', { class: 'pc-title', html: `${icon(MODE_ICONS[mode.id] || 'wand', 15)} ${esc(mode.name)}` }));
      card.append(el('span', { class: 'pc-sub', text: mode.description || mode.tagline || '' }));
      card.append(el('span', { class: 'tag', text: `${(mode.tools || []).length} tools${mode.auto_approve ? ' · auto' : ''}` }));
      modeGrid.append(card);
    });
    modesBlock.append(modeGrid);
    host.append(modesBlock);

    const sys = block(t('monitor.system'));
    const system = state.system || {};
    [
      ['OS', `${system.os || ''} ${system.os_release || ''} (${system.machine || ''})`],
      ['Python', system.python || ''],
      ['Host', `${system.hostname || ''} · ${system.user || ''}`],
      ['CPU', `${system.cpu_count || '?'} cores`],
      ['Data', system.data_dir || ''],
      ['Uptime', `${Math.round((system.uptime_seconds || state.info?.uptime_seconds || 0) / 60)} min`],
    ].forEach(([key, value]) => sys.append(el('div', { class: 'info-row' }, [el('span', { class: 'k', text: key }), el('span', { class: 'v', text: String(value) })])));
    host.append(sys);

    host.append(el('div', { class: 'divider' }));
    host.append(el('p', { class: 'center dim small', text: t('settings.thanks') }));
  },
};

/* ------------------------------------------------------------------ */

async function applyWorkspace(path) {
  if (!path) return;
  try {
    const result = await api.setWorkspace(path);
    state.workspace = result.workspace;
    await setSetting('workspace.root', result.workspace.root);
    bus.emit('workspace:changed', result.workspace);
    notify.ok(t('toast.workspace_changed'), result.workspace.root);
  } catch (error) {
    notify.error(t('common.error'), error.message);
  }
}

export function closeSettings() {
  dialogHandle?.close();
}

export function isSettingsOpen() {
  return Boolean(dialogHandle);
}
