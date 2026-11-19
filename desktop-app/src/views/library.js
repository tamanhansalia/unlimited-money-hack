import { generationOptions } from './generation-options.js';
// Library: the home screen. A composer on top (paste a link, watch it run) and a grid of source cards below.
import { h, icon, reconcile, delegate, setText, stagger, isTyping, shake, debounce } from '../core/dom.js';
import { state, subscribe, set } from '../core/store.js';
import { ago, plural, clock, baseName, durationLong } from '../core/format.js';
import { navigate, hrefFor } from '../core/router.js';
import { api, errorMessage } from '../core/api.js';
import { toast } from '../core/toast.js';
import { button, emptyState, setBusy, setFieldState, setProgress, progressBar, spinner } from '../core/components.js';
import { getSources, getSource, sourceTitle } from '../core/sources.js';
import { attachPoster } from '../core/thumbs.js';
import { refreshLibrary } from '../core/library.js';
import { startJob, cancelJob, dismissJob, jobSteps, stageLabel, validateYouTube } from '../core/jobs.js';

/* ───────── Constants and helpers ───────── */

const PREF = { sort: 'vc:library:sort', filter: 'vc:library:filter', count: 'vc:library:count' };
const MIN_CLIPS = 1;
const MAX_CLIPS = 10;
const DEFAULT_CLIPS = 5;
const PRESETS = [3, 5, 8];
const URL_HINT = 'Works with youtube.com and youtu.be links.';
const MAX_LOG_CHARS = 60000;
const FRESH_MS = 2000;
const FRESH_WINDOW_MS = 60000;

const SORTS = [
  { id: 'recent', label: 'Recent' },
  { id: 'name', label: 'Name' },
  { id: 'clips', label: 'Most clips' }
];
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'ready', label: 'Ready' },
  { id: 'completed', label: 'Completed' }
];
const SORTERS = {
  recent: (a, b) => b.updatedAt - a.updatedAt,
  name: (a, b) => sourceTitle(a).localeCompare(sourceTitle(b), undefined, { sensitivity: 'base', numeric: true }),
  clips: (a, b) => b.total - a.total || b.updatedAt - a.updatedAt
};
const FILTER_TESTS = {
  all: () => true,
  ready: source => source.readyCount > 0,
  completed: source => source.total > 0 && source.completedCount === source.total
};
const PENDING = { pending: true };
const FINISHED_MODES = new Set(['done', 'error', 'note']);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const sentence = text => { const trimmed = String(text || '').trim(); return /[.!?]$/.test(trimmed) ? trimmed : trimmed + '.'; };

function readPref(key, allowed, fallback) {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value) ? value : fallback;
  } catch { return fallback; }
}
function writePref(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* storage unavailable */ }
}
function readCountPref() {
  try {
    const value = Number.parseInt(localStorage.getItem(PREF.count), 10);
    return Number.isInteger(value) ? clamp(value, MIN_CLIPS, MAX_CLIPS) : DEFAULT_CLIPS;
  } catch { return DEFAULT_CLIPS; }
}

/** Only touch the DOM when the message really changed, so live regions do not re-announce. */
function paintField(field, input, level, text, fallback = '') {
  const signature = `${level}|${text}|${fallback}`;
  if (field._sig === signature) return;
  field._sig = signature;
  setFieldState(field, input, level, text, fallback);
}

function composerMode(job) {
  if (job.status === 'running') return 'running';
  if (job.dismissed) return 'idle';
  if (job.status === 'done') return addedClips(job) > 0 ? 'done' : 'note';
  if (job.status === 'cancelled') return 'note';
  if (job.status === 'error') return 'error';
  return 'idle';
}
const addedClips = job => job.addedCount ?? job.newClipIds?.length ?? 0;

function jobInputs(job, fallbackCount) {
  if (!job.source) return null;
  return { kind: job.kind === 'file' ? 'file' : 'url', source: job.source, label: job.label, count: job.count || fallbackCount };
}

function kindIcon(kind) {
  if (kind === 'youtube') return icon('youtube-logo', { fill: true });
  if (kind === 'file') return icon('file-video');
  return icon('film-strip');
}
function kindLabel(kind) {
  if (kind === 'youtube') return 'YouTube';
  if (kind === 'file') return 'Local file';
  return 'Earlier clips';
}

/* ───────── Page head ───────── */

function summaryText(sources) {
  if (!sources.length) return state.clipsError ? 'Your clips could not be loaded' : 'No clips yet';
  const clips = sources.reduce((sum, source) => sum + source.total, 0);
  const ready = sources.reduce((sum, source) => sum + source.readyCount, 0);
  return `${plural(sources.length, 'source')} · ${plural(clips, 'clip')} · ${ready} ready`;
}

async function openFolder(btn) {
  setBusy(btn, true, 'Open folder');
  try { await api.openFolder('ready'); }
  catch (error) { toast(`Could not open the clips folder. ${sentence(errorMessage(error))}`, { kind: 'error' }); }
  finally { setBusy(btn, false); }
}

async function refresh() {
  if (state.clipsRefreshing) return;
  try {
    await refreshLibrary();
    if (!state.clipsError) toast('Library refreshed', { kind: 'info', ttl: 2200 });
  } catch (error) {
    toast(`Could not refresh the library. ${sentence(errorMessage(error))}`, { kind: 'error' });
  }
}

function createHead() {
  const skeleton = h('span', { class: 'skeleton skeleton--line lib-summary-skel', 'aria-hidden': 'true' });
  const summary = h('span', { class: 'num' });
  const folderBtn = h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => openFolder(folderBtn) },
    icon('folder-open'), h('span', { class: 'btn__label', text: 'Open folder' }));
  const refreshBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Refresh library', title: 'Refresh library', onclick: refresh },
    icon('arrow-clockwise'));
  const el = h('header', { class: 'page-head lib-head' },
    h('div', null,
      h('h1', { class: 'page-title', text: 'Library' }),
      h('p', { class: 'page-sub' }, skeleton, summary)),
    h('div', { class: 'lib-head__actions' }, folderBtn, refreshBtn));

  function render() {
    const all = getSources();
    const loading = !state.clipsLoaded && !all.length && !state.clipsError;
    skeleton.hidden = !loading;
    summary.hidden = loading;
    setText(summary, summaryText(all));
    refreshBtn.classList.toggle('is-spinning', state.clipsRefreshing);
    refreshBtn.setAttribute('aria-busy', String(state.clipsRefreshing));
  }
  return { el, render };
}

/* ───────── Composer ───────── */

