const { execFile, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const runFile = promisify(execFile);
const MAX_RUNNING = 2;
const ENGINE_IDLE_MS = 30 * 60_000;

function killGroup(child) {
  if (!child.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
const taskkillArgs = child => ['/pid', String(child.pid), '/t', '/f'];
const stillRunning = child => child.exitCode === null && child.signalCode === null;

async function terminate(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await runFile(taskkill, taskkillArgs(child), { windowsHide: true, timeout: 10000 });
  } else {
    killGroup(child);
  }
}

function cleanWork(run) {
  const remove = file => fs.rmSync(file, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  try {
    if (run.temp) remove(run.temp);
    for (const entry of fs.readdirSync(run.readyDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(`.render-${run.id}-`)) {
        remove(path.join(run.readyDir, entry.name));
      }
    }
  } catch (error) {
    console.warn('Could not remove temporary clip files:', error.message);
  }
}

function createGenerationQueue({ onStart, onLog, idleMs = ENGINE_IDLE_MS }) {
  const jobs = new Map();
  let running = 0;

  function pump() {
    for (const run of jobs.values()) {
      if (running >= MAX_RUNNING) break;
      if (!run.child) start(run);
    }
  }

  function settle(run, error) {
    if (run.child) running--;
    jobs.delete(run.id);
    if (error) run.reject(error);
    else run.resolve(run.id);
  }

  function start(run) {
    let child;
    try {
      run.temp = fs.mkdtempSync(path.join(os.tmpdir(), '2pixelhack-job-'));
      child = spawn(run.python, run.args, {
        cwd: run.cwd, env: { ...run.env, TMPDIR: run.temp, TMP: run.temp, TEMP: run.temp },
        windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      cleanWork(run);
      settle(run, error);
      return;
    }
    run.child = child;
    running++;

    let tail = '';
    let spawnError;
    let stalled = false;
    const watchdog = setTimeout(async () => {
      stalled = true;
      try { await terminate(child); }
      catch (error) {
        console.warn('Could not stop the stalled generator process tree:', error.message);
        if (stillRunning(child)) child.kill('SIGKILL');
      }
      // A leftover subprocess can hold the pipes open after the generator exits.
      child.stdout.destroy();
      child.stderr.destroy();
    }, idleMs);
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        if (!stalled) watchdog.refresh();
        tail = (tail + chunk).slice(-3000);
        onLog(run.id, chunk);
      });
    }
    child.once('error', error => {
      spawnError = error.code === 'ENOENT'
        ? new Error('Python could not be started. Install Python or configure the generator environment.')
        : error;
    });
    child.once('close', code => {
      clearTimeout(watchdog);
      cleanWork(run);
      const error = run.cancelled ? new Error('CANCELLED')
        : stalled ? new Error('The clip engine stopped responding. Try again with the same settings.')
          : code === 0 ? null : spawnError || new Error(tail.trim() || 'The generator stopped before completing.');
      settle(run, error);
      pump();
    });
    onStart(run.id);
  }

  function submit(id, options) {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id) || jobs.has(id)) {
      throw new Error('Invalid or duplicate generation job ID.');
    }
    return new Promise((resolve, reject) => {
      jobs.set(id, { ...options, id, resolve, reject });
      pump();
    });
  }

  async function cancel(id) {
    const run = jobs.get(id);
    if (!run) return false;
    const { child } = run;
    if (!child) {
      settle(run, new Error('CANCELLED'));
      return true;
    }
    if (run.cancelled) return true;
    if (!child.pid || !stillRunning(child)) return false;
    run.cancelled = true;
    try {
      await terminate(child);
      return true;
    } catch (error) {
      if (!stillRunning(child)) return true;
      run.cancelled = false;
      throw error;
    }
  }

  function stopAll() {
    for (const run of jobs.values()) {
      const { child } = run;
      if (!child) {
        settle(run, new Error('CANCELLED'));
        continue;
      }
      run.cancelled = true;
      try {
        if (process.platform !== 'win32') killGroup(child);
        else if (child.pid && stillRunning(child)) {
          const options = { windowsHide: true, stdio: 'ignore', timeout: 5000 };
          if (spawnSync(taskkill, taskkillArgs(child), options).status !== 0) child.kill();
        }
      } catch (error) {
        console.warn('Could not stop generation:', error.message);
      }
      cleanWork(run);
    }
  }

  return { submit, cancel, stopAll, get size() { return jobs.size; } };
}

module.exports = { createGenerationQueue };
