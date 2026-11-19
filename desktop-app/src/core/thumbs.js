// Lazy, cached poster frames for clips.
//
// An <img> given to attachPoster() is resolved through: memory cache -> IndexedDB -> capture queue
// (a detached <video> sought to an early frame, two at a time, visible images first).
// Everything is best effort: any failure leaves the placeholder in place and never throws into a view.

import { sleep } from './dom.js';

const DB_NAME = 'viralclip';
const STORE = 'posters';
const POSTER_W = 270;
const POSTER_H = 480;
const JPEG_QUALITY = 0.82;
const MEMORY_CAP = 400;
const CONCURRENCY = 2;
const CAPTURE_TIMEOUT = 8000;
const RETRY_DELAY = 300;
const FAIL_COOLDOWN = 60000;
const SWEEP_MS = 5000;
const NEAR_VIEWPORT = 1;
const NEAR_STAGE = 2;

const memory = new Map();    // key -> poster URL, insertion order = LRU order
const attached = new WeakMap(); // img -> entry
const pending = new Set();   // entries still waiting for a poster
const jobs = new Map();      // key -> job (lookup, queued or running), shared by every img of the same clip
const queue = [];            // jobs waiting for a capture slot
const failures = new Map();  // key -> time of the last failed capture
let running = 0;
let sequence = 0;
let sweepTimer = 0;
let observers = null;

const keyOf = clip => `${clip.id}|${clip.fileSizeBytes ?? ''}|${clip.updatedAt ?? ''}`;

/* ───────── IndexedDB ───────── */

let dbPromise = null;

function openDb() {
  dbPromise ||= new Promise(resolve => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => {
        const db = request.result;
        const reset = () => { dbPromise = null; };
        db.onversionchange = () => { db.close(); reset(); };
        db.onclose = reset;
        resolve(db);
      };
      request.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbPromise;
}

async function withStore(mode, run) {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
      tx.onabort = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}

const idbGet = key => withStore('readonly', store => store.get(key));
const idbPut = (key, value) => withStore('readwrite', store => store.put(value, key));

async function dropStaleRows(keep) {
  const db = await openDb();
  if (!db) return;
  await new Promise(resolve => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const cursorRequest = store.openKeyCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        if (!keep.has(cursor.key)) store.delete(cursor.key);
        cursor.continue();
      };
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
    } catch { resolve(); }
  });
}

/* ───────── Memory cache ───────── */

function keysInUse() {
  const used = new Set();
  for (const img of document.querySelectorAll('img[data-poster-key]')) used.add(img.dataset.posterKey);
  return used;
}

function remember(key, record) {
  memory.delete(key);
  memory.set(key, record);
  evict(key);
}

/**
 * Drop least-recently-used object URLs beyond the cap, except those a connected <img> is still showing
 * and `protect`, the record that was just added and has not reached an <img> yet.
 */
function evict(protect) {
  if (memory.size <= MEMORY_CAP) return;
  const used = keysInUse();
  for (const [key, record] of memory) {
    if (memory.size <= MEMORY_CAP) break;
    if (key === protect || used.has(key)) continue;
    URL.revokeObjectURL(record);
    memory.delete(key);
  }
}

/* ───────── Capture ───────── */

function drawCover(ctx, source, sw, sh, dw, dh) {
  const scale = Math.max(dw / sw, dh / sh);
  const cw = dw / scale;
  const ch = dh / scale;
  ctx.drawImage(source, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, dw, dh);
}

/** Resolves once `video` shows a decoded frame near the start; rejects on decode error or after the timeout. */
function frameAt(video, url) {
  return new Promise((resolve, reject) => {
    let seeked = false;
    const timer = setTimeout(() => reject(new Error('Poster capture timed out.')), CAPTURE_TIMEOUT);
    const done = settle => value => { clearTimeout(timer); settle(value); };
    const ok = done(resolve);
    const fail = done(reject);
    const check = () => { if (seeked && video.readyState >= 2) ok(); };
    video.onerror = () => fail(new Error('The clip could not be decoded.'));
    video.onloadedmetadata = () => {
      const length = video.duration;
      if (Number.isFinite(length) && length > 0) video.currentTime = Math.min(1.2, length * 0.15);
      else { seeked = true; check(); }
    };
    video.onseeked = () => { seeked = true; check(); };
    video.onloadeddata = video.oncanplay = check;
    video.src = url;
  });
}

