import { $, h, icon, reconcile, setText } from '../core/dom.js';
import { state, subscribe } from '../core/store.js';
import { selectProfile } from '../core/account.js';
import { errorMessage } from '../core/api.js';
import { toast } from '../core/toast.js';
import { spinner } from '../core/components.js';

async function switchProfile(id) {
  try {
    await selectProfile(id);
    return true;
  } catch (error) {
    toast(errorMessage(error), { kind: 'error' });
    return false;
  }
}

export function createProfileSelect() {
  const control = h('select', { class: 'input', 'aria-label': 'Publishing profile' });
  const el = h('label', { class: 'profile-select' },
    h('span', { class: 'field__label', text: 'Publishing profile' }), control);

  function paint() {
    reconcile(control, state.profiles, profile => profile.id,
      profile => h('option', { value: profile.id, text: profile.name }),
      (option, profile) => setText(option, profile.name));
    control.value = state.account?.id ?? '';
    control.disabled = state.accountPending || state.accountStatus !== 'ready' || state.profiles.length < 2;
    control.setAttribute('aria-busy', String(state.accountPending || state.accountStatus === 'loading'));
  }

  control.addEventListener('change', async () => {
    const focused = document.activeElement === control;
    await switchProfile(control.value);
    paint();
    if (focused && document.activeElement === document.body) control.focus();
  });

  return { el, paint };
}

export function mountProfilePicker() {
  const trigger = $('#sidebar-profile');
  const name = $('#sidebar-profile-name');
  const popover = $('#profile-picker');
  const list = $('#profile-picker-list');
  const note = h('p', { class: 'profile-picker__heading loading-state', role: 'status', hidden: true });
  popover.insertBefore(note, list);

  function paintItem(item, profile) {
    const active = state.account?.id === profile.id;
    item.setAttribute('aria-pressed', String(active));
    item.disabled = state.accountPending || state.accountStatus !== 'ready';
    setText(item.firstElementChild, profile.name);
    item.lastElementChild.hidden = !active;
  }

  function createItem(profile) {
    const item = h('button', { class: 'profile-picker__item', type: 'button', onclick: async () => {
      if (profile.id !== state.account?.id && !await switchProfile(profile.id)) return;
      if (popover.matches(':popover-open')) popover.hidePopover();
      trigger.focus();
    } }, h('span', { class: 'truncate' }), icon('check'));
    paintItem(item, profile);
    return item;
  }

  function paint() {
    const current = state.account?.name;
    setText(name, current || 'Publishing profile');
    trigger.title = current ? 'Switch publishing profile · ' + current : 'Switch publishing profile';
    trigger.setAttribute('aria-label', trigger.title);
    const status = state.accountStatus;
    const loading = status === 'idle' || status === 'loading' || state.accountPending;
    note.hidden = !loading && status === 'ready' && Boolean(state.profiles.length);
    if (!note.hidden) {
      note.replaceChildren(...(loading ? [spinner(), 'Updating profiles…']
        : [status === 'error' ? 'Could not load profiles. Open Publishing to retry.' : 'No publishing profiles yet.']));
    }
    reconcile(list, state.profiles, profile => profile.id, createItem, paintItem);
  }

  $('#manage-profiles').addEventListener('click', () => popover.hidePopover());
  subscribe(['profiles', 'account', 'accountPending', 'accountStatus'], paint);
  subscribe('route', () => { if (popover.matches(':popover-open')) popover.hidePopover(); });
  paint();
}
