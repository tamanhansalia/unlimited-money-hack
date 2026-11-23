// Publishing page: the Zernio connection, linked destinations and a short explainer.
import { h, icon, reconcile, setText, stagger } from '../core/dom.js';
import { state, subscribe } from '../core/store.js';
import { ago, plural } from '../core/format.js';
import { errorMessage } from '../core/api.js';
import { toast } from '../core/toast.js';
import { button, chip, setBusy, spinner } from '../core/components.js';
import { SUPPORTED, platformInfo, refreshAccount, reverifyAccount } from '../core/account.js';
import { DASHBOARD_URL, openProfileDialog, openDashboard } from './connect.js';
import { createProfileSelect } from './profiles.js';

const FACT_LABELS = ['API key', 'Last verified', 'Destinations'];
const NOT_LINKED_HINT = 'Connect it in your Zernio dashboard, then verify again.';
const STEPS = [
  'Each clip is uploaded to Zernio from this computer.',
  'It is posted to every destination you pick, then moved to Completed.',
  'If a send fails partway, retrying skips destinations that already accepted the post, so nothing is posted twice.'
];
const NO_VALUE = { text: '—', muted: true };

/* ───────── Pure helpers ───────── */

/** Everything the page shows, derived from the store. */
function describe() {
  const { account, accountStatus, accountError } = state;
  const failed = accountStatus === 'error';
  const linked = new Set(account?.platforms);
  return {
    account,
    failed,
    first: !account && (accountStatus === 'idle' || accountStatus === 'loading'),
    checking: accountStatus === 'loading',
    connected: Boolean(account),
    legacy: Boolean(account?.needsKey),
    error: accountError,
    linked,
    rows: [...new Set([...SUPPORTED, ...linked])]
  };
}

