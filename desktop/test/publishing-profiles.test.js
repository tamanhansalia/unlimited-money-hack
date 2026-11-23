const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const { createPublishing, postBody, youtubeTags } = require('../src/main/publishing');

const key = 'sk_' + 'a'.repeat(64);
const otherKey = 'sk_' + 'b'.repeat(64);
const comedyProfile = 'c'.repeat(24);
const active = registry => registry.profiles.find(profile => profile.id === registry.activeId);
const encryptFixture = value => Buffer.from(value.split('').reverse().join(''));
const safeStorage = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async value => encryptFixture(value),
  decryptStringAsync: async buffer => ({ result: buffer.toString().split('').reverse().join('') })
};
const ACCOUNTS = [
  { _id: 'yt0000000000000000000001', platform: 'youtube', username: 'comedyclips', isActive: true },
  { _id: 'ig0000000000000000000001', platform: 'instagram', displayName: 'Comedy Clips IG', isActive: true },
  { _id: 'fb0000000000000000000001', platform: 'facebook', username: 'comedy-page', isActive: true },
  { _id: 'tw0000000000000000000001', platform: 'twitter', username: '@comedy', isActive: false },
  { _id: 'li0000000000000000000001', platform: 'linkedin', username: 'not-supported', isActive: true }
];

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), '2pixelhack-zernio-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const engineDir = path.join(root, 'engine');
  const storage = path.join(root, 'app-data');
  const file = path.join(root, 'sample.mp4');
  await fs.mkdir(storage);
  await fs.writeFile(file, 'clip content');
  await fs.writeFile(path.join(root, 'sample_meta.json'), JSON.stringify({ durationSec: 32.5 }));
  const moveClip = t.mock.fn();
  const listClips = async () => {
    const { size, mtimeMs } = await fs.stat(file);
    return [{ id: 'sample', fileSizeBytes: size, updatedAt: mtimeMs }];
  };
  const open = () => createPublishing({ engineDir, storage, safeStorage, resolveVideo: () => file, moveClip, listClips });
  return { root, engineDir, storage, file, open, moveClip };
}

/** A small fake of the Zernio API. `onPost` decides each POST /posts answer. */
function fakeZernio(t, { onPost = () => ({ status: 201, post: { status: 'published' } }), profiles = [],
  accountList = () => ACCOUNTS, getPost, lookupPosts, extraKey } = {}) {
  const calls = { posts: [], reads: [], uploads: 0, deletes: [], accounts: [] };
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(input);
    if (url.hostname === 'uploads.example') {
      assert.equal(init.method, 'PUT');
      assert.equal(init.headers['Content-Type'], 'video/mp4');
      calls.uploads++;
      return new Response(null, { status: 200 });
    }
    assert.equal(url.origin, 'https://zernio.com');
    assert.ok(url.pathname.startsWith('/api/v1/'));
    const auth = init.headers.Authorization;
    if (auth === 'Bearer ' + otherKey) {
      return Response.json({ error: 'Invalid API key ' + otherKey, type: 'authentication_error', code: 'invalid_credentials' }, { status: 401 });
    }
    assert.ok([key, extraKey].some(value => value && auth === 'Bearer ' + value));
    const route = init.method === 'DELETE' ? 'DELETE ' + url.pathname : url.pathname;
    switch (route) {
      case '/api/v1/profiles':
        return Response.json({ profiles });
      case '/api/v1/accounts':
        calls.accounts.push(Object.fromEntries(url.searchParams));
        return Response.json({ accounts: accountList(url.searchParams), hasAnalyticsAccess: false });
      case '/api/v1/media/presign': {
        const body = JSON.parse(init.body);
        assert.deepEqual([body.filename, body.contentType], ['sample.mp4', 'video/mp4']);
        return Response.json({ uploadUrl: 'https://uploads.example/put/sample.mp4', publicUrl: 'https://media.zernio.com/sample.mp4' });
      }
      case '/api/v1/posts': {
        if (init.method === 'GET') {
          calls.reads.push(url.searchParams.get('externalId'));
          return Response.json({ posts: lookupPosts?.(url.searchParams.get('externalId')) || [] });
        }
        const body = JSON.parse(init.body);
        const post = { body, key: init.headers['Idempotency-Key'] };
        calls.posts.push(post);
        const answer = onPost(post, calls.posts.length);
        if (answer.error) return Response.json(answer.error, { status: answer.status });
        const id = 'post' + String(calls.posts.length).padStart(20, '0');
        return Response.json({ post: { _id: id, ...answer.post, platforms: [{ ...body.platforms[0], ...answer.platform }] } },
          { status: answer.status });
      }
      default:
        if (route.startsWith('DELETE /api/v1/posts/')) {
          calls.deletes.push(route.split('/').pop());
          return Response.json({ message: 'deleted' });
        }
        if (route.startsWith('/api/v1/posts/') && init.method === 'GET' && getPost) {
          const postId = route.split('/').pop();
          calls.reads.push(postId);
          const post = getPost(postId);
          return post instanceof Response ? post : Response.json({ post });
        }
        return assert.fail('Unexpected request ' + route);
    }
  });
  return calls;
}

