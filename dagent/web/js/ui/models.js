/** Model manager: profile list, editor dialog, connection tests, GGUF helpers. */

import { $, el, esc, clear, truncate, humanSize } from '../dom.js';
import { icon } from '../icons.js';
import { t, getLanguage } from '../i18n.js';
import { api } from '../api.js';
import { bus, state, setting, setSetting } from '../state.js';
import { notify } from './toast.js';
import { openDialog, confirmDialog } from './modal.js';
import { openDropdown } from './dropdown.js';
import { pickPath } from './filepicker.js';

const PRESET_GROUPS = {
  cloud: ['openai', 'openrouter', 'deepseek', 'groq', 'mistral', 'together', 'fireworks', 'xai', 'moonshot', 'qwen', 'siliconflow', 'anthropic_proxy'],
  local: ['lmstudio', 'ollama', 'llamacpp', 'vllm', 'koboldcpp'],
  other: ['custom'],
};

const CHAT_FORMATS = ['auto', 'chatml', 'llama-2', 'llama-3', 'llama-3.1', 'mistral-instruct', 'openchat', 'vicuna', 'zephyr', 'gemma', 'qwen', 'deepseek', 'deepseek2', 'deepseek3', 'command-r', 'phi-3', 'orion'];

export function presetById(id) {
  return (state.providers?.presets || []).find((preset) => preset.id === id) || null;
}

/* ------------------------------------------------------------------ */
/* profile list                                                        */
/* ------------------------------------------------------------------ */

export function renderModelList(host, options = {}) {
  clear(host);
  const models = state.models || [];
  if (!models.length) {
    host.append(el('div', { class: 'empty-mini', text: t('models.empty') }));
  }
  for (const model of models) {
    host.append(modelCard(model, options));
  }
  const addRow = el('div', { class: 'row', style: { marginTop: '10px' } });
  addRow.append(el('button', {
    class: 'btn accent',
    html: `${icon('plus', 15)} ${esc(t('models.add'))}`,
    onclick: () => openModelEditor(null, options.onSaved),
  }));
  addRow.append(el('button', {
    class: 'btn ghost',
    html: `${icon('database', 15)} ${esc(t('models.unload'))}`,
    title: t('models.unload'),
    onclick: async () => {
      await api.unloadGguf();
      notify.info(t('models.unload'));
    },
  }));
  host.append(addRow);
}

