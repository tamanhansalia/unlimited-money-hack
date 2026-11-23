// Thin wrapper over window.studio (the preload bridge). Normalises errors; never throws synchronously.

const bridge = window.studio;
export const available = Boolean(bridge);
const DEFAULT_TIMEOUT = 30_000;
const TIMEOUTS = {
  listClis: 20_000,
  testCli: 60_000,
  inspectSource: 35_000,
  deleteClips: 120_000,
  accounts: 270_000,
  addProfile: 270_000,
  verifyProfile: 270_000,
  updateProfileKeys: 270_000,
  zernioProfiles: 135_000,
  // Allow presigned upload, four destinations and a profile operation ahead of the publish request.
  publishClip: 100 * 60_000
};
const WRITES = new Set([
  'moveClip', 'deleteClips', 'dismissAutomatedJob', 'addProfile', 'selectProfile', 'renameProfile',
  'removeProfile', 'verifyProfile', 'updateProfileKeys', 'autopilotSave', 'autopilotStart', 'autopilotStop',
  'autopilotRemove', 'cancelGeneration'
]);

export function errorMessage(error) {
  return String(error?.message || error || '')
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    .trim() || 'The request failed.';
}

export class TimeoutError extends Error {}

export function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function call(method, ...args) {
  if (typeof bridge?.[method] !== 'function') {
    return Promise.reject(new Error('Open 2PixelHack on your desktop to use this feature.'));
  }
  const request = Promise.resolve().then(() => bridge[method](...args));
  // The native picker waits for the user. The generation queue owns the engine process and its watchdog.
  if (method === 'chooseVideo' || method === 'generate') return request.catch(normalize);
  const message = method === 'publishClip'
    ? 'Publishing took too long to confirm. Check Zernio and refresh the library before trying again.'
    : WRITES.has(method)
      ? 'The desktop did not confirm the change in time. Refresh and check its status before trying again.'
      : 'The desktop did not respond in time. Try again.';
  return withTimeout(request, TIMEOUTS[method] ?? DEFAULT_TIMEOUT, message).catch(normalize);
}

function normalize(error) { throw error instanceof TimeoutError ? error : new Error(errorMessage(error)); }

const subscribe = (method, callback) => (typeof bridge?.[method] === 'function' ? bridge[method](callback) : () => {});

export const api = {
  listClips: () => call('listClips'),
  moveClip: (id, from, to) => call('moveClip', id, from, to),
  deleteClips: (clips, sourceKey) => call('deleteClips', clips, sourceKey),
  openFolder: status => call('openFolder', status),
  revealClip: (id, status) => call('revealClip', id, status),
  openExternal: url => call('openExternal', url),
  resolveSources: ids => call('resolveSources', ids),
  chooseVideo: () => call('chooseVideo'),
  inspectSource: (source, previewAt) => call('inspectSource', source, previewAt),
  listClis: () => call('listClis'),
  testCli: provider => call('testCli', provider),
  generate: (...args) => call('generate', ...args),
  cancelGeneration: id => call('cancelGeneration', id),
  automatedJobs: () => call('automatedJobs'),
  dismissAutomatedJob: id => call('dismissAutomatedJob', id),
  accounts: () => call('accounts'),
  addProfile: (name, key, zernioProfileId) => call('addProfile', name, key, zernioProfileId),
  selectProfile: id => call('selectProfile', id),
  renameProfile: (id, name) => call('renameProfile', id, name),
  removeProfile: id => call('removeProfile', id),
  verifyProfile: id => call('verifyProfile', id),
  updateProfileKeys: (id, key, zernioProfileId) => call('updateProfileKeys', id, key, zernioProfileId),
  zernioProfiles: key => call('zernioProfiles', key),
  publishClip: (id, platforms, details, profileId, connectionId) => call('publishClip', id, platforms, details, profileId, connectionId),
  autopilotList: () => call('autopilotList'),
  autopilotSave: profile => call('autopilotSave', profile),
  autopilotRemove: id => call('autopilotRemove', id),
  autopilotStart: id => call('autopilotStart', id),
  autopilotStop: id => call('autopilotStop', id),
  onAutopilot: callback => subscribe('onAutopilot', callback),
  onAutomatedJob: callback => subscribe('onAutomatedJob', callback),
  onLog: callback => subscribe('onLog', callback),
  onGenerationStarted: callback => subscribe('onGenerationStarted', callback),
  onLibraryChanged: callback => subscribe('onLibraryChanged', callback)
};
