// Minimal reactive store. Subscribers are notified once per microtask with the set of changed keys.

export const state = {
  route: { name: 'library' },
  clips: [],
  clipsLoaded: false,
  clipsError: '',
  clipsRefreshing: false,
  sourceInfo: {},          // source key -> { title, author } resolved from YouTube
  account: null,           // { hasKey, platforms, lastVerified }
  accountStatus: 'idle',   // idle | loading | ready | error
  accountError: '',
  job: { status: 'idle' },
  jobLog: '',
  composerPrefill: null    // { url } set by "Generate more" on a source
};

const listeners = new Set();
let pending = null;

export function set(patch) {
  for (const key of Object.keys(patch)) {
    if (Object.is(state[key], patch[key])) continue;
    state[key] = patch[key];
    (pending ||= new Set()).add(key);
  }
  if (pending && pending.size && !set.scheduled) {
    set.scheduled = true;
    queueMicrotask(flush);
  }
}

function flush() {
  set.scheduled = false;
  const changed = pending;
  pending = null;
  if (!changed) return;
  for (const listener of [...listeners]) {
    if (listener.keys === '*' || listener.keys.some(key => changed.has(key))) listener.fn(changed);
  }
}

/** subscribe('clips' | ['clips','job'], fn(changedKeys)) → unsubscribe */
export function subscribe(keys, fn) {
  const entry = { keys: keys === '*' ? '*' : [].concat(keys), fn };
  listeners.add(entry);
  return () => listeners.delete(entry);
}
