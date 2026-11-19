const { app, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const { openAsBlob } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const supported = ['youtube', 'instagram', 'facebook', 'twitter'];
const api = 'https://api.ayrshare.com/api';

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

async function request(key, endpoint, init = {}) {
  const response = await fetch(api + endpoint, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
    headers: { Authorization: 'Bearer ' + key, ...init.headers }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.status === 'error') {
    const error = new Error(data.errors?.[0]?.message || data.message || 'Ayrshare rejected this request (HTTP ' + response.status + ').');
    error.rejected = data.status === 'error' && response.status < 500 && !/duplicate|idempoten/i.test(error.message);
    throw error;
  }
  return data;
}

function httpsUrl(value) {
  if (typeof value !== 'string' || new URL(value).protocol !== 'https:') {
    throw new Error('Ayrshare returned an invalid media address.');
  }
  return value;
}

async function upload(key, video) {
  const file = await openAsBlob(video, { type: 'video/mp4' });
  const name = path.basename(video);
  if (file.size <= 30_000_000) {
    const body = new FormData();
    body.append('file', file, name);
    body.append('fileName', name);
    const result = await request(key, '/media/upload', { method: 'POST', body });
    return httpsUrl(result.url);
  }
  const params = new URLSearchParams({ fileName: name, contentType: 'mp4' });
  const urls = await request(key, '/media/uploadUrl?' + params);
  const accessUrl = httpsUrl(urls.accessUrl);
  const response = await fetch(httpsUrl(urls.uploadUrl), {
    method: 'PUT', body: file, redirect: 'error',
    headers: { 'Content-Type': urls.contentType || 'video/mp4' },
    signal: AbortSignal.timeout(30 * 60_000)
  });
  if (!response.ok) throw new Error('Video upload failed (HTTP ' + response.status + ').');
  return accessUrl;
}

function createPublishing({ engineDir, resolveVideo, moveClip }) {
  const storage = app.getPath('userData');
  const accountFile = path.join(storage, 'publishing-account.json');
  const legacyFile = path.resolve(engineDir, '..', 'social_credentials.json');

  async function readAccount() {
    const saved = await readJson(accountFile);
    if (saved) {
      return { ...saved, key: safeStorage.decryptString(Buffer.from(saved.cipher, 'base64')) };
    }
    const legacy = (await readJson(legacyFile))?.ayrshare;
    return {
      key: legacy?.apiKey || '',
      platforms: supported.filter(name => legacy?.platforms?.[name]?.connected),
      lastVerified: legacy?.lastVerified || null
    };
  }

  function summary({ key, platforms, lastVerified }) {
    return { hasKey: Boolean(key), platforms, lastVerified };
  }

  async function connectAccount(input) {
    if (typeof input !== 'string') throw new Error('Enter an Ayrshare API key.');
    const key = input.trim() || (await readAccount()).key;
    if (!key) throw new Error('Enter an Ayrshare API key.');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable.');
    const user = await request(key, '/user');
    if (!Array.isArray(user.activeSocialAccounts)) throw new Error('Ayrshare did not return a list of connected accounts.');
    const platforms = supported.filter(name => user.activeSocialAccounts.includes(name));
    const lastVerified = new Date().toISOString();
    await saveJson(accountFile, { cipher: safeStorage.encryptString(key).toString('base64'), platforms, lastVerified });
    return summary({ key, platforms, lastVerified });
  }

  async function publishClip(id, requested, details) {
    const { key, platforms } = await readAccount();
    if (!key) throw new Error('Connect your Ayrshare account first.');
    if (!Array.isArray(requested) || !requested.length || requested.some(p => !platforms.includes(p))) {
      throw new Error('Select a connected platform.');
    }
    const destinations = [...new Set(requested)];
    const title = String(details?.title || '').trim();
    if (!title) throw new Error('Enter a clip title before publishing.');
    const file = await resolveVideo(id, 'ready');
    const { size, mtimeMs } = await fs.stat(file);
    const digest = createHash('sha256').update(JSON.stringify([engineDir, id, size, mtimeMs, key])).digest('hex');
    const receiptFile = path.join(storage, 'publish-receipts', digest + '.json');
    const receipts = (await readJson(receiptFile)) || {};
    let mediaUrl;
    for (const platform of destinations) {
      if (receipts[platform]?.accepted) continue;
      mediaUrl ||= await upload(key, file);
      const post = [title, details.description].filter(Boolean).join('\n\n');
      const token = receipts[platform]?.token || randomUUID();
      receipts[platform] = { token };
      await saveJson(receiptFile, receipts);
      const body = {
        post: platform === 'twitter' && details.xPost?.trim() ? details.xPost.trim() : post,
        platforms: [platform], mediaUrls: [mediaUrl], idempotencyKey: token
      };
      if (platform === 'youtube') {
        body.post = details.description?.trim() || title;
        body.youTubeOptions = { title: title.slice(0, 100), visibility: 'public' };
        const tags = String(details.tags || '').split(',').map(tag => tag.trim()).filter(Boolean);
        if (tags.length) body.youTubeOptions.tags = tags;
      }
      try {
        const result = await request(key, '/post', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        if (!['success', 'pending'].includes(result.status) || !result.id) throw new Error('Ayrshare did not confirm acceptance.');
        receipts[platform] = { accepted: true, id: result.id };
        await saveJson(receiptFile, receipts);
      } catch (error) {
        // A definite rejection permits a corrected retry. Keep the same token
        // after timeouts so an accepted but unacknowledged post cannot be duplicated.
        if (error.rejected) {
          delete receipts[platform];
          await saveJson(receiptFile, receipts);
        }
        const sent = Object.keys(receipts).filter(name => receipts[name].accepted);
        throw new Error(platform + ': ' + error.message + (sent.length ? ' Already accepted: ' + sent.join(', ') + '.' : ''));
      }
    }
    await moveClip(id, 'ready', 'completed');
    return { message: 'Accepted by Ayrshare for ' + destinations.join(', ') + '.' };
  }

  return { accounts: async () => summary(await readAccount()), connectAccount, publishClip };
}

module.exports = { createPublishing };
