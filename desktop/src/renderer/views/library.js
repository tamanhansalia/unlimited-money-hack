import { h, icon, reconcile, delegate, setText, stagger, isTyping, shake, debounce } from '../core/dom.js';
import { state, subscribe } from '../core/store.js';
import { ago, plural, durationLong } from '../core/format.js';
import { hrefFor, openGeneration } from '../core/router.js';
import { api, errorMessage } from '../core/api.js';
import { toast } from '../core/toast.js';
import { button, iconButton, emptyState, setBusy, setFieldState, setProgress } from '../core/components.js';
import { getSources, getSource, sourceTitle } from '../core/sources.js';
import { attachPoster } from '../core/thumbs.js';
import { refreshLibrary } from '../core/library.js';
import { getJob, isActiveJob, stageLabel, validateYouTube } from '../core/jobs.js';
import { confirmDeleteClips } from './delete-clips.js';

/* ───────── Constants and helpers ───────── */

const PREF = { sort: 'vc:library:sort', filter: 'vc:library:filter' };
const URL_HINT = 'Works with youtube.com and youtu.be links.';
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
/** Only touch the DOM when the message really changed, so live regions do not re-announce. */
function paintField(field, input, level, text, fallback = '') {
  const signature = `${level}|${text}|${fallback}`;
  if (field._sig === signature) return;
  field._sig = signature;
  setFieldState(field, input, level, text, fallback);
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
  if (await refreshLibrary()) toast('Library refreshed.', { kind: 'info', ttl: 2200 });
  else toast(`Could not refresh the library. ${sentence(state.clipsError)}`, { kind: 'error' });
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
    refreshBtn.disabled = state.clipsRefreshing;
  }
  return { el, render };
}

/* ───────── Composer ───────── */

function createComposer() {
  const input = h('input', {
    class: 'lib-url', id: 'lib-url', placeholder: 'Paste a YouTube link', autocomplete: 'off',
    inputmode: 'url', spellcheck: false, 'aria-describedby': 'lib-url-msg'
  });
  const browse = button({ label: 'Browse', icon: 'file-video', variant: 'ghost' });
  const field = h('div', { class: 'field lib-field' },
    h('label', { class: 'field__label', htmlFor: input.id, text: 'Video' }),
    h('div', { class: 'lib-source', dataset: { mode: 'url' } }, icon('link', { cls: 'lib-source__lead' }), input, browse),
    h('p', { class: 'field__msg', id: 'lib-url-msg', 'aria-live': 'polite' }));
  const el = h('form', { class: 'lib-composer lib-entry glass', novalidate: true },
    h('h2', { class: 'lib-title', text: 'New clips' }), field,
    button({ label: 'Continue', icon: 'arrow-right', variant: 'primary', type: 'submit' }));

  function check(submitting = false) {
    const result = validateYouTube(input.value);
    paintField(field, input, result.ok ? 'ok' : submitting || !result.empty ? 'error' : '',
      result.ok ? 'YouTube video detected' : submitting || !result.empty ? result.message : '', URL_HINT);
    return result;
  }

  function proceed(result) {
    checkLater.cancel();
    input.value = '';
    check();
    openGeneration({ source: result.normalized, kind: 'url' });
  }

  const checkLater = debounce(check, 350);
  input.addEventListener('input', event => {
    if (event.inputType === 'insertFromPaste') {
      const result = check();
      if (result.ok) proceed(result);
    } else checkLater();
  });
  input.addEventListener('blur', () => { checkLater.cancel(); check(); });
  el.onsubmit = event => {
    event.preventDefault();
    const result = check(true);
    if (result.ok) proceed(result);
    else { input.focus(); shake(field); }
  };
  browse.onclick = async () => {
    setBusy(browse, true, 'Browse');
    try {
      const source = await api.chooseVideo();
      if (source && state.route.name === 'library') openGeneration({ source, kind: 'file' });
    } catch (error) {
      paintField(field, input, 'error', errorMessage(error), URL_HINT);
    } finally { setBusy(browse, false); }
  };
  check();
  return { el, focus: () => input.focus({ preventScroll: true }) };
}

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

