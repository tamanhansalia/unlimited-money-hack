const { contextBridge, ipcRenderer } = require('electron');

const invoke = (method, ...args) => ipcRenderer.invoke('studio:' + method, ...args);

// Returns an unsubscribe function. The event object never reaches the page.
function listen(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('studio', {
  listClips: () => invoke('listClips'),
  moveClip: (id, from, to) => invoke('moveClip', id, from, to),
  openFolder: status => invoke('openFolder', status),
  revealClip: (id, status) => invoke('revealClip', id, status),
  openExternal: url => invoke('openExternal', url),
  resolveSources: ids => invoke('resolveSources', ids),
  chooseVideo: () => invoke('chooseVideo'),
  listClis: () => invoke('listClis'),
  generate: (source, count, provider, language) => invoke('generate', source, count, provider, language),
  cancelGeneration: () => invoke('cancelGeneration'),
  accounts: () => invoke('accounts'),
  connectAccount: key => invoke('connectAccount', key),
  publishClip: (id, platforms, details) => invoke('publishClip', id, platforms, details),
  onLog: callback => listen('studio:log', callback),
  onLibraryChanged: callback => listen('studio:library-changed', callback)
});