test('a profile from the Ayrshare version stays listed and asks for a Zernio key', async t => {
  const { storage, open } = await setup(t);
  await fs.writeFile(path.join(storage, 'publishing-profiles.json'), JSON.stringify({
    activeId: 'default',
    profiles: [{ id: 'default', name: 'Default', cipher: encryptFixture('old-ayrshare-key').toString('base64'),
      platforms: ['youtube'], destinations: { youtube: 'old' }, lastVerified: '2025-08-01T10:00:00.000Z', connectionId: 'c1' }]
  }));
  const calls = fakeZernio(t);
  const service = open();
  const legacy = active(await service.accounts());
  assert.deepEqual([legacy.service, legacy.needsKey, legacy.platforms, legacy.lastVerified], ['ayrshare', true, [], null]);
  await assert.rejects(service.publishClip('sample', ['youtube'], { title: 'A clip' }, 'default', 'c1'), /set up for Ayrshare/);
  await assert.rejects(service.verifyProfile('default'), /set up for Ayrshare/);

  const switched = active(await service.updateProfileKeys('default', key, ''));
  assert.deepEqual([switched.id, switched.name, switched.service, switched.needsKey], ['default', 'Default', 'zernio', false]);
  assert.deepEqual(switched.platforms, ['youtube', 'instagram', 'facebook']);
  const stored = await fs.readFile(path.join(storage, 'publishing-profiles.json'), 'utf8');
  assert.equal(stored.includes(key), false);
  assert.equal(stored.includes('profileCipher'), false);
  assert.deepEqual(calls.accounts, [{ status: 'connected' }]);
});

