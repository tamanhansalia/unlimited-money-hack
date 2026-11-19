// Source view: every clip cut from one source video.
import { h, icon, reconcile, delegate, setText, stagger } from '../core/dom.js';
import { state, subscribe, set } from '../core/store.js';
import { duration, durationLong, bytes, plural } from '../core/format.js';
import { navigate, hrefFor } from '../core/router.js';
import { errorMessage, api } from '../core/api.js';
import { toast } from '../core/toast.js';
import { button, chip, statusChip, emptyState, setBusy } from '../core/components.js';
import { attachPoster } from '../core/thumbs.js';
import { getSource, sourceTitle } from '../core/sources.js';
import { moveClips, refreshLibrary } from '../core/library.js';
import { openClipSheet } from './sheet.js';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'ready', label: 'Ready' },
  { id: 'completed', label: 'Completed' }
];
const ORDERS = [
  { id: 'timeline', label: 'Timeline', icon: 'list-numbers' },
  { id: 'newest', label: 'Newest', icon: 'clock-counter-clockwise' }
];
const KINDS = {
  youtube: { label: 'YouTube', icon: 'youtube-logo', fill: true },
  file: { label: 'Local file', icon: 'file-video' },
  legacy: { label: 'Earlier clips', icon: 'stack' }
};
const STATUS_LABEL = { ready: 'Ready', completed: 'Completed' };

const EAGER_POSTERS = 8;
const COVER_POSTERS = 3;
const SKELETON_TILES = 8;
const TITLE_GRACE_MS = 2500;
// attachPoster loads these first.
const EAGER = { priority: 1 };

// Filter and ordering are remembered per source for the lifetime of the app.
const prefs = new Map();
function prefsFor(key) {
  let entry = prefs.get(key);
  if (!entry) { entry = { filter: 'all', order: 'timeline' }; prefs.set(key, entry); }
  return entry;
}

/* ───────── Pure helpers ───────── */

const createdOf = clip => clip.createdAt || clip.updatedAt || 0;
const sentence = text => {
  const value = String(text || '').trim();
  return !value || /[.!?]$/.test(value) ? value : value + '.';
};
const failure = (prefix, error) => `${prefix} ${sentence(errorMessage(error))}`.trim();

function visibleClips(source, { filter, order }) {
  const list = filter === 'all' ? [...source.clips] : source.clips.filter(clip => clip.status === filter);
  if (order === 'newest') list.sort((a, b) => createdOf(b) - createdOf(a));
  return list;
}

/** What the bulk button does for the current filter: which clips it moves and in which direction. */
function bulkPlan(source, filter) {
  const restore = filter === 'completed' || (filter === 'all' && source.readyCount === 0);
  const from = restore ? 'completed' : 'ready';
  return { restore, from, to: restore ? 'ready' : 'completed', clips: source.clips.filter(clip => clip.status === from) };
}

function folderStatus(source, filter) {
  if (filter === 'completed' && source.completedCount) return 'completed';
  return source.readyCount ? 'ready' : 'completed';
}

function byline(source) {
  if (source.channel) return source.channel;
  return source.clips.find(clip => clip.source?.file)?.source.file || '';
}

function titleIsPending(source) {
  return source.kind === 'youtube'
    && !state.sourceInfo[source.key]?.title
    && !source.clips.some(clip => clip.source?.title);
}

function statChip(options) {
  const el = chip('0', options);
  const label = el.lastElementChild;
  return { el, set: text => setText(label, text) };
}

/* ───────── Clip tile ───────── */

const tileParts = new WeakMap();

function createTile() {
  const parts = {
    img: h('img', { class: 'poster', alt: '', decoding: 'async' }),
    status: h('span', { class: 'src-tile__status' }),
    pos: chip('#0', { media: true, small: true }),
    title: h('span', { class: 'src-tile__title clamp-2' }),
    meta: h('span', { class: 'src-tile__meta num' }),
    sig: '', stamp: '', detach: null
  };
  const tile = h('button', { class: 'src-tile surface', type: 'button' },
    h('span', { class: 'src-tile__media' }, parts.img, h('span', { class: 'src-tile__scrim' })),
    parts.status,
    h('span', { class: 'src-tile__pos' }, parts.pos),
    h('span', { class: 'src-tile__play' }, icon('play', { fill: true })),
    h('span', { class: 'src-tile__info' }, parts.title, parts.meta));
  tileParts.set(tile, parts);
  return tile;
}