function createComposer() {
  const form = { file: '', count: readCountPref() };
  let mode = 'idle';
  let active = false;
  let ticker = 0;
  let confirmTimer = 0;
  let logFrame = 0;
  let runKind = '';
  let noteKind = '';

  /* Idle panel: source row */
  const urlInput = h('input', {
    class: 'lib-url', id: 'lib-url', type: 'text', placeholder: 'Paste a YouTube link', autocomplete: 'off', inputmode: 'url',
    'aria-label': 'YouTube link', 'aria-describedby': 'lib-url-msg'
  });
  urlInput.spellcheck = false;
  const lead = icon('link', { cls: 'lib-source__lead' });
  const clearBtn = h('button', { class: 'icon-btn icon-btn--sm icon-btn--ghost', type: 'button', 'aria-label': 'Clear link', hidden: true, dataset: { act: 'clear-url' } }, icon('x'));
  const fileName = h('span', { class: 'lib-file__name truncate' });
  const fileChip = h('div', { class: 'lib-file', hidden: true },
    icon('file-video', { cls: 'lib-file__icon' }), fileName,
    h('button', { class: 'icon-btn icon-btn--sm icon-btn--ghost', type: 'button', 'aria-label': 'Remove video file', dataset: { act: 'remove-file' } }, icon('x')));
  const browseBtn = h('button', { class: 'btn btn--ghost btn--sm lib-browse', type: 'button', 'aria-label': 'Browse for a video file', dataset: { act: 'browse' } },
    icon('file-video'), h('span', { class: 'btn__label', text: 'Browse' }));
  const sourceRow = h('div', { class: 'lib-source', dataset: { mode: 'url' } }, lead, urlInput, clearBtn, fileChip, h('span', { class: 'lib-source__sep', 'aria-hidden': 'true' }), browseBtn);
  const urlField = h('div', { class: 'field lib-field' }, sourceRow, h('p', { class: 'field__msg', id: 'lib-url-msg', 'aria-live': 'polite' }));

  /* Idle panel: clip count */
  const countInput = h('input', {
    class: 'lib-count num', id: 'lib-count', type: 'number', min: MIN_CLIPS, max: MAX_CLIPS, step: 1, inputmode: 'numeric',
    value: form.count, 'aria-label': 'Number of clips', 'aria-describedby': 'lib-count-msg'
  });
  const decBtn = h('button', { class: 'lib-stepper__btn', type: 'button', 'aria-label': 'Fewer clips', dataset: { act: 'count-dec' } }, icon('minus'));
  const incBtn = h('button', { class: 'lib-stepper__btn', type: 'button', 'aria-label': 'More clips', dataset: { act: 'count-inc' } }, icon('plus'));
  const countField = h('div', { class: 'field lib-countfield' },
    h('div', { class: 'lib-stepper', role: 'group', 'aria-label': 'Number of clips' },
      decBtn,
      h('label', { class: 'lib-stepper__value', htmlFor: 'lib-count' }, countInput, h('span', { class: 'lib-stepper__unit', text: 'clips' })),
      incBtn),
    h('p', { class: 'field__msg', id: 'lib-count-msg', 'aria-live': 'polite' }));
  const presetItems = PRESETS.map(count => h('button', { class: 'seg__item num', type: 'button', 'aria-pressed': 'false', dataset: { act: 'preset', count: String(count) }, text: String(count) }));
  const presets = h('div', { class: 'seg lib-presets', role: 'group', 'aria-label': 'Quick picks for the number of clips' }, presetItems);
  const generateBtn = h('button', { class: 'btn btn--primary btn--lg lib-generate', type: 'submit' },
    icon('sparkle', { fill: true }), h('span', { class: 'btn__label', text: 'Generate clips' }));

  const idle = h('form', { class: 'lib-panel lib-form', novalidate: true, dataset: { panel: 'idle' }, onsubmit: onSubmit },
    h('div', { class: 'lib-form__head' },
      h('h2', { class: 'lib-title', id: 'lib-composer-title', text: 'New clips' }),
      h('p', { class: 'lib-lede', text: 'Paste a YouTube link or choose a video file. We cut the best moments into vertical clips.' })),
    urlField,
    h('div', { class: 'lib-opts' }, countField, presets, h('span', { class: 'lib-opts__spacer' }), generateBtn));

  /* Running panel */
  const runIcon = h('span', { class: 'lib-run__icon' });
  const runLabel = h('span', { class: 'lib-run__label truncate' });
  const elapsed = h('span', { class: 'lib-run__time num', role: 'timer', text: '0:00' });
  const stageEl = h('p', { class: 'lib-run__stage', role: 'status', tabindex: -1 });
  const pctEl = h('span', { class: 'lib-run__pct num' });
  const bar = progressBar();
  bar.classList.add('is-active');
  bar.setAttribute('aria-label', 'Generation progress');
  const stepList = h('ol', { class: 'lib-steps', 'aria-label': 'Generation steps' });
  const cancelBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', dataset: { act: 'cancel' } }, icon('x'), h('span', { class: 'btn__label', text: 'Cancel' }));
  const stopBtn = h('button', { class: 'btn btn--danger btn--sm', type: 'button', dataset: { act: 'stop' } }, h('span', { class: 'btn__label', text: 'Stop' }));
  const keepBtn = h('button', { class: 'btn btn--sm', type: 'button', dataset: { act: 'keep' }, text: 'Keep going' });
  const confirmBox = h('div', { class: 'lib-confirm', role: 'group', 'aria-label': 'Confirm stop', hidden: true },
    h('span', { class: 'lib-confirm__text', text: 'Stop generation?' }), stopBtn, keepBtn);

  /* Engine output: one region, opened by a toggle that lives in whichever panel is showing, so no panel changes height. */
  const logToggles = [];
  function createLogToggle({ closedLabel, openLabel, always, small }) {
    const label = h('span', { class: 'btn__label' });
    const btn = h('button', { class: 'btn btn--ghost lib-logtoggle' + (small ? ' btn--sm' : ''), type: 'button', 'aria-controls': 'lib-log', 'aria-expanded': 'false', dataset: { act: 'output' } },
      icon('caret-right', { cls: 'lib-logtoggle__caret' }), label);
    logToggles.push({ btn, label, closedLabel, openLabel, always });
    return btn;
  }

  const running = h('div', { class: 'lib-panel lib-run', dataset: { panel: 'running' } },
    h('div', { class: 'lib-run__top' },
      h('span', { class: 'lib-run__src' }, runIcon, runLabel),
      h('span', { class: 'lib-run__clock' }, h('span', { class: 'sr-only', text: 'Elapsed time ' }), icon('clock'), elapsed)),
    h('div', { class: 'lib-run__headline' }, stageEl, pctEl),
    bar,
    stepList,
    h('div', { class: 'lib-run__foot' },
      h('div', { class: 'lib-run__aux' },
        createLogToggle({ closedLabel: 'Engine output', openLabel: 'Engine output', always: true, small: true }),
        h('p', { class: 'lib-run__hint', text: 'You can leave this page. Generation keeps running in the background.' })),
      h('div', { class: 'lib-run__cancel' }, cancelBtn, confirmBox)));

  /* Result panels */
  const viewBtn = h('button', { class: 'btn btn--primary btn--lg', type: 'button', dataset: { act: 'view' } }, icon('arrow-right'), h('span', { class: 'btn__label', text: 'View clips' }));
  const moreBtn = h('button', { class: 'btn btn--ghost', type: 'button', dataset: { act: 'restart' }, text: 'Generate more' });
  const dismissBtn = h('button', { class: 'btn btn--ghost', type: 'button', dataset: { act: 'dismiss' }, text: 'Dismiss' });
  const doneTitle = h('h2', { class: 'lib-result__title clamp-2' });
  const doneText = h('p', { class: 'lib-result__text' });
  const done = h('div', { class: 'lib-panel lib-result', dataset: { panel: 'done' } },
    h('span', { class: 'lib-result__badge lib-result__badge--ok' }, icon('check-circle', { fill: true })),
    h('div', { class: 'lib-result__body' }, doneTitle, doneText, h('div', { class: 'lib-result__actions' }, viewBtn, moreBtn, dismissBtn)));

  const retryBtn = h('button', { class: 'btn btn--primary btn--lg', type: 'button', dataset: { act: 'retry' } }, icon('arrow-counter-clockwise'), h('span', { class: 'btn__label', text: 'Try again' }));
  const errOutputBtn = createLogToggle({ closedLabel: 'Show output', openLabel: 'Hide output' });
  const errDismissBtn = h('button', { class: 'btn btn--ghost', type: 'button', dataset: { act: 'dismiss' }, text: 'Dismiss' });
  const errText = h('p', { class: 'lib-err__text selectable' });
  const error = h('div', { class: 'lib-panel lib-result lib-result--error', dataset: { panel: 'error' } },
    h('div', { class: 'callout callout--bad lib-err' },
      icon('warning-circle', { fill: true }),
      h('div', { class: 'callout__body' },
        h('strong', { text: 'Generation failed' }),
        errText,
        h('span', { text: 'Check the link and your connection, then try again. The engine output has the details.' }))),
    h('div', { class: 'lib-result__actions' }, retryBtn, errOutputBtn, errDismissBtn));

  const noteBadge = h('span', { class: 'lib-result__badge' });
  const noteTitle = h('h2', { class: 'lib-result__title' });
  const noteText = h('p', { class: 'lib-result__text' });
  const noteOutputBtn = createLogToggle({ closedLabel: 'Show output', openLabel: 'Hide output' });
  const startOverBtn = h('button', { class: 'btn btn--lg', type: 'button', dataset: { act: 'restart' } }, icon('arrow-counter-clockwise'), h('span', { class: 'btn__label', text: 'Start over' }));
  const note = h('div', { class: 'lib-panel lib-result', dataset: { panel: 'note' } },
    noteBadge,
    h('div', { class: 'lib-result__body' }, noteTitle, noteText, h('div', { class: 'lib-result__actions' }, startOverBtn, noteOutputBtn)));

  const logPre = h('pre', { class: 'lib-log__pre mono', role: 'log', 'aria-live': 'off', 'aria-label': 'Engine output', tabindex: 0 });
  const logRegion = h('div', { class: 'lib-log', id: 'lib-log', hidden: true }, logPre);
  const live = h('p', { class: 'sr-only', role: 'status' });
  let logOpen = false;

  const panels = new Map([['idle', idle], ['running', running], ['done', done], ['error', error], ['note', note]]);
  const root = h('section', { class: 'lib-composer glass', 'aria-labelledby': 'lib-composer-title', dataset: { mode: 'idle' } },
    h('div', { class: 'lib-stack' }, ...panels.values()),
    logRegion, live);
  for (const [name, panel] of panels) {
    panel.classList.toggle('is-active', name === 'idle');
    panel.inert = name !== 'idle';
  }

  /* Source and validation */
  function syncSource() {
    const hasFile = Boolean(form.file);
    sourceRow.dataset.mode = hasFile ? 'file' : 'url';
    lead.hidden = hasFile;
    urlInput.hidden = hasFile;
    clearBtn.hidden = hasFile || !urlInput.value;
    fileChip.hidden = !hasFile;
    if (hasFile) {
      setText(fileName, baseName(form.file));
      fileChip.title = form.file;
    }
  }

  function validateUrl() {
    if (form.file) { paintField(urlField, urlInput, 'ok', 'Video file selected'); return; }
    const raw = urlInput.value.trim();
    const result = validateYouTube(raw);
    if (!raw || result.empty) paintField(urlField, urlInput, '', '', URL_HINT);
    else if (result.ok) paintField(urlField, urlInput, 'ok', 'YouTube video detected');
    else paintField(urlField, urlInput, 'error', result.message);
  }
  const validateLater = debounce(validateUrl, 400);

  function setUrl(value) {
    form.file = '';
    urlInput.value = String(value || '');
    syncSource();
    validateUrl();
  }

  function setFile(path) {
    form.file = path;
    urlInput.value = '';
    validateLater.cancel();
    syncSource();
    validateUrl();
  }

  function onUrlInput(event) {
    syncSource();
    const raw = urlInput.value.trim();
    if (!raw || event.inputType === 'insertFromPaste' || validateYouTube(raw).ok) { validateLater.cancel(); validateUrl(); }
    else validateLater();
  }

  async function browse() {
    setBusy(browseBtn, true, 'Browse');
    try {
      const path = await api.chooseVideo();
      if (path) { setFile(path); generateBtn.focus(); }
    } catch (error) {
      paintField(urlField, urlInput, 'error', `Could not open the file picker. ${sentence(errorMessage(error))}`);
    } finally {
      setBusy(browseBtn, false);
    }
  }

  /* Clip count */
  function readCount() {
    const raw = countInput.value.trim();
    const value = Number(raw);
    if (!raw) return { ok: false, message: `Enter how many clips to make, from ${MIN_CLIPS} to ${MAX_CLIPS}.` };
    if (!Number.isInteger(value)) return { ok: false, message: `Use a whole number from ${MIN_CLIPS} to ${MAX_CLIPS}.` };
    if (value < MIN_CLIPS || value > MAX_CLIPS) return { ok: false, message: `Choose between ${MIN_CLIPS} and ${MAX_CLIPS} clips.` };
    return { ok: true, value };
  }

  /** While typing, an empty box is not an error yet (the user is about to type a number); blur and submit are strict. */
  function syncCount({ strict = true } = {}) {
    const result = readCount();
    const quiet = !strict && !countInput.value.trim();
    paintField(countField, countInput, result.ok || quiet ? '' : 'error', result.ok || quiet ? '' : result.message);
    for (const item of presetItems) item.setAttribute('aria-pressed', String(result.ok && Number(item.dataset.count) === result.value));
    decBtn.setAttribute('aria-disabled', String(result.ok && result.value <= MIN_CLIPS));
    incBtn.setAttribute('aria-disabled', String(result.ok && result.value >= MAX_CLIPS));
    if (result.ok) { form.count = result.value; writePref(PREF.count, result.value); }
  }

  function setCount(value) {
    const rounded = Math.round(Number(value));
    countInput.value = String(clamp(Number.isFinite(rounded) ? rounded : DEFAULT_CLIPS, MIN_CLIPS, MAX_CLIPS));
    syncCount();
  }

  function stepCount(delta) {
    const current = readCount();
    const base = current.ok ? current.value : form.count;
    setCount(base + delta);
  }

  /* Submit */
  function rejectField(field, input) {
    input.focus();
    shake(field);
  }

  function onSubmit(event) {
    event.preventDefault();
    if (state.job.status === 'running') return;
    const request = readRequest();
    if (!request) return;
    run(request, true);
  }

  /** Validates the form; on a problem shows it inline, focuses and shakes the field, and returns null. */
  function readRequest() {
    let request;
    if (form.file) {
      request = { kind: 'file', source: form.file, label: baseName(form.file) };
    } else {
      const raw = urlInput.value.trim();
      const result = validateYouTube(raw);
      if (!result.ok) {
        paintField(urlField, urlInput, 'error', raw ? result.message : 'Paste a YouTube link or browse for a video file to continue.');
        rejectField(urlField, urlInput);
        return null;
      }
      request = { kind: 'url', source: result.normalized, label: result.normalized.replace(/^https?:\/\/(?:www\.)?/, '') };
    }
    const count = readCount();
    if (!count.ok) {
      paintField(countField, countInput, 'error', count.message);
      rejectField(countField, countInput);
      return null;
    }
    return { ...request, count: count.value };
  }

  function resetForm() {
    form.file = '';
    urlInput.value = '';
    validateLater.cancel();
    syncSource();
    validateUrl();
  }

  /* Job actions */
  function restoreInputs(job) {
    if (job.kind === 'file' && job.source) setFile(job.source);
    else if (job.source) setUrl(job.source);
    if (job.count) setCount(job.count);
  }

  function dismissAndFocus() {
    dismissJob();
    render();
    requestAnimationFrame(() => focusPanel());
  }

  function restart() {
    restoreInputs(state.job);
    dismissAndFocus();
  }

  async function run(request, reset = false) {
    try {
      const options = await generationOptions(true);
      if (!options) return;
      if (reset) resetForm();
      await startJob({ ...request, ...options });
    } catch (cause) {
      toast(`Could not start generation. ${sentence(errorMessage(cause))}`, { kind: 'error' });
    }
  }

  function retry() {
    const inputs = jobInputs(state.job, form.count);
    if (!inputs) {
      toast('That run cannot be repeated. Start a new one from the form.', { kind: 'error' });
      dismissAndFocus();
      return;
    }
    run(inputs);
  }

  function viewClips() {
    const key = state.job.sourceKey;
    dismissJob();
    if (key) navigate(hrefFor.source(key));
  }

  function setConfirming(on) {
    clearTimeout(confirmTimer);
    const hadFocus = confirmBox.contains(document.activeElement);
    cancelBtn.hidden = on;
    confirmBox.hidden = !on;
    setBusy(stopBtn, false);
    keepBtn.disabled = false;
    if (on) {
      keepBtn.focus();
      confirmTimer = setTimeout(() => setConfirming(false), 8000);
    } else if (hadFocus) {
      cancelBtn.focus();
    }
  }

  /** cancelJob never rejects and reports its own failures with a toast; on success the job ends as "cancelled". */
  async function stop() {
    clearTimeout(confirmTimer);
    setBusy(stopBtn, true, 'Stopping…');
    keepBtn.disabled = true;
    const stopped = await cancelJob();
    if (!stopped && state.job.status === 'running') setConfirming(false);
  }

  function toggleLog() {
    logOpen = !logOpen;
    syncLog();
    if (!logOpen) return;
    logPre.scrollTop = logPre.scrollHeight;
    logRegion.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  const ACTIONS = {
    browse,
    'clear-url': () => { setUrl(''); urlInput.focus(); },
    'remove-file': () => { form.file = ''; syncSource(); validateUrl(); urlInput.focus(); },
    'count-dec': () => stepCount(-1),
    'count-inc': () => stepCount(1),
    preset: target => setCount(target.dataset.count),
    cancel: () => setConfirming(true),
    keep: () => setConfirming(false),
    stop,
    view: viewClips,
    restart,
    dismiss: dismissAndFocus,
    retry,
    output: toggleLog
  };
  delegate(root, 'click', '[data-act]', (event, target) => {
    if (target.getAttribute('aria-disabled') === 'true') return;
    ACTIONS[target.dataset.act]?.(target);
  });
  urlInput.addEventListener('input', onUrlInput);
  urlInput.addEventListener('blur', () => { validateLater.cancel(); validateUrl(); });
  countInput.addEventListener('input', () => syncCount({ strict: false }));
  countInput.addEventListener('blur', () => syncCount());

  /* Painting the job */
  function paintRunning(job) {
    if (runKind !== job.kind) {
      runKind = job.kind;
      runIcon.replaceChildren(job.kind === 'file' ? icon('file-video') : icon('youtube-logo', { fill: true }));
    }
    setText(runLabel, job.label || 'Your video');
    setText(stageEl, stageLabel(job));
    const progress = clamp(Number(job.progress) || 0, 0, 1);
    setProgress(bar, progress);
    bar.classList.toggle('progress--indeterminate', progress <= 0);
    if (progress > 0) bar.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
    else bar.removeAttribute('aria-valuenow');
    setText(pctEl, progress > 0 ? Math.round(progress * 100) + '%' : '');
    const steps = jobSteps(job).map((step, index) => ({ ...step, index: index + 1 }));
    reconcile(stepList, steps, step => step.id, step => { const node = createStep(); updateStep(node, step); return node; }, updateStep);
    tick();
  }

  function paintDone(job) {
    const source = job.sourceKey ? getSource(job.sourceKey) : null;
    const title = source ? sourceTitle(source) : job.label || 'your video';
    setText(doneTitle, `${plural(addedClips(job), 'new clip')} from ${title}`);
    const took = job.endedAt && job.startedAt ? `Finished in ${clock(job.endedAt - job.startedAt)}. ` : '';
    setText(doneText, took + 'Review them, tweak the titles and publish.');
    viewBtn.hidden = !job.sourceKey;
  }

  function paintError(job) {
    setText(errText, job.error || 'The engine stopped before it saved any clips.');
  }

  function paintNote(job) {
    const cancelled = job.status === 'cancelled';
    const variant = cancelled ? 'cancelled' : 'empty';
    if (noteKind !== variant) {
      noteKind = variant;
      noteBadge.replaceChildren(cancelled ? icon('prohibit') : icon('info'));
    }
    setText(noteTitle, cancelled ? 'Generation stopped' : 'No new clips this time');
    setText(noteText, cancelled
      ? (Number(job.saved) > 0 ? `${plural(Number(job.saved), 'clip')} saved before you stopped.` : 'No clips were saved from this run.')
      : 'The run finished without adding any clips. The engine output may say why.');
  }

  function createStep() {
    const dot = h('span', { class: 'lib-step__dot' });
    const label = h('span', { class: 'lib-step__label' });
    const status = h('span', { class: 'sr-only' });
    const detail = h('span', { class: 'lib-step__detail truncate' });
    const node = h('li', { class: 'lib-step' },
      h('span', { class: 'lib-step__head' }, dot, h('span', { class: 'lib-step__line', 'aria-hidden': 'true' })),
      h('span', { class: 'lib-step__text' }, h('span', { class: 'lib-step__name' }, label, status), detail));
    node._r = { dot, label, status, detail };
    return node;
  }

  const STEP_STATUS = { done: ', done', active: ', in progress', error: ', failed', todo: ', waiting' };
  function updateStep(node, step) {
    const refs = node._r;
    if (node.dataset.state !== step.state) {
      node.dataset.state = step.state;
      if (step.state === 'active') node.setAttribute('aria-current', 'step'); else node.removeAttribute('aria-current');
      if (step.state === 'done') refs.dot.replaceChildren(icon('check'));
      else if (step.state === 'active') refs.dot.replaceChildren(spinner('sm'));
      else if (step.state === 'error') refs.dot.replaceChildren(icon('x'));
      else refs.dot.replaceChildren(String(step.index));
      setText(refs.status, STEP_STATUS[step.state] || '');
    }
    setText(refs.label, step.label);
    setText(refs.detail, step.detail || '');
  }

  function tick() {
    setText(elapsed, clock(Date.now() - (state.job.startedAt || Date.now())));
  }

  function syncTicker() {
    const shouldRun = active && !document.hidden && mode === 'running';
    if (shouldRun && !ticker) { tick(); ticker = setInterval(tick, 1000); }
    else if (!shouldRun && ticker) { clearInterval(ticker); ticker = 0; }
  }

  function announce(job) {
    const messages = {
      running: `Generating clips from ${job.label || 'your video'}.`,
      done: `Finished. ${plural(addedClips(job), 'new clip')} added.`,
      error: `Generation failed. ${job.error || ''}`,
      note: job.status === 'cancelled' ? 'Generation stopped.' : 'Finished without adding clips.'
    };
    setText(live, messages[mode] || '');
  }

  function focusPanel({ scroll = true } = {}) {
    const target = {
      idle: form.file ? generateBtn : urlInput,
      running: stageEl,
      done: viewBtn.hidden ? moreBtn : viewBtn,
      error: retryBtn,
      note: startOverBtn
    }[mode];
    target.focus({ preventScroll: !scroll });
  }

  function switchMode(next, job) {
    const hadFocus = root.contains(document.activeElement);
    mode = next;
    root.dataset.mode = next;
    for (const [name, panel] of panels) {
      panel.classList.toggle('is-active', name === next);
      panel.inert = name !== next;
    }
    setConfirming(false);
    if (next === 'idle') logOpen = false;
    // A finished run's long message must not keep stretching the card while another panel is showing.
    if (next !== 'error') setText(errText, '');
    announce(job);
    if (hadFocus) focusPanel();
  }

  function render() {
    const job = state.job;
    const next = composerMode(job);
    if (next !== mode) switchMode(next, job);
    if (mode === 'running') paintRunning(job);
    else if (mode === 'done') paintDone(job);
    else if (mode === 'error') paintError(job);
    else if (mode === 'note') paintNote(job);
    syncLog();
    syncTicker();
  }

  /* Engine output: coalesced to one paint per frame, sticks to the bottom only if the reader is already there. */
  const logVisible = () => logOpen && mode !== 'idle';

  function syncLog() {
    const hasLog = Boolean(state.jobLog);
    const visible = logVisible();
    if (logRegion.hidden === visible) {
      logRegion.hidden = !visible;
      if (visible) paintLog();
    }
    for (const toggle of logToggles) {
      toggle.btn.hidden = !toggle.always && !hasLog;
      toggle.btn.setAttribute('aria-expanded', String(logOpen));
      setText(toggle.label, logOpen ? toggle.openLabel : toggle.closedLabel);
    }
  }
  function paintLog() {
    const log = state.jobLog || '';
    const text = log.length > MAX_LOG_CHARS ? '…' + log.slice(-MAX_LOG_CHARS) : log;
    const atBottom = logPre.scrollHeight - logPre.scrollTop - logPre.clientHeight < 24;
    logPre.textContent = text;
    if (atBottom) logPre.scrollTop = logPre.scrollHeight;
  }
  function renderLog() {
    if (logFrame || !logVisible()) return;
    logFrame = requestAnimationFrame(() => { logFrame = 0; paintLog(); });
  }

  /* Public */
  function focus({ url, reveal } = {}) {
    if (url) {
      // A finished run's panel would hide the link that "Generate more" just filled in.
      if (FINISHED_MODES.has(mode)) { dismissJob(); render(); }
      setUrl(url);
    }
    if (reveal) root.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    focusPanel({ scroll: !reveal });
  }

  function setActive(on) {
    active = on;
    syncTicker();
  }

  syncSource();
  validateUrl();
  syncCount();

  return { el: root, render, renderLog, focus, setUrl, setActive, isIdle: () => mode === 'idle' };
}

/* ───────── Source cards ───────── */

const FAN_SLOTS = ['l', 'r', 'c'];
const FAN_CLIP_INDEX = [1, 2, 0]; // slot order in the DOM -> index of the clip shown there (centre = first clip)

function createFan() {
  return FAN_SLOTS.map(slot => h('span', { class: 'lib-fan__item', dataset: { slot } },
    h('img', { class: 'poster', alt: '', decoding: 'async' })));
}

/** Point one fan slot at a clip; does nothing when it already shows that clip version. */
function bindPoster(item, clip) {
  const key = clip ? `${clip.id}|${clip.updatedAt}` : '';
  if (item._key === key) return;
  item._detach?.();
  item._detach = null;
  item._key = key;
  item.hidden = !clip;
  const img = item.firstElementChild;
  img.classList.remove('is-loaded');
  if (!clip) { img.removeAttribute('src'); return; }
  item._detach = attachPoster(img, clip);
}

function createCard(source) {
  const items = createFan();
  const fan = h('div', { class: 'lib-fan', 'aria-hidden': 'true' }, items);
  const kind = h('span', { class: 'lib-card__kind' });
  const open = h('span', { class: 'lib-card__open', 'aria-hidden': 'true' }, icon('arrow-up-right'));
  const cover = h('div', { class: 'lib-card__cover', dataset: { vt: 'cover' } }, fan, kind, open);
  const title = h('h3', { class: 'lib-card__title clamp-2' });
  const by = h('p', { class: 'lib-card__by truncate' });
  const total = h('span', { class: 'chip chip--sm' });
  const ready = h('span', { class: 'chip chip--sm chip--ready' });
  const completed = h('span', { class: 'chip chip--sm chip--ok' });
  const segDone = h('span', { class: 'lib-card__seg lib-card__seg--ok' });
  const segReady = h('span', { class: 'lib-card__seg lib-card__seg--ready' });
  const time = h('time', { class: 'lib-card__time num' });
  const node = h('a', { class: 'lib-card surface', href: hrefFor.source(source.key) },
    cover,
    h('div', { class: 'lib-card__body' },
      title, by,
      h('div', { class: 'lib-card__chips' }, total, ready, completed),
      h('div', { class: 'lib-card__foot' },
        h('span', { class: 'lib-card__bar', 'aria-hidden': 'true' }, segDone, segReady),
        time)));
  node._r = { fan, items, kind, title, by, total, ready, completed, segDone, segReady, time, kindId: '' };
  return node;
}

function byline(source) {
  const parts = [source.channel, source.totalDuration ? `${durationLong(source.totalDuration)} of clips` : ''].filter(Boolean);
  return parts.join(' · ') || 'Source video';
}

function patchCount(chipEl, count, label) {
  chipEl.hidden = !count;
  if (count) setText(chipEl, label);
}

function patchFan(refs, clips) {
  refs.fan.dataset.count = String(clips.length);
  refs.items.forEach((item, index) => {
    const slotClip = clips[FAN_CLIP_INDEX[index]] || null;
    bindPoster(item, slotClip);
  });
}

function updateCard(node, source) {
  const refs = node._r;
  const fanClips = source.clips.slice(0, 3);
  const signature = [sourceTitle(source), source.channel, source.kind, source.totalDuration, source.total, source.readyCount, source.completedCount,
    ...fanClips.map(clip => `${clip.id}@${clip.updatedAt}`)].join('|');
  if (node._sig !== signature) {
    node._sig = signature;
    setText(refs.title, sourceTitle(source));
    setText(refs.by, byline(source));
    if (refs.kindId !== source.kind) {
      refs.kindId = source.kind;
      refs.kind.replaceChildren(kindIcon(source.kind), h('span', { text: kindLabel(source.kind) }));
    }
    setText(refs.total, plural(source.total, 'clip'));
    patchCount(refs.ready, source.readyCount, `${source.readyCount} ready`);
    patchCount(refs.completed, source.completedCount, `${source.completedCount} completed`);
    refs.segDone.hidden = !source.completedCount;
    refs.segReady.hidden = !source.readyCount;
    refs.segDone.style.flexGrow = String(source.completedCount);
    refs.segReady.style.flexGrow = String(source.readyCount);
    patchFan(refs, fanClips);
  }
  node._at = source.updatedAt;
  setText(refs.time, ago(source.updatedAt));
  if (Number.isFinite(source.updatedAt)) refs.time.dateTime = new Date(source.updatedAt).toISOString();
}

function createPendingCard() {
  const fan = h('div', { class: 'lib-fan', 'aria-hidden': 'true', dataset: { count: '3' } },
    FAN_SLOTS.map(slot => h('span', { class: 'lib-fan__item lib-fan__item--ghost skeleton', dataset: { slot } })));
  const dial = h('span', { class: 'ring lib-pending__ring', 'aria-hidden': 'true' });
  const title = h('h3', { class: 'lib-card__title clamp-2' });
  const stage = h('p', { class: 'lib-card__by truncate' });
  const node = h('div', { class: 'lib-card lib-card--pending surface fade-in' },
    h('div', { class: 'lib-card__cover' }, fan),
    h('div', { class: 'lib-card__body' },
      h('div', { class: 'lib-pending__row' }, dial, h('div', { class: 'lib-pending__text' }, title, stage)),
      h('div', { class: 'lib-card__chips', 'aria-hidden': 'true' },
        h('span', { class: 'skeleton skeleton--pill lib-skel-chip' }),
        h('span', { class: 'skeleton skeleton--pill lib-skel-chip' }))));
  node._r = { dial, title, stage };
  return node;
}

function patchPending(node, job) {
  const refs = node._r;
  setText(refs.title, `Cutting ${job.label || 'your video'}`);
  setText(refs.stage, stageLabel(job));
  setProgress(refs.dial, Number(job.progress) || 0);
}

function createSkeletonCard() {
  return h('div', { class: 'lib-card lib-card--skeleton surface', 'aria-hidden': 'true' },
    h('div', { class: 'lib-card__cover lib-card__cover--skeleton' }, h('span', { class: 'skeleton lib-skel-fill' })),
    h('div', { class: 'lib-card__body' },
      h('span', { class: 'skeleton skeleton--line lib-skel-title' }),
      h('span', { class: 'skeleton skeleton--line lib-skel-by' }),
      h('div', { class: 'lib-card__chips' },
        h('span', { class: 'skeleton skeleton--pill lib-skel-chip' }),
        h('span', { class: 'skeleton skeleton--pill lib-skel-chip' }))));
}

/* ───────── Sources section ───────── */

const haystacks = new WeakMap();
function haystack(source) {
  let text = haystacks.get(source);
  if (text === undefined) {
    text = [sourceTitle(source), source.channel, ...source.clips.map(clip => clip.title)].filter(Boolean).join('\n').toLowerCase();
    haystacks.set(source, text);
  }
  return text;
}

function createSeg(group, label, options) {
  const items = options.map(option => h('button', { class: 'seg__item', type: 'button', 'aria-pressed': 'false', dataset: { value: option.id } },
    h('span', { text: option.label }),
    option.counted && h('span', { class: 'seg__count', text: '0' })));
  return { el: h('div', { class: 'seg', role: 'group', 'aria-label': label, dataset: { seg: group } }, items), items };
}

function createSources() {
  const view = {
    query: '',
    terms: [],
    sort: readPref(PREF.sort, SORTS.map(sort => sort.id), 'recent'),
    filter: readPref(PREF.filter, FILTERS.map(filter => filter.id), 'all')
  };
  let staggered = false;
  let statusKey = '';
  let fresh = null;

  /* Toolbar */
  const count = h('span', { class: 'chip num' });
  const search = h('input', { class: 'lib-search__input', id: 'lib-search', type: 'search', placeholder: 'Search sources', autocomplete: 'off', 'aria-label': 'Search sources' });
  search.spellcheck = false;
  const searchClear = h('button', { class: 'icon-btn icon-btn--sm icon-btn--ghost', type: 'button', 'aria-label': 'Clear search', hidden: true }, icon('x'));
  const slash = h('kbd', { class: 'kbd lib-search__kbd', 'aria-hidden': 'true', text: '/' });
  const searchBox = h('div', { class: 'search lib-search', role: 'search' }, icon('magnifying-glass'), search, slash, searchClear);
  const sortSeg = createSeg('sort', 'Sort sources', SORTS);
  const filterSeg = createSeg('filter', 'Filter sources', FILTERS.map(filter => ({ ...filter, counted: true })));
  const bar = h('div', { class: 'lib-bar', hidden: true },
    h('div', { class: 'lib-bar__title' }, h('h2', { text: 'Sources' }), count),
    h('div', { class: 'lib-bar__tools' }, searchBox, sortSeg.el, filterSeg.el));

  /* Body */
  const bannerText = h('span', { class: 'lib-banner__text' });
  const bannerRetry = button({ label: 'Try again', icon: 'arrow-clockwise', size: 'sm', onClick: event => retryLoad(event.currentTarget) });
  const banner = h('div', { class: 'callout callout--bad lib-banner', role: 'alert', hidden: true },
    icon('warning-circle', { fill: true }), h('div', { class: 'callout__body' }, bannerText), bannerRetry);
  const skeletons = h('div', { class: 'lib-grid', hidden: true },
    h('p', { class: 'sr-only', role: 'status', text: 'Loading your library' }),
    ...Array.from({ length: 6 }, createSkeletonCard));
  const grid = h('div', { class: 'lib-grid', hidden: true });
  const status = h('div', { class: 'lib-status', hidden: true });
  const live = h('p', { class: 'sr-only', role: 'status' });
  const el = h('section', { class: 'lib-sources', 'aria-label': 'Sources' }, bar, banner, skeletons, grid, status, live);

  /* Filtering, sorting, painting */
  function visibleSources(all) {
    const test = FILTER_TESTS[view.filter];
    const list = all.filter(source => test(source) && view.terms.every(term => haystack(source).includes(term)));
    return list.sort(SORTERS[view.sort]);
  }

  function filtersActive() { return view.terms.length > 0 || view.filter !== 'all'; }

  function paintBar(all, shown) {
    setText(count, shown === all.length ? String(all.length) : `${shown} of ${all.length}`);
    for (const item of sortSeg.items) item.setAttribute('aria-pressed', String(item.dataset.value === view.sort));
    for (const item of filterSeg.items) {
      item.setAttribute('aria-pressed', String(item.dataset.value === view.filter));
      const test = FILTER_TESTS[item.dataset.value];
      setText(item.querySelector('.seg__count'), all.filter(test).length);
    }
    const hasQuery = search.value !== '';
    searchClear.hidden = !hasQuery;
    slash.hidden = hasQuery;
    setText(live, filtersActive() ? `${plural(shown, 'source')} shown` : '');
  }

  function retryLoad(btn) {
    setBusy(btn, true, 'Loading…');
    Promise.resolve().then(() => refreshLibrary()).catch(() => {}).finally(() => setBusy(btn, false));
  }

  function clearFilters() {
    view.query = '';
    view.terms = [];
    view.filter = 'all';
    search.value = '';
    writePref(PREF.filter, view.filter);
    render();
  }

  function buildStatus(screen) {
    if (screen === 'error') {
      return emptyState({
        icon: 'warning-circle', tone: 'bad', title: 'Could not load your library',
        text: `${sentence(state.clipsError)} Check that the clips folder is available, then try again.`,
        actions: [button({ label: 'Try again', icon: 'arrow-clockwise', variant: 'primary', onClick: event => retryLoad(event.currentTarget) })]
      });
    }
    if (screen === 'empty') return buildExplainer();
    const filterName = FILTERS.find(filter => filter.id === view.filter).label.toLowerCase();
    let text;
    if (view.terms.length && view.filter !== 'all') text = `Nothing matches "${view.query}" among ${filterName} sources.`;
    else if (view.terms.length) text = `Nothing matches "${view.query}". Try a different word or clear the search.`;
    else text = view.filter === 'ready' ? 'No source has ready clips right now.' : 'No source has all of its clips completed yet.';
    return emptyState({
      icon: 'magnifying-glass', title: 'No sources match', text,
      actions: [button({ label: 'Clear filters', icon: 'x', onClick: clearFilters })]
    });
  }

  function buildExplainer() {
    const steps = [
      { icon: icon('link'), title: 'Paste a link', text: 'Drop in a YouTube URL, or pick a video file from your computer.' },
      { icon: icon('sparkle'), title: 'We find the highlights', text: 'The engine transcribes the video and cuts the strongest moments into vertical clips.' },
      { icon: icon('paper-plane-tilt'), title: 'Review and publish', text: 'Preview each clip, polish the title and post it to your connected accounts.' }
    ];
    return h('div', { class: 'lib-how surface' },
      h('div', { class: 'lib-how__head' },
        h('h2', { text: 'Your library is empty' }),
        h('p', { text: 'Clips you generate show up here, grouped by the video they came from.' })),
      h('ol', { class: 'lib-how__steps' }, steps.map((step, index) => h('li', { class: 'lib-how__step' },
        h('span', { class: 'lib-how__num num', text: String(index + 1) }),
        h('span', { class: 'lib-how__icon' }, step.icon),
        h('h3', { text: step.title }),
        h('p', { text: step.text })))));
  }

  function paintStatus(screen) {
    const key = [screen, view.query, view.filter, screen === 'error' ? state.clipsError : ''].join('|');
    if (key === statusKey) return;
    statusKey = key;
    status.replaceChildren(buildStatus(screen));
  }

  function createItem(item) {
    const node = item === PENDING ? createPendingCard() : createCard(item);
    updateItem(node, item);
    return node;
  }
  function updateItem(node, item) {
    if (item === PENDING) patchPending(node, state.job);
    else updateCard(node, item);
  }

  function paintGrid(items) {
    const before = new Set(grid.children);
    const nodes = reconcile(grid, items, item => (item === PENDING ? 'pending' : item.key), createItem, updateItem);
    if (!staggered) {
      const added = nodes.filter(node => !before.has(node) && node.dataset.key !== 'pending');
      if (added.length) { staggered = true; stagger(added); }
    }
    applyFresh();
  }

  function render() {
    const all = getSources();
    const running = state.job.status === 'running';
    const loading = !state.clipsLoaded && !all.length && !state.clipsError;
    const shown = loading ? [] : visibleSources(all);
    const showPending = running && (!all.length || !filtersActive());
    const items = showPending ? [PENDING, ...shown] : shown;
    let screen = 'grid';
    if (loading) screen = 'loading';
    else if (!all.length && !running) screen = state.clipsError ? 'error' : 'empty';
    else if (!items.length) screen = 'nomatch';

    bar.hidden = !all.length;
    skeletons.hidden = screen !== 'loading';
    grid.hidden = screen !== 'grid';
    status.hidden = screen === 'loading' || screen === 'grid';
    banner.hidden = !(state.clipsError && all.length);
    if (!banner.hidden) setText(bannerText, `Could not refresh the library. ${sentence(state.clipsError)}`);
    if (all.length) paintBar(all, shown.length);
    if (screen === 'grid') paintGrid(items);
    else if (!status.hidden) paintStatus(screen);
  }

  function patchPendingCard() {
    const node = grid.firstElementChild;
    if (node?.dataset.key === 'pending') patchPending(node, state.job);
  }

  function refreshTimes() {
    for (const node of grid.children) if (node._r?.time && node._at) setText(node._r.time, ago(node._at));
  }

  /* Highlight the card a finished run just added to or updated. */
  function expectFresh(key) { fresh = { key, at: Date.now() }; }
  function cardFor(key) { return [...grid.children].find(node => node.dataset.key === key) || null; }
  function applyFresh() {
    if (!fresh) return;
    if (Date.now() - fresh.at > FRESH_WINDOW_MS) { fresh = null; return; }
    const node = cardFor(fresh.key);
    if (!node) return;
    fresh = null;
    node.classList.remove('is-fresh');
    void node.offsetWidth;
    node.classList.add('is-fresh');
    setTimeout(() => node.classList.remove('is-fresh'), FRESH_MS + 100);
  }

  grid.addEventListener('dragstart', event => event.preventDefault());

  /* Toolbar events */
  const applyQuery = debounce(() => {
    view.query = search.value.trim();
    view.terms = view.query.toLowerCase().split(/\s+/).filter(Boolean);
    render();
  }, 120);
  search.addEventListener('input', () => {
    searchClear.hidden = search.value === '';
    slash.hidden = search.value !== '';
    applyQuery();
  });
  search.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (search.value) { search.value = ''; applyQuery.cancel(); view.query = ''; view.terms = []; render(); }
    else search.blur();
  });
  searchClear.addEventListener('click', () => {
    search.value = '';
    applyQuery.cancel();
    view.query = '';
    view.terms = [];
    render();
    search.focus();
  });
  delegate(bar, 'click', '.seg__item', (event, item) => {
    const group = item.parentElement.dataset.seg;
    view[group] = item.dataset.value;
    writePref(PREF[group], view[group]);
    render();
  });

  return {
    el, render, patchPending: patchPendingCard, refreshTimes, expectFresh,
    focusSearch() { search.focus(); search.select(); },
    coverFor(key) { return grid.hidden ? null : cardFor(key)?.querySelector('.lib-card__cover') || null; }
  };
}

