// Autopilot: per-niche profiles that find source videos, cut clips through the generation queue and
// either keep them for review or schedule them with the profile's publishing account.
//
// Every side effect (engine, queue, library, publishing, clock and timers) is injected, so the run loop
// can be tested without Electron, Python or the network.

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');

const FILE = 'autopilot.json';
const SUPPORTED_PLATFORMS = ['youtube', 'instagram', 'facebook', 'twitter'];
const LAYOUTS = ['auto', 'fit', 'fill', 'reframe'];
const LANGUAGES = ['hi', 'en', 'auto'];
const REPEAT_HOURS = [0, 6, 12, 24];
const MAX_PROFILES = 20;
const MAX_ACTIVITY = 200;
const MAX_EXCLUDE = 800;
const MAX_SLOT_DAYS = 60;
const BACKLOG_DAYS = 7;
const SLOT_LEAD_MS = 20 * 60_000;
const RETRY_SLOT_LEAD_MS = 5 * 60_000;
const RESUME_DELAY_MS = 15_000;
const HOUR_MS = 3_600_000;
const NOTIFY_MS = 120;
const VIDEO_ID = /^[\w-]{11}$/;
const HANDLE = /^@[\p{L}\p{N}_.-]{3,100}$/u;
const providerId = id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(id);
// Failures of the AI CLI or the network, not of the video. Matches the engine's cli_error sentences and
// common yt-dlp network errors. The run pauses and the video stays eligible for the next run.
const TRANSIENT = new RegExp([
  'timed out', 'temporarily unavailable', 'reached a usage limit', 'needs you to sign in', 'needs a newer version',
  'needs an active plan', 'could not access its configured model', 'failed\\. Check its version', 'was not found\\. Install it',
  'could not start\\. Check its installation', 'Unable to download', 'getaddrinfo', 'Connection (?:reset|refused|aborted)',
  'Network is unreachable', 'name resolution', 'HTTP Error 5\\d\\d', 'Couldn.t reach YouTube', 'clip engine stopped responding',
  'No module named', 'FFmpeg and add it to PATH', 'Python could not be started', 'No space left', 'read-only file system'
].join('|'), 'i');

const PROGRESS = [
  [/Downloading the YouTube video/i, () => 'Downloading the video'],
  [/^Download progress: (\d+)%/i, match => `Downloading the video · ${match[1]}%`],
  [/Transcribing speech/i, () => 'Transcribing speech'],
  [/^Transcription progress: (\d+)%/i, match => `Transcribing speech · ${match[1]}%`],
  [/^Selecting highlights/i, () => 'Finding the strongest moments'],
  [/^Analyzing transcript window (\d+) of (\d+)/i, match => `Finding highlights · part ${match[1]} of ${match[2]}`],
  [/Found (\d+) highlight/i, match => `${match[1]} moment${match[1] === '1' ? '' : 's'} found`],
  [/^Writing (subtitles and SEO|subtitles|SEO) for clip (\d+)/i, match => `Writing ${match[1]} for clip ${match[2]}`],
  [/Rendering clip (\d+) of (\d+)/i, match => `Rendering clip ${match[1]} of ${match[2]}`]
];

/* ───────── Profile validation ───────── */

function fail(message) {
  throw new Error(message);
}

function text(value, min, max, message) {
  const result = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (result.length < min || result.length > max || /[\u0000-\u001f]/.test(result)) fail(message);
  return result;
}

function integer(value, min, max, fallback, message) {
  const result = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max) fail(message);
  return result;
}

function list(value, max, message) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(/\r?\n/);
  const cleaned = [...new Set(items.map(item => String(item).trim()).filter(Boolean))];
  if (cleaned.length > max) fail(message);
  return cleaned;
}

