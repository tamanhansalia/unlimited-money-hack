import './styles/index.css';
import { $, isTyping } from './core/dom.js';
import { state, subscribe } from './core/store.js';
import { registerView, startRouter, navigate, hrefFor, openGeneration, refreshCurrentView, skipPageAnimation } from './core/router.js';
import { toast } from './core/toast.js';
import { setProgress } from './core/components.js';
import { startLibrarySync } from './core/library.js';
import { refreshAccount } from './core/account.js';
import { isActiveJob, startJobsSync } from './core/jobs.js';
import { createLibraryView } from './views/library.js';
import { createGenerateView } from './views/generate.js';
import { createJobsView } from './views/jobs.js';
import { createSourceView } from './views/source.js';
import { createPublishingView } from './views/publishing.js';
import { mountProfilePicker } from './views/profiles.js';
import { createSettingsView } from './views/settings.js';
import { createAutopilotView } from './views/autopilot.js';
import { startAutopilotSync } from './core/autopilot.js';

/* ───────── Views ───────── */
const views = {
  library: createLibraryView, generate: createGenerateView, jobs: createJobsView,
  source: createSourceView, publishing: createPublishingView, settings: createSettingsView, autopilot: createAutopilotView
};
for (const [name, create] of Object.entries(views)) registerView(name, create);

/* ───────── Sidebar ───────── */
const sidebar = $('#studio-sidebar');
const sidebarToggle = $('#sidebar-toggle');
const narrowWindow = matchMedia('(max-width: 920px)');
const sidebarPreference = 'vc:sidebar-collapsed';
let sidebarCollapsed;
try {
  const preference = localStorage.getItem(sidebarPreference);
  if (preference === 'true' || preference === 'false') sidebarCollapsed = preference === 'true';
} catch { /* Use the window width when storage is unavailable. */ }

function renderSidebar() {
  const collapsed = sidebarCollapsed ?? narrowWindow.matches;
  const value = String(collapsed);
  if (sidebar.dataset.collapsed === value) return;
  skipPageAnimation();
  const action = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  sidebar.dataset.collapsed = value;
  sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
  sidebarToggle.setAttribute('aria-label', action);
  sidebarToggle.title = action;
}

sidebarToggle.addEventListener('click', () => {
  sidebarCollapsed = sidebar.dataset.collapsed !== 'true';
  renderSidebar();
  try { localStorage.setItem(sidebarPreference, String(sidebarCollapsed)); } catch { /* Keep the current session's choice. */ }
});
narrowWindow.addEventListener('change', renderSidebar);
renderSidebar();
// Let the saved width paint before enabling transitions.
requestAnimationFrame(() => requestAnimationFrame(() => { sidebar.dataset.animate = ''; }));

function newClips() {
  openGeneration();
}
$('#new-clips').addEventListener('click', newClips);
const jobsButton = $('#sidebar-jobs');

function renderJobsButton() {
  const active = state.jobs.filter(isActiveJob);
  const count = active.length;
  const ring = $('#sidebar-jobs-ring');
  const badge = $('#sidebar-jobs-count');
  $('#sidebar-jobs-icon').hidden = Boolean(count);
  ring.hidden = badge.hidden = !count;
  if (count) {
    setProgress(ring, active.reduce((sum, job) => sum + job.progress, 0) / count);
    badge.textContent = count > 99 ? '99+' : String(count);
  }
  const label = count ? `Jobs, ${count} active` : 'Jobs';
  jobsButton.setAttribute('aria-label', label);
  jobsButton.title = label;
}
subscribe('jobs', renderJobsButton);

function renderAccountDot() {
  const missing = state.accountStatus === 'ready' && !state.account;
  $('#nav-publishing-dot').hidden = !missing;
  const publishingLink = $('[data-nav="publishing"]');
  const label = missing ? 'Publishing, account not connected' : 'Publishing';
  publishingLink.setAttribute('aria-label', label);
  publishingLink.title = label;
}
subscribe(['account', 'accountStatus'], renderAccountDot);

function renderAutopilotDot() {
  const live = state.autopilot.profiles.filter(profile => profile.state?.running || profile.state?.enabled).length;
  $('#nav-autopilot-dot').hidden = !live;
  const link = $('[data-nav="autopilot"]');
  const label = live ? `Autopilot, ${live} on` : 'Autopilot';
  link.setAttribute('aria-label', label);
  link.title = label;
}
subscribe('autopilot', renderAutopilotDot);

/* ───────── Shortcuts ───────── */
document.addEventListener('keydown', event => {
  if (document.querySelector('dialog[open]')) return;
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === 'n') { event.preventDefault(); newClips(); return; }
  if (event.key === 'F5' || (mod && event.key.toLowerCase() === 'r')) {
    event.preventDefault();
    void refreshCurrentView();
    return;
  }
  if (isTyping(event.target) || mod || event.altKey) return;
  if (event.key === 'n') { event.preventDefault(); newClips(); }
  else if (event.key === 'Backspace' && state.route.name === 'source') { event.preventDefault(); navigate(hrefFor.library()); }
});

/* ───────── Boot ───────── */
const unexpectedError = () => toast('Something went wrong. Refresh this page and check the result.', { kind: 'error' });
window.addEventListener('error', unexpectedError);
window.addEventListener('unhandledrejection', unexpectedError);
mountProfilePicker();
startRouter($('#stage'), $('#views'));
startLibrarySync();
refreshAccount();
startJobsSync();
startAutopilotSync();
renderJobsButton();
renderAccountDot();
