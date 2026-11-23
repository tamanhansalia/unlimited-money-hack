// Manage local publishing profiles backed by a Zernio API key and, optionally, one Zernio profile.
import { debounce, h, icon, setText } from '../core/dom.js';
import { state } from '../core/store.js';
import { api, errorMessage } from '../core/api.js';
import { toast } from '../core/toast.js';
import { button, iconButton, openDialog, setBusy } from '../core/components.js';
import { plural } from '../core/format.js';
import { addProfile, listZernioProfiles, renameProfile, removeProfile, updateProfileKeys } from '../core/account.js';

export const DASHBOARD_URL = 'https://zernio.com/dashboard';
const API_KEYS_URL = 'https://zernio.com/dashboard/api-keys';
const KEY_PATTERN = /^[!-~]{20,512}$/;
const ALL_ACCOUNTS = '';
const COPY = {
  add: { title: 'Add publishing profile', submit: 'Verify and add', busy: 'Verifying…' },
  keys: { title: 'Update API key', submit: 'Verify and save', busy: 'Verifying…' },
  rename: { title: 'Rename profile', submit: 'Save name', busy: 'Saving…' },
  remove: { title: 'Remove profile', submit: 'Remove profile', busy: 'Removing…' }
};

export function openDashboard(url = DASHBOARD_URL) {
  return api.openExternal(url)
    .catch(error => toast('Could not open the Zernio dashboard. ' + errorMessage(error), { kind: 'error' }));
}

function keyField(id, label, hint) {
  const input = h('input', {
    class: 'input mono', id, type: 'password', autocomplete: 'off', autocapitalize: 'off',
    spellcheck: false, maxLength: 512, placeholder: 'sk_…', 'aria-describedby': id + '-hint'
  });
  const reveal = iconButton({ icon: 'eye', label: 'Show ' + label, size: 'sm', ghost: true, cls: 'conn-reveal' });
  function show(visible) {
    input.type = visible ? 'text' : 'password';
    reveal.setAttribute('aria-pressed', String(visible));
    reveal.setAttribute('aria-label', 'Show ' + label);
    reveal.title = visible ? 'Hide ' + label : 'Show ' + label;
    reveal.replaceChildren(icon(visible ? 'eye-slash' : 'eye'));
  }
  reveal.addEventListener('click', () => {
    show(input.type === 'password');
    input.focus();
  });
  show(false);

  const getKey = h('a', { class: 'conn-link', href: API_KEYS_URL, text: 'Create a key',
    onclick: event => { event.preventDefault(); openDashboard(API_KEYS_URL); } });
  const caption = h('div', { class: 'field__label' }, h('label', { htmlFor: id, text: label }), getKey);
  const field = h('div', { class: 'field' }, caption,
    h('div', { class: 'input-wrap' }, icon('key', { cls: 'input-wrap__lead' }), input,
      h('div', { class: 'input-wrap__trail' }, reveal)),
    h('div', { class: 'field__msg', id: id + '-hint', text: hint }));
  return { field, input, reveal, show };
}

