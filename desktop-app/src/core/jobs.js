// The clip-generation job: input validation, engine log parsing, a progress value that keeps moving,
// and the hand-off to the library when the engine finishes.
//
// state.job = { status, kind, source, label, count, stage, clip, total, saved, progress, startedAt, endedAt,
//               error, sourceKey, newClipIds, addedCount, cancelling }

import { state, set } from './store.js';
import { api, errorMessage } from './api.js';
import { navigate, hrefFor } from './router.js';
import { toast } from './toast.js';
import { baseName, plural } from './format.js';
import { sleep } from './dom.js';
import { refreshLibrary } from './library.js';
import { timelineOrder } from './sources.js';

const LOG_MAX = 20000;
const LOG_FLUSH_FALLBACK = 250;
const TICK_MS = 1000;
const SOURCE_TO_TRANSCRIBE_MS = 700;
const MAX_CLIPS = 10;
const RENDER_SPAN = 0.4;
const STAGES = ['starting', 'source', 'transcribe', 'select', 'render', 'finishing'];
const STAGE_INDEX = Object.fromEntries(STAGES.map((stage, index) => [stage, index]));
const FLOOR = { starting: 0.02, source: 0.06, transcribe: 0.16, select: 0.5, render: 0.56, finishing: 0.97 };
// Share of the remaining distance to the next milestone covered each second. Transcription is the long stage
// (minutes for a long video), so it creeps slowest and still has room to move after two minutes.
const CREEP = { starting: 0.1, source: 0.05, transcribe: 0.015, select: 0.12, render: 0.05 };
const CREEP_MARGIN = 0.01;
const CREEP_MIN_STEP = 0.0005; // smaller moves are invisible, so they do not wake every subscriber
const VIDEO_ID = /^[\w-]{11}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const NOT_A_VIDEO = /^\/(?:@|channel\/|c\/|user\/|feed\b|results\b|hashtag\/|podcasts\b)/;
const YOUTUBE_LABEL = /^(?:https?:\/\/)?(?:[\w-]+\.)*(?:youtube\.com|youtu\.be)(?:[/?#]|$)/i;

/* ───────── YouTube link validation ───────── */

const fail = message => ({ ok: false, message });

/**
 * Check a pasted YouTube link against the same rules the main process enforces.
 * → { ok, empty?, id?, normalized?, message }. `normalized` is the canonical watch URL (tracking and playlist parameters dropped).
 */
export function validateYouTube(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: false, empty: true, message: 'Paste a YouTube video link.' };
  if (/\s/.test(value)) return fail('A link can’t contain spaces. Paste one video link at a time.');

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  if (scheme && !/^https?$/i.test(scheme[1])) return fail('Use a link that starts with https://.');
  let url;
  try { url = new URL(scheme ? value : 'https://' + value); } catch { url = null; }
  if (!url || !url.hostname.includes('.')) return fail('This doesn’t look like a link. Paste the full video address, like youtube.com/watch?v=…');
  if (url.username || url.password || url.port) return fail('Remove the login or port number from the link and paste it again.');

  const host = url.hostname.toLowerCase();
  const short = host === 'youtu.be';
  if (!short && !YOUTUBE_HOSTS.has(host)) {
    return fail(host === 'youtube.com' || host.endsWith('.youtube.com')
      ? 'Use a link from youtube.com or youtu.be.'
      : 'Only YouTube links work here. For other videos, choose the file instead.');
  }

  const path = url.pathname;
  let id = '';
  if (short) id = path.slice(1).replace(/\/$/, '');
  else if (path === '/watch') id = url.searchParams.get('v') || '';
  else {
    const match = /^\/(?:shorts|live|embed)\/([^/]+)\/?$/.exec(path);
    if (match) id = match[1];
  }

  if (!id) {
    if (path === '/playlist' || url.searchParams.has('list')) return fail('Playlists aren’t supported. Open one video and copy its link.');
    if (NOT_A_VIDEO.test(path)) return fail('This is a channel or search page, not a video. Open one video and copy its link.');
    if (short) return fail('This youtu.be link has no video ID. Copy the full link from the Share button.');
    return fail('Link to a single video, like youtube.com/watch?v=… or youtu.be/…');
  }
  if (!VIDEO_ID.test(id)) return fail('The video ID in this link looks cut off. YouTube IDs are 11 characters, so copy the whole link.');
  return { ok: true, id, normalized: 'https://www.youtube.com/watch?v=' + id, message: 'YouTube video detected · ' + id };
}

/* ───────── Engine output → readable error ───────── */

const ANSI = /\u001b\[[0-9;]*m/g;
// "ValueError: msg" or yt-dlp's "ERROR: msg": how a Python traceback and the downloader end.
const ERROR_LINE = /^(?:[\w.]*(?:Error|Exception)|ERROR):\s*\S/;
const FRIENDLY_ERRORS = [
  [/private video|video unavailable|has been removed|no longer available/i,
    'YouTube says this video is unavailable. Check that it is public and still online, then try again.'],
  [/sign in to confirm|confirm your age|age-restricted|login required/i,
    'YouTube wants a sign-in to play this video. Try another video, or download it and choose the file instead.'],
  [/unable to download|getaddrinfo|timed out|connection (?:reset|refused|aborted)|network is unreachable|name resolution|http error 5\d\d/i,
    'Couldn’t reach YouTube. Check your internet connection and try again.'],
  [/no space left|disk (?:is )?full/i, 'The disk is full. Free up some space and try again.'],
  [/no module named/i, 'A Python package the generator needs is missing. Reinstall its requirements, then try again.']
];

/** Drop the exception class and the yt-dlp "[youtube] <id>:" tag so only the sentence meant for the user remains. */
const stripEngineNoise = text => text
  .replace(/^(?:(?:[\w.]*(?:Error|Exception)|ERROR):\s*)+/, '')
  .replace(/^\[[^\]]+\]\s*(?:[\w-]{11}:\s*)?/, '')
  .trim();

/** Reduce engine output (often a Python traceback tail) to one sentence. */
export function engineError(text) {
  const lines = String(text).replace(ANSI, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const last = predicate => [...lines].reverse().find(predicate);
  const failed = last(line => /Clip generation failed:/i.test(line));
  const raw = failed
    ? failed.replace(/^.*?Clip generation failed:\s*/i, '')
    : last(line => ERROR_LINE.test(line)) || lines.at(-1) || '';
  let message = stripEngineNoise(raw) || 'The generator stopped before completing.';

  const providerError = /^(?:Codex CLI|Claude Code|Gemini CLI)\b/.test(message);
  const friendly = !providerError && FRIENDLY_ERRORS.find(([pattern]) => pattern.test(message));
  if (friendly) return friendly[1];
  if (message.length > 240) message = message.slice(0, 237) + '…';
  return /[.!?…]$/.test(message) ? message : message + '.';
}

/* ───────── Job state ───────── */

let pendingLog = '';
let leftover = '';
let flushFrame = 0;
let flushTimer = 0;
let ticker = 0;
let soonTimer = 0;
let rawLabels = new Set(); // labels that only echo the input (file name, video id), so a real title may replace them

const patchJob = patch => set({ job: { ...state.job, ...patch } });

function renderFloor(clip, total) {
  return FLOOR.render + RENDER_SPAN * Math.max(0, clip - 1) / Math.max(1, total);
}

function floorOf(job) {
  return job.stage === 'render' ? renderFloor(job.clip, job.total) : FLOOR[job.stage];
}

/** The next progress milestone after the job's current position. */
function nextFloor(job) {
  switch (job.stage) {
    case 'starting': return FLOOR.source;
    case 'source': return FLOOR.transcribe;
    case 'transcribe': return FLOOR.select;
    case 'select': return renderFloor(1, job.total);
    case 'render': return job.clip < job.total ? renderFloor(job.clip + 1, job.total) : FLOOR.finishing;
    default: return 1;
  }
}

/** Move to `stage` (never backwards) and lift the progress to that stage's floor. */
function advance(stage, patch = {}) {
  const job = state.job;
  if (job.status !== 'running' || STAGE_INDEX[stage] < STAGE_INDEX[job.stage]) return;
  const next = { ...job, ...patch, stage };
  next.progress = Math.max(job.progress, floorOf(next));
  set({ job: next });
}

function tick() {
  const job = state.job;
  const rate = CREEP[job.stage];
  if (job.status !== 'running' || job.cancelling || !rate) return;
  const ceiling = nextFloor(job) - CREEP_MARGIN;
  if (job.progress >= ceiling) return;
  const progress = job.progress + (ceiling - job.progress) * rate;
  if (progress - job.progress >= CREEP_MIN_STEP) patchJob({ progress });
}

function stopTimers() {
  clearInterval(ticker);
  clearTimeout(soonTimer);
  ticker = 0;
  soonTimer = 0;
}

/* ───────── Engine log ───────── */

const isRawLabel = label => !label || rawLabels.has(label) || YOUTUBE_LABEL.test(label);

function onSourceLoaded(title) {
  if (title && isRawLabel(state.job.label)) patchJob({ label: title });
  advance('source');
  // Transcription starts right after, but the model import can take a few seconds before its own log line appears.
  clearTimeout(soonTimer);
  soonTimer = setTimeout(() => {
    if (state.job.status === 'running' && STAGE_INDEX[state.job.stage] <= STAGE_INDEX.source) advance('transcribe');
  }, SOURCE_TO_TRANSCRIBE_MS);
}

function applyLine(line) {
  if (/Downloading the YouTube video/i.test(line)) { advance('source'); return; }
  const loaded = /Source loaded:\s*(.+)/i.exec(line);
  if (loaded) { onSourceLoaded(loaded[1].trim()); return; }
  if (/Transcribing speech/i.test(line)) { advance('transcribe'); return; }
  if (/^Selecting highlights with /i.test(line)) { advance('select'); return; }
  const found = /Found (\d+) highlight/i.exec(line);
  if (found) { advance('select', { total: Number(found[1]) }); return; }
  const render = /Rendering clip (\d+) of (\d+)/i.exec(line);
  if (render) { advance('render', { clip: Number(render[1]), total: Number(render[2]) }); return; }
  const saved = /Saved (\d+) of (\d+)/i.exec(line);
  if (saved) advance('finishing', { saved: Number(saved[1]) });
}

function parseLog(text) {
  const lines = (leftover + text).split(/\r\n|\n|\r/);
  leftover = lines.pop();
  lines.forEach(applyLine);
}

function flushLog({ final = false } = {}) {
  cancelAnimationFrame(flushFrame);
  clearTimeout(flushTimer);
  flushFrame = 0;
  flushTimer = 0;
  if (pendingLog) {
    const text = pendingLog;
    pendingLog = '';
    set({ jobLog: (state.jobLog + text).slice(-LOG_MAX) });
    parseLog(text);
  }
  if (final && leftover) {
    const line = leftover;
    leftover = '';
    applyLine(line);
  }
}

function onLog(chunk) {
  if (state.job.status !== 'running' || !chunk) return;
  pendingLog = (pendingLog + String(chunk)).slice(-LOG_MAX);
  if (flushFrame) return;
  // rAF pauses while the window is minimised, so a timer backs it up and the stage still advances.
  flushFrame = requestAnimationFrame(() => flushLog());
  flushTimer = setTimeout(() => flushLog(), LOG_FLUSH_FALLBACK);
}

api.onLog(onLog);

/* ───────── Start, finish, cancel ───────── */

function checkInput(kind, source, rawCount) {
  if (kind !== 'url' && kind !== 'file') return fail('Choose a YouTube link or a video file.');
  const count = typeof rawCount === 'string' && rawCount.trim() ? Number(rawCount) : rawCount;
  if (!Number.isInteger(count) || count < 1 || count > MAX_CLIPS) return fail(`Choose a whole number of clips from 1 to ${MAX_CLIPS}.`);
  if (kind === 'url') {
    const check = validateYouTube(source);
    return check.ok ? { ok: true, source: check.normalized, id: check.id, count } : fail(check.message);
  }
  const path = typeof source === 'string' ? source.trim() : '';
  return path ? { ok: true, source: path, id: '', count } : fail('Choose a video file first.');
}

function freshJob(fields) {
  const now = Date.now();
  return {
    status: 'running', kind: 'url', source: '', label: '', count: 0, stage: 'starting', clip: 0, total: 0, saved: 0,
    progress: FLOOR.starting, startedAt: now, endedAt: 0, error: '', sourceKey: '', newClipIds: [], addedCount: 0, cancelling: false,
    ...fields
  };
}

/**
 * Run a generation. Never rejects: the outcome is in state.job (status done, error or cancelled) and,
 * on success, a "N new clips ready" toast links to the new source.
 */
export async function startJob({ kind, source, label = '', count, provider, language } = {}) {
  if (state.job.status === 'running') {
    toast('A video is already being processed. Wait for it to finish, or cancel it first.', { kind: 'info' });
    return;
  }
  const input = checkInput(kind, source, count);
  if (!input.ok) {
    set({ job: freshJob({ status: 'error', kind, source: String(source ?? ''), label, count: Number(count) || 0, error: input.message, progress: 0, endedAt: Date.now() }), jobLog: '' });
    toast(input.message, { kind: 'error' });
    return;
  }

  const before = new Set(state.clips.map(clip => clip.id));
  rawLabels = new Set([baseName(input.source), input.id].filter(Boolean));
  pendingLog = '';
  leftover = '';
  stopTimers();
  // A local file has no download step, so it starts directly in "source".
  const stage = kind === 'file' ? 'source' : 'starting';
  set({
    job: freshJob({ kind, provider, source: input.source, label: label || (kind === 'file' ? baseName(input.source) : ''), count: input.count, total: input.count, stage, progress: FLOOR[stage] }),
    jobLog: ''
  });
  ticker = setInterval(tick, TICK_MS);

  let failure = null;
  try { await api.generate(input.source, input.count, provider, language); } catch (error) { failure = error; }
  stopTimers();
  flushLog({ final: true });
  if (failure) handleFailure(failure); else await handleSuccess(before);
}

async function handleSuccess(before) {
  let refreshed = await refreshLibrary({ quiet: true });
  if (!refreshed) { await sleep(800); refreshed = await refreshLibrary({ quiet: true }); }
  const fresh = timelineOrder(state.clips.filter(clip => clip.status === 'ready' && !before.has(clip.id)));
  const sourceKey = fresh[0]?.source?.key || '';
  const job = state.job;
  set({
    job: {
      ...job, status: 'done', stage: 'finishing', progress: 1, endedAt: Date.now(), cancelling: false,
      saved: job.saved || fresh.length, sourceKey, newClipIds: fresh.map(clip => clip.id), addedCount: fresh.length
    }
  });

  if (fresh.length) {
    toast(`${plural(fresh.length, 'new clip')} ready`, sourceKey ? { action: { label: 'View', run: () => navigate(hrefFor.source(sourceKey)) } } : {});
  } else if (!refreshed) {
    toast('The clips were generated, but the library could not be refreshed. Press F5 to reload it.', { kind: 'error' });
  } else {
    toast('Generation finished, but no new clips were added.', { kind: 'info' });
  }
}

const CANCELLED = /^(?:Error:\s*)?CANCELLED\.?$/i;

function handleFailure(error) {
  const raw = errorMessage(error);
  if (CANCELLED.test(raw.trim())) {
    patchJob({ status: 'cancelled', cancelling: false, endedAt: Date.now() });
  } else {
    const message = engineError(raw);
    patchJob({ status: 'error', error: message, cancelling: false, endedAt: Date.now() });
    toast(`Generation stopped. ${message}`, { kind: 'error' });
  }
  refreshLibrary({ quiet: true });
}

/** Ask the engine to stop. Resolves true when a running job was told to stop. */
export async function cancelJob() {
  if (state.job.status !== 'running' || state.job.cancelling) return false;
  patchJob({ cancelling: true });
  try {
    const stopped = await api.cancelGeneration();
    if (!stopped && state.job.status === 'running') patchJob({ cancelling: false });
    return Boolean(stopped);
  } catch (error) {
    if (state.job.status === 'running') patchJob({ cancelling: false });
    toast(`Couldn’t cancel. ${errorMessage(error)}`, { kind: 'error' });
    return false;
  }
}

/** Clear a finished job (done, error or cancelled) so the composer returns to its idle state. */
export function dismissJob() {
  if (state.job.status === 'running') return;
  set({ job: { status: 'idle' }, jobLog: '' });
}

/* ───────── Labels for the UI ───────── */

/** Short status text for the stage a running job is in. */
export function stageLabel(job) {
  switch (job.status) {
    case 'done': return 'Finished';
    case 'error': return 'Stopped';
    case 'cancelled': return 'Cancelled';
    case 'running': break;
    default: return '';
  }
  if (job.cancelling) return 'Cancelling…';
  switch (job.stage) {
    case 'source': return job.kind === 'url' ? 'Downloading video…' : 'Reading video…';
    case 'transcribe': return 'Transcribing speech…';
    case 'select': return `Preparing Hinglish clips with ${job.provider}…`;
    case 'render': return job.total ? `Rendering clip ${Math.max(1, job.clip)} of ${job.total}…` : 'Rendering clips…';
    case 'finishing': return 'Finishing up…';
    default: return 'Starting…';
  }
}

const STEP_IDS = ['source', 'transcribe', 'select', 'render'];

function stepLabel(id, job) {
  if (id === 'source') return job.kind === 'url' ? 'Download video' : 'Read video';
  return { transcribe: 'Transcribe speech', select: 'Find highlights', render: 'Render clips' }[id];
}

function stepDetail(id, stepState, job) {
  const active = stepState === 'active';
  const done = stepState === 'done';
  switch (id) {
    case 'source':
      if (done) return job.label || 'Video loaded';
      return job.kind === 'url' ? (active ? 'Downloading from YouTube' : 'From YouTube') : (active ? 'Reading the file' : 'From your computer');
    case 'transcribe':
      if (done) return 'Transcript ready';
      return active ? 'Listening for speech. This takes the longest.' : 'Speech to text on this computer';
    case 'select':
      if (done && job.total) return `${plural(job.total, 'highlight')} found`;
      return active ? 'Choosing the strongest moments' : 'Picks the strongest moments';
    default:
      if (done) return `${plural(job.saved || job.total || 0, 'clip')} rendered`;
      if (active) return job.total ? `Clip ${Math.max(1, job.clip)} of ${job.total}` : 'Starting the first clip';
      return `Up to ${plural(job.count || 0, 'clip')}, captioned and vertical`;
  }
}

/** The four pipeline steps with their state, for a stepper. */
export function jobSteps(job) {
  // Stages 'starting' and 'source' both mean the first step; 'finishing' means all four are complete.
  const position = job.status === 'done' || job.stage === 'finishing'
    ? STEP_IDS.length
    : Math.max(0, (STAGE_INDEX[job.stage] ?? 0) - 1);
  return STEP_IDS.map((id, index) => {
    let stepState = 'todo';
    if (job.status === 'done') stepState = 'done';
    else if (index < position && job.status !== 'idle') stepState = 'done';
    else if (index === position && job.status === 'running') stepState = 'active';
    else if (index === position && job.status === 'error') stepState = 'error';
    return { id, label: stepLabel(id, job), detail: stepDetail(id, stepState, job), state: stepState };
  });
}