test('adds profiles from connected accounts, scoped to a Zernio profile, and redacts rejected keys', async t => {
  const { open, storage } = await setup(t);
  const calls = fakeZernio(t, { profiles: [{ _id: comedyProfile, name: 'Comedy', isDefault: false }, { _id: 'bad', name: 'Broken' }] });
  const service = open();
  assert.deepEqual(await service.zernioProfiles(key), [{ id: comedyProfile, name: 'Comedy', isDefault: false }]);

  const first = active(await service.addProfile('Main', key, ''));
  assert.deepEqual(first.platforms, ['youtube', 'instagram', 'facebook'], 'inactive X and unsupported LinkedIn are skipped');
  assert.deepEqual(first.destinations, { youtube: 'comedyclips', instagram: 'Comedy Clips IG', facebook: 'comedy-page' });
  assert.equal(first.zernioProfile, null);

  const second = active(await service.addProfile('Comedy', key, comedyProfile));
  assert.deepEqual(second.zernioProfile, { id: comedyProfile, name: 'Comedy' });
  assert.deepEqual(calls.accounts.at(-1), { status: 'connected', profileId: comedyProfile });

  await assert.rejects(service.addProfile('Wrong', key, 'd'.repeat(24)), /Zernio profile no longer exists/);
  await assert.rejects(service.addProfile('Short', 'sk_short', ''), /valid Zernio API key/);
  await assert.rejects(service.addProfile(' comedy ', key, ''), /already uses this name/);
  await assert.rejects(service.updateProfileKeys(second.id, otherKey, ''), error => {
    assert.match(error.message, /did not accept this API key/);
    assert.equal(error.message.includes(otherKey), false);
    return true;
  });
  assert.deepEqual(active(await service.accounts()), second, 'a failed key update keeps the saved connection');

  const verified = active(await service.verifyProfile(second.id));
  assert.notEqual(verified.connectionId, second.connectionId);
  await service.selectProfile(first.id);
  assert.equal(active(await open().accounts()).id, first.id);
  assert.equal((await service.renameProfile(second.id, 'Comedy shorts')).profiles[1].name, 'Comedy shorts');
  assert.equal(active(await service.removeProfile(first.id)).id, second.id);
  const stored = await fs.readFile(path.join(storage, 'publishing-profiles.json'), 'utf8');
  assert.equal(stored.includes(key), false);
});

test('reverification keeps the same channel when the account order or availability changes', async t => {
  const { open } = await setup(t);
  const primary = ACCOUNTS[0];
  const alternate = { ...primary, _id: 'alternate', username: 'another-channel' };
  let accounts = [primary];
  fakeZernio(t, { accountList: () => accounts });
  const service = open();
  const profile = active(await service.addProfile('Pinned', key));
  accounts = [alternate, primary];
  await assert.rejects(service.addProfile('Ambiguous', key), /Choose its Zernio profile/);
  assert.equal(active(await service.verifyProfile(profile.id)).accounts.youtube, primary._id);
  accounts = [alternate];
  assert.deepEqual(active(await service.verifyProfile(profile.id)).platforms, []);
  accounts.push(primary);
  assert.equal(active(await service.verifyProfile(profile.id)).accounts.youtube, primary._id);
});

test('publishes one post per platform with its own idempotency key and skips accepted ones on retry', async t => {
  const { open, moveClip } = await setup(t);
  const calls = fakeZernio(t);
  const service = open();
  const profile = active(await service.addProfile('Main', key, ''));
  const details = { title: 'Gaadi ka hisaab', description: 'Roti band karo wali comedy.', tags: 'comedy, hindi stand up, Comedy', xPost: '' };
  const result = await service.publishClip('sample', ['youtube', 'facebook'], details, profile.id, profile.connectionId);
  assert.match(result.message, /Posted through Zernio to youtube, facebook/);
  assert.equal(calls.uploads, 1, 'one upload serves every platform');

  const [youtube, facebook] = calls.posts;
  assert.deepEqual(youtube.body.platforms, [{ platform: 'youtube', accountId: 'yt0000000000000000000001',
    platformSpecificData: { title: 'Gaadi ka hisaab', visibility: 'public', madeForKids: false } }]);
  assert.equal(youtube.body.content, 'Roti band karo wali comedy.');
  assert.deepEqual(youtube.body.tags, ['comedy', 'hindi stand up']);
  assert.deepEqual(youtube.body.mediaItems, [{ type: 'video', url: 'https://media.zernio.com/sample.mp4' }]);
  assert.equal(youtube.body.publishNow, true);
  assert.equal(facebook.body.platforms[0].platformSpecificData.contentType, 'reel', 'a 32-second clip is a Facebook Reel');
  assert.equal(facebook.body.content, 'Gaadi ka hisaab\n\nRoti band karo wali comedy.');
  assert.notEqual(youtube.key, facebook.key);
  assert.match(youtube.key, /^[0-9a-f-]{36}$/);
  assert.deepEqual(moveClip.mock.calls[0].arguments, ['sample', 'ready', 'completed']);

  await service.publishClip('sample', ['youtube', 'facebook'], details, profile.id, profile.connectionId);
  assert.equal(calls.posts.length, 2, 'accepted platforms are never posted twice');
});