async function encodeFrame(video) {
  if (!video.videoWidth || !video.videoHeight) throw new Error('The clip has no picture.');
  const canvas = document.createElement('canvas');
  canvas.width = POSTER_W;
  canvas.height = POSTER_H;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingQuality = 'high';
  drawCover(ctx, video, video.videoWidth, video.videoHeight, POSTER_W, POSTER_H);

  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
  if (!blob) throw new Error('The poster could not be encoded.');
  return blob;
}

async function capture(clip) {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  try {
    await frameAt(video, clip.videoUrl);
    return await encodeFrame(video);
  } finally {
    video.onerror = video.onloadedmetadata = video.onseeked = video.onloadeddata = video.oncanplay = null;
    video.removeAttribute('src');
    video.load();
  }
}

async function captureWithRetry(clip) {
  try {
    return await capture(clip);
  } catch {
    await sleep(RETRY_DELAY);
    return capture(clip);
  }
}

/* ───────── Jobs and queue ───────── */

function jobFor(clip, key) {
  let job = jobs.get(key);
  if (!job) {
    job = { key, clip, waiters: new Set(), state: 'lookup', seq: 0 };
    jobs.set(key, job);
    lookup(job);
  }
  job.seq = ++sequence; // newest request wins among equals
  return job;
}


async function lookup(job) {
  const row = await idbGet(job.key);
  if (row?.blob instanceof Blob) {
    complete(job, URL.createObjectURL(row.blob));
    return;
  }
  if (!job.waiters.size) { jobs.delete(job.key); return; }
  job.state = 'queued';
  queue.push(job);
  pump();
}

function complete(job, record) {
  jobs.delete(job.key);
  if (record) { remember(job.key, record); failures.delete(job.key); } else failures.set(job.key, Date.now());
  for (const entry of job.waiters) settle(entry, record);
}

function dropIfIdle(job) {
  if (job.state !== 'queued' || job.waiters.size) return;
  const index = queue.indexOf(job);
  if (index >= 0) queue.splice(index, 1);
  jobs.delete(job.key);
}

function eligible(job) {
  for (const entry of job.waiters) if (entry.near && entry.img.isConnected) return true;
  return false;
}

/** Sort key: on screen, then caller priority, then most recently requested. */
function rank(job) {
  let inView = 0;
  let priority = -Infinity;
  for (const entry of job.waiters) {
    if (entry.inView) inView = 1;
    if (entry.priority > priority) priority = entry.priority;
  }
  return [inView, priority, job.seq];
}

