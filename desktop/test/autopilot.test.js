const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { test } = require('node:test');
const { createAutomation, checkProfile, channelUrl, nextSlot, engineMessage } = require('../src/main/automation');
const presets = require('../../engine/generation-presets.json');

const video = (id, title, multiple) => ({
  id, title, url: 'https://www.youtube.com/watch?v=' + id, channel: 'Comic', views: 500000,
  median: 100000, multiple, duration: 1200, source: 'channel'
});
const base = {
  name: 'Stand-up', niche: 'Hindi stand-up comedy', channels: ['@GauravKapoor'], keywords: [],
  provider: 'claude', videosPerRun: 2, repeatHours: 0,
  publish: { mode: 'schedule', profileId: 'pub-1', platforms: ['youtube'], times: ['19:00', '09:00'] }
};

async function setup(t, overrides = {}) {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), '2pixelhack-autopilot-test-'));
  const calls = { find: [], generate: [], publish: [], cancel: [] };
  const clips = [];
  const deps = {
    storage, presets,
    findVideos: async options => {
      calls.find.push(options);
      return { channels: [{ name: 'Comic', scanned: 30, median: 100000 }], warnings: [],
        videos: [video('aaaaaaaaaaa', 'First set', 5), video('bbbbbbbbbbb', 'Second set', 3), video('ccccccccccc', 'Third set', 2)] };
    },
    generate: async (jobId, source, ...rest) => {
      calls.generate.push([jobId, source, ...rest]);
      clips.push({ id: 'clip_' + jobId + '_01', jobId, status: 'ready', title: 'Clip of ' + source.slice(-11),
        description: 'Ek joke', tags: 'comedy', xPost: '', startSec: 10 });
    },
    cancel: async jobId => { calls.cancel.push(jobId); return true; },
    listClips: async () => clips,
    accounts: async () => ({ activeId: 'other', profiles: [{ id: 'pub-1', name: 'Main', platforms: ['youtube', 'instagram'] }] }),
    publish: async (...args) => { calls.publish.push(args); },
    ...overrides
  };
  const automation = createAutomation(deps);
  t.after(async () => {
    automation.suspend();
    await sleep(20);
    await fs.rm(storage, { recursive: true, force: true });
  });
  return { automation, calls, clips, storage };
}

async function settle(automation, id) {
  for (let i = 0; i < 200; i++) {
    const profile = (await automation.list()).profiles.find(item => item.id === id);
    if (!profile.state.running) return profile;
    await sleep(10);
  }
  throw new Error('The run did not finish.');
}

test('profiles are validated and normalised', () => {
  const profile = checkProfile({ ...base, channels: 'https://youtube.com/@GauravKapoor/videos\n@ZakirKhan\n\n' }, presets);
  assert.deepEqual(profile.channels, ['https://www.youtube.com/@GauravKapoor', 'https://www.youtube.com/@ZakirKhan']);
  assert.deepEqual(profile.publish.times, ['09:00', '19:00']);
  assert.equal(profile.clips, 'auto');
  assert.equal(profile.hook, true);
  assert.throws(() => checkProfile({ ...base, channels: [], keywords: [] }, presets), /at least one channel or search/);
  assert.throws(() => checkProfile({ ...base, minMinutes: 25, maxMinutes: 25 }, presets), /longest video/);
  assert.throws(() => checkProfile({ ...base, publish: { ...base.publish, platforms: [] } }, presets), /at least one platform/);
  assert.throws(() => checkProfile({ ...base, publish: { ...base.publish, profileId: '' } }, presets), /publishing profile/);
  assert.throws(() => checkProfile({ ...base, publish: { ...base.publish, times: ['25:00'] } }, presets), /posting time/);
  assert.throws(() => checkProfile({ ...base, length: '10-13' }, presets), /clip length/);
  assert.throws(() => channelUrl('https://example.com/@someone'), /not a YouTube channel/);
  assert.throws(() => channelUrl('https://youtube.com/%E0'), /not a YouTube channel/);
  assert.equal(channelUrl('youtube.com/channel/UCkS7Vxu4PjM99w0Is6idjcg'), 'https://www.youtube.com/channel/UCkS7Vxu4PjM99w0Is6idjcg');
  assert.equal(checkProfile({ ...base, publish: { mode: 'review' } }, presets).publish.mode, 'review');
});