export function modelCard(model, options = {}) {
  const isGguf = model.kind === 'gguf' || model.kind === 'local';
  const isActive = state.activeModel?.id === model.id;
  const card = el('div', { class: `model-card${isActive ? ' active' : ''}` });

  card.append(el('span', { class: 'mc-icon', html: icon(isGguf ? 'cpu' : model.kind === 'anthropic' ? 'sparkle' : 'cloud', 18) }));

  const main = el('div', { class: 'mc-main' });
  const name = el('div', { class: 'mc-name' });
  name.append(el('span', { text: model.name || model.model || 'model' }));
  if (isActive) name.append(el('span', { class: 'tag accent', text: t('models.active') }));
  if (model.favorite) name.append(el('span', { class: 'tag warn', html: icon('star', 10) }));
  if (!isGguf && model.has_api_key) name.append(el('span', { class: 'tag ok', html: `${icon('key', 10)} ${esc(model.api_key_masked || 'key')}` }));
  main.append(name);
  main.append(el('div', {
    class: 'mc-sub',
    text: isGguf
      ? `${model.gguf_path || ''}`
      : `${model.provider_label || model.provider_preset || 'API'} · ${model.model || ''} · ${model.base_url || ''}`,
  }));

  const params = model.params || {};
  const caps = model.capabilities || {};
  const chips = el('div', { class: 'row wrap', style: { marginTop: '6px' } });
  if (caps.context_window) chips.append(el('span', { class: 'tag', text: `ctx ${caps.context_window}` }));
  if (params.temperature !== undefined) chips.append(el('span', { class: 'tag', text: `temp ${params.temperature}` }));
  if (params.max_tokens) chips.append(el('span', { class: 'tag', text: `max ${params.max_tokens}` }));
  if (isGguf && model.gguf_options?.n_gpu_layers) chips.append(el('span', { class: 'tag', text: `gpu ${model.gguf_options.n_gpu_layers}` }));
  chips.append(el('span', { class: 'tag', text: caps.native_tools === false ? 'JSON protocol' : 'native tools' }));
  if (chips.children.length) main.append(chips);
  card.append(main);

  const actions = el('div', { class: 'mc-actions' });
  actions.append(el('button', {
    class: `btn tiny ${isActive ? '' : 'outline'}`,
    text: isActive ? t('common.active') : t('common.activate'),
    disabled: isActive,
    onclick: async () => {
      await api.activateModel(model.id, state.currentSessionId || '');
      await refreshModels();
      options.onActivate?.(model);
      notify.ok(t('toast.model_switched'), model.name || '');
    },
  }));
  actions.append(el('button', {
    class: 'btn tiny ghost',
    text: t('models.test'),
    onclick: async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = t('models.testing');
      try {
        const result = await api.testModel(model.id);
        if (result.ok) notify.ok(t('models.test_ok'), `${truncate(result.message || '', 90)} · ${result.latency_ms} ms`);
        else notify.error(t('models.test_fail'), `${result.message || ''}${result.hint ? `\n${result.hint}` : ''}`);
      } catch (error) {
        notify.error(t('models.test_fail'), error.message);
      } finally {
        button.disabled = false;
        button.textContent = t('models.test');
      }
    },
  }));
  actions.append(el('button', { class: 'btn tiny ghost', html: icon('pencil', 13), title: t('common.edit'), onclick: () => openModelEditor(model, options.onSaved) }));
  actions.append(el('button', { class: 'btn tiny ghost', html: icon('copy', 13), title: t('cmd.duplicate'), onclick: async () => { await api.duplicateModel(model.id); await refreshModels(); } }));
  actions.append(el('button', {
    class: 'icon-btn tiny ghost danger',
    html: icon('trash', 13),
    title: t('common.delete'),
    onclick: async () => {
      const ok = await confirmDialog({ title: t('models.delete_confirm'), text: model.name || '', okText: t('common.delete'), danger: true });
      if (!ok) return;
      await api.deleteModel(model.id);
      await refreshModels();
      notify.info(t('common.delete'));
    },
  }));
  card.append(actions);
  return card;
}

export async function refreshModels() {
  try {
    const data = await api.models();
    state.models = data.profiles || [];
    state.providers = data.status || state.providers;
    state.activeModel = state.models.find((item) => item.id === data.active_id) || state.models[0] || null;
    bus.emit('models:loaded', state.models);
  } catch (error) {
    notify.error(t('common.error'), error.message);
  }
}

/* ------------------------------------------------------------------ */
/* editor dialog                                                       */
/* ------------------------------------------------------------------ */

