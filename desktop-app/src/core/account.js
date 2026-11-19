// The Ayrshare connection: which platforms exist, which are supported, and the connection state in the store.
// state.account = { hasKey, platforms, lastVerified }; accountStatus: idle | loading | ready | error.

import { state, set } from './store.js';
import { api, errorMessage } from './api.js';

export const PLATFORMS = {
  youtube: { name: 'YouTube', icon: 'youtube-logo' },
  instagram: { name: 'Instagram', icon: 'instagram-logo' },
  facebook: { name: 'Facebook', icon: 'facebook-logo' },
  twitter: { name: 'X', icon: 'x-logo' },
  tiktok: { name: 'TikTok', icon: 'tiktok-logo' },
  linkedin: { name: 'LinkedIn', icon: 'linkedin-logo' }
};

/** Platforms the publishing pipeline can post to. */
export const SUPPORTED = ['youtube', 'instagram', 'facebook', 'twitter'];

const FALLBACK_ICON = 'broadcast';
const MIN_KEY_LENGTH = 8;

/** Display name and icon for a platform key; unknown platforms get their own name and a generic icon. */
export function platformInfo(name) {
  const key = String(name ?? '').toLowerCase();
  const known = PLATFORMS[key === 'x' ? 'twitter' : key];
  if (known) return known;
  return { name: key ? key.charAt(0).toUpperCase() + key.slice(1) : 'Unknown', icon: FALLBACK_ICON };
}

/** Inline check for a pasted API key. → { ok, empty?, message } (message is empty when ok). */
export function validateApiKey(raw) {
  const key = String(raw ?? '').trim();
  if (!key) return { ok: false, empty: true, message: 'Enter your Ayrshare API key.' };
  if (/\s/.test(key)) return { ok: false, message: 'API keys don’t contain spaces. Check what you pasted.' };
  if (key.length < MIN_KEY_LENGTH) return { ok: false, message: 'This key looks too short. Make sure you copied all of it.' };
  return { ok: true, message: '' };
}

function normalise(account) {
  return {
    hasKey: Boolean(account?.hasKey),
    platforms: Array.isArray(account?.platforms) ? account.platforms.map(String) : [],
    lastVerified: account?.lastVerified || null
  };
}

function saveAccount(account) {
  set({ account: normalise(account), accountStatus: 'ready', accountError: '' });
  return state.account;
}

let inflight = null;
let revision = 0; // bumped by every connect, so a slow earlier summary cannot overwrite a newer one

/**
 * Load the connection summary. Concurrent calls share one request; a ready account is reused unless `force`.
 * Never rejects: on failure accountStatus is 'error' and accountError explains why. Resolves with state.account.
 */
export function refreshAccount({ force = false } = {}) {
  if (inflight) return inflight;
  if (!force && state.accountStatus === 'ready') return Promise.resolve(state.account);
  const mine = revision;
  set({ accountStatus: 'loading', accountError: '' });
  inflight = api.accounts()
    .then(account => (mine === revision ? saveAccount(account) : state.account))
    .catch(error => {
      if (mine === revision) set({ accountStatus: 'error', accountError: errorMessage(error) });
      return state.account;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

async function verify(key) {
  const account = await api.connectAccount(key);
  revision += 1;
  return saveAccount(account);
}

/** Verify a new API key with Ayrshare and store it. Rejects with a readable message; state is untouched on failure. */
export async function connectAccount(key) {
  const check = validateApiKey(key);
  if (!check.ok) throw new Error(check.message);
  return verify(String(key).trim());
}

/** Re-check the stored key (the main process reuses it when given an empty one). Rejects on failure. */
export function reverifyAccount() {
  return verify('');
}