/** Normalise @handle, a channel link, /channel/UC…, /c/… or /user/… to one canonical channel URL. */
function channelUrl(value) {
  const raw = String(value).trim();
  if (HANDLE.test(raw)) return 'https://www.youtube.com/' + raw;
  let url;
  try { url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : 'https://' + raw); } catch { url = null; }
  const parts = url?.pathname.split('/').filter(Boolean) ?? [];
  if (url && ['https:', 'http:'].includes(url.protocol) && ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname) &&
      !url.username && !url.password && !url.port) {
    let first = '';
    try { first = decodeURIComponent(parts[0] || ''); } catch { /* Report the invalid channel below. */ }
    if (HANDLE.test(first)) return 'https://www.youtube.com/' + first;
    if (parts[0] === 'channel' && /^UC[\w-]{22}$/.test(parts[1] || '')) return 'https://www.youtube.com/channel/' + parts[1];
    if (['c', 'user'].includes(parts[0]) && /^[\w.-]{1,100}$/.test(parts[1] || '')) return `https://www.youtube.com/${parts[0]}/${parts[1]}`;
  }
  return fail(`“${raw.slice(0, 60)}” is not a YouTube channel. Use @handle or a channel link.`);
}

function postTimes(value) {
  const times = [...new Set(list(value, 8, 'Choose up to 8 posting times.'))].sort();
  if (!times.length || times.some(time => !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) fail('Choose at least one posting time, like 18:30.');
  return times;
}

/** Returns a clean profile or throws a message the editor can show next to the form. */
function checkProfile(input, presets, previous) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Invalid autopilot profile.');
  const lengths = Object.entries(presets.lengths).filter(([, item]) => !item.hidden).map(([id]) => id);
  const subtitles = presets.subtitles.map(style => style.id);
  const channels = [...new Set(list(input.channels, 20, 'List up to 20 channels.').map(channelUrl))];
  const keywords = list(input.keywords, 10, 'List up to 10 searches.')
    .map(keyword => text(keyword, 1, 80, 'Keep each search between 1 and 80 characters.'));
  if (!channels.length && !keywords.length) fail('Add at least one channel or search.');
  const minMinutes = integer(input.minMinutes, 1, 239, 5, 'Choose a minimum video length from 1 to 239 minutes.');
  const maxMinutes = integer(input.maxMinutes, 2, 240, 240, 'Choose a maximum video length from 2 to 240 minutes.');
  if (minMinutes >= maxMinutes) fail('The longest video must be longer than the shortest video.');
  const ranking = input.ranking ?? 'outliers';
  if (!['outliers', 'eligible'].includes(ranking)) fail('Choose how to rank the videos.');
  const clips = input.clips === 'auto' || input.clips === undefined ? 'auto'
    : integer(input.clips, 1, 10, 'auto', 'Choose Auto or 1 to 10 clips per video.');
  const length = input.length ?? 'auto';
  if (!lengths.includes(length)) fail('Choose a clip length.');
  const subtitleStyle = input.subtitles ?? 'karaoke';
  if (!subtitles.includes(subtitleStyle)) fail('Choose a subtitle style.');
  const layout = input.layout ?? 'auto';
  if (!LAYOUTS.includes(layout)) fail('Choose a framing option.');
  const language = input.language ?? 'hi';
  if (!LANGUAGES.includes(language)) fail('Choose the spoken language.');
  if (!providerId(input.provider)) fail('Choose a generation CLI.');
  const seoProvider = input.seoProvider || '';
  if (seoProvider && !providerId(seoProvider)) fail('Choose an SEO CLI.');
  const repeatHours = Number(input.repeatHours ?? 24);
  if (!REPEAT_HOURS.includes(repeatHours)) fail('Choose how often Autopilot runs.');

  const publishInput = input.publish && typeof input.publish === 'object' ? input.publish : {};
  const mode = publishInput.mode === 'schedule' ? 'schedule' : 'review';
  const platforms = [...new Set(Array.isArray(publishInput.platforms) ? publishInput.platforms : [])];
  if (platforms.some(platform => !SUPPORTED_PLATFORMS.includes(platform))) fail('Choose supported platforms.');
  const publish = {
    mode,
    profileId: typeof publishInput.profileId === 'string' ? publishInput.profileId.slice(0, 64) : '',
    platforms,
    times: postTimes(publishInput.times ?? ['10:00', '14:00', '19:00'])
  };
  if (mode === 'schedule' && !publish.profileId) fail('Choose the publishing profile Autopilot posts with.');
  if (mode === 'schedule' && !platforms.length) fail('Choose at least one platform to schedule posts on.');

  const now = new Date().toISOString();
  return {
    id: previous?.id || randomUUID(),
    name: text(input.name, 1, 60, 'Enter a name of 1 to 60 characters.'),
    niche: text(input.niche ?? '', 0, 80, 'Describe the niche in 80 characters or fewer.'),
    channels, keywords,
    videosPerRun: integer(input.videosPerRun, 1, 5, 2, 'Choose 1 to 5 videos per run.'),
    minMinutes, maxMinutes, ranking,
    maxAgeDays: integer(input.maxAgeDays, 1, 3650, 60, 'Choose a video age of 1 to 3650 days.'),
    clips, length, subtitles: subtitleStyle, layout, language,
    provider: input.provider, seoProvider, hook: input.hook !== false,
    publish, repeatHours,
    createdAt: previous?.createdAt || now, updatedAt: now
  };
}

