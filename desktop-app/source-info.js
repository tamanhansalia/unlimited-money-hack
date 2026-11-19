const { app, net } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const VIDEO_ID = /^[\w-]{11}$/;
const MAX_IDS = 24;
const TIMEOUT_MS = 5000;
const FAILURE_TTL_MS = 10 * 60_000;
const MAX_FOUND = 1000;
const MAX_RESPONSE_CHARS = 64 * 1024;

let loading;
let writing = Promise.resolve();
const lookups = new Map();

function cacheFile() {
  return path.join(app.getPath('userData'), 'source-info.json');
}

function isRecent(timestamp, now) {
  const age = now - timestamp;
  return age >= 0 && age < FAILURE_TTL_MS;
}

function parseCache(raw) {
  const state = { found: new Map(), failed: new Map() };
  const now = Date.now();
  for (const [id, entry] of Object.entries(raw?.found ?? {})) {
    if (VIDEO_ID.test(id) && typeof entry?.title === 'string' && entry.title && typeof entry.author === 'string') {
      state.found.set(id, { title: entry.title, author: entry.author, at: Number(entry.at) || 0 });
    }
  }
  for (const [id, at] of Object.entries(raw?.failed ?? {})) {
    if (VIDEO_ID.test(id) && Number.isFinite(at) && isRecent(at, now)) state.failed.set(id, at);
  }
  return state;
}

function loadCache() {
  loading ||= fs.readFile(cacheFile(), 'utf8')
    .then(text => parseCache(JSON.parse(text)))
    .catch(() => parseCache(null));
  return loading;
}

function snapshot(state) {
  const now = Date.now();
  const newest = [...state.found].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_FOUND);
  return JSON.stringify({
    found: Object.fromEntries(newest),
    failed: Object.fromEntries([...state.failed].filter(([, at]) => isRecent(at, now)))
  });
}

// Writes are serialised and atomic (temp file, then rename) so a crash cannot leave a half-written cache.
function persist(state) {
  const data = snapshot(state);
  writing = writing.then(async () => {
    const file = cacheFile();
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(temp, data);
      await fs.rename(temp, file);
    } catch {
      // The cache only saves network calls; losing a write is harmless.
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  });
  return writing;
}

const tidy = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 300) : '';

async function fetchInfo(id) {
  const target = 'https://www.youtube.com/oembed?format=json&url=' +
    encodeURIComponent('https://www.youtube.com/watch?v=' + id);
  try {
    const response = await net.fetch(target, {
      redirect: 'error', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const body = await response.text();
    if (body.length > MAX_RESPONSE_CHARS) return null;
    const data = JSON.parse(body);
    const title = tidy(data?.title);
    return title ? { title, author: tidy(data.author_name) } : null;
  } catch {
    return null;
  }
}

// Concurrent callers asking for the same video share one request.
function lookup(id) {
  let pending = lookups.get(id);
  if (!pending) {
    pending = fetchInfo(id).finally(() => lookups.delete(id));
    lookups.set(id, pending);
  }
  return pending;
}

function pickIds(ids) {
  const picked = new Set();
  if (!Array.isArray(ids)) return [];
  for (const id of ids) {
    if (typeof id === 'string' && VIDEO_ID.test(id)) picked.add(id);
    if (picked.size === MAX_IDS) break;
  }
  return [...picked];
}

// Resolves YouTube video ids to { title, author }. Ids that cannot be resolved are left out.
async function resolveSources(ids) {
  const result = {};
  try {
    const state = await loadCache();
    const now = Date.now();
    const missing = [];
    for (const id of pickIds(ids)) {
      const hit = state.found.get(id);
      if (hit) result[id] = { title: hit.title, author: hit.author };
      else if (!isRecent(state.failed.get(id) ?? 0, now)) missing.push(id);
    }
    if (!missing.length) return result;
    const infos = await Promise.all(missing.map(lookup));
    missing.forEach((id, index) => {
      const info = infos[index];
      if (info) {
        state.found.set(id, { ...info, at: Date.now() });
        state.failed.delete(id);
        result[id] = info;
      } else {
        state.failed.set(id, Date.now());
      }
    });
    await persist(state);
  } catch {
    // Source titles are optional; the caller falls back to the clip metadata.
  }
  return result;
}

module.exports = { resolveSources };
