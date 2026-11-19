import './styles.css';
import { generationOptions } from './views/generation-options.js';
import { $, isTyping } from './core/dom.js';
import { state, subscribe } from './core/store.js';
import { registerView, startRouter, navigate, hrefFor } from './core/router.js';
import { api } from './core/api.js';
import { setProgress } from './core/components.js';
import { startLibrarySync, refreshLibrary } from './core/library.js';
import { refreshAccount } from './core/account.js';
import { stageLabel } from './core/jobs.js';
import { createLibraryView, focusComposer } from './views/library.js';
import { createSourceView } from './views/source.js';
import { createPublishingView } from './views/publishing.js';

/* ───────── Views ───────── */
const views = {
  library: createLibraryView(),
  source: createSourceView(),
  publishing: createPublishingView()
};
for (const [name, view] of Object.entries(views)) {
  view.el.classList.add('view');
  view.el.dataset.view = name;
  view.el.hidden = true;
  $('#views').append(view.el);
  registerView(name, view);
}

/* ───────── Top bar ───────── */
function newClips() {
  if (state.route.name !== 'library') navigate(hrefFor.library());
  requestAnimationFrame(() => focusComposer());
}
$('#generation-settings').addEventListener('click', () => generationOptions());
$('#new-clips').addEventListener('click', newClips);
$('#job-pill').addEventListener('click', () => {
  if (state.route.name !== 'library') navigate(hrefFor.library());
  requestAnimationFrame(() => focusComposer({ reveal: true }));
});

function renderJobPill() {
  const job = state.job;
  const pill = $('#job-pill');
  const visible = job.status === 'running' || ((job.status === 'done' || job.status === 'error') && !job.dismissed);
  pill.hidden = !visible;
  if (!visible) return;
  pill.dataset.status = job.status;
  setProgress($('#job-pill-ring'), job.status === 'running' ? job.progress : 1);
  $('#job-pill-text').textContent = job.status === 'running' ? stageLabel(job)
    : job.status === 'done' ? `${job.addedCount || 0} new ${job.addedCount === 1 ? 'clip' : 'clips'} ready`
    : 'Generation failed';
}
subscribe('job', renderJobPill);

function renderAccountDot() {
  const missing = state.accountStatus === 'ready' && !state.account?.hasKey;
  $('#nav-publishing-dot').hidden = !missing;
}
subscribe(['account', 'accountStatus'], renderAccountDot);

/* ───────── Shortcuts ───────── */
document.addEventListener('keydown', event => {
  if (document.querySelector('dialog[open]')) return;
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === 'n') { event.preventDefault(); newClips(); return; }
  if (event.key === 'F5' || (mod && event.key.toLowerCase() === 'r')) {
    event.preventDefault();
    if (state.route.name === 'publishing') refreshAccount({ force: true }); else refreshLibrary();
    return;
  }
  if (isTyping(event.target) || mod || event.altKey) return;
  if (event.key === 'n') { event.preventDefault(); newClips(); }
  else if (event.key === 'Backspace' && state.route.name === 'source') { event.preventDefault(); navigate(hrefFor.library()); }
});

/* ───────── Boot ───────── */
startRouter($('#stage'));
startLibrarySync();
refreshAccount();
renderJobPill();
renderAccountDot();
void api;