/* ───────── Scheduling ───────── */

/** The first posting time at least SLOT_LEAD_MS ahead that no earlier post already uses. */
function nextSlot(times, used, now) {
  const taken = new Set(used.map(iso => Math.floor(Date.parse(iso) / 60_000)));
  for (let day = 0; day < MAX_SLOT_DAYS; day++) {
    for (const time of times) {
      const [hours, minutes] = time.split(':').map(Number);
      const slot = new Date(now);
      slot.setDate(slot.getDate() + day);
      slot.setHours(hours, minutes, 0, 0);
      const at = slot.getTime();
      if (at >= now + SLOT_LEAD_MS && !taken.has(Math.floor(at / 60_000))) return slot;
    }
  }
  return fail(`Every posting time in the next ${MAX_SLOT_DAYS} days is taken.`);
}

/** The engine's last meaningful line, without the Python traceback around it. */
function engineMessage(error) {
  const lines = String(error?.message || error || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const failed = [...lines].reverse().find(line => /Clip generation failed:/i.test(line));
  let message = failed ? failed.replace(/^.*?Clip generation failed:\s*/i, '')
    : [...lines].reverse().find(line => /^(?:[\w.]*(?:Error|Exception)|ERROR):/.test(line)) || lines.at(-1) || 'The run stopped.';
  message = message.replace(/^(?:(?:[\w.]*(?:Error|Exception)|ERROR):\s*)+/, '').trim();
  return message.length > 220 ? message.slice(0, 217) + '…' : message;
}

const compact = value => Number.isFinite(value)
  ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value) : '';