function createCard(source, onDelete) {
  const items = createFan();
  const fan = h('div', { class: 'lib-fan', 'aria-hidden': 'true' }, items);
  const kind = h('span', { class: 'lib-card__kind' });
  const cover = h('div', { class: 'lib-card__cover', dataset: { vt: 'cover' } }, fan, kind);
  const title = h('h3', { class: 'lib-card__title clamp-2' });
  const by = h('p', { class: 'lib-card__by truncate' });
  const total = h('span', { class: 'chip chip--sm' });
  const ready = h('span', { class: 'chip chip--sm chip--ready' });
  const completed = h('span', { class: 'chip chip--sm chip--ok' });
  const segDone = h('span', { class: 'lib-card__seg lib-card__seg--ok' });
  const segReady = h('span', { class: 'lib-card__seg lib-card__seg--ready' });
  const time = h('time', { class: 'lib-card__time num' });
  const link = h('a', { class: 'lib-card__link', href: hrefFor.source(source.key) },
    cover,
    h('div', { class: 'lib-card__body' },
      title, by,
      h('div', { class: 'lib-card__chips' }, total, ready, completed),
      h('div', { class: 'lib-card__foot' },
        h('span', { class: 'lib-card__bar', 'aria-hidden': 'true' }, segDone, segReady),
        time)));
  const remove = iconButton({ icon: 'trash', label: 'Delete source group', size: 'sm',
    cls: 'lib-card__delete', onClick: () => onDelete(source.key) });
  const node = h('article', { class: 'lib-card lib-card--source surface' }, link, remove);
  node._r = { fan, items, kind, title, by, total, ready, completed, segDone, segReady, time, remove, kindId: '' };
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
    refs.remove.setAttribute('aria-label', `Delete source group: ${sourceTitle(source)}`);
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

function createPendingCard(job) {
  const fan = h('div', { class: 'lib-fan', 'aria-hidden': 'true', dataset: { count: '3' } },
    FAN_SLOTS.map(slot => h('span', { class: 'lib-fan__item lib-fan__item--ghost skeleton', dataset: { slot } })));
  const dial = h('span', { class: 'ring lib-pending__ring', 'aria-hidden': 'true' });
  const title = h('h3', { class: 'lib-card__title clamp-2' });
  const stage = h('p', { class: 'lib-card__by truncate' });
  const node = h('a', { class: 'lib-card lib-card--pending surface fade-in', href: hrefFor.jobs(job.id) },
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
  setText(refs.title, job.label || 'Your video');
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

  async function retryLoad(btn) {
    setBusy(btn, true, 'Loading…');
    try { await refresh(); }
    finally { setBusy(btn, false); }
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
    const node = isActiveJob(item) ? createPendingCard(item) : createCard(item, deleteSource);
    updateItem(node, item);
    return node;
  }
  function updateItem(node, item) {
    if (isActiveJob(item)) patchPending(node, item);
    else updateCard(node, item);
  }

  function paintGrid(items) {
    const before = new Set(grid.children);
    const nodes = reconcile(grid, items, item => isActiveJob(item) ? 'job:' + item.id : item.key, createItem, updateItem);
    if (!staggered) {
      const added = nodes.filter(node => !before.has(node) && !node.dataset.key.startsWith('job:'));
      if (added.length) { staggered = true; stagger(added); }
    }
    applyFresh();
  }

  function render() {
    const all = getSources();
    const pending = state.jobs.filter(isActiveJob);
    const loading = !state.clipsLoaded && !all.length && !pending.length && !state.clipsError;
    const shown = loading ? [] : visibleSources(all);
    const showPending = pending.length && (!all.length || !filtersActive());
    const items = showPending ? [...pending, ...shown] : shown;
    let screen = 'grid';
    if (loading) screen = 'loading';
    else if (!all.length && !pending.length) screen = state.clipsError ? 'error' : 'empty';
    else if (!items.length) screen = 'nomatch';

    bar.hidden = !all.length;
    skeletons.hidden = screen !== 'loading';
    grid.hidden = screen !== 'grid';
    status.hidden = screen === 'loading' || screen === 'grid';
    banner.hidden = !(state.clipsError && screen !== 'error');
    if (!banner.hidden) setText(bannerText, `Could not refresh the library. ${sentence(state.clipsError)}`);
    if (all.length) paintBar(all, shown.length);
    if (screen === 'grid') paintGrid(items);
    else {
      if (!all.length && grid.childElementCount) paintGrid([]);
      if (!status.hidden) paintStatus(screen);
    }
  }

  async function deleteSource(key) {
    const source = getSource(key);
    if (!source || !await confirmDeleteClips({ source })) return;
    const next = !grid.hidden && grid.querySelector('.lib-card__link');
    (next || document.getElementById('new-clips'))?.focus({ preventScroll: true });
  }

  function patchPendingCards() {
    for (const node of grid.children) {
      if (!node.dataset.key.startsWith('job:')) continue;
      const job = getJob(node.dataset.key.slice(4));
      if (job && isActiveJob(job)) patchPending(node, job);
    }
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
    el, render, patchPending: patchPendingCards, refreshTimes, expectFresh,
    focusSearch() { search.focus(); search.select(); },
    coverFor(key) { return grid.hidden ? null : cardFor(key)?.querySelector('.lib-card__cover') || null; }
  };
}

/* ───────── View ───────── */

export function createLibraryView() {
  const head = createHead();
  const composer = createComposer();
  const sources = createSources();
  const el = h('div', { class: 'lib' }, head.el, composer.el, sources.el);

  const dirty = new Set(['head', 'sources']);
  let active = false;
  let firstEnter = true;
  let jobShape = '';
  let finishedJobs = new Set();

  function flush() {
    if (dirty.delete('head')) head.render();
    if (dirty.delete('sources')) sources.render();
  }
  function mark(...parts) {
    for (const part of parts) dirty.add(part);
    if (active) flush();
  }

  subscribe(['clips', 'clipsLoaded', 'clipsError', 'sourceInfo', 'clipsRefreshing'], keys => {
    mark('head');
    if (['clips', 'clipsLoaded', 'clipsError', 'sourceInfo'].some(key => keys.has(key))) mark('sources');
  });
  subscribe('jobs', () => {
    const completed = state.jobs.filter(job => job.status === 'done');
    const fresh = completed.findLast(job => job.sourceKey && !finishedJobs.has(job.id));
    if (fresh) sources.expectFresh(fresh.sourceKey);
    finishedJobs = new Set(completed.map(job => job.id));
    const shape = state.jobs.filter(isActiveJob).map(job => job.id).join(',');
    if (shape !== jobShape) { jobShape = shape; mark('sources'); }
    else if (active) sources.patchPending();
  });

  function onKeydown(event) {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTyping(event.target) || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    sources.focusSearch();
  }

  function enter() {
    active = true;
    flush();
    sources.patchPending();
    sources.refreshTimes();
    document.addEventListener('keydown', onKeydown);
    if (firstEnter) composer.focus();
    firstEnter = false;
  }

  function leave() {
    active = false;
    document.removeEventListener('keydown', onKeydown);
  }

  function sharedElement(otherRoute) {
    return otherRoute?.name === 'source' ? sources.coverFor(otherRoute.key) : null;
  }

  return { el, enter, leave, sharedElement, refresh };
}
