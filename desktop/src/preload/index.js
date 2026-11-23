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
  deleteClips: (clips, sourceKey) => invoke('deleteClips', clips, sourceKey),
  openFolder: status => invoke('openFolder', status),
  revealClip: (id, status) => invoke('revealClip', id, status),
  openExternal: url => invoke('openExternal', url),
  resolveSources: ids => invoke('resolveSources', ids),
  chooseVideo: () => invoke('chooseVideo'),
  inspectSource: (source, previewAt) => invoke('inspectSource', source, previewAt),
  listClis: () => invoke('listClis'),
  testCli: provider => invoke('testCli', provider),
  generate: (...args) => invoke('generate', ...args),
  cancelGeneration: id => invoke('cancelGeneration', id),
  automatedJobs: () => invoke('automatedJobs'),
  dismissAutomatedJob: id => invoke('dismissAutomatedJob', id),
  accounts: () => invoke('accounts'),
  addProfile: (name, key, zernioProfileId) => invoke('addProfile', name, key, zernioProfileId),
  selectProfile: id => invoke('selectProfile', id),
  renameProfile: (id, name) => invoke('renameProfile', id, name),
  removeProfile: id => invoke('removeProfile', id),
  verifyProfile: id => invoke('verifyProfile', id),
  updateProfileKeys: (id, key, zernioProfileId) => invoke('updateProfileKeys', id, key, zernioProfileId),
  zernioProfiles: key => invoke('zernioProfiles', key),
  publishClip: (id, platforms, details, profileId, connectionId) => invoke('publishClip', id, platforms, details, profileId, connectionId),
  autopilotList: () => invoke('autopilotList'),
  autopilotSave: profile => invoke('autopilotSave', profile),
  autopilotRemove: id => invoke('autopilotRemove', id),
  autopilotStart: id => invoke('autopilotStart', id),
  autopilotStop: id => invoke('autopilotStop', id),
  onAutopilot: callback => listen('studio:autopilot', callback),
  onAutomatedJob: callback => listen('studio:automated-job', callback),
  onLog: callback => listen('studio:log', callback),
  onGenerationStarted: callback => listen('studio:generation-started', callback),
  onLibraryChanged: callback => listen('studio:library-changed', callback)
});
