// Autopilot profiles and their live run state. The main process owns the runner and pushes snapshots.

import { state, set } from './store.js';
import { api, errorMessage } from './api.js';
import { toast } from './toast.js';
import { hrefFor, navigate } from './router.js';

export const REPEAT_CHOICES = [
  { hours: 0, label: 'Once' },
  { hours: 6, label: 'Every 6 hours' },
  { hours: 12, label: 'Every 12 hours' },
  { hours: 24, label: 'Every day' }
];

export const FRAMING_CHOICES = [
  { id: 'auto', label: 'Auto' },
  { id: 'fill', label: 'Fill frame' },
  { id: 'fit', label: 'Fit full frame' },
  { id: 'reframe', label: 'Follow the speaker' }
];

/** A starting point for the editor. Stand-up and podcast clips work best with motion captions. */
export function blankProfile() {
  return {
    id: '', name: '', niche: '', channels: [], keywords: [],
    videosPerRun: 2, minMinutes: 5, maxMinutes: 240, maxAgeDays: 60, ranking: 'outliers',
    clips: 'auto', length: 'auto', subtitles: 'karaoke', layout: 'auto', language: 'hi',
    provider: '', seoProvider: '', hook: true,
    publish: { mode: 'review', profileId: '', platforms: [], times: ['10:00', '14:00', '19:00'] },
    repeatHours: 24
  };
}

export const hindiStandUpPreset = {
  name: 'Hindi stand-up comedy', niche: 'Indian Hindi and Hinglish stand-up comedy and crowd work',
  videosPerRun: 1, minMinutes: 5, maxMinutes: 25, maxAgeDays: 180, ranking: 'eligible',
  clips: 2, length: '30-60', language: 'hi', repeatHours: 0
};

function apply(snapshot) {
  if (!Array.isArray(snapshot?.profiles) || snapshot.profiles.some(profile => !profile?.id || !profile.state ||
      !Array.isArray(profile.state.activity) || !Array.isArray(profile.channels) || !Array.isArray(profile.keywords) ||
      !Array.isArray(profile.publish?.platforms) || !Array.isArray(profile.publish?.times))) {
    throw new Error('Autopilot returned an unexpected profile list.');
  }
  const previous = new Map(state.autopilot.profiles.map(profile => [profile.id, profile.state]));
  set({ autopilot: { profiles: snapshot.profiles, status: 'ready', error: '' } });
  for (const { id, name, state: run } of snapshot.profiles) {
    if (!previous.has(id) || run.running || !run.lastError || previous.get(id).lastError === run.lastError) continue;
    toast(`${name} needs attention. ${run.lastError}`, { kind: 'warning',
      action: { label: 'Open Autopilot', run: () => navigate(hrefFor.autopilot()) } });
  }
  return snapshot;
}

let loading;

export function refreshAutopilot() {
  if (loading) return loading;
  set({ autopilot: { ...state.autopilot, status: 'loading', error: '' } });
  loading = api.autopilotList()
    .then(snapshot => { if (state.autopilot.status === 'loading') apply(snapshot); })
    .catch(error => {
      if (state.autopilot.status === 'loading') set({ autopilot: { ...state.autopilot, status: 'error', error: errorMessage(error) } });
    })
    .finally(() => { loading = undefined; });
  return loading;
}

export const saveAutopilot = profile => api.autopilotSave(profile).then(apply);
export const removeAutopilot = id => api.autopilotRemove(id).then(apply);
export const startAutopilot = id => api.autopilotStart(id).then(apply);
export const stopAutopilot = id => api.autopilotStop(id).then(apply);

export function startAutopilotSync() {
  api.onAutopilot(snapshot => {
    try { apply(snapshot); }
    catch (error) { set({ autopilot: { ...state.autopilot, status: 'error', error: errorMessage(error) } }); }
  });
  return refreshAutopilot();
}

export const isRunning = profile => profile.state?.running || profile.state?.enabled;