function verifiedAt(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return { text: ago(ms), title: new Date(ms).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' }) };
}

function factValues(vm) {
  if (!vm.account) return [NO_VALUE, NO_VALUE, NO_VALUE];
  const verified = verifiedAt(vm.account.lastVerified);
  if (vm.legacy) return [{ text: 'Needs a Zernio key', muted: true }, { text: 'Never', muted: true }, { text: 'None yet', muted: true }];
  return [
    vm.connected ? { text: 'Stored securely' } : { text: 'Not added', muted: true },
    verified || { text: 'Never', muted: true },
    vm.connected ? { text: `${vm.linked.size} of ${vm.rows.length} linked` } : { text: 'None yet', muted: true }
  ];
}

function statusOf(vm, verifying) {
  if (verifying) return { key: 'verifying', text: 'Verifying…', busy: true };
  if (state.accountPending) return { key: 'changing', text: 'Updating profiles…', busy: true };
  if (vm.first || vm.checking) return { key: 'checking', text: 'Checking…', busy: true };
  if (vm.failed) return { key: 'bad', text: 'Unavailable', kind: 'bad' };
  if (vm.legacy) return { key: 'legacy', text: 'Needs Zernio key', kind: 'warn' };
  if (vm.connected) return { key: 'ok', text: 'Connected', kind: 'ok' };
  return { key: 'idle', text: 'Not connected' };
}

function noteFor(vm) {
  if (vm.legacy) return 'This profile was set up for Ayrshare. Add a Zernio API key to see and post to its accounts.';
  if (vm.first || vm.connected) return '';
  return vm.failed
    ? 'Destination status is unavailable until the connection check works.'
    : 'Add a publishing profile to see its linked accounts.';
}

/** Swap the content of `slot` only when `key` changed, so chips are not rebuilt on every store tick. */
function setSlot(slot, key, make) {
  if (slot.dataset.s === key) return;
  slot.dataset.s = key;
  const node = make();
  if (node) slot.replaceChildren(node); else slot.replaceChildren();
}

function busyChip(text) {
  const node = chip(text);
  node.prepend(spinner('sm'));
  return node;
}

/* ───────── Destination rows ───────── */

function updateRow(node, id, vm) {
  const { name, hint, state: slot } = node._refs;
  const linked = vm.linked.has(id);
  const accountLabel = vm.account?.destinations[id];
  setText(name, platformInfo(id).name);
  hint.hidden = !vm.connected || (linked && !accountLabel);
  setText(hint, linked ? accountLabel : NOT_LINKED_HINT);
  const key = !vm.connected ? 'none' : linked ? 'linked' : 'unlinked';
  setSlot(slot, key, () => {
    if (key === 'linked') return chip('Linked', { kind: 'ok', dot: true });
    return key === 'unlinked' ? chip('Not linked', { dot: true }) : null;
  });
}

function createRow(id, vm) {
  const refs = {
    name: h('strong', { class: 'pub-dest__name truncate' }),
    hint: h('span', { class: 'pub-dest__hint' }),
    state: h('span', { class: 'pub-dest__state' })
  };
  const node = h('li', { class: 'pub-dest__row' },
    h('span', { class: 'pub-dest__tile' }, icon(platformInfo(id).icon)),
    h('div', { class: 'pub-dest__text' }, refs.name, refs.hint),
    refs.state);
  node._refs = refs;
  updateRow(node, id, vm);
  return node;
}

function skeletonRow() {
  return h('li', { class: 'pub-dest__row' },
    h('span', { class: 'skeleton pub-skel-tile' }),
    h('div', { class: 'pub-dest__text' },
      h('span', { class: 'skeleton skeleton--line pub-skel-name' }),
      h('span', { class: 'skeleton skeleton--line pub-skel-hint' })),
    h('span', { class: 'skeleton skeleton--pill pub-skel-chip' }));
}

/* ───────── Card builders ───────── */

function buildConnection({ onVerify, onRetry }) {
  const status = h('div', { class: 'pub-conn__status', role: 'status' });
  const facts = FACT_LABELS.map(label => ({
    label,
    value: h('dd', { class: 'pub-fact__v' })
  }));

  const errorText = h('span', { class: 'selectable' });
  const retry = button({ label: 'Try again', icon: 'arrow-clockwise', size: 'sm', cls: 'pub-error__retry', onClick: onRetry });
  const error = h('div', { class: 'callout callout--bad pub-error', role: 'alert', hidden: true },
    icon('warning-circle'),
    h('div', { class: 'callout__body' }, h('strong', { text: 'Connection problem' }), errorText),
    retry);

  const skeleton = h('span', { class: 'skeleton skeleton--pill pub-actions__skeleton' });
  const name = h('h2', { class: 'pub-conn__name', id: 'pub-conn-title' });
  const description = h('p', { class: 'pub-conn__desc' });
  const rename = button({ label: 'Rename', icon: 'pencil-simple', onClick: () => openProfileDialog('rename') });
  const replace = button({ label: 'Update API key', icon: 'key', onClick: () => openProfileDialog('keys') });
  const remove = button({ label: 'Remove', icon: 'trash', onClick: () => openProfileDialog('remove') });
  const verify = button({ label: 'Verify again', icon: 'arrows-clockwise', onClick: onVerify });
  const dashboard = h('a', { class: 'pub-link', href: DASHBOARD_URL, onclick: event => { event.preventDefault(); openDashboard(); } },
    h('span', { text: 'Open Zernio dashboard' }),
    icon('arrow-square-out'));

  const root = h('section', { class: 'pub-card pub-conn glass', 'aria-labelledby': 'pub-conn-title' },
    h('header', { class: 'pub-conn__head' },
      h('div', { class: 'pub-mark' }, icon('broadcast')),
      h('div', { class: 'pub-conn__id' }, name, description),
      status),
    h('dl', { class: 'pub-facts' }, facts.map(fact => h('div', { class: 'pub-fact' }, h('dt', { class: 'pub-fact__k', text: fact.label }), fact.value))),
    error,
    h('div', { class: 'pub-actions' }, skeleton, verify, rename, replace, remove, dashboard));

  return { root, status, facts, error, errorText, retry, skeleton, name, description, rename, replace, remove, verify };
}

function buildDestinations() {
  const noteText = h('div', { class: 'callout__body' });
  const note = h('div', { class: 'callout pub-note', hidden: true }, icon('info'), noteText);
  const list = h('ul', { class: 'pub-dest', 'aria-label': 'Destinations' });
  const skeleton = h('ul', { class: 'pub-dest', 'aria-hidden': 'true' }, Array.from(SUPPORTED, () => skeletonRow()));

  const root = h('section', { class: 'pub-card pub-dest-card glass', 'aria-labelledby': 'pub-dest-title' },
    h('header', { class: 'pub-card__head' },
      h('h2', { class: 'pub-card__title', id: 'pub-dest-title', text: 'Destinations' }),
      h('p', { class: 'pub-card__sub', text: 'Social accounts linked to the selected profile.' })),
    note, skeleton, list);

  return { root, note, noteText, list, skeleton };
}

function buildHow() {
  return h('section', { class: 'pub-card pub-how surface', 'aria-labelledby': 'pub-how-title' },
    h('h2', { class: 'pub-card__title', id: 'pub-how-title', text: 'How publishing works' }),
    h('ol', { class: 'pub-steps' }, STEPS.map((text, index) => h('li', { class: 'pub-step' },
      h('span', { class: 'pub-step__n num', 'aria-hidden': 'true', text: String(index + 1) }),
      h('span', { class: 'pub-step__t', text })))));
}

/* ───────── View ───────── */

export function createPublishingView() {
  let visible = false;
  let introduced = false;
  let awaitingReveal = false;
  let verifying = false;
  let retrying = false;

  const conn = buildConnection({ onVerify: verify, onRetry: retry });
  const dest = buildDestinations();
  const how = buildHow();
  const profileSelect = createProfileSelect();
  const add = button({ label: 'Add profile', icon: 'plus', variant: 'primary', onClick: () => openProfileDialog() });
  add.id = 'add-profile';

  const el = h('section', { class: 'pub', 'aria-labelledby': 'pub-title' },
    h('header', { class: 'page-head' },
      h('div', null,
        h('h1', { class: 'page-title', id: 'pub-title', text: 'Publishing' }),
        h('p', { class: 'page-sub', text: 'Manage which social accounts you post clips to.' })),
      h('div', { class: 'pub-profile-controls' }, profileSelect.el, add)),
    h('div', { class: 'pub-grid' }, conn.root, dest.root, how));

  // A hidden view never re-renders; enter() paints the latest state.
  const paint = () => { if (visible) render(); };
  subscribe(['account', 'profiles', 'accountStatus', 'accountError', 'accountPending'], paint);

  async function refresh(force) {
    try {
      await refreshAccount({ force });
    } catch (error) {
      toast(`Could not check the connection. ${errorMessage(error)}`, { kind: 'error' });
    }
  }

  async function retry() {
    if (retrying) return;
    retrying = true;
    setBusy(conn.retry, true, 'Checking…');
    paint();
    try { await refresh(true); }
    finally {
      retrying = false;
      setBusy(conn.retry, false);
      paint();
    }
  }

  async function verify() {
    if (verifying) return;
    verifying = true;
    setBusy(conn.verify, true, 'Verifying…');
    paint();
    let failure = '';
    try {
      await reverifyAccount();
      if (state.accountStatus === 'error') failure = state.accountError || 'Zernio did not respond.';
    } catch (error) {
      failure = errorMessage(error);
    } finally {
      verifying = false;
      setBusy(conn.verify, false);
      paint();
    }
    if (failure) toast(`Could not verify the connection. ${failure}`, { kind: 'error' });
    else announceVerified();
  }

  function announceVerified() {
    const count = new Set(state.account?.platforms).size;
    if (count) {
      toast(`Connection verified. ${plural(count, 'destination')} linked.`);
      return;
    }
    toast('Connection verified, but no destinations are linked yet. Connect one in your Zernio dashboard, then verify again.',
      { kind: 'info', action: { label: 'Open dashboard', run: () => openDashboard() } });
  }

  function renderConnection(vm) {
    const status = statusOf(vm, verifying);
    setSlot(conn.status, status.key, () => (status.busy ? busyChip(status.text) : chip(status.text, { kind: status.kind, dot: true })));
    conn.root.setAttribute('aria-busy', String(status.busy === true));
    setText(conn.name, vm.account?.name ?? 'Zernio');
    setText(conn.description, !vm.account ? 'Connect your social accounts in Zernio, then add its API key here.'
      : vm.legacy ? 'Set up for Ayrshare · add a Zernio API key to publish'
        : vm.account.zernioProfile ? 'Zernio profile · ' + vm.account.zernioProfile.name : 'All connected Zernio accounts');
    setText(conn.replace.querySelector('.btn__label'), vm.legacy ? 'Add Zernio key' : 'Update API key');

    const values = factValues(vm);
    conn.facts.forEach((fact, index) => {
      const value = values[index];
      fact.value.classList.toggle('skeleton', vm.first);
      fact.value.classList.toggle('is-muted', !vm.first && Boolean(value.muted));
      setText(fact.value, vm.first ? '' : value.text);
      fact.value.title = vm.first ? '' : value.title || '';
    });

    conn.error.hidden = !vm.error;
    setText(conn.errorText, vm.error);

    conn.skeleton.hidden = !vm.first;
    for (const action of [conn.rename, conn.replace, conn.remove, conn.verify]) {
      action.hidden = !vm.connected || (vm.legacy && action === conn.verify);
      action.disabled = state.accountPending || state.accountStatus !== 'ready';
    }
  }

  function renderDestinations(vm) {
    dest.root.setAttribute('aria-busy', String(vm.first));
    dest.skeleton.hidden = !vm.first;
    dest.list.hidden = vm.first;
    const note = noteFor(vm);
    dest.note.hidden = !note;
    setText(dest.noteText, note);
    if (vm.first) {
      awaitingReveal = true;
      return;
    }

    dest.list.classList.toggle('is-dim', !vm.connected);
    const rows = reconcile(dest.list, vm.rows, id => id, id => createRow(id, vm), (node, id) => updateRow(node, id, vm));
    // Only animate rows in when they replace the skeleton; otherwise the cards' own entrance is enough.
    if (awaitingReveal) {
      awaitingReveal = false;
      stagger(rows);
    }
  }

  function render() {
    const vm = describe();
    profileSelect.el.hidden = !vm.account;
    profileSelect.paint();
    add.disabled = state.accountPending || state.accountStatus !== 'ready';
    renderConnection(vm);
    renderDestinations(vm);
  }

  function enter() {
    visible = true;
    if (state.accountStatus === 'idle' || state.accountStatus === 'error') refresh(false);
    render();
    if (!introduced) {
      introduced = true;
      stagger([conn.root, dest.root, how]);
    }
  }

  function leave() {
    visible = false;
  }

  return { el, enter, leave, refresh: retry };
}