test('reports a failed profile save and can retry after storage recovers', async t => {
  const { automation, storage } = await setup(t);
  const file = path.join(storage, 'autopilot.json');
  await automation.list();
  await fs.mkdir(file);
  await assert.rejects(automation.save(base), /Could not save Autopilot settings/);
  assert.deepEqual((await automation.list()).profiles, []);
  await fs.rmdir(file);
  const { profiles: [saved] } = await automation.save(base);
  assert.equal(saved.name, base.name);
  assert.equal(JSON.parse(await fs.readFile(file)).profiles[0].id, saved.id);
});

test('preserves unreadable settings and can reload a repaired file', async t => {
  const { automation, storage } = await setup(t);
  const file = path.join(storage, 'autopilot.json');
  await fs.writeFile(file, 'incomplete JSON');
  await assert.rejects(automation.list(), /Could not read Autopilot settings/);
  await assert.rejects(automation.save(base), /Could not read Autopilot settings/);
  assert.equal(await fs.readFile(file, 'utf8'), 'incomplete JSON');
  await fs.writeFile(file, '{"profiles":[],"runs":{}}');
  assert.deepEqual((await automation.list()).profiles, []);
});

test('posting slots skip taken times and keep a lead time', () => {
  const now = new Date(2026, 10, 23, 8, 50).getTime();
  const first = nextSlot(['09:00', '19:00'], [], now);
  assert.equal(first.getHours(), 19, '09:00 is inside the 20-minute lead time');
  const second = nextSlot(['09:00', '19:00'], [first.toISOString()], now);
  assert.equal(second.getDate(), 24);
  assert.equal(second.getHours(), 9);
});

test('engine errors are reduced to the line meant for people', () => {
  assert.equal(engineMessage(new Error('Traceback...\nValueError: x\nClip generation failed: No speech was detected.')), 'No speech was detected.');
  assert.equal(engineMessage(new Error('ERROR: [youtube] Video unavailable')), '[youtube] Video unavailable');
});

test('a scheduled run clips the top picks and books one slot per clip', async t => {
  const { automation, calls } = await setup(t);
  const { profiles: [profile] } = await automation.save(base);
  await automation.start(profile.id);
  const done = await settle(automation, profile.id);

  assert.equal(calls.find.length, 1);
  assert.deepEqual(calls.find[0].channels, ['https://www.youtube.com/@GauravKapoor']);
  assert.equal(calls.find[0].minDuration, 300);
  assert.deepEqual(calls.generate.map(call => call[1]), [
    'https://www.youtube.com/watch?v=aaaaaaaaaaa', 'https://www.youtube.com/watch?v=bbbbbbbbbbb'
  ]);
  const [jobId, , count, provider, language, seoProvider, length, options, origin] = calls.generate[0];
  assert.match(jobId, /^[a-f0-9]{32}$/);
  assert.deepEqual([count, provider, language, seoProvider, length], ['auto', 'claude', 'hi', 'claude', 'auto']);
  assert.deepEqual(options, { mode: 'auto', orientation: 'auto', layout: 'auto', subtitles: 'karaoke', niche: 'Hindi stand-up comedy',
    hook: true, fastProcessing: true });
  assert.deepEqual(origin, { label: 'First set', autopilot: 'Stand-up' });

  assert.equal(calls.publish.length, 2);
  const [clipId, platforms, details, profileId, firstSlot] = calls.publish[0];
  assert.equal(clipId, 'clip_' + jobId + '_01');
  assert.deepEqual(platforms, ['youtube']);
  assert.equal(details.title, 'Clip of aaaaaaaaaaa');
  assert.equal(profileId, 'pub-1');
  assert.match(firstSlot, /^\d{4}-\d\d-\d\dT\d\d:\d\d:00Z$/);
  assert.notEqual(calls.publish[1][4], firstSlot);

  assert.equal(done.state.enabled, false, 'a run-once profile turns itself off');
  assert.equal(done.state.processed, 2);
  assert.equal(done.state.scheduled, 2);
  assert.ok(done.state.activity.some(item => /Scheduled “Clip of aaaaaaaaaaa”/.test(item.text)));

  // The next run skips videos it already clipped.
  await automation.start(profile.id);
  await settle(automation, profile.id);
  assert.deepEqual(calls.generate.slice(2).map(call => call[1]), ['https://www.youtube.com/watch?v=ccccccccccc']);
  assert.deepEqual(calls.find[1].exclude.sort(), ['aaaaaaaaaaa', 'bbbbbbbbbbb']);
});

