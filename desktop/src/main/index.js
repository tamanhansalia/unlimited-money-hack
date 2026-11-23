const { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, safeStorage, session, shell } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');
const { createLibrary, mediaResponse } = require('./library');
const { createGenerationQueue } = require('./generation');
const { createAutomation } = require('./automation');
const { createPublishing } = require('./publishing');
const { resolveSources } = require('./source-info');
const runFile = promisify(execFile);

// Root of the desktop package: desktop/ in development, app.asar when packaged.
const appRoot = path.resolve(__dirname, '..', '..');
// PIXELHACK_DIST lets development builds be tested from a separate output folder. Ignored in packaged builds.
const index = !app.isPackaged && process.env.PIXELHACK_DIST
  ? path.join(path.resolve(process.env.PIXELHACK_DIST), 'index.html')
  : path.join(appRoot, 'dist', 'index.html');
// The Python engine folder: a sibling of desktop/ in the repository, or a folder near the packaged executable.
const engineName = 'engine';
const sources = new Set();
const publishingIds = new Set();
const videoExtensions = ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi', 'mpeg', 'mpg'];
const validProviderId = id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(id);
const externalHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'zernio.com', 'www.zernio.com', 'docs.zernio.com']);
// Height of the title bar strip the renderer draws (.titlebar in src/renderer/styles/shell.css reads it back as
// env(titlebar-area-height)). Each OS centres its window controls in it.
const titleBarHeight = 32;
let activeWindow;
const automatedJobs = new Map();
const generation = createGenerationQueue({
  onStart: id => {
    const job = automatedJobs.get(id);
    if (job) {
      job.startedAt = Date.now();
      sendToWindow('studio:automated-job', job);
    } else sendToWindow('studio:generation-started', id);
  },
  onLog: (id, chunk) => {
    const job = automatedJobs.get(id);
    if (job) job.log = (job.log + chunk).slice(-20000);
    sendToWindow('studio:log', id, chunk);
    automation?.onJobLog(id, chunk);
  }
});
let automation;
let deletion;
let stopWatching;

// The app used to be called ViralClip Studio. On the first launch under the new name, move that version's data
// folder (settings, publishing profiles, Autopilot, caches) into the new one. Chromium writes "Local State" there
// only after it has run once, so its absence means nothing of the new app's would be overwritten.
function adoptPreviousUserData() {
  const current = app.getPath('userData');
  const previous = path.join(app.getPath('appData'), 'ViralClip Studio');
  if (current === previous || !fs.existsSync(previous) || fs.existsSync(path.join(current, 'Local State'))) return;
  try {
    fs.mkdirSync(current, { recursive: true });
    for (const name of fs.readdirSync(previous)) {
      if (!fs.existsSync(path.join(current, name))) fs.renameSync(path.join(previous, name), path.join(current, name));
    }
  } catch (error) {
    console.error('Could not move data from the ViralClip Studio folder:', error.message);
    return;
  }
  try { fs.rmdirSync(previous); } catch { /* Something was left behind; keep the folder. */ }
}

// Test instances can run next to the real app with their own settings.
// This must happen before the single-instance lock, which is keyed on this folder.
if (process.env.PIXELHACK_USER_DATA) app.setPath('userData', path.resolve(process.env.PIXELHACK_USER_DATA));
else adoptPreviousUserData();

protocol.registerSchemesAsPrivileged([{
  scheme: 'clip-media',
  privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true }
}]);

function findEngine() {
  if (process.env.PIXELHACK_ENGINE_DIR) return path.resolve(process.env.PIXELHACK_ENGINE_DIR);
  if (!app.isPackaged) return path.resolve(appRoot, '..', engineName);
  for (const start of [process.env.PORTABLE_EXECUTABLE_DIR, path.dirname(app.getPath('exe'))].filter(Boolean)) {
    let current = start;
    for (let depth = 0; depth <= 3; depth++) {
      const candidate = path.join(current, engineName);
      if (fs.existsSync(path.join(candidate, 'autoclipper.py'))) return candidate;
      current = path.dirname(current);
    }
  }
  return path.join(app.getPath('userData'), 'engine');
}

