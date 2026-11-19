import { h, icon } from '../core/dom.js';
import { api, errorMessage } from '../core/api.js';
import { openDialog } from '../core/components.js';

const key = 'vc:generation-settings';
let active = false;

function defaults() {
  try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; }
}

/** Settings edits the saved defaults. The Generate dialog chooses options for one run. */
export function generationOptions(forRun = false) {
  if (active) return Promise.resolve(null);
  active = true;
  const saved = defaults();
  const cli = h('select', { class: 'input', id: 'generation-cli', disabled: true });
  const language = h('select', { class: 'input', id: 'spoken-language' },
    h('option', { value: 'hi', text: 'Hindi or Hinglish' }),
    h('option', { value: 'en', text: 'English' }),
    h('option', { value: 'auto', text: 'Auto-detect' }));
  language.value = ['en', 'auto'].includes(saved.language) ? saved.language : 'hi';
  const status = h('p', { class: 'field__msg', role: 'status', text: 'Checking installed CLIs…' });
  const showCommand = () => {
    confirm.disabled = !cli.value;
    status.textContent = cli.value
      ? `Terminal command: ${cli.value}. Sign in there before generating.`
      : 'Your saved CLI is unavailable. Choose an installed CLI.';
  };
  const cancel = h('button', { class: 'btn', type: 'button', text: 'Cancel' });
  const confirm = h('button', { class: 'btn btn--primary', type: 'submit', disabled: true,
    text: forRun ? 'Start generation' : 'Save settings' });
  const form = h('form', { class: 'dialog__panel' },
    h('div', { class: 'dialog__head' }, h('span', { class: 'dialog__icon' }, icon(forRun ? 'sparkle' : 'gear')),
      h('div', { class: 'dialog__title' }, h('h2', { id: 'generation-heading', text: forRun ? 'Generate clips' : 'Generation settings' }),
        h('p', { text: 'Your selected CLI receives the transcript to choose highlights and write clip details.' }))),
    h('div', { class: 'dialog__body' },
      h('div', { class: 'field' }, h('label', { htmlFor: cli.id, text: forRun ? 'AI CLI for this run' : 'Default AI CLI' }), cli, status),
      h('div', { class: 'field' }, h('label', { htmlFor: language.id, text: 'Spoken language in the source' }), language),
      h('div', { class: 'field' }, h('strong', { text: 'Output language' }),
        h('p', { text: 'Roman Hinglish for subtitles, titles, descriptions, tags and X posts.' }))),
    h('div', { class: 'dialog__foot' }, cancel, confirm));
  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'generation-heading' }, form);
  document.body.append(dialog);
  let choice = null;
  cancel.onclick = () => dialog.close();
  form.onsubmit = event => {
    event.preventDefault();
    if (confirm.disabled || !cli.value) return;
    const selected = { provider: cli.value, language: language.value };
    if (!forRun) {
      try { localStorage.setItem(key, JSON.stringify(selected)); }
      catch { status.textContent = 'Could not save settings on this device.'; return; }
    }
    choice = selected;
    dialog.close();
  };
  openDialog(dialog, cancel);
  api.listClis().then(list => {
    if (!dialog.open) return;
    const installed = list.filter(item => item.installed);
    for (const item of list) cli.append(h('option', { value: item.id, disabled: !item.installed,
      text: item.label + (item.installed ? ' · installed' : ' · not found') }));
    cli.disabled = !installed.length;
    if (installed.length) {
      cli.value = saved.provider || installed[0].id;
      if (!installed.some(item => item.id === cli.value)) cli.selectedIndex = -1;
      cli.onchange = showCommand;
      showCommand();
    } else {
      status.textContent = 'Install Codex CLI, Claude Code or Gemini CLI, sign in, then reopen this panel.';
    }
  }).catch(error => { status.textContent = 'Could not check installed CLIs. ' + errorMessage(error); });
  return new Promise(resolve => dialog.addEventListener('close', () => {
    active = false;
    dialog.remove();
    resolve(choice);
  }, { once: true }));
}