const when = date => new Date(date).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const platformNames = { youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook', twitter: 'X' };
const plural = (count, word, many = word + 's') => `${count} ${count === 1 ? word : many}`;

/* ───────── Runner ───────── */

function createAutomation({
  storage, presets, findVideos, generate, cancel, listClips, accounts, publish,
  notify = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout
}) {
  const file = path.join(storage, FILE);
  let data;
  let loading;
  let writing = Promise.resolve();
  let changing = Promise.resolve();
  let notifyTimer;
  let suspended = false;
  const live = new Map();
  const jobs = new Map();

  function load() {
    if (data) return Promise.resolve(data);
    if (loading) return loading;
    loading = fs.readFile(file, 'utf8').then(raw => {
      const saved = JSON.parse(raw);
      if (!Array.isArray(saved?.profiles) || (saved.runs && (typeof saved.runs !== 'object' || Array.isArray(saved.runs)))) {
        throw new Error('Unexpected Autopilot settings format.');
      }
      return saved;
    }).catch(error => {
      if (error.code === 'ENOENT') return { profiles: [], runs: {} };
      console.error('Could not read Autopilot settings:', error.message);
      throw new Error('Could not read Autopilot settings on this device. Check the app’s storage and try again.');
    }).then(saved => {
      data = { profiles: saved.profiles, runs: saved.runs ?? {}, bookings: Array.isArray(saved.bookings) ? saved.bookings : [] };
      return data;
    }).finally(() => { loading = undefined; });
    return loading;
  }

  function save() {
    const attempt = writing.then(async () => {
      const snapshot = JSON.stringify({ version: 1, ...data });
      await fs.mkdir(storage, { recursive: true });
      const temp = file + '.' + randomUUID() + '.tmp';
      try {
        await fs.writeFile(temp, snapshot, { mode: 0o600 });
        await fs.rename(temp, file);
      } finally {
        await fs.rm(temp, { force: true }).catch(error => console.warn('Could not clean up Autopilot settings:', error.message));
      }
    }).catch(error => {
      console.error('Could not save Autopilot settings:', error.message);
      throw new Error('Could not save Autopilot settings on this device.');
    });
    writing = attempt.catch(() => {});
    return attempt;
  }

  function change(operation, ...args) {
    const attempt = changing.then(() => operation(...args));
    changing = attempt.catch(() => {});
    return attempt;
  }

  function record(id) {
    data.runs[id] ||= { enabled: false, lastRunAt: null, nextRunAt: null, lastError: '', processed: {}, slots: [], activity: [] };
    return data.runs[id];
  }

  function state(id) {
    if (!live.has(id)) live.set(id, { running: false, status: 'idle', step: '', detail: '', jobId: '', stopping: false, timer: null, finder: null });
    return live.get(id);
  }

  function snapshot() {
    const at = now();
    return {
      profiles: data.profiles.map(profile => {
        const run = record(profile.id);
        const current = state(profile.id);
        const dates = [...run.slots, ...data.bookings.filter(item => item.profileId === profile.id).map(item => item.date)];
        const upcoming = [...new Set(dates.map(date => Date.parse(date)))].filter(date => date > at).sort((a, b) => a - b);
        return {
          ...profile,
          state: {
            enabled: run.enabled, running: current.running, stopping: current.stopping,
            status: current.running ? current.status : run.enabled ? 'waiting' : 'idle',
            step: current.running ? current.step : '', detail: current.running ? current.detail : '',
            jobId: current.jobId,
            lastRunAt: run.lastRunAt, nextRunAt: run.enabled && !current.running ? run.nextRunAt : null,
            lastError: run.lastError, processed: Object.values(run.processed).filter(entry => entry.clips > 0).length,
            scheduled: upcoming.length, nextPostAt: upcoming.length ? new Date(upcoming[0]).toISOString() : null,
            activity: run.activity.slice(-60).reverse()
          }
        };
      })
    };
  }

  function emit() {
    if (notifyTimer) return;
    notifyTimer = setTimer(() => {
      notifyTimer = null;
      notify(snapshot());
    }, NOTIFY_MS);
  }

  function log(id, level, message) {
    if (!find(id)) return; // A run that outlives its deleted profile must not recreate its history.
    const run = record(id);
    run.activity.push({ at: new Date(now()).toISOString(), level, text: message });
    if (run.activity.length > MAX_ACTIVITY) run.activity.splice(0, run.activity.length - MAX_ACTIVITY);
    emit();
  }

  function progress(id, fields) {
    Object.assign(state(id), fields);
    emit();
  }

  function find(id) {
    return data.profiles.find(profile => profile.id === id);
  }

  function arm(id, at) {
    const current = state(id);
    clearTimer(current.timer);
    const run = record(id);
    run.nextRunAt = new Date(at).toISOString();
    current.timer = setTimer(() => {
      current.timer = null;
      void execute(id).catch(error => console.error('Could not run Autopilot:', error));
    }, Math.max(0, at - now()));
    current.timer?.unref?.();
  }

  /* One run: plan from the finder, clip each pick, then hand clips to review or the schedule. */
  async function runOnce(id, current) {
    const profile = structuredClone(find(id));
    const run = record(id);
    log(id, 'info', `Run started for ${profile.name}.`);

    const scheduling = profile.publish.mode === 'schedule';
    let target;
    if (scheduling) {
      progress(id, { status: 'publishing', step: 'Checking publishing profile' });
      target = await publishingTarget(profile);
      if (current.stopping) return;
      if (!profile.publish.accountIds && Object.keys(target.accounts || {}).length) {
        const savedProfile = find(id);
        profile.publish.accountIds = destinationIds(profile, target);
        savedProfile.publish.accountIds = profile.publish.accountIds;
        try { await save(); }
        catch (error) { delete savedProfile.publish.accountIds; throw error; }
      }
    }

    const publishTarget = scheduling ? JSON.stringify([target.id, Object.entries(destinationIds(profile, target)).sort()]) : null;
    async function finishClips(entry, clips) {
      entry.clips = clips.length;
      const ready = clips.filter(clip => clip.status === 'ready').sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0));
      const targetChanged = entry.publishTarget && entry.publishTarget !== publishTarget;
      let keepGoing = true;
      if (scheduling && ready.length && !targetChanged) {
        await save();
        keepGoing = await schedule(id, profile, ready, current, target);
      } else if (scheduling && ready.length && targetChanged) {
        log(id, 'warn', `The publishing destination changed after clipping “${entry.title}”. Its clips stay in the Library.`);
      }
      entry.done = true;
      delete entry.publishTarget;
      await save();
      return keepGoing;
    }

    const interrupted = Object.values(run.processed).filter(entry => entry.done === false && entry.jobId);
    if (interrupted.length) {
      const library = await listClips();
      for (const entry of interrupted) {
        if (current.stopping) return;
        const clips = library.filter(clip => clip.jobId === entry.jobId);
        if (!clips.length) continue;
        log(id, 'ok', `Recovered ${plural(clips.length, 'clip')} from “${entry.title}” in the Library.`);
        if (!await finishClips(entry, clips)) return;
      }
    }
    if (scheduling && !postingSlot(profile, target)) {
      log(id, 'warn', 'The next seven days of posting times are booked. Skipping this run.');
      return;
    }

    progress(id, { status: 'finding', step: 'Finding videos', detail: [
      profile.channels.length && plural(profile.channels.length, 'channel'),
      profile.keywords.length && plural(profile.keywords.length, 'search', 'searches')
    ].filter(Boolean).join(' · ') });
    const processed = Object.entries(run.processed)
      .filter(([, entry]) => entry.done !== false)
      .sort((a, b) => b[1].at - a[1].at).map(([videoId]) => videoId);
    const finder = current.finder = new AbortController();
    let found;
    try {
      found = await findVideos({
        channels: profile.channels, keywords: profile.keywords, recent: 30, searchLimit: 12,
        minDuration: Math.min(profile.minMinutes, 239) * 60, maxDuration: (profile.maxMinutes ?? 240) * 60,
        maxAgeDays: profile.maxAgeDays, ranking: profile.ranking ?? 'outliers',
        exclude: processed.filter(videoId => VIDEO_ID.test(videoId)).slice(0, MAX_EXCLUDE)
      }, {
        signal: finder.signal,
        onProgress: detail => {
          if (!current.stopping) progress(id, { detail });
        }
      });
    } finally {
      current.finder = null;
    }
    if (current.stopping) return;
    for (const channel of found.channels.slice(0, 8)) {
      log(id, 'info', channel.median
        ? `${channel.name}: ${channel.scanned} recent uploads, median ${compact(channel.median)} views.`
        : `${channel.name}: too few uploads with view counts to rank against.`);
    }
    for (const warning of found.warnings) log(id, 'warn', warning);

    const picks = found.videos.filter(video => !run.processed[video.id] || run.processed[video.id].done === false).slice(0, profile.videosPerRun);
    if (!picks.length) {
      log(id, 'info', found.considered
        && profile.ranking !== 'eligible'
        ? `Found ${plural(found.considered, 'new video')}, but none reached ${found.minMultiple}× its channel median. Try a wider upload window or “All eligible uploads”.`
        : 'No new videos matched the filters this time.');
      return;
    }
    log(id, 'info', `Plan: clip ${plural(picks.length, 'video')}. ` + picks.map(video => `“${video.title}” (${
      video.multiple ? `${video.multiple}× its channel median` : `${compact(video.views)} views`}, ${Math.ceil(video.duration / 60)} min)`).join(', ') + '.');

    let made = 0;
    for (const [index, video] of picks.entries()) {
      if (current.stopping) break;
      const jobId = randomBytes(16).toString('hex');
      const entry = { at: now(), title: video.title, channel: video.channel, clips: 0, done: false, jobId, publishTarget };
      run.processed[video.id] = entry;
      try { await save(); }
      catch (error) { delete run.processed[video.id]; throw error; }
      if (current.stopping) {
        delete run.processed[video.id];
        await save();
        break;
      }
      jobs.set(jobId, id);
      progress(id, { status: 'clipping', jobId, step: `Video ${index + 1} of ${picks.length}: ${video.title}`, detail: 'Waiting for a generation slot' });
      try {
        await generate(jobId, video.url, profile.clips, profile.provider, profile.language,
          profile.seoProvider || profile.provider, profile.length,
          { mode: 'auto', orientation: 'auto', layout: profile.layout, subtitles: profile.subtitles,
            niche: profile.niche, hook: profile.hook, fastProcessing: true },
          { label: video.title, autopilot: profile.name });
      } catch (error) {
        const message = engineMessage(error);
        if (current.stopping || TRANSIENT.test(message)) {
          // Stopped by the person, or the CLI or network failed: the video is fine, so offer it again next run.
          await save();
          if (!current.stopping) {
            run.lastError = message;
            log(id, 'error', `Paused this run: ${message} “${video.title}” will be tried again next run.`);
          }
          break;
        }
        run.processed[video.id].done = true;
        run.lastError = message;
        log(id, 'error', `Could not clip “${video.title}”: ${message}`);
        continue;
      } finally {
        jobs.delete(jobId);
        progress(id, { jobId: '' });
      }
      const clips = (await listClips()).filter(clip => clip.jobId === jobId && clip.status === 'ready');
      if (!clips.length) {
        log(id, 'warn', `No moment in “${video.title}” was strong enough to clip.`);
      } else {
        made += clips.length;
        log(id, 'ok', `${plural(clips.length, 'clip')} ready from “${video.title}”.`);
      }
      if (!await finishClips(entry, clips)) break;
    }
    if (profile.publish.mode === 'review' && made) log(id, 'info', `${plural(made, 'new clip')} in the Library for review.`);
  }

  function destinationIds(profile, target) {
    return Object.fromEntries(profile.publish.platforms.map(platform => [platform, target.accounts?.[platform]]));
  }

  async function publishingTarget(profile) {
    const registry = (await accounts()).profiles;
    const target = registry.find(item => item.id === profile.publish.profileId);
    if (!target) fail('The chosen publishing profile no longer exists. Choose a Zernio profile in Autopilot.');
    if (target.needsKey) fail(`${target.name} needs a Zernio API key. Update it in Publishing.`);
    const missing = profile.publish.platforms.filter(platform => !target.platforms?.includes(platform));
    if (missing.length) fail(`${target.name} is missing ${missing.map(platform => platformNames[platform]).join(', ')}. Reconnect it in Publishing or edit the destinations in Autopilot.`);
    const destinationAccounts = Object.values(destinationIds(profile, target)).filter(Boolean);
    if (profile.publish.platforms.some(platform => profile.publish.accountIds?.[platform] &&
        profile.publish.accountIds[platform] !== target.accounts?.[platform])) {
      fail('A publishing destination changed. Review the account handles and save this Autopilot again before starting it.');
    }
    const sharedProfiles = new Set(registry.filter(item => item.id === target.id ||
      Object.values(item.accounts || {}).some(account => destinationAccounts.includes(account))).map(item => item.id));
    return { ...target, destinationAccounts, sharedProfiles };
  }

  function postingSlot(profile, target) {
    const at = now();
    const used = data.profiles
      .filter(item => target.sharedProfiles.has(item.publish.profileId))
      .flatMap(item => record(item.id).slots);
    for (const booking of data.bookings) {
      if (booking.accounts.some(account => target.destinationAccounts.includes(account)) ||
          (!booking.accounts.length && booking.publishingProfileId === target.id)) used.push(booking.date);
    }
    const slot = nextSlot(profile.publish.times, used, at);
    return slot.getTime() < at + BACKLOG_DAYS * 24 * HOUR_MS ? slot : null;
  }

  /** Returns false when scheduling cannot continue this run (the remaining clips stay in the Library). */
  async function schedule(id, profile, clips, current, target) {
    const run = record(id);
    const report = message => {
      if (!current.stopping) {
        run.lastError = message;
        log(id, 'error', message);
      }
      return false;
    };
    const platforms = profile.publish.platforms;
    const names = platforms.map(platform => platformNames[platform] || platform).join(', ');
    for (const clip of clips) {
      if (current.stopping) return false;
      const prior = data.bookings.find(item => item.pending && item.clipId === clip.id && item.profileId === id &&
        item.publishingProfileId === target.id && Date.parse(item.date) > now() + RETRY_SLOT_LEAD_MS);
      const slot = prior ? new Date(prior.date) : postingSlot(profile, target);
      if (!slot) {
        log(id, 'warn', 'The next seven days of posting times are booked. The remaining clips are in the Library.');
        return false;
      }
      const reservation = slot.toISOString();
      const reserved = prior || { date: reservation, accounts: target.destinationAccounts, clipId: clip.id, profileId: id,
        publishingProfileId: target.id, pending: true };
      progress(id, { status: 'publishing', step: `Scheduling “${clip.title}”`, detail: `${when(slot)} · ${names}` });
      if (!prior) data.bookings.push(reserved);
      let dates = [];
      let bookings;
      try {
        await save();
        if (current.stopping) return false;
        const published = await publish(clip.id, platforms, { title: clip.title, description: clip.description, tags: clip.tags, xPost: clip.xPost },
          target.id, slot.toISOString().replace(/\.\d{3}Z$/, 'Z'), target.connectionId);
        dates = published?.scheduledDates ?? [reservation];
        bookings = published?.bookings;
      } catch (error) {
        dates = error.scheduledDates ?? [];
        bookings = error.bookings;
        return report(`Could not schedule “${clip.title}”. ${engineMessage(error)} Check the clip in the Library.`);
      } finally {
        const cutoff = now() - 3 * 24 * HOUR_MS;
        run.slots = run.slots.filter(date => Date.parse(date) > cutoff);
        data.bookings = data.bookings.filter(item => item !== reserved && Date.parse(item.date) > cutoff);
        const confirmed = bookings?.map(item => ({ ...reserved, date: item.date, accounts: [item.accountId], pending: false })) ||
          dates.map(date => ({ ...reserved, date, pending: false }));
        data.bookings.push(...confirmed.filter(item => Date.parse(item.date) > cutoff));
        await save();
      }
      const upcoming = dates.filter(date => Date.parse(date) > now());
      log(id, 'ok', upcoming.length
        ? `Scheduled “${clip.title}” for ${upcoming.map(when).join(', ')} on ${names}.`
        : `Zernio already accepted “${clip.title}” on ${names}.`);
    }
    return true;
  }

  async function execute(id) {
    await load();
    if (!find(id)) return;
    const current = state(id);
    const run = record(id);
    if (suspended || !run.enabled || current.running) return;
    current.running = true;
    current.stopping = false;
    run.nextRunAt = null;
    run.lastError = '';
    emit();
    try {
      await runOnce(id, current);
    } catch (error) {
      if (!current.stopping) {
        run.lastError = engineMessage(error);
        log(id, 'error', `Run failed: ${run.lastError}`);
      }
    } finally {
      const profile = find(id);
      Object.assign(current, { running: false, status: 'idle', step: '', detail: '', jobId: '' });
      run.lastRunAt = new Date(now()).toISOString();
      if (current.stopping || !profile) {
        current.stopping = false;
      } else if (run.enabled && profile.repeatHours) {
        arm(id, now() + profile.repeatHours * HOUR_MS);
        log(id, 'info', `Next run ${when(run.nextRunAt)}.`);
      } else {
        run.enabled = false;
        log(id, 'info', 'Run finished.');
      }
      try { await save(); }
      catch (error) {
        if (profile) {
          run.lastError = error.message;
          log(id, 'error', run.lastError);
        }
      } finally {
        if (!profile) live.delete(id);
        emit();
      }
    }
  }

  /* ───────── Public API ───────── */

  async function list() {
    await load();
    return snapshot();
  }

  async function saveProfile(input) {
    await load();
    const previous = input?.id ? find(input.id) : null;
    if (input?.id && !previous) fail('That autopilot profile no longer exists.');
    if (!previous && data.profiles.length >= MAX_PROFILES) fail(`You can keep up to ${MAX_PROFILES} autopilot profiles.`);
    const profile = checkProfile(input, presets, previous);
    if (data.profiles.some(item => item.id !== profile.id && item.name.toLowerCase() === profile.name.toLowerCase())) {
      fail('Another autopilot profile already uses this name.');
    }
    if (profile.publish.mode === 'schedule') {
      const target = (await accounts()).profiles.find(item => item.id === profile.publish.profileId);
      if (input.publish.connectionId && target?.connectionId !== input.publish.connectionId) {
        fail('The publishing account changed. Refresh the profiles and review the destinations before saving.');
      }
      if (Object.keys(target?.accounts || {}).length) profile.publish.accountIds = destinationIds(profile, target);
    }
    const previousProfiles = data.profiles;
    data.profiles = previous ? previousProfiles.map(item => item.id === profile.id ? profile : item) : [...previousProfiles, profile];
    const run = record(profile.id);
    const activity = [...run.activity];
    log(profile.id, 'info', previous ? 'Settings updated. They apply from the next run.' : 'Profile created.');
    const entry = run.activity.at(-1);
    try { await save(); }
    catch (error) {
      data.profiles = previousProfiles;
      if (previous) {
        const latest = run.activity.filter(item => item !== entry && !activity.includes(item));
        run.activity = [...activity, ...latest].slice(-MAX_ACTIVITY);
      } else delete data.runs[profile.id];
      emit();
      throw error;
    }
    if (previous && run.enabled && !state(profile.id).running && previous.repeatHours !== profile.repeatHours) {
      if (profile.repeatHours) arm(profile.id, Date.parse(run.lastRunAt || new Date(now()).toISOString()) + profile.repeatHours * HOUR_MS);
    }
    return snapshot();
  }

  async function start(id) {
    await load();
    if (!find(id)) fail('That autopilot profile no longer exists.');
    const current = state(id);
    if (current.running) fail('This autopilot is already running.');
    const run = record(id);
    const wasEnabled = run.enabled;
    run.enabled = true;
    try { await save(); }
    catch (error) { run.enabled = wasEnabled; emit(); throw error; }
    clearTimer(current.timer);
    current.timer = null;
    void execute(id).catch(error => console.error('Could not run Autopilot:', error));
    return snapshot();
  }

  async function halt(id, { disable }) {
    const current = state(id);
    const run = record(id);
    clearTimer(current.timer);
    current.timer = null;
    if (disable) {
      run.enabled = false;
      run.nextRunAt = null;
    }
    if (current.running) {
      current.stopping = true;
      current.detail = 'Stopping';
      current.finder?.abort();
      if (current.jobId) await cancel(current.jobId).catch(() => false);
    }
  }

  async function stop(id) {
    await load();
    if (!find(id)) fail('That autopilot profile no longer exists.');
    await halt(id, { disable: true });
    log(id, 'warn', 'Stopped. Clips that finished before the stop stay in the Library.');
    try { await save(); }
    catch {
      throw new Error('Autopilot stopped for this session. Its settings could not be saved for the next launch.');
    }
    return snapshot();
  }

  async function remove(id) {
    await load();
    if (!find(id)) fail('That autopilot profile no longer exists.');
    await halt(id, { disable: true });
    const previousProfiles = data.profiles;
    const run = record(id);
    data.profiles = data.profiles.filter(profile => profile.id !== id);
    delete data.runs[id];
    try { await save(); }
    catch (error) {
      data.profiles = previousProfiles;
      data.runs[id] = run;
      emit();
      throw error;
    }
    if (!state(id).running) live.delete(id);
    emit();
    return snapshot();
  }

  /** Window closed or app quitting: stop work but keep each profile's on/off choice for next time. */
  function suspend() {
    suspended = true;
    if (!data) return;
    for (const profile of data.profiles) void halt(profile.id, { disable: false });
    void save().catch(() => {});
  }

  /** On launch: profiles that were on carry on, starting with any run that came due while the app was closed. */
  async function resume() {
    suspended = false;
    await load();
    for (const profile of data.profiles) {
      const run = record(profile.id);
      const current = state(profile.id);
      if (!run.enabled || current.running || current.timer) continue;
      const due = Date.parse(run.nextRunAt || '') || now();
      arm(profile.id, Math.max(due, now() + RESUME_DELAY_MS));
      log(profile.id, 'info', `Autopilot is on. Next run ${when(run.nextRunAt)}.`);
    }
    emit();
  }

  function onJobLog(jobId, chunk) {
    const id = jobs.get(jobId);
    if (!id) return;
    for (const line of String(chunk).split(/\r?\n/)) {
      for (const [pattern, label] of PROGRESS) {
        const match = pattern.exec(line.trim());
        if (match) progress(id, { detail: label(match) });
      }
    }
  }

  const active = () => Boolean(data?.profiles.some(profile => record(profile.id).enabled || state(profile.id).running));

  return {
    list, save: input => change(saveProfile, input), start: id => change(start, id),
    stop: id => change(stop, id), remove: id => change(remove, id), suspend, resume, onJobLog, active
  };
}

module.exports = { createAutomation, checkProfile, channelUrl, nextSlot, engineMessage };