/** The Zernio profiles the typed key can see. Loads once the key looks complete. */
function zernioProfileField(selected) {
  const select = h('select', { class: 'input', id: 'zernio-profile', 'aria-describedby': 'zernio-profile-hint' },
    h('option', { value: ALL_ACCOUNTS, text: 'All connected accounts' }));
  const hint = h('div', { class: 'field__msg', id: 'zernio-profile-hint',
    role: 'status',
    text: 'Paste your API key to list its Zernio profiles. Use one profile per YouTube channel or brand.' });
  const retry = button({ label: 'Retry profile lookup', icon: 'arrow-clockwise', size: 'sm', onClick: () => load() });
  retry.hidden = true;
  const field = h('div', { class: 'field' },
    h('label', { class: 'field__label', htmlFor: select.id, text: 'Zernio profile' }), select, hint, retry);
  let currentKey = '';
  let status = 'idle';
  let request = 0;
  let locked = false;

  function paint() {
    select.disabled = locked || status !== 'ready';
    retry.hidden = status !== 'error';
    retry.disabled = locked;
    field.setAttribute('aria-busy', String(status === 'loading'));
    hint.dataset.tone = status === 'error' ? 'error' : '';
  }

  function setKey(key) {
    if (key === currentKey) return;
    currentKey = key;
    request++;
    status = 'idle';
    select.replaceChildren(h('option', { value: '', text: 'Choose a Zernio profile' }));
    setText(hint, KEY_PATTERN.test(key) ? 'Checking the new key…' : 'Enter your API key to load its Zernio profiles.');
    paint();
  }

  async function load() {
    if (!KEY_PATTERN.test(currentKey) || ['ready', 'loading'].includes(status) || locked) return;
    const ticket = ++request;
    status = 'loading';
    paint();
    setText(hint, 'Loading Zernio profiles…');
    try {
      const profiles = await listZernioProfiles(currentKey);
      if (ticket !== request) return;
      if (!Array.isArray(profiles) || profiles.some(item => !item?.id || typeof item.name !== 'string')) {
        throw new Error('Zernio returned an unexpected profile list.');
      }
      const missing = selected && !profiles.some(item => item.id === selected);
      select.replaceChildren(missing && h('option', { value: selected, disabled: true, text: 'Saved Zernio profile unavailable' }),
        h('option', { value: ALL_ACCOUNTS, text: 'All connected accounts' }),
        ...profiles.map(item => h('option', { value: item.id, text: item.name + (item.isDefault ? ' (default)' : '') })));
      select.value = selected || ALL_ACCOUNTS;
      status = 'ready';
      setText(hint, missing ? 'Choose which accounts to use with this key.' : profiles.length > 1
        ? `${plural(profiles.length, 'Zernio profile')} found. Each one can hold one account per network.`
        : 'Posts go to the accounts connected in your Zernio dashboard.');
    } catch (error) {
      if (ticket !== request) return;
      status = 'error';
      setText(hint, errorMessage(error));
    } finally {
      if (ticket === request) paint();
    }
  }

  paint();
  return {
    field, select, setKey, load,
    lock(value) { locked = value; paint(); },
    get valid() { return status === 'ready' && select.selectedOptions[0] && !select.selectedOptions[0].disabled; }
  };
}

function announceConnected(profile) {
  const count = profile?.platforms.length ?? 0;
  if (count) {
    toast(profile.name + ' verified. ' + plural(count, 'destination') + ' linked.');
    return;
  }
  toast(profile?.name + ' verified. Connect YouTube or Instagram in your Zernio dashboard, then verify again.', {
    kind: 'info', action: { label: 'Open dashboard', run: () => openDashboard() }
  });
}