function isYouTubeVideo(source) {
  try {
    const url = new URL(source);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return false;
    const videoId = /^[\w-]{11}$/;
    if (url.hostname === 'youtu.be') return videoId.test(url.pathname.slice(1).replace(/\/$/, ''));
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname)) return false;
    return (url.pathname === '/watch' && videoId.test(url.searchParams.get('v') || '')) ||
      /^\/(shorts|live|embed)\/[\w-]{11}\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

// Returns the normalised address of a link the app may open in the browser, or throws.
function externalUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Enter a valid web address.');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid web address that starts with https://.');
  }
  const trustedHost = externalHosts.has(url.hostname);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !trustedHost) {
    throw new Error('Only https links to YouTube or Zernio can be opened from 2PixelHack.');
  }
  return url.href;
}

function sendToWindow(channel, ...args) {
  if (!activeWindow || activeWindow.isDestroyed() || activeWindow.webContents.isDestroyed()) return;
  activeWindow.webContents.send(channel, ...args);
}

function generatorRuntime(engineDir) {
  const scripts = app.isPackaged
    ? [path.join(process.resourcesPath, 'engine', 'autoclipper.py')]
    : [path.join(engineDir, 'autoclipper.py'), path.resolve(appRoot, '..', engineName, 'autoclipper.py')];
  const script = scripts.find(file => fs.existsSync(file));
  if (!script) throw new Error('The clip generator could not be found.');
  const pythonSubpath = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  const virtualPython = ['venv', '.venv'].map(dir => path.join(engineDir, dir, ...pythonSubpath)).find(file => fs.existsSync(file));
  const python = virtualPython || (process.platform === 'win32' ? 'python' : 'python3');
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  if (virtualPython) {
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
    env[pathKey] = path.dirname(virtualPython) + path.delimiter + (env[pathKey] || '');
  }
  return { python, script, env };
}

function checkedSource(source) {
  if (typeof source !== 'string') throw new Error('Choose a video or enter a YouTube video URL.');
  source = source.trim();
  if (isYouTubeVideo(source) || (sources.has(source) && fs.statSync(source, { throwIfNoEntry: false })?.isFile())) return source;
  throw new Error('Use a YouTube video link or choose a local video file.');
}

function generate(engineDir, readyDir, jobId, source, count, provider, language, seoProvider = provider, length = 'auto', options = {}) {
  if (count !== 'auto' && (!Number.isInteger(count) || count < 1 || count > 10)) {
    throw new Error('Choose Auto or enter a clip count from 1 to 10.');
  }
  source = checkedSource(source);
  if (!validProviderId(provider) || !['hi', 'en', 'auto'].includes(language)) {
    throw new Error('Choose a generation CLI and a source language.');
  }
  if (!validProviderId(seoProvider)) throw new Error('Choose an SEO CLI.');
  const { python, script, env } = generatorRuntime(engineDir);
  const presets = require(path.join(path.dirname(script), 'generation-presets.json'));
  if (typeof length !== 'string' || !Object.hasOwn(presets.lengths, length)) throw new Error('Choose a clip length.');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid generation settings.');
  if (options.mode !== undefined && !['auto', 'manual'].includes(options.mode)) throw new Error('Choose a clip mode.');
  if (options.mode === 'manual' && (!Array.isArray(options.ranges) || options.ranges.length !== count ||
      options.ranges.some(pair => !Array.isArray(pair) || pair.length !== 2 || !pair.every(Number.isSafeInteger) || pair[0] < 0 || pair[0] >= pair[1]))) {
    throw new Error('Enter valid start and end times for each manual clip.');
  }
  if (options.layout !== undefined && !presets.layouts.includes(options.layout)) throw new Error('Choose a layout.');
  if (options.orientation !== undefined && !presets.orientations.includes(options.orientation)) throw new Error('Choose a source orientation.');
  if (options.subtitles !== undefined && !presets.subtitles.some(style => style.id === options.subtitles)) throw new Error('Choose a subtitle style.');
  const serialized = JSON.stringify(options);
  if (serialized.length > 4096) throw new Error('Invalid generation settings.');
  const args = ['-u', script, source, '--provider', provider, '--source-language', language,
    '--clips', String(count), '--length', length, '--job-id', jobId, '--output-dir', path.join(engineDir, 'output'), '--options', serialized];
  if (seoProvider !== provider) args.push('--seo-provider', seoProvider);
  return generation.submit(jobId, { python, args, cwd: engineDir, env, readyDir });
}

