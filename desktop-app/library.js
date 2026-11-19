const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');

const statuses = ['ready', 'completed'];
const READ_CONCURRENCY = 16;
const WATCH_DEBOUNCE_MS = 250;
const WATCH_RETRY_MS = 5000;
const VIDEO_ID = /^[\w-]{11}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
// Older clips only carry the source link inside their description text.
const DESCRIPTION_LINK = /(?:youtube\.com\/(?:watch\?(?:[^\s#]*?&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})(?![\w-])/i;

function validId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 250 &&
    !/[<>:"/\\|?*\u0000-\u001f]/.test(id) && !/[. ]$/.test(id) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id);
}

function optionalStat(file) {
  return fs.lstatSync(file, { throwIfNoEntry: false });
}

function text(meta, key) {
  return typeof meta[key] === 'string' ? meta[key] : '';
}

function number(value) {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

function youtubeIdFromUrl(value) {
  try {
    const url = new URL(value);
    let id = '';
    if (url.hostname === 'youtu.be') {
      id = url.pathname.split('/')[1] || '';
    } else if (YOUTUBE_HOSTS.has(url.hostname)) {
      const [, kind, second] = url.pathname.split('/');
      if (kind === 'watch') id = url.searchParams.get('v') || '';
      else if (['shorts', 'live', 'embed'].includes(kind)) id = second || '';
    }
    return VIDEO_ID.test(id) ? id : '';
  } catch {
    return '';
  }
}

// Which source video a clip was cut from; clips with the same key are shown together.
function sourceIdentity(id, meta) {
  const youtube = videoId => ({ key: 'yt:' + videoId, kind: 'youtube', id: videoId });
  const declared = text(meta, 'sourceKey').trim();
  const [, prefix, rest] = /^(yt|file|legacy):(\S.*)$/.exec(declared) || [];
  if (declared.length <= 200) {
    if (prefix === 'yt' && VIDEO_ID.test(rest)) return youtube(rest);
    if (prefix === 'file' || prefix === 'legacy') return { key: declared, kind: prefix === 'file' ? 'file' : 'legacy', id: '' };
  }
  const videoId = youtubeIdFromUrl(meta.sourceUrl) || DESCRIPTION_LINK.exec(text(meta, 'description'))?.[1];
  if (videoId) return youtube(videoId);
  return { key: 'legacy:' + (id.replace(/_\d{1,3}$/, '') || id), kind: 'legacy', id: '' };
}

function toClip(status, id, stat, meta) {
  const identity = sourceIdentity(id, meta);
  const creator = text(meta, 'creator') || text(meta, 'uploader');
  const duration = number(meta.durationSec);
  const created = Date.parse(text(meta, 'createdAt'));
  return {
    id, status,
    title: text(meta, 'title') || id, creator,
    hook: text(meta, 'hook'), description: text(meta, 'description'), xPost: text(meta, 'xPost'),
    tags: Array.isArray(meta.tags) ? meta.tags.filter(tag => typeof tag === 'string').join(', ') : text(meta, 'tags'),
    durationSec: duration > 0 ? duration : null,
    fileSizeBytes: stat.size,
    videoUrl: 'clip-media://library/' + status + '/' + encodeURIComponent(id),
    updatedAt: stat.mtimeMs,
    createdAt: Number.isFinite(created) ? created : stat.birthtimeMs || stat.mtimeMs,
    startSec: number(meta.sourceStartSec), endSec: number(meta.sourceEndSec),
    source: {
      ...identity,
      url: identity.id ? 'https://www.youtube.com/watch?v=' + identity.id : '',
      title: text(meta, 'sourceTitle').trim(), creator: creator.trim(), file: text(meta, 'sourceFile').trim()
    }
  };
}

async function readMetadata(file) {
  try {
    const meta = JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^﻿/, ''));
    return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
  } catch {
    return {};
  }
}

async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function createLibrary(engineDir) {
  // Clips are cached by video path, mtime and size plus the sidecar's mtime and size,
  // so a scan only parses files that changed since the previous one.
  let cache = new Map();
  let scanning = null;
  let followUp = null;

  // Check each component before creating children. Junctions and symlinks
  // inside the library must never redirect file operations elsewhere.
  function folder(status) {
    if (status !== undefined && !statuses.includes(status)) throw new Error('Invalid clip folder.');
    fs.mkdirSync(engineDir, { recursive: true });
    let current = fs.realpathSync(engineDir);
    for (const component of ['output', 'clips', ...(status ? [status] : [])]) {
      current = path.join(current, component);
      let stat = optionalStat(current);
      if (!stat) {
        try {
          fs.mkdirSync(current);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
        stat = fs.lstatSync(current);
      }
      if (!stat.isDirectory()) throw new Error('Invalid clip library location.');
    }
    return current;
  }

  function resolveVideo(id, status) {
    if (!statuses.includes(status) || !validId(id)) throw new Error('Invalid clip.');
    const dir = folder(status);
    const direct = path.join(dir, id + '.mp4');
    if (optionalStat(direct)?.isFile()) return direct;
    const file = fs.readdirSync(dir).find(name =>
      path.extname(name).toLowerCase() === '.mp4' && name.slice(0, -4) === id);
    if (!file || !optionalStat(path.join(dir, file))?.isFile()) throw new Error('Clip no longer exists.');
    return path.join(dir, file);
  }

  async function loadClip({ dir, status, name }, previous, next) {
    const id = name.slice(0, -4);
    const video = path.join(dir, name);
    const sidecar = path.join(dir, id + '_meta.json');
    try {
      const [stat, sidecarStat] = await Promise.all([fsp.lstat(video), fsp.lstat(sidecar).catch(() => null)]);
      if (!stat.isFile()) return null;
      const hasMeta = Boolean(sidecarStat?.isFile());
      const key = [video, stat.mtimeMs, stat.size, hasMeta ? sidecarStat.mtimeMs + ':' + sidecarStat.size : '-'].join('|');
      const clip = previous.get(key) || toClip(status, id, stat, hasMeta ? await readMetadata(sidecar) : {});
      next.set(key, clip);
      return clip;
    } catch {
      return null;
    }
  }

  async function scan() {
    const previous = cache;
    const next = new Map();
    const candidates = [];
    for (const status of statuses) {
      const dir = folder(status);
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.mp4' && validId(entry.name.slice(0, -4))) {
          candidates.push({ dir, status, name: entry.name });
        }
      }
    }
    const clips = (await mapLimit(candidates, READ_CONCURRENCY, item => loadClip(item, previous, next))).filter(Boolean);
    cache = next;
    return clips.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }

  // Overlapping calls share work: at most one scan runs and one more waits behind it,
  // so a call made after a change is never answered with a scan that started before it.
  function listClips() {
    if (!scanning) {
      scanning = scan().finally(() => { scanning = null; });
      return scanning;
    }
    followUp ||= scanning.catch(() => {}).then(() => {
      followUp = null;
      return listClips();
    });
    return followUp;
  }

  function moveClip(id, from, to) {
    if (from === to || !statuses.includes(to)) throw new Error('Invalid destination.');
    const video = resolveVideo(id, from);
    const dest = folder(to);
    const meta = path.join(path.dirname(video), id + '_meta.json');
    const destMeta = path.join(dest, path.basename(meta));
    const destVideo = path.join(dest, path.basename(video));
    if (optionalStat(destVideo) || optionalStat(destMeta)) throw new Error('A clip with this name already exists in that folder.');
    const metaStat = optionalStat(meta);
    if (metaStat && !metaStat.isFile()) throw new Error('Invalid clip metadata file.');
    if (metaStat) fs.renameSync(meta, destMeta);
    try {
      fs.renameSync(video, destVideo);
    } catch (error) {
      if (metaStat) fs.renameSync(destMeta, meta);
      throw error;
    }
    return true;
  }

  // Calls onChange (debounced) when a clip or sidecar appears, changes or disappears.
  // Temporary render folders (dot-prefixed) and unrelated files are ignored.
  function watch(onChange) {
    const watchers = new Map();
    const retries = new Set();
    let timer;
    let closed = false;
    const relevant = name => {
      if (typeof name !== 'string' || name.startsWith('.')) return false;
      const lower = name.toLowerCase();
      return lower.endsWith('.mp4') || lower.endsWith('_meta.json');
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (!closed) onChange(); }, WATCH_DEBOUNCE_MS);
    };
    function retryLater(status) {
      const retry = setTimeout(() => { retries.delete(retry); arm(status); }, WATCH_RETRY_MS);
      retry.unref();
      retries.add(retry);
    }
    // The folder was removed or renamed, so its clips are gone: refresh now and watch again shortly.
    function lost(status, watcher) {
      if (watchers.get(status) !== watcher) return;
      watchers.delete(status);
      watcher.close();
      schedule();
      retryLater(status);
    }
    function arm(status) {
      if (closed) return;
      try {
        const watcher = fs.watch(folder(status), { persistent: false }, (_event, name) => {
          // Windows reports a removed folder as endless events named after the folder's own full path.
          if (typeof name === 'string' && path.isAbsolute(name)) lost(status, watcher);
          else if (relevant(name)) schedule();
        });
        watcher.once('error', () => lost(status, watcher));
        watchers.set(status, watcher);
      } catch {
        retryLater(status);
      }
    }
    statuses.forEach(arm);
    return () => {
      closed = true;
      clearTimeout(timer);
      retries.forEach(clearTimeout);
      for (const watcher of watchers.values()) {
        try { watcher.close(); } catch { /* already closed */ }
      }
      watchers.clear();
    };
  }

  return { folder, listClips, moveClip, resolveVideo, watch };
}