test('review mode keeps clips in the Library and a failed video does not stop the run', async t => {
  let attempt = 0;
  const { automation, calls } = await setup(t, {
    generate: async () => {
      attempt++;
      if (attempt === 1) throw new Error('Traceback\nClip generation failed: YouTube says this video is unavailable.');
    }
  });
  const { profiles: [profile] } = await automation.save({ ...base, publish: { mode: 'review' } });
  await automation.start(profile.id);
  const done = await settle(automation, profile.id);
  assert.equal(attempt, 2);
  assert.equal(calls.publish.length, 0);
  assert.ok(done.state.activity.some(item => item.level === 'error' && /unavailable/.test(item.text)));
  assert.equal(done.state.processed, 0, 'a failed or empty render is not counted as clipped');
  assert.match(done.state.lastError, /unavailable/);
  await automation.start(profile.id);
  await settle(automation, profile.id);
  assert.deepEqual(calls.find[1].exclude.sort(), ['aaaaaaaaaaa', 'bbbbbbbbbbb']);
});

test('stopping cancels the running job and keeps the profile off', async t => {
  let release;
  const { automation, calls } = await setup(t, {
    generate: () => new Promise((_resolve, reject) => { release = () => reject(new Error('CANCELLED')); })
  });
  const { profiles: [profile] } = await automation.save({ ...base, repeatHours: 24 });
  await automation.start(profile.id);
  for (let i = 0; i < 100 && !release; i++) await sleep(5);
  const { profiles: [active] } = await automation.list();
  assert.match(active.state.jobId, /^[a-f0-9]{32}$/);
  await automation.stop(profile.id);
  assert.deepEqual(calls.cancel, [active.state.jobId]);
  release();
  const done = await settle(automation, profile.id);
  assert.equal(done.state.enabled, false);
  assert.equal(done.state.nextRunAt, null);
  assert.equal(done.state.jobId, '');
  assert.equal(done.state.processed, 0, 'a stopped video is offered again next run');
});

test('repeating profiles arm the next run and resume after a restart', async t => {
  const { automation, storage } = await setup(t);
  const { profiles: [profile] } = await automation.save({ ...base, publish: { mode: 'review' }, repeatHours: 6 });
  await automation.start(profile.id);
  const done = await settle(automation, profile.id);
  assert.equal(done.state.enabled, true);
  const next = Date.parse(done.state.nextRunAt) - Date.parse(done.state.lastRunAt);
  assert.ok(Math.abs(next - 6 * 3600_000) < 2000);
  automation.suspend();
  await sleep(50);

  const restarted = createAutomation({
    storage, presets, findVideos: async () => ({ channels: [], videos: [], warnings: [] }),
    generate: async () => {}, cancel: async () => true, listClips: async () => [], accounts: async () => ({ profiles: [] }),
    publish: async () => {}
  });
  await restarted.resume();
  const [again] = (await restarted.list()).profiles;
  assert.equal(again.state.enabled, true);
  assert.equal(again.state.status, 'waiting');
  assert.ok(Date.parse(again.state.nextRunAt) > Date.now());
  assert.equal(restarted.active(), true);
  restarted.suspend();
});

