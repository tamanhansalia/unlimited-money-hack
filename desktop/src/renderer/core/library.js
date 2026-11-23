// Keeps state.clips in sync with the library folders: instant paint from a snapshot, then the real list,
// then quiet refreshes whenever the main process reports a change.

import { state, set } from './store.js';
import { api, errorMessage, TimeoutError } from './api.js';
import { debounce } from './dom.js';
import { pruneCache } from './thumbs.js';

const SNAPSHOT_KEY = 'vc:clips:v2';
const SNAPSHOT_MAX = 1.5 * 1024 * 1024;
const FOCUS_REFRESH_AFTER = 30000;
const CHANGE_DEBOUNCE = 300;

const CLIP_FIELDS = ['id', 'status', 'jobId', 'title', 'creator', 'hook', 'description', 'xPost', 'tags', 'durationSec',
  'fileSizeBytes', 'videoUrl', 'updatedAt', 'createdAt', 'startSec', 'endSec'];
const SOURCE_FIELDS = ['key', 'kind', 'id', 'url', 'title', 'creator', 'file'];

let started = false;
let lastRefresh = 0;
let running = null;     // the refresh in flight
let queued = null;      // one follow-up refresh, requested while another was running
let pruned = false;

/* ───────── Snapshot ───────── */

function pick(source, fields) {
  const out = {};
  for (const field of fields) out[field] = source[field];
  return out;
}

const snapshotClip = clip => ({ ...pick(clip, CLIP_FIELDS), source: pick(clip.source || {}, SOURCE_FIELDS) });

const isSnapshotClip = clip => Boolean(clip) && typeof clip.id === 'string' && typeof clip.videoUrl === 'string'
  && (clip.status === 'ready' || clip.status === 'completed') && typeof clip.source?.key === 'string';

function hydrate() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw || raw.length > SNAPSHOT_MAX) return false;
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return false;
    const clips = list.filter(isSnapshotClip);
    if (list.length && !clips.length) return false; // unreadable snapshot: show the skeleton instead of a false empty state
    set({ clips, clipsLoaded: true });
    return true;
  } catch { return false; }
}

function saveSnapshot(clips) {
  try {
    const json = JSON.stringify(clips.map(snapshotClip));
    if (json.length > SNAPSHOT_MAX) localStorage.removeItem(SNAPSHOT_KEY);
    else localStorage.setItem(SNAPSHOT_KEY, json);
  } catch { /* quota or storage disabled: the next launch just starts with a skeleton */ }
}

/* ───────── Refresh ───────── */

const TEXT_FIELDS = ['title', 'hook', 'description', 'xPost', 'tags'];

/**
 * Cheap structural comparison: same clips in the same order, same status and file revision, and the same
 * text. The text is compared too because a sidecar edit does not change the video's updatedAt.
 */
function sameClips(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.id !== y.id || x.status !== y.status || x.jobId !== y.jobId || x.updatedAt !== y.updatedAt || x.fileSizeBytes !== y.fileSizeBytes) return false;
    if (x.source?.key !== y.source?.key || x.source?.title !== y.source?.title) return false;
    for (const field of TEXT_FIELDS) if (x[field] !== y[field]) return false;
  }
  return true;
}

async function load() {
  try {
    const clips = await api.listClips();
    if (!Array.isArray(clips) || !clips.every(isSnapshotClip)) throw new Error('The library returned an unexpected response.');
    const changed = !sameClips(state.clips, clips);
    set({ clipsError: '', clipsLoaded: true, ...(changed ? { clips } : null) });
    if (changed) saveSnapshot(clips);
    if (changed || !pruned) { pruned = true; pruneCache(clips); }
    return true;
  } catch (error) {
    set({ clipsError: errorMessage(error), clipsLoaded: true });
    return false;
  } finally {
    lastRefresh = Date.now();
  }
}

function start() {
  const attempt = load().finally(() => {
    if (running === attempt) running = null;
    if (!queued) set({ clipsRefreshing: false });
  });
  running = attempt;
  return attempt;
}

/**
 * Re-read the library. `quiet` skips the refreshing flag (no spinner). Resolves true when the list was fetched,
 * false when it failed (state.clips is kept and state.clipsError explains why). Never rejects.
 * A request made while a scan is running queues one more scan, because the running one may predate the change.
 */
export function refreshLibrary({ quiet = false } = {}) {
  if (!quiet) set({ clipsRefreshing: true });
  if (queued) return queued;
  if (running) {
    queued = running.then(() => {
      queued = null;
      return start();
    });
    return queued;
  }
  return start();
}

/** Begin following the library. Call once at boot. */
export function startLibrarySync() {
  if (started) return;
  started = true;
  const hydrated = hydrate();
  refreshLibrary({ quiet: hydrated });

  const refreshQuietly = debounce(() => refreshLibrary({ quiet: true }), CHANGE_DEBOUNCE);
  api.onLibraryChanged(refreshQuietly);
  window.addEventListener('focus', () => {
    if (Date.now() - lastRefresh > FOCUS_REFRESH_AFTER) refreshLibrary({ quiet: true });
  });
}

/* ───────── Actions and lookups ───────── */

/**
 * Move clips between Ready and Completed one at a time, so a failure never aborts the rest.
 * Always refreshes the library afterwards. `failed[i].error` is the Error from the main process (use `.message`).
 */
export async function moveClips(clips, to) {
  const moved = [];
  const failed = [];
  let timedOut = false;
  for (const clip of clips) {
    if (clip.status === to) continue;
    if (timedOut) {
      failed.push({ clip, error: new Error('The move stopped after the desktop did not respond.') });
      continue;
    }
    try {
      await api.moveClip(clip.id, clip.status, to);
      moved.push(clip);
    } catch (error) {
      failed.push({ clip, error });
      timedOut = error instanceof TimeoutError;
    }
  }
  await refreshLibrary({ quiet: true });
  return { moved, failed };
}

export async function deleteClips(clips, sourceKey) {
  const targets = clips.map(({ id, status, updatedAt, fileSizeBytes }) => ({ id, status, updatedAt, fileSizeBytes }));
  try {
    await api.deleteClips(targets, sourceKey);
  } catch (error) {
    if (error instanceof TimeoutError) void refreshLibrary({ quiet: true });
    else await refreshLibrary({ quiet: true });
    throw error;
  }
  if (await refreshLibrary({ quiet: true })) return;

  // The Trash operation succeeded. Remove the confirmed files even if reloading failed.
  const key = clip => JSON.stringify([clip.id, clip.status, clip.updatedAt, clip.fileSizeBytes]);
  const deleted = new Set(targets.map(key));
  const remaining = state.clips.filter(clip => !deleted.has(key(clip)));
  set({ clips: remaining });
  saveSnapshot(remaining);
  pruneCache(remaining);
}

let index = { clips: null, byId: new Map() };

export function findClip(id) {
  if (index.clips !== state.clips) index = { clips: state.clips, byId: new Map(state.clips.map(clip => [clip.id, clip])) };
  return index.byId.get(id) || null;
}
