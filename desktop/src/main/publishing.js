// Publishing through Zernio (https://docs.zernio.com): local profiles that each hold an encrypted Zernio API
// key, an optional Zernio profile, and the connected account found for every supported platform.

const fs = require('node:fs/promises');
const { openAsBlob } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const SUPPORTED = ['youtube', 'instagram', 'facebook', 'twitter'];
const API = 'https://zernio.com/api/v1';
const SERVICE = 'zernio';
const OBJECT_ID = /^[a-f0-9]{24}$/i;
const REQUEST_MS = 120_000;
const PUBLISH_NOW_MS = 15 * 60_000; // publishNow uploads to the platform inside the request
const UPLOAD_MS = 30 * 60_000;
const IDEMPOTENCY_MS = 24 * 60 * 60_000;
const FACEBOOK_REEL_SECONDS = 60;
const X_LIMIT = 280;
const YOUTUBE_TAGS = 500;
const LEGACY_MESSAGE = 'This profile was set up for Ayrshare. Add a Zernio API key to it in Publishing to keep using it.';
// Accepted on Zernio's side: published now, scheduled for later, or still uploading to the platform.
const ACCEPTED = new Set(['published', 'scheduled', 'publishing']);

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function saveJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

/** A Zernio error envelope ({ error, type, code }) as an Error, with the API key removed from the text. */
function zernioError(status, data, key, submitting) {
  let message = String(data?.error || data?.message || `Zernio rejected this request (HTTP ${status}).`);
  if (['invalid_credentials', 'missing_credentials'].includes(data?.code) || status === 401) {
    message = 'Zernio did not accept this API key. Create a new key at zernio.com/dashboard/api-keys.';
  }
  if (key) message = message.replaceAll(key, '[redacted]');
  const error = new Error(message);
  error.status = status;
  error.code = typeof data?.code === 'string' ? data.code : '';
  error.data = data;
  // A refused request created nothing, so a corrected retry may use a new idempotency key.
  error.rejected = submitting && status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
  return error;
}