async function inspectSource(engineDir, source, previewAt) {
  source = checkedSource(source);
  if (previewAt !== undefined && (!Number.isFinite(previewAt) || previewAt < 0)) throw new Error('Choose a valid preview time.');
  const { python, script, env } = generatorRuntime(engineDir);
  const args = [script, '--inspect-source'];
  if (previewAt !== undefined) args.push('--preview-at', String(previewAt));
  try {
    const { stdout } = await runFile(python, [...args, source], { cwd: engineDir, env, windowsHide: true, timeout: 25000 });
    return JSON.parse(stdout);
  } catch (error) {
    const detail = error.stderr?.trim().split('\n').filter(Boolean).at(-1)?.replace(/^ERROR:\s*/i, '');
    throw new Error(detail || 'Could not read the source video.');
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 760, minHeight: 560,
    backgroundColor: '#000000', autoHideMenuBar: true, show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#f4f4f4', height: titleBarHeight },
    icon: path.join(appRoot, 'resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: { preload: path.join(appRoot, 'src', 'preload', 'index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  activeWindow = win;
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.once('ready-to-show', () => win.show());
  void automation?.resume().catch(error => console.error('Could not resume Autopilot:', error));
  let closeAfterDeletion = false;
  win.on('close', event => {
    if (deletion) {
      event.preventDefault();
      if (!closeAfterDeletion) {
        closeAfterDeletion = true;
        const close = () => {
          closeAfterDeletion = false;
          if (!win.isDestroyed()) win.close();
        };
        deletion.done.then(close, close);
      }
      return;
    }
    const autopilot = automation?.active();
    if (generation.size || publishingIds.size || autopilot) {
      const [message, detail] = publishingIds.size
        ? ['A clip is being published.', 'If you quit now, check the post in Zernio before trying again.']
        : generation.size
          ? ['Clip generation is in progress.', 'Quitting will stop running and queued jobs.' + (autopilot ? ' Autopilot resumes when you open 2PixelHack again.' : '')]
          : ['Autopilot is on.', 'Quitting pauses Autopilot. It resumes when you open 2PixelHack again.'];
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question', buttons: ['Keep 2PixelHack open', 'Quit 2PixelHack'], defaultId: 0, cancelId: 0, message, detail
      });
      if (choice === 0) event.preventDefault();
    }
  });
  win.once('closed', () => { activeWindow = undefined; sources.clear(); });
  win.loadFile(index).catch(error => dialog.showErrorBox('Could not open 2PixelHack', error.message));
}

// The renderer is a hash-routed single page, so its frame URL is index.html plus a "#/..." fragment.
const indexUrl = pathToFileURL(index).href;
function isAppUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = '';
    url.search = '';
    return url.href === indexUrl;
  } catch { return false; }
}

