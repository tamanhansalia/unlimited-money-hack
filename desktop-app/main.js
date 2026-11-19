const { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, session, shell } = require('electron');
const { execFile, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createLibrary, mediaResponse } = require('./library');
const { createPublishing } = require('./publishing');
const { resolveSources } = require('./source-info');

// VIRALCLIP_DIST lets development builds be tested from a separate output folder. Ignored in packaged builds.
const index = !app.isPackaged && process.env.VIRALCLIP_DIST
  ? path.join(path.resolve(process.env.VIRALCLIP_DIST), 'index.html')
  : path.join(__dirname, 'dist', 'index.html');
const engineName = 'AI-Youtube-Shorts-Generator';
const sources = new Set();
const publishingIds = new Set();
const videoExtensions = ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi', 'mpeg', 'mpg'];
const externalHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'ayrshare.com']);
const titleBarHeight = 48;
let activeWindow;
let generation;
let stopWatching;

// Test instances can run next to the real app with their own settings.
// This must happen before the single-instance lock, which is keyed on this folder.
if (process.env.VIRALCLIP_USER_DATA) app.setPath('userData', path.resolve(process.env.VIRALCLIP_USER_DATA));

protocol.registerSchemesAsPrivileged([{
  scheme: 'clip-media',
  privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true }
}]);

function findEngine() {
  if (process.env.VIRALCLIP_ENGINE_DIR) return path.resolve(process.env.VIRALCLIP_ENGINE_DIR);
  if (!app.isPackaged) return path.resolve(__dirname, '..', engineName);
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

// Returns the normalised address of a link the studio may open in the browser, or throws.
function externalUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Enter a valid web address.');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid web address that starts with https://.');
  }
  const trustedHost = externalHosts.has(url.hostname) || url.hostname.endsWith('.ayrshare.com');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !trustedHost) {
    throw new Error('Only https links to YouTube or Ayrshare can be opened from the studio.');
  }
  return url.href;
}

function sendToWindow(channel, ...args) {
  if (!activeWindow || activeWindow.isDestroyed() || activeWindow.webContents.isDestroyed()) return;
  activeWindow.webContents.send(channel, ...args);
}

// Ends the generator and everything it started (ffmpeg, yt-dlp). The pid is a number
// and no shell is involved, so nothing from the renderer reaches the command line.
function killTree(child, sync) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32' || !child.pid) {
    child.kill();
    return;
  }
  const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
  const args = ['/pid', String(child.pid), '/t', '/f'];
  const options = { windowsHide: true, stdio: 'ignore' };
  if (sync) {
    if (spawnSync(taskkill, args, options).error) child.kill();
  } else {
    spawn(taskkill, args, options).once('error', () => child.kill());
  }
}

// A killed generator cannot clean up its temporary render folder, which holds the downloaded source.
function removeAbandonedRenders(readyDir, since) {
  try {
    for (const entry of fs.readdirSync(readyDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('.render-')) continue;
      const dir = path.join(readyDir, entry.name);
      try {
        const stat = fs.statSync(dir);
        if ((stat.birthtimeMs || stat.mtimeMs) >= since - 1000) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        // Leftover temporary files are harmless; they are not shown in the library.
      }
    }
  } catch {
    // The library folder is validated elsewhere.
  }
}

function stopGeneration({ sync = false } = {}) {
  const run = generation;
  if (!run) return false;
  if (!run.cancelled) {
    run.cancelled = true;
    killTree(run.child, sync);
    if (sync) removeAbandonedRenders(run.readyDir, run.startedAt);
  }
  return true;
}