test('a CLI or network failure pauses the run and keeps the video for next time', async t => {
  let attempts = 0;
  const { automation, calls } = await setup(t, {
    generate: async () => {
      attempts++;
      throw new Error('Traceback\nClip generation failed: Codex CLI failed. Check its version, sign-in and model access in a terminal, then retry.');
    }
  });
  const { profiles: [profile] } = await automation.save({ ...base, publish: { mode: 'review' } });
  await automation.start(profile.id);
  const done = await settle(automation, profile.id);
  assert.equal(attempts, 1, 'the second pick is not attempted with a broken CLI');
  assert.equal(done.state.processed, 0);
  assert.match(done.state.lastError, /Codex CLI failed/);
  assert.ok(done.state.activity.some(item => /Paused this run: .*will be tried again next run/.test(item.text)));
  assert.ok(!done.state.activity.some(item => /in the Library for review/.test(item.text)));

  await automation.start(profile.id);
  await settle(automation, profile.id);
  assert.deepEqual(calls.find[1].exclude, [], 'the paused video is eligible again');
});

test('a missing publishing profile is reported before research or rendering', async t => {
  const { automation, calls } = await setup(t, { accounts: async () => ({ profiles: [] }) });
  const { profiles: [profile] } = await automation.save({ ...base, videosPerRun: 1 });
  await automation.start(profile.id);
  const done = await settle(automation, profile.id);
  assert.equal(calls.publish.length, 0);
  assert.equal(calls.find.length, 0);
  assert.equal(calls.generate.length, 0);
  assert.ok(done.state.activity.some(item => /no longer exists/.test(item.text)));
});

test('Stop aborts live discovery and lets the profile start again', async t => {
  let first = true;
  let searching;
  const started = new Promise(resolve => { searching = resolve; });
  const { automation, calls } = await setup(t, {
    findVideos: (_options, { signal, onProgress }) => {
      if (!first) return { videos: [], channels: [], warnings: [], considered: 0 };
      first = false;
      onProgress('Checking matching videos · 2 of 12');
      searching();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Search cancelled.')), { once: true }));
    }
  });
  const { profiles: [profile] } = await automation.save({ ...base, publish: { mode: 'review' } });
  await automation.start(profile.id);
  await started;
  assert.match((await automation.list()).profiles[0].state.detail, /2 of 12/);
  await automation.stop(profile.id);
  const stopped = await settle(automation, profile.id);
  assert.equal(stopped.state.lastError, '');
  assert.equal(calls.generate.length, 0);
  await automation.start(profile.id);
  const restarted = await settle(automation, profile.id);
  assert.match(restarted.state.activity[1].text, /No new videos/);
});

test('a run can recover finished clips or retry incomplete videos after interruption', async t => {
  const jobId = 'a'.repeat(32);
  const { storage, automation, calls, clips } = await setup(t);
  await fs.writeFile(path.join(storage, 'autopilot.json'), JSON.stringify({
    profiles: [{ ...checkProfile({ ...base, publish: { mode: 'review' } }, presets), id: 'resume' }],
    runs: {
      resume: {
        slots: [], activity: [], processed: {
          aaaaaaaaaaa: { jobId, at: 1, title: 'First set', done: false },
          bbbbbbbbbbb: { jobId: 'b'.repeat(32), at: 2, title: 'Second set', done: false }
        }
      }
    }
  }));
  clips.push({ id: `clip_${jobId}_01`, jobId, status: 'ready' });
  await automation.start('resume');
  const done = await settle(automation, 'resume');
  assert.deepEqual(calls.find[0].exclude, ['aaaaaaaaaaa']);
  assert.equal(calls.generate[0][1], 'https://www.youtube.com/watch?v=bbbbbbbbbbb');
  assert.ok(done.state.activity.some(item => /Recovered 1 clip/.test(item.text)));
});

