import { h, icon, setText, debounce, shake, stagger } from '../core/dom.js';
import { state, set, subscribe } from '../core/store.js';
import { baseName } from '../core/format.js';
import { api, errorMessage } from '../core/api.js';
import { button, setBusy, setFieldState } from '../core/components.js';
import { AUTO_CLIPS, MAX_CLIPS, startJob, validateYouTube } from '../core/jobs.js';
import { hrefFor, navigate } from '../core/router.js';
import { createGenerationControls } from './generation-controls.js';
import { createCliFields, sourceLanguageSelect } from './cli-fields.js';
import {
  CLIP_LENGTHS, clipLengthById, readGenerationSettings
} from '../core/generation-settings.js';

const COUNT_KEY = 'vc:generate:count';
const MIN_CLIPS = 1;
const DEFAULT_CLIPS = 5;
const PRESETS = [AUTO_CLIPS, 3, 5, 8];
const LENGTH_CHOICES = [...CLIP_LENGTHS, { id: 'custom', label: 'Custom range' }];
const URL_HINT = 'Works with youtube.com and youtu.be links.';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const sentence = text => { const trimmed = String(text || '').trim(); return /[.!?]$/.test(trimmed) ? trimmed : trimmed + '.'; };

function readCountPref() {
  try {
    const value = localStorage.getItem(COUNT_KEY);
    if (value === AUTO_CLIPS) return AUTO_CLIPS;
    const count = Number.parseInt(value, 10);
    return Number.isInteger(count) ? clamp(count, MIN_CLIPS, MAX_CLIPS) : AUTO_CLIPS;
  } catch { return AUTO_CLIPS; }
}

function writeCountPref(value) {
  try { localStorage.setItem(COUNT_KEY, String(value)); } catch { /* storage unavailable */ }
}

function paintField(field, input, level, text, fallback = '') {
  const signature = `${level}|${text}|${fallback}`;
  if (field._sig === signature) return;
  field._sig = signature;
  setFieldState(field, input, level, text, fallback);
}

