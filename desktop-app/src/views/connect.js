// Connect dialog: one field for the Ayrshare API key, verified with Ayrshare before it is stored.
import { h, icon, setText, shake } from '../core/dom.js';
import { state } from '../core/store.js';
import { api, errorMessage } from '../core/api.js';
import { toast } from '../core/toast.js';
import { button, iconButton, setBusy, setFieldState } from '../core/components.js';
import { plural } from '../core/format.js';
import { connectAccount } from '../core/account.js';

const DASHBOARD_URL = 'https://app.ayrshare.com';
const MIN_LENGTH = 8;
const HINT = 'Find it in Ayrshare under API Key. It is stored with your OS credential encryption.';
const INTRO_NEW = 'Paste your Ayrshare API key. It is verified with Ayrshare before it is saved.';
const INTRO_REPLACE = 'Paste a new API key to replace the one saved on this computer. It is verified before it is saved.';

export function openDashboard() {
  api.openExternal(DASHBOARD_URL)
    .catch(error => toast(`Could not open the Ayrshare dashboard. ${errorMessage(error)}`, { kind: 'error' }));
}

/** code is '' when the key is acceptable, otherwise 'empty' | 'spaces' | 'short'. */
function validateKey(raw) {
  const key = raw.trim();
  if (!key) return { key, code: 'empty', message: 'Enter your Ayrshare API key.' };
  if (/\s/.test(key)) return { key, code: 'spaces', message: 'Remove the spaces inside the key. Paste it exactly as Ayrshare shows it.' };
  if (key.length < MIN_LENGTH) return { key, code: 'short', message: 'That key is too short. Copy the whole key from Ayrshare.' };
  return { key, code: '', message: '' };
}

function announceConnected(result) {
  const count = new Set(result?.platforms ?? state.account?.platforms).size;
  if (count) {
    toast(`Connected to Ayrshare. ${plural(count, 'destination')} linked.`);
    return;
  }
  toast('Connected to Ayrshare, but no destinations are linked yet. Link an account in your Ayrshare dashboard, then verify again.',
    { kind: 'info', action: { label: 'Open dashboard', run: openDashboard } });
}

function createDialog() {
  const inputId = 'conn-key';
  let busy = false;
  let touched = false;
  let opener = null;
  let pressStartedOnBackdrop = false;

  const intro = h('p');
  const input = h('input', {
    class: 'input mono', id: inputId, type: 'password', autocomplete: 'off', autocapitalize: 'off',
    placeholder: 'Paste your API key', 'aria-describedby': inputId + '-msg', 'aria-required': 'true'
  });
  input.setAttribute('spellcheck', 'false');
  const reveal = iconButton({ icon: 'eye', label: 'Show API key', size: 'sm', ghost: true, cls: 'conn-reveal' });
  reveal.setAttribute('aria-pressed', 'false');
  const message = h('div', { class: 'field__msg', id: inputId + '-msg', 'aria-live': 'polite' });
  const field = h('div', { class: 'field' },
    h('label', { class: 'field__label', for: inputId, text: 'API key' }),
    h('div', { class: 'input-wrap' },
      icon('key', { cls: 'input-wrap__lead' }),
      input,
      h('div', { class: 'input-wrap__trail' }, reveal)),
    message);

  const errorText = h('span', { class: 'selectable' });
  const error = h('div', { class: 'callout callout--bad conn-error fade-in', role: 'alert', hidden: true },
    icon('warning-circle'),
    h('div', { class: 'callout__body' }, h('strong', { text: 'Could not verify this key' }), errorText));

  const cancel = button({ label: 'Cancel', variant: 'ghost', onClick: () => dialog.close() });
  const submit = button({ label: 'Verify and connect', icon: 'shield-check', variant: 'primary', type: 'submit' });

  const form = h('form', { class: 'dialog__panel conn-panel', novalidate: true },
    h('div', { class: 'dialog__head' },
      h('div', { class: 'dialog__icon' }, icon('broadcast')),
      h('div', { class: 'dialog__title' }, h('h2', { id: 'conn-title', text: 'Connect Ayrshare' }), intro)),
    h('div', { class: 'dialog__body' }, field, error),
    h('div', { class: 'dialog__foot' }, cancel, submit));
  const dialog = h('dialog', { class: 'dialog conn', 'aria-labelledby': 'conn-title' }, form);
  document.body.append(dialog);

  /* Short keys are only flagged once the user leaves the field or submits; stray spaces are flagged at once. */
  function validate() {
    const check = validateKey(input.value);
    const visible = Boolean(check.code) && (touched || check.code === 'spaces');
    setFieldState(field, input, visible ? 'error' : '', visible ? check.message : '', HINT);
    return check;
  }

  function setPending(pending) {
    busy = pending;
    setBusy(submit, pending, 'Verifying…');
    input.disabled = pending;
    reveal.disabled = pending;
    cancel.disabled = pending;
    form.setAttribute('aria-busy', String(pending));
  }

  function setRevealed(show) {
    input.type = show ? 'text' : 'password';
    reveal.setAttribute('aria-pressed', String(show));
    reveal.replaceChildren(icon(show ? 'eye-slash' : 'eye'));
  }

  function reset() {
    input.value = '';
    touched = false;
    setRevealed(false);
    error.hidden = true;
    setFieldState(field, input, '', '', HINT);
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (busy) return;
    touched = true;
    const check = validate();
    if (check.code) {
      shake(field);
      input.focus();
      return;
    }
    error.hidden = true;
    setPending(true);
    try {
      const result = await connectAccount(check.key);
      setPending(false);
      dialog.close();
      announceConnected(result);
    } catch (failure) {
      setPending(false);
      setText(errorText, errorMessage(failure));
      error.hidden = false;
      input.focus();
      input.select();
    }
  }

  form.addEventListener('submit', onSubmit);
  input.addEventListener('input', () => { error.hidden = true; validate(); });
  input.addEventListener('blur', () => {
    if (!input.value) return;
    touched = true;
    validate();
  });
  reveal.addEventListener('click', () => {
    setRevealed(input.type === 'password');
    input.focus();
  });

  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  // A second Esc press can close the dialog even when the first cancel was prevented, so reopen while a request is in flight.
  dialog.addEventListener('close', () => {
    if (busy) { dialog.showModal(); return; }
    reset();
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    opener = null;
  });
  // Close on a backdrop click, but not when a text selection started inside the panel and ended outside it.
  dialog.addEventListener('pointerdown', event => { pressStartedOnBackdrop = event.target === dialog; });
  dialog.addEventListener('click', event => {
    if (pressStartedOnBackdrop && event.target === dialog && !busy) dialog.close();
    pressStartedOnBackdrop = false;
  });

  reset();

  return {
    open() {
      if (dialog.open) return;
      opener = document.activeElement;
      setText(intro, state.account?.hasKey ? INTRO_REPLACE : INTRO_NEW);
      dialog.showModal();
      input.focus();
    }
  };
}

let controller = null;

export function openConnectDialog() {
  controller ||= createDialog();
  controller.open();
}
