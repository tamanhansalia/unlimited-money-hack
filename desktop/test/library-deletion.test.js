const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createLibrary } = require('../src/main/library');

async function setup(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), '2pixelhack-library-test-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const engine = path.join(workspace, 'engine');
  const library = createLibrary(engine);
  const trash = path.join(workspace, 'trash');
  const trashItem = bundle => fs.rename(bundle, trash);

  async function add(id, status, sourceKey, withMetadata = true) {
    const folder = library.folder(status);
    const video = path.join(folder, id + '.mp4');
    const metadata = path.join(folder, id + '_meta.json');
    await fs.writeFile(video, id);
    if (withMetadata) await fs.writeFile(metadata, JSON.stringify({ sourceKey }));
    return { video, metadata };
  }

  return { library, add, trash, trashItem };
}

test('removes only the selected clip and its sidecar', async t => {
  const { library, add, trash, trashItem } = await setup(t);
  const original = await add('clip_1', 'ready', 'file:one');
  await add('clip_2', 'ready', 'file:one');
  const target = (await library.listClips()).find(clip => clip.id === 'clip_1');

  await library.trashClips([target], null, trashItem);

  assert.deepEqual((await library.listClips()).map(clip => clip.id), ['clip_2']);
  await assert.rejects(fs.stat(original.video), { code: 'ENOENT' });
  await assert.rejects(fs.stat(original.metadata), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(path.join(trash, 'ready'))).sort(), ['clip_1.mp4', 'clip_1_meta.json']);
});

test('moves a source group across both statuses and accepts older clips without metadata', async t => {
  const { library, add, trash, trashItem } = await setup(t);
  await add('older_1', 'ready', null, false);
  await add('older_2', 'completed', 'legacy:older');
  await add('other_1', 'ready', 'file:other');
  const key = 'legacy:older';
  const targets = (await library.listClips()).filter(clip => clip.source.key === key);

  await library.trashClips(targets, key, trashItem);

  assert.deepEqual((await library.listClips()).map(clip => clip.id), ['other_1']);
  assert.deepEqual(await fs.readdir(path.join(trash, 'ready')), ['older_1.mp4']);
  assert.deepEqual((await fs.readdir(path.join(trash, 'completed'))).sort(), ['older_2.mp4', 'older_2_meta.json']);
});

test('rejects a group that gained a clip after confirmation', async t => {
  const { library, add, trash, trashItem } = await setup(t);
  const key = 'file:group';
  await add('clip_1', 'ready', key);
  const targets = await library.listClips();
  await add('clip_2', 'completed', key);

  await assert.rejects(library.trashClips(targets, key, trashItem), /selection changed/);
  assert.equal((await library.listClips()).length, 2);
  await assert.rejects(fs.stat(trash), { code: 'ENOENT' });
});

test('rejects a clip file that changed after confirmation', async t => {
  const { library, add, trash, trashItem } = await setup(t);
  const { video } = await add('clip_1', 'ready', 'file:one');
  const targets = await library.listClips();
  await fs.writeFile(video, 'replacement clip');

  await assert.rejects(library.trashClips(targets, null, trashItem), /selection changed/);
  assert.equal(await fs.readFile(video, 'utf8'), 'replacement clip');
  await assert.rejects(fs.stat(trash), { code: 'ENOENT' });
});

test('restores every video and sidecar if moving to Trash fails', async t => {
  const { library, add } = await setup(t);
  const key = 'file:group';
  const ready = await add('clip_1', 'ready', key);
  const completed = await add('clip_2', 'completed', key);
  const targets = await library.listClips();

  await assert.rejects(library.trashClips(targets, key, async bundle => {
    await assert.rejects(fs.stat(ready.video), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(bundle, 'completed', 'clip_2.mp4'), 'utf8'), 'clip_2');
    throw new Error('Trash is unavailable.');
  }), /Could not move the selection to Trash. Trash is unavailable/);

  for (const { video, metadata } of [ready, completed]) {
    assert.equal(await fs.readFile(video, 'utf8'), path.basename(video, '.mp4'));
    assert.deepEqual(JSON.parse(await fs.readFile(metadata, 'utf8')), { sourceKey: key });
  }
  assert.deepEqual((await fs.readdir(library.folder())).sort(), ['completed', 'ready']);
});