function mediaResponse(request, resolveVideo) {
  // The renderer draws poster frames from these videos to a canvas, which needs CORS.
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: cors });
  let file;
  let size;
  try {
    const url = new URL(request.url);
    const parts = url.pathname.split('/');
    if (url.host !== 'library' || parts.length !== 3) return new Response(null, { status: 404, headers: cors });
    file = resolveVideo(decodeURIComponent(parts[2]), parts[1]);
    size = fs.statSync(file).size;
  } catch {
    return new Response(null, { status: 404, headers: cors });
  }
  let start = 0;
  let end = size - 1;
  const range = request.headers.get('range');
  const headers = { ...cors, 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4' };
  if (range !== null) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
    const invalid = () => new Response(null, { status: 416, headers: { ...cors, 'Content-Range': 'bytes */' + size } });
    if (!match || (!match[1] && !match[2]) || !size) return invalid();
    if (match[1]) {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    } else {
      start = Math.max(0, size - Number(match[2]));
    }
    if (!Number.isSafeInteger(start) || start > end) return invalid();
    headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
  }
  headers['Content-Length'] = String(end - start + 1);
  const body = request.method === 'HEAD' || !size ? null : Readable.toWeb(fs.createReadStream(file, { start, end }));
  return new Response(body, { status: range === null ? 200 : 206, headers });
}

module.exports = { createLibrary, mediaResponse };