export function openModelEditor(existing = null, onSaved = null) {
  const profile = existing ? JSON.parse(JSON.stringify(existing)) : {
    kind: 'api',
    provider_preset: 'openai',
    name: '',
    base_url: presetById('openai')?.base_url || 'https://api.openai.com/v1',
    api_key: '',
    model: '',
    gguf_path: '',
    params: { temperature: 0.7, top_p: 0.95, max_tokens: 2048 },
    capabilities: { native_tools: true, context_window: 8192, vision: false },
    gguf_options: { n_ctx: 8192, n_gpu_layers: 0, chat_format: 'auto' },
    extra_headers: {},
    extra_body: {},
  };
  if (profile.provider_preset === 'anthropic') profile.kind = 'anthropic';

  let kind = profile.gguf_path ? 'gguf' : profile.kind === 'anthropic' ? 'api' : 'api';
  const isLocalPreset = ['lmstudio', 'ollama', 'llamacpp', 'vllm', 'koboldcpp'].includes(profile.provider_preset || '');
  if (isLocalPreset && !profile.api_key) kind = 'server';

  const body = el('div', { class: 'col' });

  // kind selector
  const kindRow = el('div', { class: 'segmented' });
  const kinds = [
    { id: 'api', label: t('models.api'), icon: 'cloud' },
    { id: 'server', label: t('models.server'), icon: 'server' },
    { id: 'gguf', label: t('models.gguf'), icon: 'cpu' },
  ];
  kinds.forEach((item) => {
    const button = el('button', {
      class: kind === item.id ? 'active' : '',
      html: `${icon(item.icon, 13)} ${esc(item.label)}`,
      onclick: () => {
        kind = item.id;
        kindRow.querySelectorAll('button').forEach((node, index) => node.classList.toggle('active', kinds[index].id === kind));
        renderForm();
      },
    });
    kindRow.append(button);
  });
  body.append(el('div', { class: 'field' }, [el('div', { class: 'label', text: t('models.provider') }), kindRow]));

  const form = el('div', { class: 'col' });
  body.append(form);

  const fields = {};

  function input(name, label, value, opts = {}) {
    const node = el('input', { class: `input-t ${opts.mono ? 'mono' : ''}`, type: opts.type || 'text', value: value ?? '', placeholder: opts.placeholder || '' });
    if (opts.autofocus) node.dataset.autofocus = 'true';
    fields[name] = node;
    return el('div', { class: 'field' }, [
      el('div', { class: 'label', html: `${esc(label)}${opts.required ? ' <span class="req">*</span>' : ''}` }),
      node,
      opts.hint ? el('div', { class: 'hint', html: esc(opts.hint) }) : null,
    ]);
  }

  function select(name, label, value, options, opts = {}) {
    const node = el('select', { class: 'input-t' });
    options.forEach((option) => {
      const opt = el('option', { value: option.value ?? option.id ?? option, text: option.label ?? option });
      if ((option.value ?? option.id ?? option) === value) opt.selected = true;
      node.append(opt);
    });
    fields[name] = node;
    return el('div', { class: 'field' }, [
      el('div', { class: 'label', text: label }),
      node,
      opts.hint ? el('div', { class: 'hint', text: opts.hint }) : null,
    ]);
  }

  function numberField(name, label, value, opts = {}) {
    const node = el('input', { class: 'input-t', type: 'number', value: value ?? '', min: opts.min ?? '', max: opts.max ?? '', step: opts.step ?? '1' });
    fields[name] = node;
    return el('div', { class: 'field' }, [el('div', { class: 'label', text: label }), node, opts.hint ? el('div', { class: 'hint', text: opts.hint }) : null]);
  }

  function switchField(name, label, value, hint = '') {
    const node = el('input', { type: 'checkbox' });
    node.checked = Boolean(value);
    fields[name] = node;
    return el('label', { class: 'switch' }, [
      node,
      el('span', { class: 'track' }, [el('span', { class: 'thumb' })]),
      el('span', { class: 'switch-label', text: label }),
      hint ? el('span', { class: 'hint', text: hint }) : null,
    ]);
  }

  function renderForm() {
    clear(form);
    Object.keys(fields).forEach((key) => delete fields[key]);

    if (kind === 'gguf') {
      const ggufStatus = state.providers || {};
      if (!ggufStatus.llama_cpp_installed) {
        const warn = el('div', { class: 'approval', dataset: { risk: 'high' } });
        warn.append(el('div', { class: 'approval-title', html: `${icon('alert', 15)} ${esc(t('models.llama_missing'))}` }));
        warn.append(el('div', { class: 'approval-preview', text: ggufStatus.llama_cpp_hint || 'pip install llama-cpp-python' }));
        const actions = el('div', { class: 'approval-actions' });
        actions.append(el('button', {
          class: 'btn tiny',
          text: t('common.copy'),
          onclick: () => navigator.clipboard?.writeText('pip install llama-cpp-python'),
        }));
        actions.append(el('button', {
          class: 'btn tiny ghost',
          text: t('models.server'),
          onclick: () => {
            kind = 'server';
            renderForm();
          },
        }));
        warn.append(actions);
        form.append(warn);
      }

      form.append(input('name', t('models.name'), profile.name, { placeholder: 'Qwen2.5 7B Q4' }));

      const pathRow = el('div', { class: 'field-row' });
      const pathField = input('gguf_path', `${t('models.gguf_file')} *`, profile.gguf_path, { mono: true, placeholder: '/home/user/models/model.gguf' });
      pathRow.append(pathField);
      const pickBtn = el('button', {
        class: 'btn',
        html: `${icon('folderOpen', 14)} ${esc(t('models.browse'))}`,
        onclick: async () => {
          const picked = await pickPath({
            mode: 'file',
            title: t('models.gguf_file'),
            filter: (entry) => entry.name.toLowerCase().endsWith('.gguf'),
            hint: t('models.gguf_hint'),
          });
          if (picked) {
            fields.gguf_path.value = picked;
            if (!fields.name.value) fields.name.value = picked.split(/[\\/]/).pop().replace(/\.gguf$/i, '');
          }
        },
      });
      const scanBtn = el('button', {
        class: 'btn ghost',
        html: `${icon('search', 14)} ${esc(t('models.scan'))}`,
        onclick: async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            const result = await api.scanGguf([], true, true);
            if (!result.files.length) {
              notify.info(t('models.scan'), '0 .gguf');
              return;
            }
            openDropdown({
              anchor: button,
              searchable: true,
              width: 460,
              placeholder: t('models.search'),
              items: result.files.map((file) => ({
                title: file.name,
                sub: `${file.path} · ${humanSize(file.size_mb * 1024 * 1024)}${file.quant ? ` · ${file.quant}` : ''}`,
                icon: 'cpu',
                onClick: () => {
                  fields.gguf_path.value = file.path;
                  if (!fields.name.value) fields.name.value = file.name.replace(/\.gguf$/i, '');
                },
              })),
            });
          } catch (error) {
            notify.error(t('common.error'), error.message);
          } finally {
            button.disabled = false;
          }
        },
      });
      pathRow.append(el('div', { class: 'field' }, [el('div', { class: 'label', text: '' }), el('div', { class: 'row' }, [pickBtn, scanBtn])]));
      form.append(pathRow);

      const ctxRow = el('div', { class: 'field-row' });
      ctxRow.append(numberField('n_ctx', t('models.n_ctx'), profile.gguf_options?.n_ctx ?? setting('gguf.n_ctx', 8192), { min: 512, step: 512 }));
      ctxRow.append(numberField('n_gpu_layers', t('models.gpu_layers'), profile.gguf_options?.n_gpu_layers ?? setting('gguf.n_gpu_layers', 0), { min: 0, max: 200 }));
      ctxRow.append(numberField('n_threads', 'Threads', profile.gguf_options?.n_threads ?? 0, { min: 0, max: 128, hint: '0 = auto' }));
      form.append(ctxRow);

      form.append(select('chat_format', t('models.chat_format'), profile.gguf_options?.chat_format || 'auto', CHAT_FORMATS));
      form.append(switchField('native_tools', t('models.native_tools'), profile.capabilities?.native_tools !== false, t('models.native_tools_hint')));
      form.append(el('div', { class: 'hint', text: t('models.gguf_hint') }));
      return;
    }

    // API / local server
    const presets = state.providers?.presets || [];
    const presetOptions = [
      { label: `— ${t('models.api')} —`, value: '__group_cloud', disabled: true },
      ...PRESET_GROUPS.cloud.map((id) => presets.find((p) => p.id === id)).filter(Boolean).map((p) => ({ label: p.label, value: p.id })),
      { label: `— local —`, value: '__group_local', disabled: true },
      ...PRESET_GROUPS.local.map((id) => presets.find((p) => p.id === id)).filter(Boolean).map((p) => ({ label: p.label, value: p.id })),
      { label: 'Custom', value: 'custom' },
    ];
    const presetValue = kind === 'server'
      ? (profile.provider_preset && PRESET_GROUPS.local.includes(profile.provider_preset) ? profile.provider_preset : 'lmstudio')
      : profile.provider_preset || 'openai';
    const presetField = select('preset', t('models.provider'), presetValue, presetOptions);
    form.append(presetField);

    form.append(input('name', t('models.name'), profile.name, { placeholder: kind === 'server' ? 'LM Studio' : 'GPT-4o mini', autofocus: !existing }));
    form.append(input('base_url', `${t('models.base_url')} *`, profile.base_url || presetById(presetValue)?.base_url || '', {
      mono: true,
      placeholder: presetById(presetValue)?.base_url || 'https://api.openai.com/v1',
      hint: kind === 'server' ? 'LM Studio: http://localhost:1234/v1 · Ollama: http://localhost:11434/v1 · llama.cpp: http://localhost:8080/v1' : '',
    }));

    if (kind === 'api' || profile.api_key || (presetValue !== 'lmstudio' && presetValue !== 'ollama' && presetValue !== 'llamacpp')) {
      const keyRow = el('div', { class: 'field' });
      const keyInput = el('input', { class: 'input-t mono', type: 'password', value: existing?.has_api_key ? '' : profile.api_key || '', placeholder: existing?.has_api_key ? existing.api_key_masked || '••••' : 'sk-...' });
      fields.api_key = keyInput;
      const wrapRow = el('div', { class: 'row' });
      wrapRow.append(keyInput);
      wrapRow.append(el('button', {
        class: 'icon-btn ghost',
        html: icon('eye', 15),
        title: 'Show',
        onclick: (event) => {
          keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
          event.currentTarget.innerHTML = icon(keyInput.type === 'password' ? 'eye' : 'eyeOff', 15);
        },
      }));
      keyRow.append(el('div', { class: 'label', text: t('models.api_key') }));
      keyRow.append(wrapRow);
      keyRow.append(el('div', { class: 'hint', text: t('models.key_hint') }));
      form.append(keyRow);
    }

    const modelRow = el('div', { class: 'field' });
    const modelInput = el('input', { class: 'input-t mono', type: 'text', value: profile.model || '', placeholder: 'gpt-4o-mini / qwen2.5:7b / local-model' });
    fields.model = modelInput;
    const modelRowLine = el('div', { class: 'row' });
    modelRowLine.append(modelInput);
    const fetchBtn = el('button', {
      class: 'btn ghost',
      html: `${icon('download', 14)} ${esc(t('models.fetch_list'))}`,
      onclick: async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const payload = collect(kind);
          if (existing?.id) payload.id = existing.id;
          const result = await api.probeModel({ ...payload, list_only: true });
          if (!result.ok && !result.models?.length) {
            notify.error(t('common.error'), `${result.error || ''}${result.hint ? `\n${result.hint}` : ''}`);
            return;
          }
          openDropdown({
            anchor: button,
            searchable: true,
            width: 460,
            placeholder: t('models.search'),
            emptyText: 'No models returned',
            items: (result.models || []).map((name) => ({
              title: name,
              icon: 'box',
              onClick: () => {
                modelInput.value = name;
                if (!fields.name.value) fields.name.value = name;
              },
            })),
          });
        } catch (error) {
          notify.error(t('common.error'), error.message);
        } finally {
          button.disabled = false;
        }
      },
    });
    modelRowLine.append(fetchBtn);
    modelRow.append(el('div', { class: 'label', html: `${esc(t('models.model_id'))} <span class="req">*</span>` }));
    modelRow.append(modelRowLine);
    form.append(modelRow);

    const paramRow = el('div', { class: 'field-row' });
    paramRow.append(numberField('context_window', t('models.context'), profile.capabilities?.context_window ?? 8192, { min: 512, step: 512 }));
    paramRow.append(numberField('max_tokens', t('settings.max_tokens'), profile.params?.max_tokens ?? 2048, { min: 64, step: 64 }));
    const tempField = el('input', { class: 'input-t', type: 'number', step: '0.05', min: '0', max: '2', value: profile.params?.temperature ?? 0.7 });
    fields.temperature = tempField;
    paramRow.append(el('div', { class: 'field' }, [el('div', { class: 'label', text: t('settings.temperature') }), tempField]));
    form.append(paramRow);

    form.append(switchField('native_tools', t('models.native_tools'), profile.capabilities?.native_tools !== false, t('models.native_tools_hint')));
    form.append(switchField('favorite', '★ Favorite', Boolean(profile.favorite)));

    const details = el('details', { class: 'reasoning' });
    details.append(el('summary', { text: t('models.advanced') }));
    const detailsBody = el('div', { class: 'col', style: { marginTop: '8px' } });
    const headersInput = el('textarea', { class: 'input-t', placeholder: '{"HTTP-Referer": "https://my.app"}' });
    headersInput.value = Object.keys(profile.extra_headers || {}).length ? JSON.stringify(profile.extra_headers, null, 2) : '';
    fields.extra_headers = headersInput;
    const bodyInput = el('textarea', { class: 'input-t', placeholder: '{"top_k": 40}' });
    bodyInput.value = Object.keys(profile.extra_body || {}).length ? JSON.stringify(profile.extra_body, null, 2) : '';
    fields.extra_body = bodyInput;
    detailsBody.append(el('div', { class: 'field' }, [el('div', { class: 'label', text: 'Extra headers (JSON)' }), headersInput]));
    detailsBody.append(el('div', { class: 'field' }, [el('div', { class: 'label', text: 'Extra body params (JSON)' }), bodyInput]));
    detailsBody.append(input('notes', 'Notes', profile.notes || '', { placeholder: 'Why this profile exists' }));
    details.append(detailsBody);
    form.append(details);
  }

  function collect(currentKind) {
    const value = (name) => fields[name]?.value ?? '';
    const checked = (name) => Boolean(fields[name]?.checked);
    if (currentKind === 'gguf') {
      return {
        kind: 'gguf',
        name: value('name') || (value('gguf_path').split(/[\\/]/).pop() || 'GGUF model').replace(/\.gguf$/i, ''),
        gguf_path: value('gguf_path'),
        model: value('gguf_path').split(/[\\/]/).pop() || 'gguf',
        gguf_options: {
          n_ctx: Number(value('n_ctx')) || 8192,
          n_gpu_layers: Number(value('n_gpu_layers')) || 0,
          n_threads: Number(value('n_threads')) || 0,
          chat_format: value('chat_format') || 'auto',
        },
        capabilities: { native_tools: checked('native_tools'), context_window: Number(value('n_ctx')) || 8192, emulate_tool_role: true },
      };
    }
    const preset = value('preset') || 'custom';
    const presetData = presetById(preset) || {};
    return {
      kind: preset === 'anthropic_proxy' ? 'anthropic' : 'api',
      provider_preset: preset === 'anthropic_proxy' ? 'anthropic' : preset,
      provider_label: presetData.label || preset,
      name: value('name') || value('model') || preset,
      base_url: value('base_url') || presetData.base_url || '',
      api_key: value('api_key') || '',
      model: value('model'),
      params: {
        temperature: Number(fields.temperature?.value ?? 0.7),
        max_tokens: Number(value('max_tokens')) || 2048,
        top_p: Number(profile.params?.top_p ?? 0.95),
      },
      capabilities: {
        native_tools: checked('native_tools'),
        context_window: Number(value('context_window')) || 8192,
        vision: Boolean(profile.capabilities?.vision),
      },
      favorite: checked('favorite'),
      notes: value('notes') || '',
      extra_headers: parseJson(value('extra_headers'), {}),
      extra_body: parseJson(value('extra_body'), {}),
    };
  }

  const footer = el('div', { class: 'row' });
  const status = el('div', { class: 'hint grow', text: '' });
  const testBtn = el('button', {
    class: 'btn',
    html: `${icon('zap', 14)} ${esc(t('models.test'))}`,
    onclick: async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      status.textContent = t('models.testing');
      try {
        const payload = collect(kind);
        const result = await api.probeModel(payload);
        if (result.ok) {
          status.textContent = `${t('models.test_ok')} · ${result.latency_ms || 0} ms`;
          notify.ok(t('models.test_ok'), truncate(result.message || '', 120));
        } else {
          status.textContent = `${result.error || ''} ${result.hint || ''}`.trim();
          notify.error(t('models.test_fail'), `${result.error || ''}\n${result.hint || ''}`);
        }
      } catch (error) {
        status.textContent = error.message;
        notify.error(t('models.test_fail'), error.message);
      } finally {
        button.disabled = false;
      }
    },
  });
  const cancelBtn = el('button', { class: 'btn ghost', text: t('common.cancel'), onclick: () => handle.close() });
  const saveBtn = el('button', {
    class: 'btn accent',
    html: `${icon('save', 14)} ${esc(t('common.save'))}`,
    onclick: async () => {
      const payload = collect(kind);
      if (kind === 'gguf' && !payload.gguf_path) {
        notify.warn(t('common.error'), t('models.gguf_file'));
        return;
      }
      if (kind !== 'gguf' && !payload.model) {
        notify.warn(t('common.error'), t('models.model_id'));
        return;
      }
      saveBtn.disabled = true;
      try {
        if (existing?.id) {
          if (!payload.api_key) delete payload.api_key;
          await api.updateModel(existing.id, payload);
        } else {
          await api.createModel({ ...payload, activate: !state.models.length });
        }
        await refreshModels();
        notify.ok(t('models.saved'), payload.name);
        onSaved?.(payload);
        handle.close();
      } catch (error) {
        notify.error(t('common.error'), error.message);
      } finally {
        saveBtn.disabled = false;
      }
    },
  });
  footer.append(status, el('div', { class: 'spacer' }), testBtn, cancelBtn, saveBtn);

  const handle = openDialog({
    title: existing ? `${t('common.edit')}: ${existing.name || ''}` : t('models.add'),
    subtitle: t('models.subtitle'),
    icon: existing ? 'pencil' : 'plus',
    size: 'medium',
    body,
    footer: [footer],
  });

  renderForm();
  return handle;
}

function parseJson(text, fallback) {
  if (!text || !String(text).trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch (error) {
    notify.warn('JSON', error.message);
    return fallback;
  }
}