test('a confirmed platform failure permits a corrected retry without deleting the failed post', async t => {
  const { open } = await setup(t);
  const calls = fakeZernio(t, {
    onPost: (_post, count) => count === 1
      ? { status: 207, post: { status: 'failed' }, platform: { status: 'failed', errorMessage: 'Media processing failed: video too short for Reels' } }
      : { status: 201, post: { status: 'published' } }
  });
  const service = open();
  const profile = active(await service.addProfile('Main', key, ''));
  const publish = () => service.publishClip('sample', ['instagram'], { title: 'A clip' }, profile.id, profile.connectionId);
  await assert.rejects(publish(), /instagram: Media processing failed/);
  assert.deepEqual(calls.deletes, []);
  await publish();
  assert.notEqual(calls.posts[0].key, calls.posts[1].key);
});

test('an uncertain failure keeps the key, and a duplicate counts as already posted', async t => {
  const { open } = await setup(t);
  const calls = fakeZernio(t, {
    onPost: (_post, count) => [
      { status: 503, error: { error: 'Service unavailable', type: 'api_error' } },
      { status: 409, error: { error: 'Duplicate content', code: 'duplicate_content',
        details: { existingPostId: 'existing00000000000000001' } } }
    ][count - 1],
    getPost: _id => ({ _id, status: 'published', platforms: [{ platform: 'youtube', accountId: ACCOUNTS[0]._id, status: 'published' }] })
  });
  const service = open();
  const profile = active(await service.addProfile('Main', key, ''));
  const publish = () => service.publishClip('sample', ['youtube'], { title: 'A clip' }, profile.id, profile.connectionId);
  await assert.rejects(publish(), /youtube: Service unavailable/);
  await publish();
  assert.equal(calls.posts[0].key, calls.posts[1].key, 'a retry after a server error reuses the idempotency key');
  assert.deepEqual(calls.reads, ['existing00000000000000001']);
  assert.deepEqual(calls.posts[0].body, calls.posts[1].body);
  assert.equal(calls.uploads, 1, 'the uncertain attempt already uploaded the media');
});

test('Zernio retry and funding responses preserve the same provider post', async t => {
  const { open, moveClip } = await setup(t);
  const x = { ...ACCOUNTS[3], isActive: true };
  const calls = fakeZernio(t, {
    accountList: () => [...ACCOUNTS.slice(0, 3), x],
    onPost: ({ body }) => body.platforms[0].platform === 'twitter'
      ? { status: 202, post: { status: 'scheduled' }, platform: { status: 'pending', errorMessage: 'Waiting for funds.' } }
      : { status: 207, post: { status: 'scheduled' }, platform: { status: 'pending' } },
    getPost: _id => ({ _id, status: 'published', platforms: [_id.endsWith('1')
      ? { platform: 'youtube', accountId: ACCOUNTS[0]._id, status: 'published' }
      : { platform: 'twitter', accountId: x._id, status: 'published' }] })
  });
  const service = open();
  const profile = active(await service.addProfile('Recovery', key));
  const publish = (id, platform) => service.publishClip(id, [platform], { title: 'A clip' }, profile.id, profile.connectionId);
  await assert.rejects(publish('retry', 'youtube'), /still processing/);
  assert.equal(moveClip.mock.calls.length, 0);
  assert.match((await publish('retry', 'youtube')).message, /Posted/);
  assert.deepEqual(calls.deletes, []);
  await assert.rejects(publish('funds', 'twitter'), /waiting for funds/);
  assert.equal(moveClip.mock.calls.length, 1);
  assert.match((await publish('funds', 'twitter')).message, /Posted/);
  assert.equal(calls.posts.length, 2);
  assert.equal(calls.reads.length, 2);
});