test('restart during scheduling recovers the same clips and posting slot', async t => {
  const at = new Date(2026, 10, 23, 8, 0).getTime();
  let savedAtSubmission;
  let expectedDate;
  const first = await setup(t, { now: () => at,
    publish: async (_clip, _platforms, _copy, _target, date) => {
      savedAtSubmission = await fs.readFile(path.join(first.storage, 'autopilot.json'), 'utf8');
      expectedDate = date;
    }
  });
  const { profiles: [profile] } = await first.automation.save({ ...base, videosPerRun: 1 });
  await first.automation.start(profile.id);
  await settle(first.automation, profile.id);
  const interrupted = JSON.parse(savedAtSubmission);
  assert.equal(interrupted.runs[profile.id].processed.aaaaaaaaaaa.done, false);
  assert.equal(interrupted.bookings[0].pending, true);

  const second = await setup(t, { now: () => at + 30_000,
    findVideos: async () => ({ videos: [], channels: [], warnings: [] }) });
  second.clips.push(...first.clips);
  await fs.writeFile(path.join(second.storage, 'autopilot.json'), savedAtSubmission);
  await second.automation.start(profile.id);
  const resumed = await settle(second.automation, profile.id);
  assert.equal(second.calls.generate.length, 0);
  assert.equal(second.calls.publish.length, 1);
  assert.equal(second.calls.publish[0][0], first.clips[0].id);
  assert.equal(second.calls.publish[0][4], expectedDate);
  assert.equal(resumed.state.scheduled, 1);
});

test('two Autopilots share posting times and honor a partially accepted slot', async t => {
  const attempted = [];
  const { automation } = await setup(t, {
    accounts: async () => ({ profiles: [
      { id: 'pub-1', platforms: ['youtube', 'instagram'], accounts: { youtube: 'shared-channel', instagram: 'instagram' } },
      { id: 'pub-alias', platforms: ['youtube'], accounts: { youtube: 'shared-channel' } }
    ] }),
    publish: async (_id, _platforms, _details, _profile, date) => {
      attempted.push(date);
      if (attempted.length === 1) throw Object.assign(new Error('Instagram did not accept the clip.'), {
        scheduledDates: [date], bookings: [{ date, accountId: 'shared-channel' }]
      });
      return { scheduledDates: [date] };
    }
  });
  const { profiles: [one, two] } = await automation.save({ ...base, name: 'First', videosPerRun: 1,
    publish: { ...base.publish, platforms: ['youtube', 'instagram'] } })
    .then(() => automation.save({ ...base, name: 'Second', videosPerRun: 1, publish: { ...base.publish, profileId: 'pub-alias' } }));
  await automation.start(one.id);
  const first = await settle(automation, one.id);
  await automation.remove(one.id);
  await automation.start(two.id);
  const second = await settle(automation, two.id);
  assert.equal(new Set(attempted).size, 2);
  assert.equal(first.state.scheduled, 1);
  assert.equal(second.state.scheduled, 1);
});

test('a replaced destination stops a saved Autopilot before it clips anything', async t => {
  let youtube = 'original-channel';
  const { automation, calls } = await setup(t, {
    accounts: async () => ({ profiles: [{ id: 'pub-1', platforms: ['youtube'], accounts: { youtube } }] })
  });
  const { profiles: [profile] } = await automation.save(base);
  youtube = 'replacement-channel';
  await automation.start(profile.id);
  const run = await settle(automation, profile.id);
  assert.match(run.state.lastError, /A publishing destination changed/);
  assert.equal(calls.generate.length, 0);
  assert.equal(calls.publish.length, 0);
});

test('one large batch stays inside the seven-day scheduling window', async t => {
  const at = new Date(2026, 10, 23, 8, 0).getTime();
  const generated = Array.from({ length: 10 }, (_, i) => ({ id: `clip-${i}`, title: `Clip ${i}`, status: 'ready' }));
  const { automation, calls } = await setup(t, { now: () => at,
    generate: async jobId => generated.forEach(clip => { clip.jobId = jobId; }), listClips: async () => generated });
  const { profiles: [profile] } = await automation.save({ ...base, videosPerRun: 1, publish: { ...base.publish, times: ['19:00'] } });
  await automation.start(profile.id);
  const run = await settle(automation, profile.id);
  assert.equal(calls.publish.length, 7);
  assert.equal(run.state.scheduled, 7);
  assert.ok(run.state.activity.some(item => /remaining clips are in the Library/.test(item.text)));
});
