import { button, chip } from '../core/components.js';
import { h, icon } from '../core/dom.js';
import { CLIP_LENGTHS, clipLengthById, readGenerationSettings, validDuration, writeGenerationSettings } from '../core/generation-settings.js';
import { createCliFields, sourceLanguageSelect } from './cli-fields.js';
import { toast } from '../core/toast.js';

function cardHeading(id, title, detail, symbol, action) {
  return h('header', { class: 'settings-card__head' },
    h('span', { class: 'settings-card__icon' }, symbol),
    h('div', { class: 'settings-card__heading' },
      h('h2', { id, text: title }), h('p', { text: detail })), action);
}

function defaultRow(control, label, hint) {
  return h('div', { class: 'settings-row' },
    h('div', null, h('label', { htmlFor: control.id, text: label }), hint), control);
}

function cliItem({ label, executable, installed }) {
  return h('li', { class: 'settings-cli' },
    h('div', { class: 'settings-cli__name' }, h('span', { text: label }), h('code', { class: 'selectable', text: executable })),
    chip(installed ? 'Installed' : 'Missing', { kind: installed ? 'ok' : undefined, dot: installed }));
}

export function createSettingsView() {
  let saved = readGenerationSettings();
  let draft = { ...saved };
  let saveStatus = '';
  let renderedCatalog;

  const heading = h('h1', { class: 'page-title', id: 'settings-title', tabIndex: -1, text: 'Settings' });
  const feedback = h('p', { class: 'settings-feedback', role: 'status' });
  const discard = button({ label: 'Discard changes', variant: 'ghost' });
  const save = button({ label: 'Save settings', icon: 'check', variant: 'primary', type: 'submit' });
  const language = sourceLanguageSelect('settings-language');
  const lengthHint = h('p', { class: 'settings-row__hint', id: 'settings-length-hint' });
  const length = h('select', { class: 'input', id: 'settings-length', 'aria-describedby': lengthHint.id },
    CLIP_LENGTHS.map(({ id, label }) => h('option', { value: id, text: label })));
  length.append(h('option', { value: 'custom', text: 'Custom range' }));
  const minDuration = h('input', { class: 'input num', type: 'number', min: 0.04, max: 300, step: 0.001, 'aria-describedby': lengthHint.id });
  const maxDuration = h('input', { class: 'input num', type: 'number', min: 0.04, max: 300, step: 0.001, 'aria-describedby': lengthHint.id });
  const durationFields = h('div', { class: 'settings-row gen-pair', hidden: true },
    h('label', { class: 'field' }, 'Minimum seconds', minDuration),
    h('label', { class: 'field' }, 'Maximum seconds', maxDuration));
  const inventory = h('ul', { class: 'settings-clis' });
  const cli = createCliFields({ generationId: 'settings-generation-cli', seoId: 'settings-seo-cli',
    onChange: edit, onUpdate: paint });

  const providers = h('section', { class: 'settings-card glass', 'aria-labelledby': 'settings-providers-title' },
    cardHeading('settings-providers-title', 'AI providers', 'Choose the CLI for each part of clip generation.', icon('cpu')),
    h('div', { class: 'settings-card__rows' }, cli.generation, cli.seo));
  const defaults = h('section', { class: 'settings-card glass', 'aria-labelledby': 'settings-defaults-title' },
    cardHeading('settings-defaults-title', 'Generation defaults', 'Starting options for new clips.', icon('sliders-horizontal')),
    h('div', { class: 'settings-card__rows' },
      defaultRow(language, 'Spoken language', h('p', { class: 'settings-row__hint', text: 'The language Whisper listens for in the source video.' })),
      defaultRow(length, 'Clip length', lengthHint),
      durationFields,
      h('div', { class: 'settings-row' }, h('div', null,
        h('strong', { text: 'Output language' }), h('p', { class: 'settings-row__hint', text: 'Used for generated subtitles and publishing copy.' })),
        h('span', { class: 'settings-output-language', text: 'Roman Hinglish' }))));
  const devices = h('aside', { class: 'settings-card glass settings-device', 'aria-labelledby': 'settings-device-title' },
    cardHeading('settings-device-title', 'Local CLIs', 'Install and sign in through your terminal.', icon('terminal-window'), cli.rescan),
    cli.notice, inventory);
  const form = h('form', { class: 'settings', 'aria-labelledby': heading.id },
    h('header', { class: 'page-head settings-head' },
      h('div', null, heading, h('p', { class: 'page-sub', text: 'Manage the defaults used when you generate clips.' })),
      h('div', { class: 'settings-actions' }, feedback, discard, save)),
    h('div', { class: 'settings-grid' }, h('div', { class: 'settings-column' }, providers, defaults), devices));

  function changes() {
    return Object.fromEntries(Object.entries(draft).filter(([key, value]) => key === 'duration'
      ? draft.length === 'custom' && value?.some((item, index) => item !== saved.duration?.[index])
      : value !== saved[key]));
  }

  function paint() {
    const patch = changes();
    const dirty = Object.keys(patch).length > 0;
    discard.disabled = !dirty;
    const invalidDuration = draft.length === 'custom' && !validDuration(draft.duration);
    save.disabled = !dirty || invalidDuration || ['provider', 'seoProvider'].some(role => patch[role] &&
      (cli.scanning || !cli.hasInstalled(patch[role])));
    feedback.textContent = saveStatus || (dirty ? 'Unsaved changes' : '');
    durationFields.hidden = draft.length !== 'custom';
    for (const input of [minDuration, maxDuration]) {
      if (invalidDuration) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
    lengthHint.textContent = invalidDuration ? 'Enter a range from 0.04 to 300 seconds that fits whole video frames.'
      : clipLengthById(draft.length).hint || '';
    inventory.setAttribute('aria-busy', String(cli.scanning));
    if (renderedCatalog !== cli.catalog) {
      renderedCatalog = cli.catalog;
      inventory.replaceChildren(...renderedCatalog.map(cliItem));
      inventory.hidden = renderedCatalog.length === 0;
    }
  }

  function edit(key, value) {
    draft[key] = value;
    saveStatus = '';
    paint();
  }

  function loadDraft(next) {
    draft = next;
    language.value = draft.language;
    length.value = draft.length;
    minDuration.value = Number.isFinite(draft.duration?.[0]) ? draft.duration[0] / 1000 : '';
    maxDuration.value = Number.isFinite(draft.duration?.[1]) ? draft.duration[1] / 1000 : '';
    cli.setValues(draft);
  }

  language.onchange = () => edit('language', language.value);
  length.onchange = () => edit('length', length.value);
  const editDuration = () => edit('duration', [minDuration.valueAsNumber, maxDuration.valueAsNumber]
    .map(value => Math.round(value * 1000)));
  minDuration.oninput = maxDuration.oninput = editDuration;
  discard.onclick = () => {
    saved = readGenerationSettings();
    saveStatus = 'Changes discarded';
    loadDraft({ ...saved });
  };
  form.onsubmit = event => {
    event.preventDefault();
    if (save.disabled) return;
    try {
      writeGenerationSettings(changes());
      saved = readGenerationSettings();
      saveStatus = '';
      loadDraft({ ...saved });
      toast('Settings saved.');
    } catch {
      saveStatus = 'Could not save settings on this device.';
      paint();
      toast(saveStatus, { kind: 'error' });
    }
  };

  return {
    el: form,
    refresh: cli.scan,
    enter() {
      const pending = changes();
      saved = readGenerationSettings();
      saveStatus = '';
      loadDraft({ ...saved, ...pending });
      heading.focus({ preventScroll: true });
      void cli.scan();
    }
  };
}