async function call(key, endpoint, { method = 'GET', body, headers = {}, timeout = REQUEST_MS } = {}) {
  let response;
  try {
    response = await fetch(API + endpoint, {
      method, redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { Authorization: 'Bearer ' + key, ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (cause) {
    // The request may still have reached Zernio, so callers keep their idempotency key.
    throw new Error(cause?.name === 'TimeoutError' ? 'Zernio did not answer in time. The post may still be processing.'
      : 'Could not reach Zernio. Check your internet connection and try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw zernioError(response.status, data, key, method === 'POST' && endpoint === '/posts');
  return { status: response.status, data };
}

function httpsUrl(value) {
  try {
    if (typeof value === 'string' && new URL(value).protocol === 'https:') return value;
  } catch { /* fall through */ }
  throw new Error('Zernio returned an invalid media address.');
}

/** Presigned upload: Zernio returns a PUT URL and the public URL that posts reference. */
async function upload(key, video) {
  const file = await openAsBlob(video, { type: 'video/mp4' });
  const { data } = await call(key, '/media/presign', {
    method: 'POST', body: { filename: path.basename(video), contentType: 'video/mp4', size: file.size }
  });
  const publicUrl = httpsUrl(data.publicUrl);
  const response = await fetch(httpsUrl(data.uploadUrl), {
    method: 'PUT', body: file, redirect: 'error',
    headers: { 'Content-Type': 'video/mp4' }, signal: AbortSignal.timeout(UPLOAD_MS)
  });
  if (!response.ok) throw new Error('Video upload to Zernio failed (HTTP ' + response.status + ').');
  return publicUrl;
}

/** YouTube allows 100 characters per tag and 500 in total. */
function youtubeTags(value) {
  const tags = [];
  let total = 0;
  for (const tag of String(value || '').split(',').map(item => item.trim()).filter(Boolean)) {
    if (tag.length > 100 || tags.some(item => item.toLowerCase() === tag.toLowerCase())) continue;
    if (total + tag.length > YOUTUBE_TAGS) break;
    tags.push(tag);
    total += tag.length;
  }
  return tags;
}

function clip(text, limit) {
  return text.length <= limit ? text : text.slice(0, limit - 1).trimEnd() + '…';
}

/** One post per platform, so each platform keeps its own receipt and idempotency key. */
function postBody(platform, accountId, details, mediaUrl, scheduleDate, durationSec) {
  const title = String(details.title || '').trim();
  const description = String(details.description || '').trim();
  const caption = [title, description].filter(Boolean).join('\n\n');
  const entry = { platform, accountId };
  const body = { content: caption, mediaItems: [{ type: 'video', url: mediaUrl }], platforms: [entry] };
  if (platform === 'youtube') {
    body.content = description || title;
    entry.platformSpecificData = { title: title.slice(0, 100), visibility: 'public', madeForKids: false };
    const tags = youtubeTags(details.tags);
    if (tags.length) body.tags = tags;
  } else if (platform === 'twitter') {
    body.content = clip(String(details.xPost || '').trim() || caption, X_LIMIT);
  } else if (platform === 'facebook' && durationSec > 0 && durationSec <= FACEBOOK_REEL_SECONDS) {
    entry.platformSpecificData = { contentType: 'reel' };
  }
  if (scheduleDate) body.scheduledFor = scheduleDate;
  else body.publishNow = true;
  return body;
}

async function clipDuration(file, id) {
  try {
    const meta = JSON.parse(await fs.readFile(path.join(path.dirname(file), id + '_meta.json'), 'utf8'));
    return Number.isFinite(meta.durationSec) ? meta.durationSec : 0;
  } catch {
    return 0;
  }
}

function createPublishing({ engineDir, storage, safeStorage, resolveVideo, moveClip, listClips }) {
  const profilesFile = path.join(storage, 'publishing-profiles.json');
  const receiptDir = path.join(storage, 'publish-receipts');
  let operations = Promise.resolve();
  let receiptOperations = Promise.resolve();

  // Local receipt identity follows the clip and external account, including across credential rotation.
  const digest = values => createHash('sha256').update(JSON.stringify(values)).digest('hex');
  const receiptKey = (platform, accountId) => `${platform}:${accountId}`;
  const receiptFile = version => path.join(receiptDir, `destinations-${digest(version)}.json`);
  const legacyReceipt = (version, key, profileId) => path.join(receiptDir, `${digest([...version, key, profileId])}.json`);

  function withReceipts(operation) {
    const result = receiptOperations.then(operation);
    receiptOperations = result.then(() => {}, () => {});
    return result;
  }

  function loadReceipts(file, legacyFile, legacyAccounts, credential) {
    return withReceipts(async () => {
      const saved = await readJson(file) || {};
      const legacy = await readJson(legacyFile);
      let changed = false;
      for (const [platform, receipt] of Object.entries(legacy || {})) {
        const knownAccount = receipt.accountId || receipt.body?.platforms?.[0]?.accountId;
        const account = knownAccount || legacyAccounts[platform];
        if (!account || Object.hasOwn(saved, receiptKey(platform, account))) continue;
        saved[receiptKey(platform, account)] = { ...receipt, credential, ...(receipt.accepted && !knownAccount && { checkAccount: true }) };
        changed = true;
      }
      if (changed) await saveJson(file, saved);
      return saved;
    });
  }

  function saveReceipt(file, destination, receipt) {
    return withReceipts(async () => {
      const saved = await readJson(file) || {};
      // A null entry also prevents a superseded legacy receipt from being imported again.
      saved[destination] = receipt;
      await saveJson(file, saved);
    });
  }

  async function encryptKey(key) {
    if (!await safeStorage.isAsyncEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('OS credential encryption is unavailable.');
    }
    return (await safeStorage.encryptStringAsync(key)).toString('base64');
  }

  async function credentials(profile) {
    if (profile.service !== SERVICE) throw new Error(LEGACY_MESSAGE);
    try {
      const { result } = await safeStorage.decryptStringAsync(Buffer.from(profile.cipher, 'base64'));
      if (!result) throw new Error('Empty credential.');
      return { key: result, zernioProfileId: profile.zernioProfile?.id || '' };
    } catch {
      throw new Error('Could not read this profile’s saved API key. Update its key in Publishing.');
    }
  }

  // Profiles saved by the Ayrshare version stay listed (Autopilot and the clip sheet refer to their ids)
  // but cannot publish until they get a Zernio key.
  const loadProfiles = async () => (await readJson(profilesFile)) || { activeId: null, profiles: [] };

  function withProfiles(operation) {
    const result = operations.then(async () => operation(await loadProfiles()));
    operations = result.then(() => {}, () => {});
    return result;
  }

  function summary({ activeId, profiles }) {
    return {
      activeId,
      profiles: profiles.map(profile => {
        const ready = profile.service === SERVICE;
        return {
          id: profile.id, name: profile.name, service: ready ? SERVICE : 'ayrshare', needsKey: !ready,
          zernioProfile: ready ? profile.zernioProfile || null : null,
          platforms: ready ? profile.platforms || [] : [], destinations: ready ? profile.destinations || {} : {},
          accounts: ready ? profile.accounts || {} : {},
          lastVerified: ready ? profile.lastVerified || null : null, connectionId: profile.connectionId
        };
      })
    };
  }

  function findProfile(registry, id) {
    const profile = registry.profiles.find(item => item.id === id);
    if (!profile) throw new Error('That publishing profile is no longer saved.');
    return profile;
  }

  function profileName(registry, input, id) {
    const name = typeof input === 'string' ? input.trim() : '';
    if (!name || name.length > 60) throw new Error('Enter a profile name of 1 to 60 characters.');
    if (registry.profiles.some(item => item.id !== id && item.name.toLowerCase() === name.toLowerCase())) {
      throw new Error('A profile already uses this name.');
    }
    return name;
  }

  function checkedKey(input) {
    const key = typeof input === 'string' ? input.trim() : '';
    if (!/^[!-~]{20,512}$/.test(key)) throw new Error('Enter a valid Zernio API key. It starts with sk_.');
    return key;
  }

  function checkedProfileId(input) {
    const id = typeof input === 'string' ? input.trim() : '';
    if (id && !OBJECT_ID.test(id)) throw new Error('Choose a Zernio profile from the list.');
    return id;
  }

  async function listZernioProfiles(key) {
    const { data } = await call(key, '/profiles');
    if (!Array.isArray(data.profiles)) throw new Error('Zernio did not return a list of profiles.');
    return data.profiles
      .filter(item => typeof item?._id === 'string' && OBJECT_ID.test(item._id))
      .map(item => ({ id: item._id, name: String(item.name || 'Untitled profile').slice(0, 80), isDefault: Boolean(item.isDefault) }));
  }

  async function verify(key, zernioProfileId, previous = {}) {
    let zernioProfile = null;
    if (zernioProfileId) {
      const match = (await listZernioProfiles(key)).find(item => item.id === zernioProfileId);
      if (!match) throw new Error('That Zernio profile no longer exists. Choose another one.');
      zernioProfile = { id: match.id, name: match.name };
    }
    const query = new URLSearchParams({ status: 'connected' });
    if (zernioProfileId) query.set('profileId', zernioProfileId);
    const { data } = await call(key, '/accounts?' + query);
    if (!Array.isArray(data.accounts)) throw new Error('Zernio did not return a list of connected accounts.');
    const accountPins = { ...previous };
    const accounts = {};
    const destinations = {};
    for (const platform of SUPPORTED) {
      const connected = data.accounts.filter(account => account?.platform === platform && typeof account._id === 'string' &&
        account._id && account.isActive !== false && account.enabled !== false);
      if (!accountPins[platform] && connected.length > 1) {
        throw new Error(`More than one ${platform === 'youtube' ? 'YouTube' : platform} account is connected. Choose its Zernio profile in Publishing.`);
      }
      const account = accountPins[platform] ? connected.find(item => item._id === accountPins[platform]) : connected[0];
      if (!account) continue;
      accounts[platform] = account._id.slice(0, 64);
      accountPins[platform] = accounts[platform];
      const label = [account.username, account.displayName].find(value => typeof value === 'string' && value.trim());
      if (label) destinations[platform] = label.trim().slice(0, 120);
    }
    return {
      service: SERVICE, zernioProfile, accounts, accountPins, platforms: SUPPORTED.filter(platform => accounts[platform]),
      destinations, lastVerified: new Date().toISOString(), connectionId: randomUUID()
    };
  }

  async function connect(profile, key, zernioProfileId) {
    const sameProfile = profile.service === SERVICE && (profile.zernioProfile?.id || '') === zernioProfileId;
    const connection = await verify(key, zernioProfileId, sameProfile ? profile.accountPins || profile.accounts : undefined);
    const cipher = await encryptKey(key);
    delete profile.profileCipher;
    Object.assign(profile, connection, { cipher });
  }

  async function saveProfiles(registry) {
    await saveJson(profilesFile, registry);
    return summary(registry);
  }

  const addProfile = (input, inputKey, inputZernioProfileId = '') => withProfiles(async registry => {
    const profile = { id: randomUUID(), name: profileName(registry, input) };
    await connect(profile, checkedKey(inputKey), checkedProfileId(inputZernioProfileId));
    registry.profiles.push(profile);
    registry.activeId = profile.id;
    return saveProfiles(registry);
  });

  const selectProfile = id => withProfiles(registry => {
    findProfile(registry, id);
    if (registry.activeId === id) return summary(registry);
    registry.activeId = id;
    return saveProfiles(registry);
  });

  const renameProfile = (id, input) => withProfiles(registry => {
    findProfile(registry, id).name = profileName(registry, input, id);
    return saveProfiles(registry);
  });

  const removeProfile = id => withProfiles(registry => {
    findProfile(registry, id);
    registry.profiles = registry.profiles.filter(item => item.id !== id);
    if (registry.activeId === id) registry.activeId = registry.profiles[0]?.id ?? null;
    return saveProfiles(registry);
  });

  const verifyProfile = id => withProfiles(async registry => {
    const profile = findProfile(registry, id);
    const { key, zernioProfileId } = await credentials(profile);
    Object.assign(profile, await verify(key, zernioProfileId, profile.accountPins || profile.accounts));
    return saveProfiles(registry);
  });

  // Also how a profile from the Ayrshare version becomes a Zernio profile, keeping its id and name.
  const updateProfileKeys = (id, inputKey, inputZernioProfileId = '') => withProfiles(async registry => {
    const profile = findProfile(registry, id);
    const key = checkedKey(inputKey);
    const profileId = checkedProfileId(inputZernioProfileId);
    const old = profile.service === SERVICE ? await credentials(profile).catch(() => null) : null;
    if (old && (old.key !== key || old.zernioProfileId !== profileId)) await migrateReceipts(profile, old);
    await connect(profile, key, profileId);
    return saveProfiles(registry);
  });

  const zernioProfiles = inputKey => listZernioProfiles(checkedKey(inputKey));

  async function migrateReceipts(profile, { key, zernioProfileId }) {
    if (!listClips) return;
    const files = await fs.readdir(receiptDir).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const legacy = new Set(files.filter(name => /^[a-f0-9]{64}\.json$/.test(name)));
    if (!legacy.size) return;
    for (const clip of await listClips()) {
      const version = [engineDir, clip.id, clip.fileSizeBytes, clip.updatedAt, SERVICE];
      const previous = legacyReceipt(version, key, zernioProfileId);
      if (legacy.has(path.basename(previous))) {
        await loadReceipts(receiptFile(version), previous, profile.accountPins || profile.accounts || {}, digest([key]));
      }
    }
  }

  function readPost(post, { platform, accountId }, { existing = false, waiting = false, scheduleDate = null } = {}) {
    const target = post?.platforms?.find(item => {
      const account = typeof item?.accountId === 'object' ? item.accountId?._id : item?.accountId;
      return item?.platform === platform && (account === accountId || (!existing && !account));
    });
    if (typeof post?._id !== 'string' || ((existing || post.platforms?.length) && !target)) {
      throw new Error('Could not confirm the existing Zernio post for this account. Check Zernio before retrying.');
    }
    if (post.status === 'failed' || post.status === 'cancelled' || ['failed', 'cancelled'].includes(target?.status)) {
      return { id: post._id, status: 'failed', message: target?.errorMessage || 'The platform did not accept this post.' };
    }
    const blocked = waiting || (platform === 'twitter' && target?.status === 'pending' &&
      /balance|funds|insufficient_balance/i.test(`${target.errorMessage || ''} ${target.errorCategory || ''}`));
    const status = blocked ? 'waiting' : target?.status === 'published' ? 'published' : post.status;
    if (!ACCEPTED.has(status) && status !== 'waiting') throw new Error('Zernio has not confirmed the post status. Check Zernio before retrying.');
    const date = target?.scheduledFor || post.scheduledFor || scheduleDate;
    return { id: post._id, status, scheduleDate: Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : null };
  }

  async function getPost(key, postId, destination) {
    const { data } = await call(key, '/posts/' + encodeURIComponent(postId));
    return readPost(data.post, destination, { existing: true });
  }

  async function sendPost(key, receipt, destination, credential) {
    const { body, token, scheduleDate, createdAt } = receipt;
    const changedKey = receipt.credential !== credential;
    if (changedKey || Date.now() - createdAt >= IDEMPOTENCY_MS) {
      const query = new URLSearchParams({ externalId: body.externalId });
      const { data } = await call(key, '/posts?' + query);
      if (data.posts?.length === 1) return readPost(data.posts[0], destination, { existing: true });
      const reason = changedKey ? 'after the API key changed' : 'after the retry window ended';
      throw new Error(`Could not safely confirm the previous submission ${reason}. Check Zernio before trying to post again.`);
    }
    let response;
    try {
      response = await call(key, '/posts', {
        method: 'POST', body, headers: { 'Idempotency-Key': token }, timeout: scheduleDate ? REQUEST_MS : PUBLISH_NOW_MS
      });
    } catch (error) {
      const existingId = error.data?.existingPostId || error.data?.details?.existingPostId;
      if (error.code === 'duplicate_content' && typeof existingId === 'string') {
        return getPost(key, existingId, destination);
      }
      if (error.code === 'idempotency_conflict') error.message = 'Zernio is still processing this post. Try again in a minute.';
      throw error;
    }
    return readPost(response.data.post, destination, { waiting: response.status === 202, scheduleDate });
  }

  // `automated` posts come from Autopilot in the main process. They name their profile explicitly, so they
  // skip the check that the clip sheet's confirmed profile is still the one selected in the sidebar.
  async function publishClip(id, requested, details, profileId, connectionId, { scheduleDate = null, automated = false } = {}) {
    if (scheduleDate !== null && (typeof scheduleDate !== 'string' || !(Date.parse(scheduleDate) > Date.now() + 5 * 60_000))) {
      throw new Error('Choose a posting time at least five minutes from now.');
    }
    const { key, zernioProfileId, platforms, accounts, accountPins } = await withProfiles(async registry => {
      const profile = findProfile(registry, profileId);
      if (!automated && (profile.id !== registry.activeId || profile.connectionId !== connectionId)) {
        throw new Error('Your publishing profile changed. Review the destinations and confirm again.');
      }
      if (automated && connectionId && profile.connectionId !== connectionId) {
        throw new Error('The publishing profile changed during this run. Review the destinations before starting Autopilot again.');
      }
      return { ...await credentials(profile), platforms: profile.platforms || [], accounts: profile.accounts || {},
        accountPins: profile.accountPins || profile.accounts || {} };
    });
    if (!Array.isArray(requested) || !requested.length || requested.some(p => !platforms.includes(p) || !accounts[p])) {
      throw new Error('Select a connected platform.');
    }
    const destinations = [...new Set(requested)];
    const title = String(details?.title || '').trim();
    if (!title) throw new Error('Enter a clip title before publishing.');
    const file = await resolveVideo(id, 'ready');
    const { size, mtimeMs } = await fs.stat(file);
    const durationSec = await clipDuration(file, id);
    const version = [engineDir, id, size, mtimeMs, SERVICE];
    const fileName = receiptFile(version);
    const credential = digest([key]);
    const saved = await loadReceipts(fileName, legacyReceipt(version, key, zernioProfileId), accountPins, credential);
    const receipts = Object.fromEntries(destinations.map(platform => [platform, saved[receiptKey(platform, accounts[platform])]]));
    const scheduledBookings = () => destinations.flatMap(platform => {
      const date = receipts[platform]?.scheduleDate;
      return date ? [{ accountId: accounts[platform], date }] : [];
    });
    const scheduleInfo = () => {
      const bookings = scheduledBookings();
      return { bookings, scheduledDates: [...new Set(bookings.map(item => item.date))] };
    };
    let mediaUrl;
    for (const platform of destinations) {
      const accountId = accounts[platform];
      const destination = { platform, accountId };
      const store = async receipt => {
        receipts[platform] = receipt;
        await saveReceipt(fileName, receiptKey(platform, accountId), receipt);
      };
      let receipt = receipts[platform];
      const scheduled = ['publishing', 'scheduled'].includes(receipt?.status);
      const check = receipt?.id && (!receipt.accepted || receipt.checkAccount || (scheduled && !(Date.parse(receipt.scheduleDate) > Date.now())));
      if (receipt?.accepted && !check) continue;
      let newSubmission = false;
      try {
        if (receipt && !check && (!receipt.createdAt || !receipt.body?.externalId)) {
          throw new Error('An older submission could not be confirmed. Check this clip in Zernio before posting it again.');
        }
        if (!receipt) {
          mediaUrl ||= await upload(key, file);
          const body = postBody(platform, accountId, details, mediaUrl, scheduleDate, durationSec);
          const token = randomUUID();
          body.externalId = token;
          receipt = { token, body, credential, createdAt: Date.now(), scheduleDate };
          // A timeout is ambiguous. Resend the original payload and key if this destination is retried.
          await store(receipt);
          newSubmission = true;
        }
        const post = await (check ? getPost(key, receipt.id, destination) : sendPost(key, receipt, destination, credential));
        if (post.status === 'failed') throw Object.assign(new Error(post.message), { terminal: true });
        const requestedSchedule = receipt.body ? receipt.body.scheduledFor : receipt.scheduleDate;
        const processing = ['publishing', 'scheduled'].includes(post.status) &&
          (!requestedSchedule || !(Date.parse(post.scheduleDate) > Date.now()));
        if (post.status === 'waiting' || processing) {
          await store({ ...receipt, ...post, accepted: false });
          throw new Error(post.status === 'waiting'
            ? 'X is waiting for funds. Add funds in Zernio Billing, then retry to check the same post.'
            : 'Zernio is still processing this post. Retry to check its status.');
        }
        await store({ ...post, accepted: true });
      } catch (error) {
        // A read error or a rejection of a replay does not settle the original submission.
        if (error.terminal || (newSubmission && error.rejected)) await store(null);
        const sent = destinations.filter(name => receipts[name]?.accepted);
        throw Object.assign(new Error(platform + ': ' + error.message + (sent.length ? ' Already accepted: ' + sent.join(', ') + '.' : '')),
          scheduleInfo());
      }
    }
    try { await moveClip(id, 'ready', 'completed'); }
    catch (error) { throw Object.assign(error, scheduleInfo()); }
    const result = scheduleInfo();
    const pending = destinations.some(platform => ['publishing', 'scheduled'].includes(receipts[platform]?.status));
    const message = result.scheduledDates.some(date => Date.parse(date) > Date.now()) ? 'Scheduled with Zernio for '
      : pending ? 'Zernio is still processing ' : 'Posted through Zernio to ';
    return { message: message + destinations.join(', ') + '.', ...result };
  }

  return {
    accounts: () => withProfiles(summary), addProfile, selectProfile, renameProfile, removeProfile,
    verifyProfile, updateProfileKeys, zernioProfiles, publishClip
  };
}

module.exports = { createPublishing, postBody, youtubeTags };
