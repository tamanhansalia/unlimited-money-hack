const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { test } = require('node:test');
const { createGenerationQueue } = require('../src/main/generation');

const engine = `
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const [id, ready] = process.argv.slice(1);
fs.mkdirSync(path.join(ready, '.render-' + id + '-fixture'));
console.log('Temp ' + os.tmpdir());
console.log('Source ' + id);
const timer = setInterval(() => {
  if (fs.existsSync(path.join(ready, 'finish-' + id))) clearInterval(timer);
}, 20);
`;

async function setup(t, options) {
  const readyDir = await fs.mkdtemp(path.join(os.tmpdir(), '2pixelhack-queue-test-'));
  const started = [];
  const logs = new Map();
  const queue = createGenerationQueue({
    onStart: id => started.push(id),
    onLog: (id, chunk) => logs.set(id, (logs.get(id) || '') + chunk),
    ...options
  });
  t.after(async () => {
    queue.stopAll();
    await fs.rm(readyDir, { recursive: true, force: true });
  });
  const submit = (id, script = engine) => queue.submit(id, {
    cwd: readyDir, readyDir, env: process.env,
    python: process.execPath, args: ['-e', script, id, readyDir]
  });
  const finish = id => fs.writeFile(path.join(readyDir, 'finish-' + id), '');
  return { queue, submit, finish, readyDir, started, logs };
}

test('an unresponsive engine fails and releases its queue slot', { timeout: 10000 }, async t => {
  const { queue, submit, started } = await setup(t, { idleMs: 800 });
  const [first, second, next] = ['a', 'b', 'c'].map(value => value.repeat(32));
  const stall = 'setInterval(() => {}, 100)';
  const failures = [first, second].map(id => assert.rejects(submit(id, stall), /engine stopped responding/));
  const done = submit(next, 'console.log("Finished");');
  assert.deepEqual(started, [first, second]);
  await Promise.all(failures);
  assert.equal(await done, next);
  assert.equal(queue.size, 0);
});

async function until(check) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for a job update.');
    await sleep(20);
  }
}

test('runs two jobs, cancels by ID, and starts the next queued job', { timeout: 10000 }, async t => {
  const { queue, submit, finish, readyDir, started, logs } = await setup(t);
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(char => char.repeat(32));
  const stoppedA = assert.rejects(submit(a), /CANCELLED/);
  const doneB = submit(b);
  const stoppedC = assert.rejects(submit(c), /CANCELLED/);
  const doneD = submit(d);
  doneB.catch(() => {});
  doneD.catch(() => {});
  assert.deepEqual(started, [a, b]);
  assert.equal(await queue.cancel(c), true);
  await stoppedC;
  assert.deepEqual(started, [a, b]);

  await until(() => logs.get(a)?.includes('Source ' + a) && logs.get(b)?.includes('Source ' + b));
  const tempA = logs.get(a).split('\n')[0].slice('Temp '.length);
  assert.equal(await queue.cancel(a), true);
  await stoppedA;
  await until(() => logs.get(d)?.includes('Source ' + d));
  assert.deepEqual(started, [a, b, d]);
  assert.ok(!logs.get(a).includes(b));
  await assert.rejects(fs.stat(path.join(readyDir, '.render-' + a + '-fixture')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(tempA), { code: 'ENOENT' });
  await fs.access(path.join(readyDir, '.render-' + b + '-fixture'));

  await finish(b);
  await finish(d);
  assert.equal(await doneB, b);
  assert.equal(await doneD, d);
  assert.equal(queue.size, 0);
});

test('stops active and queued jobs during shutdown without starting the queue', { timeout: 10000 }, async t => {
  const { queue, submit, started } = await setup(t);
  const ids = ['a', 'b', 'c'].map(char => char.repeat(32));
  const outcomes = ids.map(id => assert.rejects(submit(id), /CANCELLED/));
  queue.stopAll();
  await Promise.all(outcomes);
  assert.deepEqual(started, ids.slice(0, 2));
  assert.equal(queue.size, 0);
});

test('stopping a running job also stops an engine subprocess', { timeout: 10000 }, async t => {
  const { queue, submit, readyDir } = await setup(t);
  const script = `
const { spawn } = require('node:child_process');
const worker = \`
  const fs = require('node:fs');
  fs.writeFileSync('worker-started', '');
  setTimeout(() => fs.writeFileSync('worker-finished', ''), 750);
\`;
spawn(process.execPath, ['-e', worker], { stdio: 'ignore' });
setInterval(() => {}, 100);
`;
  const id = 'a'.repeat(32);
  const stopped = assert.rejects(submit(id, script), /CANCELLED/);
  await until(() => existsSync(path.join(readyDir, 'worker-started')));
  assert.equal(await queue.cancel(id), true);
  await stopped;
  await sleep(800);
  assert.equal(existsSync(path.join(readyDir, 'worker-finished')), false);
});
