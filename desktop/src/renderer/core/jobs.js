// Validates generation requests and follows each engine process through its own job ID.

import { state, set } from './store.js';
import { api, errorMessage } from './api.js';
import { navigate, hrefFor } from './router.js';
import { toast } from './toast.js';
import { baseName, plural } from './format.js';
import { sleep } from './dom.js';
import { refreshLibrary } from './library.js';
import { resolveClipLength } from './generation-settings.js';
import { timelineOrder } from './sources.js';

const LOG_MAX = 20000;
const LOG_FLUSH_FALLBACK = 250;
const TICK_MS = 1000;
const SOURCE_TO_TRANSCRIBE_MS = 700;
export const MAX_CLIPS = 10;
export const AUTO_CLIPS = 'auto';
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
  [/open\(\).*unexpected keyword argument ['"]metadata_errors['"]/i,
    'The audio decoder is incompatible with Whisper. Reinstall the engine dependencies from engine/requirements.txt, then try again.'],
  [/private video|video unavailable|has been removed|no longer available/i,
    'YouTube says this video is unavailable. Check that it is public and still online, then try again.'],
  [/sign in to confirm|confirm your age|age-restricted|login required/i,
    'YouTube wants a sign-in to play this video. Try another video, or download it and choose the file instead.'],
  [/unable to download|getaddrinfo|connection (?:reset|refused|aborted)|network is unreachable|name resolution|http error 5\d\d|youtube.*timed out|timed out.*youtube/i,
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
export function engineError(text, providerLabel = '', seoProviderLabel = '') {
  const lines = String(text).replace(ANSI, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const last = predicate => [...lines].reverse().find(predicate);
  const failed = last(line => /Clip generation failed:/i.test(line));
  const raw = failed
    ? failed.replace(/^.*?Clip generation failed:\s*/i, '')
    : last(line => ERROR_LINE.test(line)) || lines.at(-1) || '';
  let message = stripEngineNoise(raw) || 'The generator stopped before completing.';

  const providerError = [providerLabel, seoProviderLabel].some(label => label && message.startsWith(label));
  const friendly = !providerError && FRIENDLY_ERRORS.find(([pattern]) => pattern.test(message));
  if (friendly) return friendly[1];
  if (message.length > 240) message = message.slice(0, 237) + '…';
  return /[.!?…]$/.test(message) ? message : message + '.';
}

/* ───────── Job state ───────── */

const trackers = new Map();
export const getJob = id => state.jobs.find(job => job.id === id);
export const isActiveJob = job => job.status === 'queued' || job.status === 'running';

function patchJob(id, patch) {
  if (getJob(id)) set({ jobs: state.jobs.map(job => job.id === id ? { ...job, ...patch } : job) });
}

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

function trackJob(id, rawLabels) {
  let pendingLog = '';
  let leftover = '';
  let flushFrame = 0;
  let flushTimer = 0;
  let ticker = 0;
  let soonTimer = 0;
  const current = () => getJob(id);
  const patch = fields => patchJob(id, fields);

  /** Move to `stage` (never backwards) and lift the progress to that stage's floor. */
  function advance(stage, fields = {}) {
    const job = current();
    if (job.status !== 'running' || STAGE_INDEX[stage] < STAGE_INDEX[job.stage]) return;
    const next = { ...job, ...fields, stage };
    next.progress = Math.max(job.progress, next.progress, floorOf(next));
    patch(next);
  }

  function tick() {
    const job = current();
    const rate = CREEP[job.stage];
    if (job.status !== 'running' || job.cancelling || !rate) return;
    if (job.stage === 'transcribe' && job.transcriptionPercent !== undefined) return;
    const ceiling = nextFloor(job) - CREEP_MARGIN;
    if (job.progress >= ceiling) return;
    const progress = job.progress + (ceiling - job.progress) * rate;
    if (progress - job.progress >= CREEP_MIN_STEP) patch({ progress });
  }

  /* ───────── Engine log ───────── */

  const isRawLabel = label => !label || rawLabels.has(label) || YOUTUBE_LABEL.test(label);

  function onSourceLoaded(title) {
    if (title && isRawLabel(current().label)) patch({ label: title });
    advance('source');
    // Transcription starts right after, but the model import can take a few seconds before its own log line appears.
    clearTimeout(soonTimer);
    soonTimer = setTimeout(() => {
      if (current().status === 'running' && STAGE_INDEX[current().stage] <= STAGE_INDEX.source) advance('transcribe');
    }, SOURCE_TO_TRANSCRIBE_MS);
  }

  function applyLine(line) {
    if (/Downloading the YouTube video/i.test(line)) { advance('source'); return; }
    const download = /^Download progress: (\d+)%$/.exec(line);
    if (download) { advance('source', { downloadPercent: Number(download[1]) }); return; }
    const loaded = /Source loaded:\s*(.+)/i.exec(line);
    if (loaded) { onSourceLoaded(loaded[1].trim()); return; }
    if (/Transcribing speech/i.test(line)) { advance('transcribe'); return; }
    const transcription = /^Transcription progress: (\d+)%$/.exec(line);
    if (transcription) {
      const transcriptionPercent = Number(transcription[1]);
      advance('transcribe', {
        transcriptionPercent,
        progress: FLOOR.transcribe + (FLOOR.select - FLOOR.transcribe) * transcriptionPercent / 100
      });
      return;
    }
    if (/^Selecting highlights with /i.test(line)) { advance('select'); return; }
    const analysis = /^Analyzing transcript window (\d+) of (\d+)$/.exec(line);
    if (analysis) { advance('select', { analysisPart: Number(analysis[1]), analysisTotal: Number(analysis[2]) }); return; }
    const found = /(?:Found (\d+) highlight|Prepared (\d+) manual clip)/i.exec(line);
    if (found) { advance('select', { total: Number(found[1] || found[2]) }); return; }
    const writing = /^Writing (subtitles and SEO|subtitles|SEO) for clip (\d+) with (.+)\.\.\.$/.exec(line);
    if (writing) {
      const [, task, clip, provider] = writing;
      advance('render', { clip: Number(clip), clipTask: `Writing ${task} with ${provider}…` });
      return;
    }
    const render = /Rendering clip (\d+) of (\d+)/i.exec(line);
    if (render) { advance('render', { clip: Number(render[1]), total: Number(render[2]), clipTask: '' }); return; }
    const saved = /^Saved (\d+)(?: of \d+ requested)? clips/i.exec(line);
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
      patch({ log: (current().log + text).slice(-LOG_MAX) });
      parseLog(text);
    }
    if (final && leftover) {
      const line = leftover;
      leftover = '';
      applyLine(line);
    }
  }

  function onLog(chunk) {
    if (current().status !== 'running' || !chunk) return;
    pendingLog = (pendingLog + String(chunk)).slice(-LOG_MAX);
    if (flushFrame) return;
    // rAF pauses while the window is minimised, so a timer backs it up and the stage still advances.
    flushFrame = requestAnimationFrame(() => flushLog());
    flushTimer = setTimeout(() => flushLog(), LOG_FLUSH_FALLBACK);
  }

  function begin(startedAt = Date.now()) {
    const stage = current().kind === 'file' ? 'source' : 'starting';
    patch({ status: 'running', startedAt, stage, progress: FLOOR[stage] });
    ticker = setInterval(tick, TICK_MS);
  }

  function finish() {
    clearInterval(ticker);
    flushLog({ final: true });
    clearTimeout(soonTimer);
  }

  return { begin, onLog, finish };
}

api.onGenerationStarted(id => trackers.get(id)?.begin());
api.onLog((id, chunk) => trackers.get(id)?.onLog(chunk));

/* ───────── Start, finish, cancel ───────── */

function checkInput(kind, source, rawCount) {
  if (kind !== 'url' && kind !== 'file') return fail('Choose a YouTube link or a video file.');
  const count = typeof rawCount === 'string' && rawCount !== AUTO_CLIPS ? Number(rawCount) : rawCount;
  if (count !== AUTO_CLIPS && (!Number.isInteger(count) || count < 1 || count > MAX_CLIPS)) {
    return fail(`Choose Auto or enter a clip count from 1 to ${MAX_CLIPS}.`);
  }
  if (kind === 'url') {
    const check = validateYouTube(source);
    return check.ok ? { ok: true, source: check.normalized, id: check.id, count } : fail(check.message);
  }
  const path = typeof source === 'string' ? source.trim() : '';
  return path ? { ok: true, source: path, id: '', count } : fail('Choose a video file first.');
}

export function startJob({ kind, source, label = '', count, provider, providerLabel, language, seoProvider, seoProviderLabel, length, options = {} } = {}) {
  const input = checkInput(kind, source, count);
  const chosen = resolveClipLength(length);
  if (!input.ok || !chosen) {
    toast(input.message || 'Choose a clip length.', { kind: 'error' });
    return null;
  }

  const id = crypto.randomUUID().replaceAll('-', '');
  const job = registerJob({
    id, kind, source: input.source, label: label || (kind === 'file' ? baseName(input.source) : input.id),
    provider, providerLabel, seoProvider, seoProviderLabel, language, count: input.count, length: chosen.id,
    options: structuredClone(options), queuedAt: Date.now()
  });
  void runJob(job);
  return id;
}

function registerJob(request) {
  const { id, count, source } = request;
  const job = {
    ...request, status: 'queued', log: '',
    stage: 'starting', clip: 0, total: count === AUTO_CLIPS ? null : count,
    saved: 0, progress: 0, startedAt: 0, endedAt: 0, error: '', sourceKey: '', addedCount: 0, cancelling: false
  };
  trackers.set(id, trackJob(id, new Set([baseName(source), validateYouTube(source).id].filter(Boolean))));
  set({ jobs: [...state.jobs, job] });
  return job;
}

async function runJob({ id, source, count, provider, language, seoProvider, length, options }) {
  let failure;
  try { await api.generate(id, source, count, provider, language, seoProvider || provider, length, options); }
  catch (error) { failure = error; }
  await finishJob(id, failure);
}

async function finishJob(id, failure, log) {
  const tracker = trackers.get(id);
  if (!tracker) return;
  tracker.finish();
  trackers.delete(id);
  if (log !== undefined) patchJob(id, { log });
  try {
    if (failure) await handleFailure(id, failure);
    else await handleSuccess(id);
  } catch (error) {
    console.error('Could not finalize generation:', error);
    const message = 'Could not update this job. Refresh the library to check which clips were saved.';
    patchJob(id, { status: 'error', error: message, finalizing: false, cancelling: false, endedAt: Date.now() });
    toast(message, { kind: 'error' });
  }
}

const automatedJobsSeen = new Set();

function syncAutomatedJob({ startedAt, endedAt, log, error, ...request }) {
  const { id } = request;
  if (!automatedJobsSeen.has(id)) {
    registerJob(request);
    automatedJobsSeen.add(id);
  }
  const tracker = trackers.get(id);
  if (!tracker) return;
  if (startedAt && !getJob(id).startedAt) {
    tracker.begin(startedAt);
    tracker.onLog(log);
  }
  if (endedAt) void finishJob(id, error, log);
}

let loadingJobs;

export function refreshJobs() {
  if (loadingJobs) return loadingJobs;
  set({ jobsStatus: 'loading', jobsError: '' });
  loadingJobs = api.automatedJobs().then(jobs => {
    if (!Array.isArray(jobs) || jobs.some(job => !job?.id || typeof job.source !== 'string')) {
      throw new Error('The job history returned an unexpected response.');
    }
    jobs.forEach(syncAutomatedJob);
    set({ jobsStatus: 'ready' });
  }).catch(error => {
    set({ jobsStatus: 'error', jobsError: errorMessage(error) });
  }).finally(() => { loadingJobs = undefined; });
  return loadingJobs;
}

export function startJobsSync() {
  api.onAutomatedJob(syncAutomatedJob);
  return refreshJobs();
}

function jobClips(id) {
  return timelineOrder(state.clips.filter(clip => clip.jobId === id));
}

async function handleSuccess(id) {
  patchJob(id, { stage: 'finishing', progress: FLOOR.finishing, finalizing: true });
  let refreshed = await refreshLibrary({ quiet: true });
  if (!refreshed) { await sleep(800); refreshed = await refreshLibrary({ quiet: true }); }
  const fresh = jobClips(id);
  const sourceKey = fresh[0]?.source?.key || '';
  const job = getJob(id);
  const addedCount = fresh.length || job.saved;
  patchJob(id, {
    status: 'done', progress: 1, endedAt: Date.now(), cancelling: false, finalizing: false,
    saved: job.saved || fresh.length, sourceKey, addedCount
  });

  if (job.autopilot) return;
  if (!refreshed) {
    toast('The run completed. The library could not be refreshed.', { kind: 'warning', action: {
      label: 'Refresh library', run: async () => {
        if (!await refreshLibrary()) throw new Error(state.clipsError);
      }
    } });
  } else if (fresh.length) {
    toast(`${plural(fresh.length, 'new clip')} ready`, sourceKey ? { action: { label: 'View', run: () => {
      const currentSource = state.clips.find(clip => clip.jobId === id)?.source?.key;
      navigate(currentSource ? hrefFor.source(currentSource) : hrefFor.jobs(id));
    } } } : {});
  } else {
    toast(job.total === 0
      ? 'No highlights fit the selected duration and quality settings.'
      : 'Generation finished without adding clips.', { kind: 'info' });
  }
}

const CANCELLED = /^(?:Error:\s*)?CANCELLED\.?$/i;

async function handleFailure(id, error) {
  const raw = errorMessage(error);
  const job = getJob(id);
  if (CANCELLED.test(raw.trim())) {
    patchJob(id, { status: 'cancelled', cancelling: false, endedAt: Date.now() });
    if (job.startedAt) {
      await refreshLibrary({ quiet: true });
      const fresh = jobClips(id);
      patchJob(id, { saved: fresh.length || job.saved, sourceKey: fresh[0]?.source?.key || '' });
    }
  } else {
    const message = engineError(raw, job.providerLabel, job.seoProviderLabel);
    patchJob(id, { status: 'error', error: message, cancelling: false, endedAt: Date.now() });
    if (!job.autopilot) toast(`Generation stopped. ${message}`, { kind: 'error' });
    refreshLibrary({ quiet: true });
  }
}

export async function cancelJob(id) {
  const job = getJob(id);
  if (!job || job.autopilot || !isActiveJob(job) || job.cancelling || job.finalizing) return false;
  patchJob(id, { cancelling: true });
  try {
    const stopped = await api.cancelGeneration(id);
    if (!stopped) patchJob(id, { cancelling: false });
    return Boolean(stopped);
  } catch (error) {
    patchJob(id, { cancelling: false });
    toast(`Couldn’t stop the job. ${errorMessage(error)}`, { kind: 'error' });
    return false;
  }
}

export async function dismissJob(id) {
  const job = getJob(id);
  if (!job || isActiveJob(job) || job.dismissing) return;
  if (job.autopilot) {
    patchJob(id, { dismissing: true });
    try { await api.dismissAutomatedJob(id); }
    catch (error) {
      patchJob(id, { dismissing: false });
      toast(`Couldn’t dismiss the job. ${errorMessage(error)}`, { kind: 'error' });
      return;
    }
  }
  set({ jobs: state.jobs.filter(item => item.id !== id) });
}

/* ───────── Labels for the UI ───────── */

/** Short status text for the stage a running job is in. */
export function stageLabel(job) {
  if (job.cancelling) return 'Stopping…';
  switch (job.status) {
    case 'queued': return 'Queued';
    case 'done': return 'Finished';
    case 'error': return 'Stopped';
    case 'cancelled': return 'Cancelled';
    case 'running': break;
    default: return '';
  }
  switch (job.stage) {
    case 'source':
      if (job.kind !== 'url') return 'Reading video…';
      return job.downloadPercent === undefined ? 'Downloading video…' : `Downloading video · ${job.downloadPercent}%`;
    case 'transcribe':
      return job.transcriptionPercent === undefined ? 'Transcribing speech…' : `Transcribing speech · ${job.transcriptionPercent}%`;
    case 'select':
      if (job.options?.mode === 'manual') return 'Preparing manual cuts…';
      return job.analysisTotal > 1 ? `Finding highlights · part ${job.analysisPart} of ${job.analysisTotal}`
        : `Finding highlights with ${job.providerLabel || 'AI'}…`;
    case 'render':
      if (job.clipTask) return job.clipTask;
      return job.total ? `Rendering clip ${Math.max(1, job.clip)} of ${job.total}…` : 'Rendering clips…';
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
      if (done && job.total !== null) return `${plural(job.total, 'highlight')} found`;
      return active ? 'Choosing the strongest moments' : 'Picks the strongest moments';
    default:
      if (done) return `${plural(job.saved || job.total || 0, 'clip')} rendered`;
      if (active) return job.total ? `Clip ${Math.max(1, job.clip)} of ${job.total}` : 'Starting the first clip';
      return job.count === AUTO_CLIPS
        ? 'Auto selects the clip count'
        : `Up to ${plural(job.count || 0, 'clip')}, captioned and vertical`;
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