function paintTile(tile, clip, position, eager) {
  const parts = tileParts.get(tile);
  const stamp = `${clip.id}|${clip.updatedAt}`;
  if (parts.stamp !== stamp) {
    parts.detach?.();
    parts.stamp = stamp;
    parts.detach = attachPoster(parts.img, clip, eager ? EAGER : {});
  }
  const sig = [clip.status, clip.title, clip.durationSec, clip.fileSizeBytes, position].join('|');
  if (parts.sig === sig) return;
  parts.sig = sig;

  const title = clip.title || 'Untitled clip';
  const length = duration(clip.durationSec);
  parts.status.replaceChildren(statusChip(clip.status, { media: true, small: true }));
  setText(parts.pos.lastElementChild, `#${position}`);
  setText(parts.title, title);
  setText(parts.meta, [length, bytes(clip.fileSizeBytes)].filter(Boolean).join(' · '));
  tile.setAttribute('aria-label', `${title}. ${STATUS_LABEL[clip.status] || clip.status}, clip ${position}${length ? ', ' + length : ''}`);
}

function columnCount(tiles) {
  const top = tiles[0].offsetTop;
  const wrapped = tiles.findIndex(tile => tile.offsetTop !== top);
  return wrapped === -1 ? tiles.length : wrapped;
}

/** Index to focus for an arrow/home/end key, or null when the key is not a navigation key. */
function nextIndex(key, index, tiles) {
  const last = tiles.length - 1;
  switch (key) {
    case 'ArrowRight': return Math.min(index + 1, last);
    case 'ArrowLeft': return Math.max(index - 1, 0);
    case 'Home': return 0;
    case 'End': return last;
    case 'ArrowUp': {
      const up = index - columnCount(tiles);
      return up >= 0 ? up : index;
    }
    case 'ArrowDown': {
      const cols = columnCount(tiles);
      if (index + cols <= last) return index + cols;
      return Math.floor(index / cols) === Math.floor(last / cols) ? index : last;
    }
    default: return null;
  }
}

/* ───────── View ───────── */