/* ───────── View ───────── */

let instance = null;

/** Focus the composer (optionally prefilled and scrolled into view). Works on the single library instance. */
export function focusComposer(options = {}) {
  instance?.focusComposer(options);
}

export function createLibraryView() {
  const head = createHead();
  const composer = createComposer();
  const sources = createSources();
  const el = h('div', { class: 'lib' }, head.el, composer.el, sources.el);

  const dirty = new Set(['head', 'composer', 'log', 'sources']);
  let active = false;
  let firstEnter = true;
  let pendingFocus = null;
  let jobShape = '';
  let lastStatus = state.job.status;

  function flush() {
    if (dirty.delete('head')) head.render();
    if (dirty.delete('composer')) composer.render();
    if (dirty.delete('log')) composer.renderLog();
    if (dirty.delete('sources')) sources.render();
  }
  function mark(...parts) {
    for (const part of parts) dirty.add(part);
    if (active) flush();
  }

  function consumePrefill() {
    const prefill = state.composerPrefill;
    if (!prefill) return false;
    set({ composerPrefill: null });
    composer.focus({ url: prefill.url });
    return true;
  }

  subscribe(['clips', 'clipsLoaded', 'clipsError', 'sourceInfo', 'clipsRefreshing'], keys => {
    mark('head');
    if (['clips', 'clipsLoaded', 'clipsError', 'sourceInfo'].some(key => keys.has(key))) mark('sources');
  });
  subscribe('job', () => {
    const job = state.job;
    if (lastStatus === 'running' && job.status === 'done' && job.sourceKey) sources.expectFresh(job.sourceKey);
    lastStatus = job.status;
    mark('composer');
    const shape = job.status + '|' + job.label;
    if (shape !== jobShape) { jobShape = shape; mark('sources'); }
    else if (active) sources.patchPending();
  });
  subscribe('jobLog', () => mark('log'));
  subscribe('composerPrefill', () => { if (active) consumePrefill(); });

  function onKeydown(event) {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTyping(event.target) || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    sources.focusSearch();
  }
  const onVisibility = () => composer.setActive(active && !document.hidden);

  function enter() {
    active = true;
    flush();
    sources.patchPending();
    sources.refreshTimes();
    composer.setActive(!document.hidden);
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('visibilitychange', onVisibility);

    const prefilled = consumePrefill();
    if (pendingFocus && Date.now() - pendingFocus.at < 2000) { composer.focus(pendingFocus); pendingFocus = null; }
    else if (firstEnter && !prefilled && composer.isIdle()) composer.focus({});
    firstEnter = false;
    pendingFocus = null;
  }

  function leave() {
    active = false;
    composer.setActive(false);
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('visibilitychange', onVisibility);
  }

  function sharedElement(otherRoute) {
    return otherRoute?.name === 'source' ? sources.coverFor(otherRoute.key) : null;
  }

  instance = {
    focusComposer(options) {
      if (active) composer.focus(options);
      else pendingFocus = { ...options, at: Date.now() };
    }
  };

  return { el, enter, leave, sharedElement };
}