// Ranks channel uploads and searches for Autopilot. The engine prints one JSON object.
async function findVideos(engineDir, options, { signal, onProgress }) {
  const { python, script, env } = generatorRuntime(engineDir);
  const result = runFile(python, ['-u', script, '--find-videos', '--options', JSON.stringify(options)], {
    cwd: engineDir, env, windowsHide: true, signal, killSignal: 'SIGKILL', timeout: 90_000, maxBuffer: 8 * 1024 * 1024
  });
  const lines = createInterface({ input: result.child.stderr });
  lines.on('line', line => {
    if (line.startsWith('Finder progress: ')) onProgress(line.slice(17));
  });
  try {
    const { stdout } = await result;
    return JSON.parse(stdout);
  } catch (error) {
    if (signal.aborted) throw new Error('Search cancelled.');
    if (error.killed) throw new Error('Searching YouTube took too long. Try fewer searches or use channel links.');
    const detail = error.stderr?.split('\n').findLast(line => line.startsWith('ERROR: '));
    throw new Error(detail || 'Could not search YouTube. Check your connection and try again.');
  } finally {
    lines.close();
  }
}

// Clips being published are locked against moves and deletion, whoever started the post.
async function guardedPublish(id, publish) {
  if (publishingIds.has(id)) throw new Error('This clip is already being published.');
  if (deletion?.ids.has(id)) throw new Error('This clip is being moved to Trash.');
  publishingIds.add(id);
  try { return await publish(); }
  finally { publishingIds.delete(id); }
}