export function createSourceView() {
  let visible = false;
  let stale = true;            // the store changed while hidden
  let routeKey = '';
  let source = null;           // the Source on screen, null while loading or missing
  let staggeredKey = '';
  let coverSig = '';
  let coverDetach = [];
  let bulkBusy = false;
  let titleTimer = 0;
  const titleSince = new Map();

  /* Header */
  const coverEl = h('div', { class: 'src-cover', 'aria-hidden': 'true' });
  const kindEl = h('div', { class: 'src-kind' });
  const titleEl = h('h1', { class: 'src-title clamp-3' });
  const bylineEl = h('p', { class: 'src-byline truncate' });
  const stats = {
    clips: statChip({ icon: 'film-strip' }),
    ready: statChip({ kind: 'ready', dot: true }),
    completed: statChip({ kind: 'ok', dot: true }),
    length: statChip({ icon: 'clock', title: 'Total length of all clips' })
  };
  const generateBtn = button({ label: 'Generate more', icon: 'sparkle', variant: 'primary', onClick: generateMore });
  const youtubeBtn = button({ label: 'Open on YouTube', icon: 'arrow-square-out', onClick: openYouTube });
  const bulkBtn = button({ onClick: runBulk });
  const folderBtn = button({ label: 'Show in folder', icon: 'folder-open', variant: 'ghost', onClick: showFolder });
  const headEl = h('header', { class: 'src-head glass' },
    coverEl,
    h('div', { class: 'src-info' },
      kindEl, titleEl, bylineEl,
      h('div', { class: 'src-stats' }, stats.clips.el, stats.ready.el, stats.completed.el, stats.length.el),
      h('div', { class: 'src-actions' }, generateBtn, youtubeBtn, bulkBtn, folderBtn)));

  const doneEl = h('div', { class: 'callout callout--ok src-done', hidden: true },
    icon('confetti'),
    h('div', { class: 'callout__body' },
      h('strong', { text: 'All clips from this video are done' }),
      h('span', { text: 'Everything here is marked completed. Generate more to keep going.' })));

  /* Toolbar */
  const filterRefs = FILTERS.map(({ id, label }) => {
    const count = h('span', { class: 'seg__count num', text: '0' });
    const btn = h('button', { class: 'seg__item', type: 'button', dataset: { filter: id }, 'aria-pressed': 'false' }, h('span', { text: label }), count);
    return { id, btn, count };
  });
  const orderRefs = ORDERS.map(({ id, label, icon: iconName }) => ({
    id,
    btn: h('button', { class: 'seg__item', type: 'button', dataset: { order: id }, 'aria-pressed': 'false' }, icon(iconName), h('span', { text: label }))
  }));
  const filterSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Show clips' }, filterRefs.map(ref => ref.btn));
  const orderSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Order clips' }, orderRefs.map(ref => ref.btn));
  const toolbarEl = h('div', { class: 'src-toolbar' }, filterSeg, orderSeg);
  const statusEl = h('p', { class: 'sr-only', role: 'status' });

  /* Grid and per-filter empty states */
  const grid = h('div', { class: 'src-grid', role: 'group', 'aria-label': 'Clips from this video' });
  const emptyNodes = new Map([
    ['ready', emptyState({
      icon: 'tray', title: 'No ready clips',
      text: 'Every clip from this video is completed. Restore one if you want to review it again.',
      actions: [button({ label: 'Show completed clips', icon: 'check-circle', onClick: () => setFilter('completed') })]
    })],
    ['completed', emptyState({
      icon: 'seal-check', title: 'No completed clips',
      text: 'Mark clips completed once you have published them and they will be listed here.',
      actions: [button({ label: 'Show ready clips', icon: 'play-circle', onClick: () => setFilter('ready') })]
    })]
  ]);
  const emptyEl = h('div', { class: 'src-empty surface' }, [...emptyNodes.values()]);
  const contentEl = h('div', { class: 'src-content' }, headEl, doneEl, toolbarEl, grid, emptyEl, statusEl);

  /* Loading, error and not-found states */
  const loadingEl = buildSkeleton();
  const errorDetail = h('p', { class: 'src-error-detail selectable' });
  const retryBtn = button({ label: 'Try again', icon: 'arrow-clockwise', variant: 'primary', onClick: retryLoad });
  const errorEmpty = emptyState({
    icon: 'cloud-slash', tone: 'bad', title: "Couldn't load your clips",
    text: 'Check that the clips folder exists and is not locked by another program, then try again.',
    actions: [retryBtn, backButton()]
  });
  errorEmpty.insertBefore(errorDetail, errorEmpty.querySelector('.empty__actions'));
  const errorEl = h('div', { class: 'src-state surface' }, errorEmpty);
  const missingEl = h('div', { class: 'src-state surface' }, emptyState({
    icon: 'video-camera-slash', title: 'Source not found',
    text: 'None of the clips from this video are in your library any more. They may have been moved or deleted.',
    actions: [backButton()]
  }));
  const modes = { loading: loadingEl, error: errorEl, missing: missingEl, content: contentEl };

  const back = h('a', { class: 'btn btn--ghost btn--sm src-back', href: hrefFor.library(), title: 'Back to library (Backspace)' },
    icon('arrow-left'), h('span', { text: 'Library' }));
  const el = h('section', { class: 'src', 'aria-label': 'Source clips' },
    h('div', { class: 'src-crumb' }, back), loadingEl, errorEl, missingEl, contentEl);
  showMode('loading');

  /* ───────── Rendering ───────── */

  function showMode(name) {
    for (const [mode, node] of Object.entries(modes)) node.hidden = mode !== name;
  }

  function render() {
    stale = false;
    source = getSource(routeKey) || null;
    if (!source) {
      const failed = !state.clipsLoaded && Boolean(state.clipsError);
      showMode(state.clipsLoaded ? 'missing' : failed ? 'error' : 'loading');
      if (failed) setText(errorDetail, state.clipsError);
      return;
    }
    showMode('content');
    const choice = prefsFor(source.key);
    renderHeader(source, choice);
    renderToolbar(source, choice);
    renderGrid(source, choice);
  }

  function renderHeader(src, choice) {
    renderCover(src);
    renderKind(src);
    const pending = titleIsPending(src) && trackPendingTitle(src.key);
    setText(titleEl, sourceTitle(src));
    titleEl.classList.toggle('is-resolving', pending);
    const by = byline(src);
    bylineEl.hidden = !by;
    setText(bylineEl, by);

    stats.clips.set(plural(src.total, 'clip'));
    stats.ready.el.hidden = !src.readyCount;
    stats.ready.set(`${src.readyCount} ready`);
    stats.completed.el.hidden = !src.completedCount;
    stats.completed.set(`${src.completedCount} completed`);
    const length = durationLong(src.totalDuration);
    stats.length.el.hidden = !length;
    stats.length.set(length);

    youtubeBtn.hidden = !(src.kind === 'youtube' && src.url);
    generateBtn.title = src.url ? 'Open the library with this video link filled in' : 'Open the library to add more videos';
    paintBulk(bulkPlan(src, choice.filter));

    doneEl.hidden = !(src.total > 0 && src.completedCount === src.total);
  }

  /** Shimmer the fallback title for a short grace period while the real title is fetched. */
  function trackPendingTitle(key) {
    const since = titleSince.get(key) ?? Date.now();
    titleSince.set(key, since);
    const remaining = TITLE_GRACE_MS - (Date.now() - since);
    if (remaining <= 0) return false;
    clearTimeout(titleTimer);
    titleTimer = setTimeout(() => titleEl.classList.remove('is-resolving'), remaining);
    return true;
  }

  function renderCover(src) {
    const picks = src.clips.slice(0, COVER_POSTERS);
    const sig = picks.map(clip => `${clip.id}|${clip.updatedAt}`).join();
    if (sig === coverSig) return;
    coverSig = sig;
    for (const detach of coverDetach) detach();
    coverDetach = [];
    coverEl.dataset.count = String(picks.length);
    coverEl.replaceChildren(...picks.map(clip => {
      const img = h('img', { class: 'poster', alt: '', decoding: 'async' });
      coverDetach.push(attachPoster(img, clip, EAGER));
      return h('span', { class: 'src-cell' }, img);
    }));
  }

  function renderKind(src) {
    const kind = KINDS[src.kind] ? src.kind : 'legacy';
    if (kindEl.dataset.kind === kind) return;
    kindEl.dataset.kind = kind;
    const spec = KINDS[kind];
    kindEl.replaceChildren(chip(spec.label, { icon: spec.icon, fill: spec.fill }));
  }

  function paintBulk(plan) {
    bulkBtn.hidden = plan.clips.length === 0;
    if (bulkBusy) return;
    const mode = plan.restore ? 'restore' : 'complete';
    if (bulkBtn.dataset.mode !== mode) {
      bulkBtn.dataset.mode = mode;
      bulkBtn.replaceChildren(
        icon(plan.restore ? 'arrow-counter-clockwise' : 'checks'),
        h('span', { class: 'btn__label', text: plan.restore ? 'Restore all' : 'Mark all completed' }));
    }
    bulkBtn.title = plan.restore
      ? `Move ${plural(plan.clips.length, 'completed clip')} back to Ready`
      : `Mark ${plural(plan.clips.length, 'ready clip')} as completed`;
  }

  function renderToolbar(src, choice) {
    const counts = { all: src.total, ready: src.readyCount, completed: src.completedCount };
    for (const { id, btn, count } of filterRefs) {
      btn.setAttribute('aria-pressed', String(id === choice.filter));
      setText(count, counts[id]);
    }
    for (const { id, btn } of orderRefs) btn.setAttribute('aria-pressed', String(id === choice.order));
  }

  function renderGrid(src, choice) {
    const list = visibleClips(src, choice);
    const positions = new Map(src.clips.map((clip, index) => [clip.id, index + 1]));
    const rank = new Map(list.map((clip, index) => [clip.id, index]));
    const eager = clip => rank.get(clip.id) < EAGER_POSTERS;

    const tiles = reconcile(grid, list, clip => clip.id,
      clip => { const tile = createTile(); paintTile(tile, clip, positions.get(clip.id), eager(clip)); return tile; },
      (tile, clip) => paintTile(tile, clip, positions.get(clip.id), eager(clip)));

    grid.hidden = tiles.length === 0;
    for (const [filter, node] of emptyNodes) node.hidden = !(tiles.length === 0 && choice.filter === filter);
    emptyEl.hidden = tiles.length > 0;
    if (tiles.length && staggeredKey !== src.key) {
      staggeredKey = src.key;
      stagger(tiles);
    }
  }

  /* ───────── Actions ───────── */

  function setFilter(id) {
    if (!source) return;
    prefsFor(source.key).filter = id;
    render();
    setText(statusEl, `Showing ${plural(grid.children.length, 'clip')}`);
  }

  function setOrder(id) {
    if (!source) return;
    prefsFor(source.key).order = id;
    render();
    setText(statusEl, `Ordered by ${id === 'newest' ? 'newest first' : 'position in the video'}`);
  }

  function generateMore() {
    if (source?.url) set({ composerPrefill: { url: source.url } });
    navigate(hrefFor.library());
  }

  function openYouTube() {
    if (!source?.url) return;
    api.openExternal(source.url).catch(error => toast(failure("Couldn't open the video in your browser.", error), { kind: 'error' }));
  }

  function showFolder() {
    if (!source) return;
    api.openFolder(folderStatus(source, prefsFor(source.key).filter))
      .catch(error => toast(failure("Couldn't open the clips folder.", error), { kind: 'error' }));
  }

  async function runBulk() {
    if (bulkBusy || !source) return;
    const plan = bulkPlan(source, prefsFor(source.key).filter);
    if (!plan.clips.length) return;
    bulkBusy = true;
    setBusy(bulkBtn, true, plan.restore ? 'Restoring…' : 'Marking…');
    try {
      reportMove(await moveClips(plan.clips, plan.to), plan);
    } catch (error) {
      toast(failure("Couldn't move the clips.", error), { kind: 'error' });
    } finally {
      bulkBusy = false;
      setBusy(bulkBtn, false);
      if (visible) render(); else stale = true;
    }
  }

  function reportMove({ moved, failed }, { from, to }) {
    if (moved.length) {
      const text = to === 'completed'
        ? `Marked ${plural(moved.length, 'clip')} completed`
        : `Moved ${plural(moved.length, 'clip')} back to Ready`;
      toast(text, { action: { label: 'Undo', run: () => undoMove(moved, from, to) } });
    }
    if (failed.length) {
      const reason = sentence(errorMessage(failed[0].error));
      toast(`${plural(failed.length, 'clip')} could not be moved. ${reason} Close any program using the files, then try again.`, { kind: 'error' });
    }
  }

  async function undoMove(moved, from, to) {
    try {
      const result = await moveClips(moved.map(clip => ({ ...clip, status: to })), from);
      if (result.moved.length) toast(`${plural(result.moved.length, 'clip')} moved back to ${STATUS_LABEL[from]}`);
      if (result.failed.length) toast(failure(`${plural(result.failed.length, 'clip')} could not be moved back.`, result.failed[0].error), { kind: 'error' });
    } catch (error) {
      toast(failure("Couldn't undo the move.", error), { kind: 'error' });
    }
  }

  async function retryLoad() {
    setBusy(retryBtn, true, 'Retrying…');
    try {
      await refreshLibrary();
    } catch (error) {
      toast(failure("Couldn't load your clips.", error), { kind: 'error' });
    } finally {
      setBusy(retryBtn, false);
    }
  }

  /* ───────── Events ───────── */

  delegate(filterSeg, 'click', '[data-filter]', (event, btn) => setFilter(btn.dataset.filter));
  delegate(orderSeg, 'click', '[data-order]', (event, btn) => setOrder(btn.dataset.order));
  delegate(grid, 'click', '.src-tile', (event, tile) => {
    if (source) openClipSheet(source.key, tile.dataset.key);
  });
  grid.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const tile = event.target instanceof Element ? event.target.closest('.src-tile') : null;
    if (!tile) return;
    const tiles = [...grid.children];
    const index = tiles.indexOf(tile);
    const next = nextIndex(event.key, index, tiles);
    if (next === null) return;
    event.preventDefault();
    if (next !== index) tiles[next].focus();
  });

  subscribe(['clips', 'clipsLoaded', 'clipsError', 'sourceInfo'], () => {
    if (visible) render(); else stale = true;
  });

  return {
    el,
    enter(route) {
      visible = true;
      if (stale || route.key !== routeKey) {
        routeKey = route.key;
        render();
      }
    },
    leave() {
      visible = false;
      clearTimeout(titleTimer);
    },
    /** The header cover morphs with the library card cover, as long as it is on screen. */
    sharedElement(otherRoute) {
      if (otherRoute?.name !== 'library' || contentEl.hidden) return null;
      const rect = coverEl.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < innerHeight ? coverEl : null;
    }
  };
}

function backButton() {
  return button({ label: 'Back to library', icon: 'arrow-left', onClick: () => navigate(hrefFor.library()) });
}

function buildSkeleton() {
  const line = cls => h('span', { class: 'skeleton ' + cls });
  return h('div', { class: 'src-skeleton', 'aria-busy': 'true', 'aria-label': 'Loading clips' },
    h('div', { class: 'src-head glass' },
      line('src-skel-cover'),
      h('div', { class: 'src-info' },
        line('skeleton--pill src-skel-chip'),
        line('src-skel-title'),
        line('src-skel-title src-skel-title--short'),
        line('skeleton--line src-skel-line'))),
    h('div', { class: 'src-toolbar' }, line('skeleton--pill src-skel-seg')),
    h('div', { class: 'src-grid' }, Array.from({ length: SKELETON_TILES }, () => line('src-skel-tile'))));
}