function generatorRuntime(engineDir) {
  const scripts = app.isPackaged
    ? [path.join(process.resourcesPath, 'engine', 'autoclipper.py')]
    : [path.join(engineDir, 'autoclipper.py'), path.resolve(__dirname, '..', engineName, 'autoclipper.py')];
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

async function generate(engineDir, readyDir, source, count, provider, language) {
  if (generation) throw new Error('A video is already being processed.');
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('Choose between 1 and 10 clips.');
  if (typeof source !== 'string') throw new Error('Choose a video or enter a YouTube video URL.');
  source = source.trim();
  if (!isYouTubeVideo(source) && !(sources.has(source) && fs.statSync(source, { throwIfNoEntry: false })?.isFile())) {
    throw new Error('Use a YouTube video link or choose a local video file.');
  }
  if (!['claude', 'codex', 'gemini'].includes(provider) || !['hi', 'en', 'auto'].includes(language)) {
    throw new Error('Choose an AI CLI and a source language.');
  }
  const { python, script, env } = generatorRuntime(engineDir);
  const startedAt = Date.now();
  const child = spawn(python, ['-u', script, source, '--provider', provider, '--source-language', language, '--clips', String(count), '--output-dir', path.join(engineDir, 'output')], {
    cwd: engineDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  const run = { child, readyDir, startedAt, cancelled: false };
  generation = run;
  try {
    await new Promise((resolve, reject) => {
      let tail = '';
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding('utf8');
        stream.on('data', chunk => {
          tail = (tail + chunk).slice(-3000);
          sendToWindow('studio:log', chunk);
        });
      }
      child.once('error', error => reject(error.code === 'ENOENT' ? new Error('Python could not be started. Install Python or configure the generator environment.') : error));
      child.once('close', code => {
        if (code === 0) resolve();
        else if (run.cancelled) reject(new Error('CANCELLED'));
        else reject(new Error(tail.trim() || 'The generator stopped before completing.'));
      });
    });
  } finally {
    generation = undefined;
    if (run.cancelled) removeAbandonedRenders(readyDir, startedAt);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 760, minHeight: 560,
    backgroundColor: '#000000', autoHideMenuBar: true, show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#f4f4f4', height: titleBarHeight },
    icon: path.join(__dirname, 'assets', 'studio.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  activeWindow = win;
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.once('ready-to-show', () => win.show());
  win.on('close', event => {
    if (generation || publishingIds.size) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question', buttons: ['Keep studio open', 'Quit studio'], defaultId: 0, cancelId: 0,
        message: generation ? 'Clip generation is in progress.' : 'A clip is being published.',
        detail: generation ? 'Quitting will interrupt the current job.' : 'If you quit now, check the post in Ayrshare before trying again.'
      });
      if (choice === 0) event.preventDefault();
      else stopGeneration({ sync: true });
    }
  });
  win.once('closed', () => { activeWindow = undefined; sources.clear(); });
  win.loadFile(index).catch(error => dialog.showErrorBox('Could not open ViralClip Studio', error.message));
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

function registerHandlers(engineDir, library) {
  const publishing = createPublishing({ engineDir, ...library });
  protocol.handle('clip-media', request => mediaResponse(request, library.resolveVideo));
  const methods = {
    listClips: () => library.listClips(),
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
      return library.moveClip(id, from, to);
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
      const { stdout } = await require('node:util').promisify(execFile)(python, [script, '--list-clis'], {
        cwd: engineDir, env, windowsHide: true, timeout: 15000
      });
      return JSON.parse(stdout);
    },
    generate(source, count, provider, language) {
      return generate(engineDir, library.folder('ready'), source, count, provider, language);
    },
    cancelGeneration: () => stopGeneration(),
    accounts: publishing.accounts,
    connectAccount: publishing.connectAccount,
    async publishClip(id, platforms, details) {
      if (typeof id !== 'string' || !Array.isArray(platforms) || typeof details !== 'object' || details === null) {
        throw new Error('The publish request is incomplete.');
      }
      if (publishingIds.has(id)) throw new Error('This clip is already being published.');
      publishingIds.add(id);
      try { return await publishing.publishClip(id, platforms, details); }
      finally { publishingIds.delete(id); }
    }
  };
  for (const [name, handler] of Object.entries(methods)) {
    ipcMain.handle('studio:' + name, (event, ...args) => {
      if (!activeWindow || event.sender !== activeWindow.webContents ||
          event.senderFrame !== event.sender.mainFrame || !isAppUrl(event.senderFrame.url)) {
        throw new Error('The studio window must be open.');
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
    nativeTheme.themeSource = 'dark';
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
    const engineDir = findEngine();
    const library = createLibrary(engineDir);
    registerHandlers(engineDir, library);
    createWindow();
    stopWatching = library.watch(() => sendToWindow('studio:library-changed'));
    app.on('activate', () => { if (!activeWindow) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('will-quit', () => {
    stopWatching?.();
    stopGeneration({ sync: true });
  });
}
