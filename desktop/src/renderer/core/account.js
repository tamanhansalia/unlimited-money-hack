// Publishing profiles and the active profile's linked platforms.

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

/** Display name and icon for a platform key; unknown platforms get their own name and a generic icon. */
export function platformInfo(name) {
  const key = String(name ?? '').toLowerCase();
  const known = PLATFORMS[key === 'x' ? 'twitter' : key];
  if (known) return known;
  return { name: key ? key.charAt(0).toUpperCase() + key.slice(1) : 'Unknown', icon: FALLBACK_ICON };
}

function saveAccounts(snapshot) {
  const { profiles, activeId } = snapshot ?? {};
  if (!Array.isArray(profiles) || profiles.some(profile => !profile?.id || typeof profile.name !== 'string' || !Array.isArray(profile.platforms))) {
    throw new Error('Publishing returned an unexpected profile list.');
  }
  const account = profiles.find(profile => profile.id === activeId) ?? null;
  set({ profiles, account, accountStatus: 'ready', accountError: '' });
  return account;
}

let loading;
let action;

/** Load the local profile list and its selection. A failed load keeps the last known list. */
export function refreshAccount({ force = false } = {}) {
  if (action) return action.catch(() => state.account);
  if (loading) return loading;
  if (!force && state.accountStatus === 'ready') return Promise.resolve(state.account);
  set({ accountStatus: 'loading', accountError: '' });
  loading = api.accounts()
    .then(saveAccounts)
    .catch(error => {
      set({ accountStatus: 'error', accountError: errorMessage(error) });
      return state.account;
    })
    .finally(() => { loading = undefined; });
  return loading;
}

async function updateAccounts(method, ...args) {
  if (action) throw new Error('Wait for the current profile action to finish.');
  set({ accountPending: true });
  action = Promise.resolve(loading).then(() => api[method](...args)).then(saveAccounts);
  try {
    return await action;
  } finally {
    action = undefined;
    set({ accountPending: false });
  }
}

export const addProfile = (name, key, zernioProfileId) => updateAccounts('addProfile', name, key, zernioProfileId);
export const selectProfile = id => updateAccounts('selectProfile', id);
export const renameProfile = (id, name) => updateAccounts('renameProfile', id, name);
export const removeProfile = id => updateAccounts('removeProfile', id);
export const reverifyAccount = () => updateAccounts('verifyProfile', state.account?.id);
export const updateProfileKeys = (id, key, zernioProfileId) => updateAccounts('updateProfileKeys', id, key, zernioProfileId);
/** The Zernio profiles an API key can see, for the profile picker. */
export const listZernioProfiles = key => api.zernioProfiles(key);