function outranks(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function takeNext() {
  let bestIndex = -1;
  let bestRank = null;
  queue.forEach((job, index) => {
    if (!eligible(job)) return;
    const candidate = rank(job);
    if (!bestRank || outranks(candidate, bestRank)) { bestRank = candidate; bestIndex = index; }
  });
  return bestIndex < 0 ? null : queue.splice(bestIndex, 1)[0];
}

function pump() {
  while (running < CONCURRENCY) {
    const job = takeNext();
    if (!job) return;
    run(job);
  }
}

async function run(job) {
  running += 1;
  job.state = 'running';
  let record = null;
  try {
    const blob = await captureWithRetry(job.clip);
    record = URL.createObjectURL(blob);
    idbPut(job.key, { blob });
  } catch { /* leave the placeholder; the cooldown stops us from retrying on every scroll */ }
  running -= 1;
  complete(job, record);
  pump();
}

/* ───────── Attached images ───────── */

function getObservers() {
  if (observers) return observers;
  const stage = document.getElementById('stage');
  // #stage is the scroll container, and a viewport-rooted observer would not apply the margin through it.
  const near = (root, bit) => new IntersectionObserver(records => {
    for (const record of records) {
      const entry = attached.get(record.target);
      if (!entry || entry.done) continue;
      entry.near = record.isIntersecting ? entry.near | bit : entry.near & ~bit;
      if (entry.near && !entry.job) request(entry);
    }
    pump();
  }, { root, rootMargin: '400px' });
  const view = new IntersectionObserver(records => {
    for (const record of records) {
      const entry = attached.get(record.target);
      if (entry) entry.inView = record.isIntersecting;
    }
  }, { root: null });
  observers = [near(null, NEAR_VIEWPORT), ...(stage ? [near(stage, NEAR_STAGE)] : []), view];
  return observers;
}

function request(entry) {
  const cached = memory.get(entry.key);
  if (cached) { settle(entry, cached); return; }
  const failedAt = failures.get(entry.key);
  if (failedAt !== undefined && Date.now() - failedAt < FAIL_COOLDOWN) { settle(entry, null); return; }
  const job = jobFor(entry.clip, entry.key);
  job.waiters.add(entry);
  entry.job = job;
}

function settle(entry, record) {
  entry.done = true;
  entry.job = null;
  pending.delete(entry);
  for (const observer of getObservers()) observer.unobserve(entry.img);
  if (record) show(entry, record);
}

function reveal(img, key) {
  if (img.classList.contains('is-loaded')) return;
  img.decode().then(() => {
    if (img.dataset.posterKey === key) img.classList.add('is-loaded');
  }, () => {});
}

function show(entry, record) {
  const { img, key } = entry;
  memory.delete(key);
  memory.set(key, record); // most recently used
  if (img.dataset.posterKey !== key || img.src !== record) {
    img.dataset.posterKey = key;
    img.decoding = 'async';
    img.src = record;
  }
  reveal(img, key);
}

function release(entry) {
  if (attached.get(entry.img) === entry) attached.delete(entry.img);
  entry.released = true;
  if (pending.delete(entry) && observers) for (const observer of observers) observer.unobserve(entry.img);
  const job = entry.job;
  if (job) {
    job.waiters.delete(entry);
    entry.job = null;
    dropIfIdle(job);
  }
}

/** Entries whose image was removed from the page without calling detach: forgotten after two consecutive sweeps. */
function sweep() {
  for (const entry of [...pending]) {
    if (entry.img.isConnected) entry.stale = false;
    else if (entry.stale) release(entry);
    else entry.stale = true;
  }
  if (!pending.size) { clearInterval(sweepTimer); sweepTimer = 0; }
}

function watch(entry) {
  pending.add(entry);
  for (const observer of getObservers()) observer.observe(entry.img);
  if (!sweepTimer) sweepTimer = setInterval(sweep, SWEEP_MS);
}

/* ───────── Public API ───────── */

/**
 * Lazily load a clip's poster into `img`. Sets img.src when the poster is ready and adds `.is-loaded` once decoded.
 * `priority` (higher first) orders the capture queue.
 * Returns detach. Calling it is optional: images that leave the page are swept.
 */
export function attachPoster(img, clip, { priority = 0 } = {}) {
  const previous = attached.get(img);
  if (!clip?.videoUrl) {
    if (previous) release(previous);
    return () => {};
  }
  const key = keyOf(clip);
  // Reuse the entry unless it finished without a picture or its URL has since been evicted: those start over.
  if (previous && previous.key === key && !previous.released && (!previous.done || memory.has(key))) {
    previous.priority = priority;
    return () => release(previous);
  }
  if (previous) release(previous);

  if (img.dataset.posterKey && img.dataset.posterKey !== key) {
    // The node is being reused for another clip: drop the old picture instead of flashing it.
    img.classList.remove('is-loaded');
    img.removeAttribute('src');
    delete img.dataset.posterKey;
  }
  const entry = { img, clip, key, priority, near: 0, inView: false, job: null, done: false, released: false, stale: false };
  attached.set(img, entry);

  const cached = memory.get(key);
  if (cached) {
    entry.done = true;
    show(entry, cached);
  } else {
    watch(entry);
  }
  return () => release(entry);
}

let pruneHandle = 0;

/** Forget cached posters of clips that no longer exist (or changed on disk). Runs when the browser is idle. */
export function pruneCache(clips) {
  if (!Array.isArray(clips) || !clips.length) return; // an empty list is more likely a failed load than an empty library
  const keep = new Set(clips.map(keyOf));
  const work = () => {
    pruneHandle = 0;
    const used = keysInUse();
    for (const [key, record] of memory) {
      if (keep.has(key) || used.has(key)) continue;
      URL.revokeObjectURL(record);
      memory.delete(key);
    }
    dropStaleRows(keep);
  };
  if (pruneHandle) {
    if ('cancelIdleCallback' in window) cancelIdleCallback(pruneHandle); else clearTimeout(pruneHandle);
  }
  pruneHandle = 'requestIdleCallback' in window ? requestIdleCallback(work, { timeout: 15000 }) : setTimeout(work, 3000);
}