function registerHandlers(engineDir, library) {
  const { publishClip, ...publishing } = createPublishing({ engineDir, storage: app.getPath('userData'), safeStorage, ...library });
  protocol.handle('clip-media', request => mediaResponse(request, library.resolveVideo));
  let presets = { lengths: {}, subtitles: [] };
  try {
    presets = require(path.join(path.dirname(generatorRuntime(engineDir).script), 'generation-presets.json'));
  } catch (error) {
    console.warn('Autopilot could not load the generation presets:', error.message);
  }
  automation = createAutomation({
    storage: app.getPath('userData'), presets,
    findVideos: (options, controls) => findVideos(engineDir, options, controls),
    async generate(id, source, count, provider, language, seoProvider, length, options, { label, autopilot }) {
      const job = {
        id, kind: 'url', source, label, autopilot, count, provider, language, seoProvider, length, options,
        queuedAt: Date.now(), startedAt: 0, endedAt: 0, log: '', error: ''
      };
      automatedJobs.set(id, job);
      sendToWindow('studio:automated-job', job);
      try {
        return await generate(engineDir, library.folder('ready'), id, source, count, provider, language, seoProvider, length, options);
      } catch (error) {
        job.error = error.message || String(error);
        throw error;
      } finally {
        job.endedAt = Date.now();
        sendToWindow('studio:automated-job', job);
      }
    },
    cancel: jobId => generation.cancel(jobId),
    listClips: () => library.listClips(),
    accounts: () => publishing.accounts(),
    publish: (id, platforms, details, profileId, scheduleDate, connectionId) =>
      guardedPublish(id, () => publishClip(id, platforms, details, profileId, connectionId, { scheduleDate, automated: true })),
    notify: snapshot => sendToWindow('studio:autopilot', snapshot)
  });
  const methods = {
    async listClips() {
      if (deletion) await deletion.done.catch(() => {});
      return library.listClips();
    },
    async openFolder(status) {
      const error = await shell.openPath(library.folder(status));
      if (error) throw new Error(error);
    },
    revealClip(id, status) {
      // resolveVideo rejects anything that is not a known status and a plain clip id.
      shell.showItemInFolder(library.resolveVideo(id, status));
    },
    async openExternal(url) {
      await shell.openExternal(externalUrl(url));
    },
    resolveSources(ids) {
      if (!Array.isArray(ids)) throw new Error('Invalid video list.');
      return resolveSources(ids);
    },
    moveClip(id, from, to) {
      if (publishingIds.has(id)) throw new Error('This clip is being published.');
      if (deletion?.ids.has(id)) throw new Error('This clip is being moved to Trash.');
      return library.moveClip(id, from, to);
    },
    async deleteClips(targets, sourceKey = null) {
      if (!Array.isArray(targets) || !targets.length || targets.some(clip => typeof clip?.id !== 'string')) {
        throw new Error('Invalid clip selection.');
      }
      if (deletion) throw new Error('A deletion is already in progress.');
      const ids = new Set(targets.map(clip => clip.id));
      if ([...ids].some(id => publishingIds.has(id))) throw new Error('Wait for publishing to finish, then try again.');
      const done = library.trashClips(targets, sourceKey, file => shell.trashItem(file));
      deletion = { ids, done };
      try { await done; }
      finally { deletion = undefined; }
    },
    async chooseVideo() {
      const { canceled, filePaths } = await dialog.showOpenDialog(activeWindow, {
        title: 'Choose a video', properties: ['openFile'], filters: [{ name: 'Video files', extensions: videoExtensions }]
      });
      if (canceled || !filePaths.length) return null;
      const file = filePaths[0];
      if (!videoExtensions.includes(path.extname(file).slice(1).toLowerCase())) throw new Error('Choose a supported video file.');
      sources.add(file);
      return file;
    },
    async listClis() {
      const { python, script, env } = generatorRuntime(engineDir);
      const { stdout } = await runFile(python, [script, '--list-clis'], {
        cwd: engineDir, env, windowsHide: true, timeout: 15000
      });
      return JSON.parse(stdout);
    },
    async testCli(provider) {
      if (!validProviderId(provider)) throw new Error('Choose an AI CLI to test.');
      const { python, script, env } = generatorRuntime(engineDir);
      try {
        await runFile(python, [script, '--test-cli', provider], {
          cwd: engineDir, env, windowsHide: true, timeout: 50000
        });
      } catch (error) {
        const message = error.stderr?.trim();
        throw new Error(message && !message.includes('\n') ? message : 'Could not test the selected AI CLI.');
      }
    },
    inspectSource: (source, previewAt) => inspectSource(engineDir, source, previewAt),
    generate(jobId, source, count, provider, language, seoProvider, length, options) {
      return generate(engineDir, library.folder('ready'), jobId, source, count, provider, language, seoProvider, length, options);
    },
    cancelGeneration: jobId => !automatedJobs.has(jobId) && generation.cancel(jobId),
    automatedJobs: () => Array.from(automatedJobs.values()),
    dismissAutomatedJob: jobId => {
      if (automatedJobs.get(jobId)?.endedAt) automatedJobs.delete(jobId);
    },
    ...publishing,
    async publishClip(id, platforms, details, profileId, connectionId) {
      if (typeof id !== 'string' || !Array.isArray(platforms) || typeof details !== 'object' || details === null) {
        throw new Error('The publish request is incomplete.');
      }
      return guardedPublish(id, () => publishClip(id, platforms, details, profileId, connectionId));
    },
    autopilotList: () => automation.list(),
    autopilotSave: profile => automation.save(profile),
    autopilotRemove: id => automation.remove(String(id)),
    autopilotStart: id => automation.start(String(id)),
    autopilotStop: id => automation.stop(String(id))
  };
  for (const [name, handler] of Object.entries(methods)) {
    ipcMain.handle('studio:' + name, (event, ...args) => {
      if (!activeWindow || event.sender !== activeWindow.webContents ||
          event.senderFrame !== event.sender.mainFrame || !isAppUrl(event.senderFrame.url)) {
        throw new Error('The 2PixelHack window must be open.');
      }
      return handler(...args);
    });
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (activeWindow?.isMinimized()) activeWindow.restore();
    activeWindow?.focus();
  });
  app.whenReady().then(() => {
    // Packaged macOS builds get the icon from the app bundle; development runs show Electron's icon otherwise.
    if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(path.join(appRoot, 'resources', 'icon.png'));
    nativeTheme.themeSource = 'dark';
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
    const engineDir = findEngine();
    const library = createLibrary(engineDir);
    registerHandlers(engineDir, library);
    createWindow();
    stopWatching = library.watch(() => sendToWindow('studio:library-changed'));
  });
  // Closing the last window ends the session on every platform.
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    stopWatching?.();
    automation?.suspend();
    generation.stopAll();
  });
}
