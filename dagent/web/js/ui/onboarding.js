/** First-run wizard: language -> model -> mode & workspace -> go. */

import { $, el, esc, clear } from '../dom.js';
import { icon, MODE_ICONS } from '../icons.js';
import { t, setLanguage, applyTranslations, LANGUAGES } from '../i18n.js';
import { api } from '../api.js';
import { bus, state, setting, setSetting } from '../state.js';
import * as theme from '../theme.js';
import { openModelEditor, refreshModels } from './models.js';
import { pickPath } from './filepicker.js';
import { notify } from './toast.js';

const STEPS = ['language', 'model', 'mode', 'ready'];

export function shouldShow() {
  return !setting('app.first_run_done', false);
}

export function startOnboarding(force = false) {
  if (!force && !shouldShow()) return null;
  const root = document.getElementById('onboardingRoot');
  clear(root);
  root.classList.add('active');

  let step = 0;
  let chosenModel = null;
  let chosenMode = setting('agent.mode', 'assistant');

  const card = el('div', { class: 'ob-card' });
  const head = el('div', { class: 'ob-head' });
  const body = el('div', { class: 'ob-body' });
  const foot = el('div', { class: 'ob-foot' });
  card.append(head, body, foot);
  const wrap = el('div', { class: 'onboarding' });
  wrap.append(card);
  root.append(wrap);

  const logo = `<svg viewBox="0 0 64 64" width="58" height="58"><defs><linearGradient id="obg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="var(--accent)"/><stop offset="100%" stop-color="var(--accent-2)"/></linearGradient></defs><path d="M32 5 56 18.5v27L32 59 8 45.5v-27z" fill="none" stroke="url(#obg)" stroke-width="2.6" stroke-linejoin="round"/><circle cx="32" cy="32" r="8.5" fill="url(#obg)" opacity=".9"/><path d="M32 13v8M32 43v8M15 22l7 4M42 38l7 4M49 22l-7 4M22 38l-7 4" stroke="url(#obg)" stroke-width="2.4" stroke-linecap="round" opacity=".8"/></svg>`;

  function renderHead(title, subtitle) {
    clear(head);
    head.append(el('div', { class: 'ob-logo', html: logo }));
    head.append(el('h2', { class: 'ob-title', text: title }));
    head.append(el('p', { class: 'ob-sub', text: subtitle }));
    const dots = el('div', { class: 'ob-steps' });
    STEPS.forEach((_, index) => {
      dots.append(el('span', { class: `ob-step-dot${index === step ? ' active' : index < step ? ' done' : ''}` }));
    });
    head.append(dots);
  }

  function renderFoot({ back = true, next = true, nextLabel = t('common.next') } = {}) {
    clear(foot);
    foot.append(el('button', { class: 'btn ghost', text: t('onboarding.skip'), onclick: finish }));
    foot.append(el('div', { class: 'spacer' }));
    if (back && step > 0) foot.append(el('button', { class: 'btn', text: t('common.back'), onclick: () => { step -= 1; render(); } }));
    if (next) {
      const nextBtn = el('button', { class: 'btn accent', text: nextLabel, onclick: onNext });
      foot.append(nextBtn);
    }
  }

  function onNext() {
    if (step === 0) {
      step = 1;
      render();
      return;
    }
    if (step === 1) {
      step = 2;
      render();
      return;
    }
    if (step === 2) {
      step = 3;
      render();
      return;
    }
    finish();
  }

  async function finish() {
    try {
      await setSetting('app.first_run_done', true);
      state.settings.app = { ...(state.settings.app || {}), first_run_done: true };
    } catch (error) {
      console.error(error);
    }
    root.classList.remove('active');
    clear(root);
    bus.emit('onboarding:done');
    bus.emit('ui:focus-input');
  }

  function render() {
    clear(body);
    const current = STEPS[step];

    if (current === 'language') {
      renderHead(t('onboarding.welcome_title'), t('onboarding.welcome_sub'));
      const options = el('div', { class: 'ob-options' });
      LANGUAGES.forEach((lang) => {
        const card2 = el('button', {
          class: `ob-option${setting('app.language') === lang.id ? ' active' : ''}`,
          onclick: async () => {
            await setSetting('app.language', lang.id);
            setLanguage(lang.id);
            applyTranslations(document);
            theme.refresh(state.settings);
            options.querySelectorAll('.ob-option').forEach((node) => node.classList.remove('active'));
            card2.classList.add('active');
            render();
          },
        });
        card2.append(el('span', { class: 'oo-icon', html: icon('globe', 21) }));
        card2.append(el('span', { class: 'oo-title', text: lang.label }));
        card2.append(el('span', { class: 'oo-text', text: lang.id === 'ru' ? 'Русский интерфейс, ответы на русском' : 'English interface and answers' }));
        options.append(card2);
      });
      body.append(options);
      body.append(el('div', { class: 'divider' }));
      const themeRow = el('div', { class: 'row wrap' });
      themeRow.append(el('span', { class: 'label', text: t('settings.theme') }));
      theme.THEMES.forEach((item) => {
        themeRow.append(el('button', {
          class: `swatch${setting('ui.theme') === item.id ? ' active' : ''}`,
          title: item.label,
          style: { background: `linear-gradient(135deg, ${item.colors[0]} 55%, ${item.colors[1]})` },
          onclick: async () => {
            await setSetting('ui.theme', item.id);
            theme.refresh(state.settings);
            render();
          },
        }));
      });
      body.append(themeRow);
      renderFoot({ back: false, nextLabel: t('common.next') });
      return;
    }

    if (current === 'model') {
      renderHead(t('onboarding.model_title'), t('onboarding.model_sub'));
      const options = el('div', { class: 'ob-options' });
      const variants = [
        {
          id: 'api',
          icon: 'key',
          title: t('onboarding.have_key'),
          text: 'OpenAI, OpenRouter, DeepSeek, Groq, Mistral, Anthropic, Together, xAI...',
          open: () => openModelEditor({ kind: 'api', provider_preset: 'openai' }, afterModelSaved),
        },
        {
          id: 'server',
          icon: 'server',
          title: t('onboarding.local_server'),
          text: 'LM Studio (localhost:1234), Ollama (11434), llama.cpp server, vLLM, KoboldCpp',
          open: () => openModelEditor({ kind: 'api', provider_preset: 'lmstudio', base_url: 'http://localhost:1234/v1', model: 'local-model' }, afterModelSaved),
        },
        {
          id: 'gguf',
          icon: 'cpu',
          title: t('onboarding.local_gguf'),
          text: state.providers?.llama_cpp_installed
            ? 'llama-cpp-python is installed - pick a .gguf file from disk'
            : `${t('models.llama_missing')} - pip install llama-cpp-python`,
          open: () => openModelEditor({ kind: 'gguf' }, afterModelSaved),
        },
        {
          id: 'later',
          icon: 'clock',
          title: t('onboarding.later'),
          text: t('chat.no_model_text'),
          open: () => {
            chosenModel = null;
            step = 2;
            render();
          },
        },
      ];
      variants.forEach((variant) => {
        const node = el('button', { class: 'ob-option', onclick: () => variant.open() });
        node.append(el('span', { class: 'oo-icon', html: icon(variant.icon, 21) }));
        node.append(el('span', { class: 'oo-title', text: variant.title }));
        node.append(el('span', { class: 'oo-text', text: variant.text }));
        options.append(node);
      });
      body.append(options);

      if ((state.models || []).length) {
        body.append(el('div', { class: 'divider' }));
        body.append(el('div', { class: 'label', text: t('models.title') }));
        const list = el('div', { class: 'col', style: { marginTop: '6px' } });
        state.models.forEach((model) => {
          const row = el('div', { class: `picker-item${chosenModel === model.id ? ' sel' : ''}` });
          row.append(el('span', { html: icon(model.kind === 'gguf' ? 'cpu' : 'cloud', 15) }));
          row.append(el('span', { class: 'grow truncate', text: model.name || model.model }));
          row.append(el('span', { class: 'pi-size', text: model.model || '' }));
          row.addEventListener('click', () => {
            chosenModel = model.id;
            list.querySelectorAll('.picker-item').forEach((node) => node.classList.remove('sel'));
            row.classList.add('sel');
          });
          list.append(row);
        });
        body.append(list);
      }
      renderFoot({ nextLabel: t('common.next') });
      return;
    }

    if (current === 'mode') {
      renderHead(t('onboarding.mode_title'), t('onboarding.mode_sub'));
      const options = el('div', { class: 'ob-options' });
      (state.modes || []).forEach((mode) => {
        const node = el('button', { class: `ob-option${chosenMode === mode.id ? ' active' : ''}` });
        node.append(el('span', { class: 'oo-icon', html: icon(MODE_ICONS[mode.id] || 'wand', 21) }));
        node.append(el('span', { class: 'oo-title', text: mode.name }));
        node.append(el('span', { class: 'oo-text', text: mode.description || mode.tagline || '' }));
        node.append(el('span', { class: 'tag', text: `${(mode.tools || []).length} tools${mode.auto_approve ? ' · auto-approve' : ' · confirmations'}` }));
        node.addEventListener('click', () => {
          chosenMode = mode.id;
          options.querySelectorAll('.ob-option').forEach((item) => item.classList.remove('active'));
          node.classList.add('active');
        });
        options.append(node);
      });
      body.append(options);

      body.append(el('div', { class: 'divider' }));
      body.append(el('div', { class: 'label', text: t('onboarding.workspace_title') }));
      body.append(el('div', { class: 'hint', text: t('onboarding.workspace_sub') }));
      const wsRow = el('div', { class: 'row', style: { marginTop: '8px' } });
      const wsInput = el('input', { class: 'input-t mono', type: 'text', value: setting('workspace.root', ''), style: { flex: '1' } });
      wsRow.append(wsInput);
      wsRow.append(el('button', {
        class: 'btn',
        html: `${icon('folderOpen', 14)} ${esc(t('models.browse'))}`,
        onclick: async () => {
          const picked = await pickPath({ mode: 'dir', title: t('settings.workspace_root') });
          if (picked) wsInput.value = picked;
        },
      }));
      body.append(wsRow);
      renderFoot({ nextLabel: t('common.next') });

      const nextHandler = async () => {
        await setSetting('agent.mode', chosenMode);
        const path = wsInput.value.trim();
        if (path && path !== setting('workspace.root')) {
          try {
            const result = await api.setWorkspace(path);
            state.workspace = result.workspace;
            await setSetting('workspace.root', result.workspace.root);
            bus.emit('workspace:changed', result.workspace);
          } catch (error) {
            notify.error(t('common.error'), error.message);
          }
        }
        step = 3;
        render();
      };
      foot.querySelector('.btn.accent').onclick = nextHandler;
      return;
    }

    // ready
    renderHead(t('onboarding.ready_title'), t('onboarding.ready_sub'));
    const summary = el('div', { class: 'col' });
    const model = state.models.find((item) => item.id === chosenModel) || state.activeModel;
    const mode = (state.modes || []).find((item) => item.id === chosenMode);
    summary.append(el('div', { class: 'info-block' }, [
      el('div', { class: 'info-row' }, [el('span', { class: 'k', text: t('monitor.model') }), el('span', { class: 'v', text: model ? `${model.name || model.model}` : t('models.none') })]),
      el('div', { class: 'info-row' }, [el('span', { class: 'k', text: t('monitor.mode') }), el('span', { class: 'v', text: mode?.name || chosenMode })]),
      el('div', { class: 'info-row' }, [el('span', { class: 'k', text: t('monitor.workspace') }), el('span', { class: 'v', text: setting('workspace.root', '') })]),
      el('div', { class: 'info-row' }, [el('span', { class: 'k', text: t('settings.language') }), el('span', { class: 'v', text: setting('app.language', 'ru') })]),
    ]));
    body.append(summary);
    body.append(el('div', { class: 'hint', style: { marginTop: '10px' }, text: 'Ctrl+K - command palette · Ctrl+M - switch model · Ctrl+, - settings' }));
    renderFoot({ nextLabel: t('onboarding.start') });
    const startBtn = foot.querySelector('.btn.accent');
    if (startBtn) {
      startBtn.onclick = async () => {
        if (chosenModel) {
          try {
            await api.activateModel(chosenModel, state.currentSessionId || '');
            state.activeModel = model;
            bus.emit('models:loaded', state.models);
          } catch (error) {
            console.error(error);
          }
        }
        await finish();
      };
    }
  }

  async function afterModelSaved(profile) {
    await refreshModels();
    if (profile?.name) chosenModel = state.models.find((item) => item.name === profile.name)?.id || null;
    render();
    notify.ok(t('models.saved'), profile?.name || '');
  }

  render();
  return { finish };
}