export function openProfileDialog(mode = 'add', profile = state.account) {
  if (state.accountPending || document.querySelector('dialog.conn[open]') || (mode !== 'add' && !profile)) return;
  const copy = { ...COPY[mode] };
  if (mode === 'keys' && profile?.needsKey) Object.assign(copy, { title: 'Add Zernio API key', submit: 'Verify and switch' });
  const editingKeys = mode === 'add' || mode === 'keys';
  const editingName = mode === 'add' || mode === 'rename';
  const removing = mode === 'remove';
  const name = editingName && h('input', {
    class: 'input', id: 'profile-name', required: true, maxLength: 60, value: mode === 'rename' ? profile.name : '',
    placeholder: 'For example, Comedy clips'
  });
  const key = editingKeys && keyField('profile-api-key', 'Zernio API key',
    'Stored with your operating system’s credential encryption. Zernio never shows a key twice, so keep a copy.');
  const zernioProfile = editingKeys && zernioProfileField(profile?.zernioProfile?.id);
  if (key) key.input.required = true;

  const errorText = h('div', { class: 'callout__body' });
  const error = h('div', { class: 'callout callout--bad', role: 'alert', hidden: true }, icon('warning-circle'), errorText);
  const controls = [name, key?.input, key?.reveal].filter(Boolean);
  const cancel = button({ label: 'Cancel', variant: 'ghost', onClick: () => dialog.close() });
  const submit = button({ label: copy.submit, variant: removing ? 'danger' : 'primary', type: 'submit' });
  const description = {
    add: 'Connect your social accounts in Zernio, then paste an API key here. The first two accounts are free.',
    keys: profile?.needsKey
      ? '“' + profile?.name + '” was set up for Ayrshare. Add a Zernio API key to keep its name and Autopilot settings.'
      : 'Update the Zernio API key saved for “' + profile?.name + '”.',
    rename: 'Choose a name you’ll recognize when publishing a clip.',
    remove: 'Remove “' + profile?.name + '” from 2PixelHack. Your Zernio account and its posts are not affected.'
  };
  const form = h('form', { class: 'dialog__panel' },
    h('header', { class: 'dialog__head' },
      h('div', { class: 'dialog__icon' }, icon(removing ? 'trash' : 'user-circle')),
      h('div', { class: 'dialog__title' },
        h('h2', { id: 'profile-dialog-title', text: copy.title }),
        h('p', { text: description[mode] }))),
    h('div', { class: 'dialog__body' },
      name && h('div', { class: 'field' }, h('label', { class: 'field__label', htmlFor: name.id, text: 'Profile name' }), name),
      key?.field, zernioProfile?.field, error),
    h('footer', { class: 'dialog__foot' }, cancel, submit));
  const dialog = h('dialog', { class: 'dialog conn', 'aria-labelledby': 'profile-dialog-title' }, form);
  let busy = false;
  let backdropDown = false;

  const loadProfiles = debounce(() => zernioProfile.load(), 450);
  if (key) {
    key.input.addEventListener('input', () => { zernioProfile.setKey(key.input.value.trim()); loadProfiles(); });
    key.input.addEventListener('blur', () => { loadProfiles.cancel(); void zernioProfile.load(); });
  }

  function pending(value) {
    busy = value;
    setBusy(submit, value, copy.busy);
    setText(cancel.querySelector('.btn__label'), value ? 'Close' : 'Cancel');
    for (const control of controls) control.disabled = value;
    zernioProfile?.lock(value);
    form.setAttribute('aria-busy', String(value));
  }

  function validate() {
    if (name) name.setCustomValidity(name.value.trim() ? '' : 'Enter a profile name.');
    if (key) key.input.setCustomValidity(KEY_PATTERN.test(key.input.value.trim()) ? '' : 'Enter a valid Zernio API key. It starts with sk_.');
    return form.reportValidity();
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    error.hidden = true;
    if (!validate()) return;
    if (zernioProfile && !zernioProfile.valid) {
      void zernioProfile.load();
      setText(errorText, 'Load the Zernio profiles and choose which accounts to use before saving.');
      error.hidden = false;
      if (!zernioProfile.select.disabled) zernioProfile.select.focus();
      return;
    }
    pending(true);
    try {
      const chosen = zernioProfile?.select.value ?? ALL_ACCOUNTS;
      if (mode === 'add') announceConnected(await addProfile(name.value, key.input.value, chosen));
      if (mode === 'keys') announceConnected(await updateProfileKeys(profile.id, key.input.value, chosen));
      if (mode === 'rename') {
        await renameProfile(profile.id, name.value);
        toast('Profile renamed.');
      }
      if (removing) {
        await removeProfile(profile.id);
        toast('Removed ' + profile.name + '.');
      }
      dialog.close();
    } catch (failure) {
      if (dialog.open) {
        setText(errorText, errorMessage(failure));
        error.hidden = false;
      } else toast(errorMessage(failure), { kind: 'error' });
    } finally {
      pending(false);
      if (dialog.open) submit.focus();
    }
  });
  form.addEventListener('input', event => {
    event.target.setCustomValidity?.('');
    error.hidden = true;
  });
  dialog.addEventListener('pointerdown', event => { backdropDown = event.target === dialog; });
  dialog.addEventListener('click', event => {
    if (backdropDown && event.target === dialog) dialog.close();
    backdropDown = false;
  });

  const opener = document.activeElement;
  document.body.append(dialog);
  openDialog(dialog, name || key?.input || cancel);
  dialog.addEventListener('close', () => {
    loadProfiles.cancel();
    zernioProfile?.setKey('');
    dialog.remove();
    if (opener instanceof HTMLElement && opener.closest('[hidden]')) {
      const fallback = document.querySelector('dialog[open] .sheet-close, [data-view="publishing"]:not([hidden]) #add-profile');
      fallback?.focus({ preventScroll: true });
    }
  });
}