test('an expired uncertain submission is looked up without another POST', async t => {
  const { open, storage } = await setup(t);
  const calls = fakeZernio(t, {
    onPost: () => ({ status: 503, error: { error: 'Unavailable' } }),
    lookupPosts: externalId => [{ _id: 'existing-post', externalId, status: 'published',
      platforms: [{ platform: 'youtube', accountId: ACCOUNTS[0]._id, status: 'published' }] }]
  });
  const service = open();
  const profile = active(await service.addProfile('Uncertain', key));
  const publish = () => service.publishClip('sample', ['youtube'], { title: 'A clip' }, profile.id, profile.connectionId);
  await assert.rejects(publish(), /Unavailable/);
  const directory = path.join(storage, 'publish-receipts');
  const [receiptName] = await fs.readdir(directory);
  const file = path.join(directory, receiptName);
  const receipts = JSON.parse(await fs.readFile(file, 'utf8'));
  receipts[`youtube:${ACCOUNTS[0]._id}`].createdAt -= 25 * 3600_000;
  await fs.writeFile(file, JSON.stringify(receipts));
  await publish();
  assert.deepEqual(calls.reads, [calls.posts[0].body.externalId]);
  assert.equal(calls.posts.length, 1);
});

test('a status lookup returning 404 keeps the provider receipt for the next retry', async t => {
  const { open, moveClip } = await setup(t);
  let reads = 0;
  const calls = fakeZernio(t, {
    onPost: () => ({ status: 207, post: { status: 'scheduled' }, platform: { status: 'pending' } }),
    getPost: _id => ++reads === 1 ? Response.json({ error: 'Post not found' }, { status: 404 }) :
      { _id, status: 'published', platforms: [{ platform: 'youtube', accountId: ACCOUNTS[0]._id, status: 'published' }] }
  });
  const service = open();
  const profile = active(await service.addProfile('Main', key));
  const publish = () => service.publishClip('sample', ['youtube'], { title: 'A clip' }, profile.id, profile.connectionId);
  await assert.rejects(publish(), /still processing/);
  await assert.rejects(publish(), /Post not found/);
  assert.equal(moveClip.mock.calls.length, 0);
  await publish();
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.reads[0], calls.reads[1]);
  assert.equal(moveClip.mock.calls.length, 1);
});

test('key rotation and profile aliases retain receipts for the same destination', async t => {
  const { open } = await setup(t);
  const rotatedKey = 'sk_' + 'd'.repeat(64);
  let lookupAvailable = false;
  const calls = fakeZernio(t, { extraKey: rotatedKey,
    onPost: (_post, count) => count === 1 ? { status: 201, post: { status: 'published' } } :
      { status: 503, error: { error: 'Unavailable' } },
    lookupPosts: externalId => lookupAvailable ? [{ _id: 'existing-post', externalId, status: 'published',
      platforms: [{ platform: 'instagram', accountId: ACCOUNTS[1]._id, status: 'published' }] }] : []
  });
  const service = open();
  const original = active(await service.addProfile('Main', key));
  const publish = (profile, platforms) => open().publishClip('sample', platforms, { title: 'A clip' }, profile.id, profile.connectionId);
  await assert.rejects(publish(original, ['youtube', 'instagram']), /Unavailable.*Already accepted: youtube/);
  const rotated = active(await service.updateProfileKeys(original.id, rotatedKey));
  await assert.rejects(publish(rotated, ['youtube', 'instagram']), /after the API key changed.*Already accepted: youtube/);
  lookupAvailable = true;
  await publish(rotated, ['youtube', 'instagram']);
  const alias = active(await service.addProfile('Alias', rotatedKey));
  await publish(alias, ['youtube']);
  assert.equal(calls.posts.length, 2);
  assert.equal(calls.uploads, 1);
});

