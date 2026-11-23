import { h, icon } from '../core/dom.js';
import { button, openDialog, setBusy } from '../core/components.js';
import { errorMessage } from '../core/api.js';
import { plural } from '../core/format.js';
import { deleteClips } from '../core/library.js';
import { sourceTitle } from '../core/sources.js';
import { toast } from '../core/toast.js';

export function confirmDeleteClips({ source, clip, beforeDelete }) {
  if ((!source && !clip) || document.querySelector('#delete-clips-heading')) return Promise.resolve(false);
  const clips = source?.clips ?? [clip];
  const title = source ? sourceTitle(source) : clip.title || 'Untitled clip';
  const selection = source
    ? [source.readyCount && `${source.readyCount} Ready`, source.completedCount && `${source.completedCount} Completed`].filter(Boolean).join(', ')
    : clip.status === 'ready' ? 'Ready' : 'Completed';
  const metadata = clips.length === 1 ? 'its metadata' : 'their metadata';
  const failure = h('p', { class: 'callout callout--bad', role: 'alert', hidden: true });
  const cancel = button({ label: 'Cancel', onClick: () => dialog.close() });
  const confirm = button({ label: 'Move to Trash', icon: 'trash', variant: 'danger', onClick: runDeletion });
  const dialog = h('dialog', {
    class: 'dialog', 'aria-labelledby': 'delete-clips-heading', 'aria-describedby': 'delete-clips-description'
  }, h('div', { class: 'dialog__panel' },
    h('div', { class: 'dialog__head' },
      h('span', { class: 'dialog__icon' }, icon('trash')),
      h('div', { class: 'dialog__title' },
        h('h2', { id: 'delete-clips-heading', text: source ? 'Delete source group?' : 'Delete clip?' }))),
    h('div', { class: 'dialog__body' },
      h('strong', { class: 'delete-clips__name', text: title }),
      h('p', { id: 'delete-clips-description',
        text: `Move ${plural(clips.length, 'generated clip')} (${selection}) and ${metadata} to Trash.` }), failure),
    h('div', { class: 'dialog__foot' }, cancel, confirm)));

  let removed = false;
  let busy = false;
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });

  async function runDeletion() {
    if (busy) return;
    busy = true;
    failure.hidden = true;
    cancel.disabled = true;
    setBusy(confirm, true, 'Moving to Trash…');
    try {
      beforeDelete?.();
      await deleteClips(clips, source?.key ?? null);
      removed = true;
      toast(`${plural(clips.length, 'clip')} moved to Trash.`);
      dialog.close();
    } catch (error) {
      failure.textContent = errorMessage(error);
      failure.hidden = false;
    } finally {
      busy = false;
      cancel.disabled = false;
      setBusy(confirm, false);
      if (dialog.open) confirm.focus();
    }
  }

  return new Promise(resolve => {
    dialog.addEventListener('close', () => { dialog.remove(); resolve(removed); }, { once: true });
    document.body.append(dialog);
    openDialog(dialog, cancel);
  });
}