export function createGenerateView() {
  const saved = readGenerationSettings();
  const formState = { file: '', count: readCountPref(), length: saved.length };
  let automatic = formState.count === AUTO_CLIPS;
  let hasDraft = false;
  let visible = false;
  let introduced = false;
  let submitting = false;

  const urlInput = h('input', {
    class: 'lib-url', id: 'gen-url', type: 'text', placeholder: 'Paste a YouTube link', autocomplete: 'off', inputmode: 'url',
    'aria-label': 'YouTube link', 'aria-describedby': 'gen-url-msg'
  });
  urlInput.spellcheck = false;
  const lead = icon('link', { cls: 'lib-source__lead' });
  const clearBtn = h('button', { class: 'icon-btn icon-btn--sm icon-btn--ghost', type: 'button', 'aria-label': 'Clear link', hidden: true }, icon('x'));
  const fileName = h('span', { class: 'lib-file__name truncate' });
  const fileChip = h('div', { class: 'lib-file', hidden: true },
    icon('file-video', { cls: 'lib-file__icon' }), fileName,
    h('button', { class: 'icon-btn icon-btn--sm icon-btn--ghost', type: 'button', 'aria-label': 'Remove video file' }, icon('x')));
  const browseBtn = h('button', { class: 'btn btn--ghost btn--sm lib-browse', type: 'button', 'aria-label': 'Browse for a video file' },
    icon('file-video'), h('span', { class: 'btn__label', text: 'Browse' }));
  const sourceRow = h('div', { class: 'lib-source', dataset: { mode: 'url' } }, lead, urlInput, clearBtn, fileChip,
    h('span', { class: 'lib-source__sep', 'aria-hidden': 'true' }), browseBtn);
  const urlField = h('div', { class: 'field lib-field' },
    h('label', { class: 'field__label', htmlFor: 'gen-url', text: 'Video' }),
    sourceRow,
    h('p', { class: 'field__msg', id: 'gen-url-msg', 'aria-live': 'polite' }));

  const countInput = h('input', {
    class: 'lib-count num', id: 'gen-count', type: 'number', min: MIN_CLIPS, max: MAX_CLIPS, step: 1, inputmode: 'numeric',
    value: automatic ? '' : formState.count, placeholder: '–', 'aria-label': 'Number of clips', 'aria-describedby': 'gen-count-msg'
  });
  const decBtn = h('button', { class: 'lib-stepper__btn', type: 'button', 'aria-label': 'Fewer clips' }, icon('minus'));
  const incBtn = h('button', { class: 'lib-stepper__btn', type: 'button', 'aria-label': 'More clips' }, icon('plus'));
  const countField = h('div', { class: 'field lib-countfield' },
    h('span', { class: 'field__label', id: 'gen-count-label', text: 'How many clips' }),
    h('div', { class: 'lib-opts' },
      h('div', { class: 'lib-stepper', role: 'group', 'aria-labelledby': 'gen-count-label' },
        decBtn,
        h('label', { class: 'lib-stepper__value', htmlFor: 'gen-count' }, countInput, h('span', { class: 'lib-stepper__unit', text: 'clips' })),
        incBtn),
      h('div', { class: 'seg lib-presets', role: 'group', 'aria-label': 'Quick picks for the number of clips' })),
    h('p', { class: 'field__msg', id: 'gen-count-msg', 'aria-live': 'polite' }));
  const presetItems = PRESETS.map(count => h('button', {
    class: count === AUTO_CLIPS ? 'seg__item' : 'seg__item num', type: 'button', 'aria-pressed': 'false',
    text: count === AUTO_CLIPS ? 'Auto' : String(count)
  }));
  countField.querySelector('.lib-presets').append(...presetItems);

  const lengthHint = h('p', { class: 'field__msg', id: 'gen-length-hint' });
  const lengthItems = LENGTH_CHOICES.map(item => h('button', {
    class: 'seg__item', type: 'button', 'aria-pressed': 'false', title: item.hint, text: item.label
  }));
  const lengthField = h('div', { class: 'field' },
    h('span', { class: 'field__label', id: 'gen-length-label', text: 'Clip length' }),
    h('div', { class: 'seg gen-lengths', role: 'group', 'aria-labelledby': 'gen-length-label' }, lengthItems),
    lengthHint);

  const controls = createGenerationControls({ countField, lengthField, getLength: () => formState.length });
  const formMessage = h('p', { class: 'field__msg gen-error', role: 'alert', hidden: true });
  const generateBtn = h('button', { class: 'btn btn--primary btn--lg gen-submit', type: 'submit', disabled: true },
    icon('sparkle', { fill: true }), h('span', { class: 'btn__label', text: 'Generate clips' }));
  const clipForm = h('form', { class: 'gen-card glass', novalidate: true, 'aria-labelledby': 'gen-video-title' },
    h('header', { class: 'gen-card__head' },
      h('h2', { class: 'gen-card__title', id: 'gen-video-title', text: 'Source' }),
      h('p', { class: 'gen-card__sub', text: 'Paste a YouTube link or choose a video file.' })),
    urlField, controls.clipControls, controls.visualControls);

  const cli = createCliFields({ generationId: 'gen-cli', seoId: 'gen-seo',
    onUpdate() {
      const ready = Boolean(cli.selection());
      generateBtn.disabled = submitting || !ready;
      if (!ready && !cli.notice.textContent) cli.notice.textContent = 'Choose installed CLIs in Advanced to generate clips.';
      cliStatus.hidden = ready;
      retryCli.disabled = cli.rescan.disabled;
    } });
  const language = sourceLanguageSelect('gen-language');
  language.value = saved.language;
  const aiCard = h('details', { class: 'gen-section gen-advanced' },
    h('summary', { text: 'Advanced' }),
    cli.rescan, cli.generation, cli.seo,
    h('div', { class: 'field' }, h('label', { htmlFor: language.id, text: 'Spoken language in the source' }), language));
  const retryCli = button({ label: 'Rescan CLIs', icon: 'arrow-clockwise', size: 'sm', onClick: () => cli.scan() });
  const cliStatus = h('div', { class: 'cli-scan-row', hidden: true }, retryCli, cli.notice);
  clipForm.append(aiCard, cliStatus, formMessage, generateBtn);

  const el = h('section', { class: 'gen', 'aria-labelledby': 'gen-title' },
    h('header', { class: 'page-head' },
      h('div', null,
        h('h1', { class: 'page-title', id: 'gen-title', text: 'Generate' }),
        h('p', { class: 'page-sub', text: 'Choose your cuts, framing and subtitle style.' }))),
    h('div', { class: 'gen-grid' }, clipForm, controls.preview));

  function syncSource() {
    const hasFile = Boolean(formState.file);
    sourceRow.dataset.mode = hasFile ? 'file' : 'url';
    lead.hidden = hasFile;
    urlInput.hidden = hasFile;
    clearBtn.hidden = hasFile || !urlInput.value;
    fileChip.hidden = !hasFile;
    if (hasFile) {
      setText(fileName, baseName(formState.file));
      fileChip.title = formState.file;
    }
  }

  function validateUrl() {
    if (formState.file) {
      paintField(urlField, urlInput, 'ok', 'Video file selected');
      controls.setSource(formState.file);
      return;
    }
    const raw = urlInput.value.trim();
    const result = validateYouTube(raw);
    controls.setSource(result.ok ? result.normalized : '');
    if (!raw || result.empty) paintField(urlField, urlInput, '', '', URL_HINT);
    else if (result.ok) paintField(urlField, urlInput, 'ok', 'YouTube video detected');
    else paintField(urlField, urlInput, 'error', result.message);
  }
  const validateLater = debounce(validateUrl, 400);

  function setFile(path) {
    hasDraft = true;
    formState.file = path;
    urlInput.value = '';
    validateLater.cancel();
    syncSource();
    validateUrl();
  }

  function readCount() {
    if (automatic) return { ok: true, value: AUTO_CLIPS };
    const raw = countInput.value.trim();
    const value = Number(raw);
    if (!raw) return { ok: false, message: `Enter how many clips to make, from ${MIN_CLIPS} to ${MAX_CLIPS}.` };
    if (!Number.isInteger(value)) return { ok: false, message: `Use a whole number from ${MIN_CLIPS} to ${MAX_CLIPS}.` };
    if (value < MIN_CLIPS || value > MAX_CLIPS) return { ok: false, message: `Choose between ${MIN_CLIPS} and ${MAX_CLIPS} clips.` };
    return { ok: true, value };
  }

  function syncCount({ strict = true } = {}) {
    const result = readCount();
    const quiet = !strict && !countInput.value.trim();
    paintField(countField, countInput, result.ok || quiet ? '' : 'error', result.ok || quiet ? '' : result.message,
      automatic ? 'AI chooses the clip count.' : '');
    presetItems.forEach((item, index) => item.setAttribute('aria-pressed', String(result.ok && PRESETS[index] === result.value)));
    decBtn.setAttribute('aria-disabled', String(!automatic && result.ok && result.value <= MIN_CLIPS));
    incBtn.setAttribute('aria-disabled', String(!automatic && result.ok && result.value >= MAX_CLIPS));
    if (result.ok) { formState.count = result.value; writeCountPref(result.value); }
  }

  function setCount(value) {
    automatic = value === AUTO_CLIPS;
    const rounded = Math.round(Number(value));
    countInput.value = automatic ? '' : String(clamp(Number.isFinite(rounded) ? rounded : DEFAULT_CLIPS, MIN_CLIPS, MAX_CLIPS));
    syncCount();
  }

  function stepCount(delta) {
    const current = readCount();
    const base = current.ok ? current.value : formState.count;
    if (base === AUTO_CLIPS) { setCount(DEFAULT_CLIPS + delta); return; }
    setCount(base + delta);
  }

  function paintLength() {
    const chosen = clipLengthById(formState.length);
    lengthItems.forEach((item, index) => item.setAttribute('aria-pressed', String(LENGTH_CHOICES[index].id === chosen.id)));
    setText(lengthHint, chosen.hint || '');
    controls.refreshControls();
  }

  function readRequest() {
    let request;
    if (formState.file) {
      request = { kind: 'file', source: formState.file, label: baseName(formState.file) };
    } else {
      const raw = urlInput.value.trim();
      const result = validateYouTube(raw);
      if (!result.ok) {
        paintField(urlField, urlInput, 'error', raw ? result.message : 'Paste a YouTube link or browse for a video file to continue.');
        urlInput.focus();
        shake(urlField);
        return null;
      }
      request = { kind: 'url', source: result.normalized, label: result.normalized.replace(/^https?:\/\/(?:www\.)?/, '') };
    }
    controls.setSource(request.source);
    const options = controls.read();
    if (options.mode === 'manual') return { ...request, count: options.ranges.length, options };
    const count = readCount();
    if (!count.ok) {
      paintField(countField, countInput, 'error', count.message);
      countInput.focus();
      shake(countField);
      return null;
    }
    return { ...request, count: count.value, options };
  }

  function onSubmit(event) {
    event.preventDefault();
    const selection = cli.selection();
    if (submitting || !selection) return;
    formMessage.hidden = true;
    try {
      const request = readRequest();
      if (!request) return;
      const id = startJob({
        ...request,
        ...selection,
        language: language.value,
        length: request.options.mode === 'manual' || formState.length === 'custom' ? 'auto' : formState.length
      });
      if (id) {
        submitting = generateBtn.disabled = true;
        navigate(hrefFor.jobs(id));
      }
    } catch (cause) {
      formMessage.hidden = false;
      setText(formMessage, errorMessage(cause));
    }
  }

  clearBtn.onclick = () => { urlInput.value = ''; syncSource(); validateUrl(); urlInput.focus(); };
  fileChip.querySelector('button').onclick = () => { formState.file = ''; syncSource(); validateUrl(); urlInput.focus(); };
  async function browse(useDefaults = false) {
    if (browseBtn.disabled) return;
    setBusy(browseBtn, true, 'Browse');
    try {
      const path = await api.chooseVideo();
      if (path && visible) {
        if (useDefaults) applyDefaults();
        setFile(path);
        generateBtn.focus();
      }
    } catch (error) {
      paintField(urlField, urlInput, 'error', `Could not open the file picker. ${sentence(errorMessage(error))}`);
    } finally { setBusy(browseBtn, false); }
  }
  browseBtn.onclick = () => browse();
  urlInput.addEventListener('input', event => {
    syncSource();
    const raw = urlInput.value.trim();
    if (!raw || event.inputType === 'insertFromPaste' || validateYouTube(raw).ok) { validateLater.cancel(); validateUrl(); }
    else validateLater();
  });
  urlInput.addEventListener('blur', () => { validateLater.cancel(); validateUrl(); });
  decBtn.onclick = () => { if (decBtn.getAttribute('aria-disabled') !== 'true') stepCount(-1); };
  incBtn.onclick = () => { if (incBtn.getAttribute('aria-disabled') !== 'true') stepCount(1); };
  presetItems.forEach((item, index) => { item.onclick = () => setCount(PRESETS[index]); });
  countInput.addEventListener('input', () => { automatic = false; syncCount({ strict: false }); });
  countInput.addEventListener('blur', () => syncCount());
  lengthItems.forEach((item, index) => {
    item.onclick = () => {
      hasDraft = true;
      formState.length = LENGTH_CHOICES[index].id;
      paintLength();
    };
  });
  clipForm.onsubmit = onSubmit;
  clipForm.addEventListener('input', () => { hasDraft = true; formMessage.hidden = true; });

  function applyDefaults(settings = readGenerationSettings()) {
    formState.length = settings.length;
    language.value = settings.language;
    cli.setValues(settings);
    controls.restore({}, settings.duration);
    paintLength();
  }

  function consumePrefill() {
    const prefill = state.generationPrefill;
    if (!prefill || !visible || state.route.name !== 'generate') return false;
    set({ generationPrefill: null });
    if (prefill.browse) { void browse(true); return true; }
    const settings = readGenerationSettings();
    formMessage.hidden = true;
    if (prefill.kind === 'file') setFile(prefill.source);
    else {
      formState.file = '';
      urlInput.value = prefill.source || '';
      syncSource();
      validateUrl();
    }
    if (prefill.options) {
      formState.length = prefill.options.duration ? 'custom' : clipLengthById(prefill.length).id;
      if (prefill.options.mode !== 'manual') setCount(prefill.count);
      language.value = prefill.language || settings.language;
      cli.setValues(prefill);
      controls.restore(prefill.options, prefill.options.duration);
      paintLength();
    } else applyDefaults(settings);
    hasDraft = Boolean(prefill.source || prefill.options);
    if (prefill.source) controls.clipControls.querySelector('select').focus({ preventScroll: true });
    else focusSource();
    return true;
  }
  subscribe(['generationPrefill', 'route'], consumePrefill);

  function focusSource() {
    (formState.file ? generateBtn : urlInput).focus();
  }

  function enter() {
    visible = true;
    if (!hasDraft && !state.generationPrefill) applyDefaults();
    else paintLength();
    syncCount({ strict: false });
    validateUrl();
    // Focus after the router restores the stage scroll.
    queueMicrotask(() => { if (visible && !consumePrefill()) focusSource(); });
    void cli.scan();
    if (!introduced) {
      introduced = true;
      stagger([clipForm, controls.preview]);
    }
  }

  function leave() {
    visible = false;
    submitting = false;
    generateBtn.disabled = !cli.selection();
    validateLater.cancel();
    controls.stopSubtitlePreview();
  }

  cli.setValues(saved);
  controls.restore({}, saved.duration);
  paintLength();
  syncSource();
  validateUrl();
  syncCount();
  return {
    el, enter, leave, refresh: cli.scan,
    sharedElement: () => null
  };
}