test('legacy receipts are migrated while the old profile key is still available', async t => {
  const { open, storage, file, engineDir } = await setup(t);
  const rotatedKey = 'sk_' + 'd'.repeat(64);
  const calls = fakeZernio(t, { extraKey: rotatedKey });
  const service = open();
  const profile = active(await service.addProfile('Main', key));
  const { size, mtimeMs } = await fs.stat(file);
  const digest = createHash('sha256').update(JSON.stringify([engineDir, 'sample', size, mtimeMs, 'zernio', key, ''])).digest('hex');
  const directory = path.join(storage, 'publish-receipts');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, `${digest}.json`), JSON.stringify({
    youtube: { accepted: true, id: 'legacy-post', accountId: ACCOUNTS[0]._id, status: 'published' }
  }));
  const rotated = active(await service.updateProfileKeys(profile.id, rotatedKey));
  await open().publishClip('sample', ['youtube'], { title: 'A clip' }, rotated.id, rotated.connectionId);
  assert.equal(calls.posts.length, 0);
});

test('a partially accepted schedule reports its occupied posting time', async t => {
  const { open } = await setup(t);
  fakeZernio(t, { onPost: (_post, count) => count === 1
    ? { status: 201, post: { status: 'scheduled' } }
    : { status: 422, error: { error: 'Instagram rejected the video' } }
  });
  const service = open();
  const profile = active(await service.addProfile('Main', key, ''));
  const date = new Date(Date.now() + 3600_000).toISOString();
  await assert.rejects(service.publishClip('sample', ['youtube', 'instagram'], { title: 'A clip' }, profile.id, profile.connectionId,
    { automated: true, scheduleDate: date }), error => {
    assert.match(error.message, /Already accepted: youtube/);
    assert.deepEqual(error.scheduledDates, [new Date(date).toISOString()]);
    return true;
  });
});

test('Autopilot schedules with scheduledFor, and manual posts stay pinned to the confirmed profile', async t => {
  const { open } = await setup(t);
  const calls = fakeZernio(t, { onPost: () => ({ status: 201, post: { status: 'scheduled' } }) });
  const service = open();
  const first = active(await service.addProfile('Comedy', key, ''));
  const second = active(await service.addProfile('Highlights', key, ''));
  await assert.rejects(service.publishClip('sample', ['youtube'], { title: 'A clip' }, first.id, first.connectionId),
    /publishing profile changed/);
  const when = new Date(Date.now() + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const result = await service.publishClip('sample', ['youtube'], { title: 'A clip' }, first.id, null, { scheduleDate: when, automated: true });
  assert.match(result.message, /Scheduled with Zernio/);
  assert.equal(calls.posts[0].body.scheduledFor, when);
  assert.equal(calls.posts[0].body.publishNow, undefined);
  await assert.rejects(service.publishClip('sample', ['youtube'], { title: 'A clip' }, second.id, first.connectionId,
    { scheduleDate: when, automated: true }), /changed during this run/);
  await assert.rejects(service.publishClip('sample', ['youtube'], { title: 'A clip' }, second.id, null,
    { scheduleDate: new Date().toISOString(), automated: true }), /five minutes from now/);
});

test('post bodies respect each platform’s limits', () => {
  const long = 'x'.repeat(400);
  const x = postBody('twitter', 'tw1', { title: 'T', description: long }, 'https://m/v.mp4', null, 30);
  assert.equal(x.content.length, 280);
  assert.equal(postBody('twitter', 'tw1', { title: 'T', xPost: 'Short post' }, 'https://m/v.mp4', null, 30).content, 'Short post');
  assert.equal(postBody('facebook', 'fb1', { title: 'T' }, 'https://m/v.mp4', null, 65).platforms[0].platformSpecificData, undefined);
  assert.equal(postBody('youtube', 'yt1', { title: 'y'.repeat(150) }, 'https://m/v.mp4', null, 30).platforms[0].platformSpecificData.title.length, 100);
  const tags = youtubeTags(Array.from({ length: 30 }, (_, index) => 'tag number ' + index).join(','));
  assert.ok(tags.join('').length <= 500);
});
