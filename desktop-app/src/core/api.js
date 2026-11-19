// Thin wrapper over window.studio (the preload bridge). Normalises errors; never throws synchronously.

const bridge = window.studio;
export const available = Boolean(bridge);

export function errorMessage(error) {
  return String(error?.message || error || 'The request failed.')
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    .trim();
}

function call(method, ...args) {
  if (typeof bridge?.[method] !== 'function') {
    return Promise.reject(new Error('Open ViralClip Studio on your desktop to use this feature.'));
  }
  return Promise.resolve()
    .then(() => bridge[method](...args))
    .catch(error => { throw new Error(errorMessage(error)); });
}

const subscribe = (method, callback) => (typeof bridge?.[method] === 'function' ? bridge[method](callback) : () => {});

export const api = {
  listClips: () => call('listClips'),
  moveClip: (id, from, to) => call('moveClip', id, from, to),
  openFolder: status => call('openFolder', status),
  revealClip: (id, status) => call('revealClip', id, status),
  openExternal: url => call('openExternal', url),
  resolveSources: ids => call('resolveSources', ids),
  chooseVideo: () => call('chooseVideo'),
  listClis: () => call('listClis'),
  generate: (source, count, provider, language) => call('generate', source, count, provider, language),
  cancelGeneration: () => call('cancelGeneration'),
  accounts: () => call('accounts'),
  connectAccount: key => call('connectAccount', key),
  publishClip: (id, platforms, details) => call('publishClip', id, platforms, details),
  onLog: callback => subscribe('onLog', callback),
  onLibraryChanged: callback => subscribe('onLibraryChanged', callback)
};
