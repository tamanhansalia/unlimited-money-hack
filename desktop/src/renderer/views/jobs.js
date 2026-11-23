import { h, icon, reconcile, setText } from '../core/dom.js';
import { button, chip, emptyState, progressBar, setBusy, setProgress, spinner } from '../core/components.js';
import { plural } from '../core/format.js';
import { cancelJob, dismissJob, getJob, isActiveJob, refreshJobs, stageLabel } from '../core/jobs.js';
import { hrefFor, openGeneration } from '../core/router.js';
import { state, subscribe } from '../core/store.js';

const FILTERS = [
  { label: 'All jobs', empty: 'No jobs yet' },
  { label: 'Active', empty: 'No active jobs' },
  { label: 'History', empty: 'No finished jobs' }
];

const STATUSES = {
  queued: { label: 'Queued' },
  running: { label: 'Running', kind: 'ready' },
  done: { label: 'Completed', kind: 'ok' },
  error: { label: 'Failed', kind: 'bad' },
  cancelled: { label: 'Cancelled' }
};

function jobMessage(job) {
  switch (job.status) {
    case 'queued': return job.cancelling ? stageLabel(job) : 'Waiting to start.';
    case 'done': return job.addedCount ? `${plural(job.addedCount, 'clip')} generated` : 'No clips found.';
    case 'error': return job.error || 'Generation failed.';
    case 'cancelled': return job.saved ? `${plural(job.saved, 'clip')} saved before stopping` : 'Job stopped.';
    default: return stageLabel(job);
  }
}

function createRow(job, sourceKey) {
  const title = h('h2', { class: 'job__title', id: `job-${job.id}`, tabindex: -1 });
  const badge = h('span', { class: 'job__badge' });
  const message = h('p', { class: 'job__message selectable', role: 'status' });
  const bar = progressBar();
  bar.setAttribute('aria-labelledby', title.id);
  const percent = h('span', { class: 'job__percent num', 'aria-hidden': 'true' });
  const progress = h('div', { class: 'job__progress' }, bar, percent);
  const stop = button({ label: 'Stop', icon: 'stop', variant: 'danger', size: 'sm', onClick: () => cancelJob(job.id) });
  const stopLabel = stop.querySelector('.btn__label');
  const view = h('a', { class: 'btn btn--sm' }, 'View clips', icon('arrow-right'));
  const retry = button({ label: 'Use settings again', size: 'sm', onClick: () => {
    const previous = getJob(job.id);
    if (previous) openGeneration(previous);
  } });
  const manage = h('a', { class: 'btn btn--sm', href: hrefFor.autopilot() }, 'Manage in Autopilot', icon('arrow-right'));
  const dismiss = button({ label: 'Dismiss', variant: 'ghost', size: 'sm', onClick: () => dismissJob(job.id) });
  const log = h('pre', { class: 'job__log mono', tabindex: 0, 'aria-label': 'Engine output' });
  const details = h('details', { class: 'job__output' },
    h('summary', null, icon('caret-right'), 'Engine output'), log);
  const row = h('li', { class: 'job surface', 'aria-labelledby': title.id },
    h('div', { class: 'job__head' },
      h('span', { class: 'job__source-icon' }, icon(job.kind === 'url' ? 'youtube-logo' : 'file-video')),
      h('div', { class: 'job__source' },
        h('div', { class: 'job__identity' }, title, badge,
          job.autopilot && chip(job.autopilot, { icon: 'robot', title: 'Autopilot profile' })),
        message),
      h('div', { class: 'job__actions' }, stop, view, retry, manage, dismiss)),
    progress, details);
  row.refs = { title, badge, message, progress, bar, percent, stop, stopLabel, view, retry, manage, dismiss, log, details };
  paintRow(row, job, sourceKey);
  return row;
}

function paintRow(row, job, sourceKey) {
  if (row.job === job && row.sourceKey === sourceKey) return;
  const { title, badge, message, progress, bar, percent, stop, stopLabel, view, retry, manage, dismiss, log, details } = row.refs;
  if (row.job?.status !== job.status) {
    const status = STATUSES[job.status];
    badge.replaceChildren(chip(status.label, { kind: status.kind, dot: true }));
  }
  row.job = job;
  row.sourceKey = sourceKey;
  setText(title, job.label || 'Video');
  setText(message, jobMessage(job));

  const active = isActiveJob(job);
  progress.hidden = job.status !== 'running';
  if (!progress.hidden) {
    const value = Math.round(job.progress * 100);
    setProgress(bar, job.progress);
    bar.setAttribute('aria-valuenow', String(value));
    setText(percent, `${value}%`);
  }

  const focused = document.activeElement;
  stop.hidden = !active || Boolean(job.autopilot);
  setBusy(stop, job.cancelling, 'Stopping…');
  stop.disabled = job.cancelling || job.finalizing;
  stop.setAttribute('aria-label', `${job.status === 'queued' ? 'Cancel' : 'Stop'} job for ${title.textContent}`);
  setText(stopLabel, job.cancelling ? 'Stopping…' : job.status === 'queued' ? 'Cancel' : 'Stop');
  dismiss.hidden = active;
  setBusy(dismiss, job.dismissing, 'Dismissing…');
  retry.hidden = active || Boolean(job.autopilot);
  manage.hidden = !active || !job.autopilot;
  view.hidden = active || !sourceKey;
  if (sourceKey) view.href = hrefFor.source(sourceKey);
  if (focused === stop && stop.disabled) title.focus({ preventScroll: true });
  else if ([stop, manage, view].includes(focused) && focused.hidden) dismiss.focus({ preventScroll: true });

  details.hidden = !job.log;
  setText(log, job.log);
}

export function createJobsView() {
  let selected = 0;
  let currentJobId;
  let clips;
  const clipSources = new Map();
  const heading = h('h1', { class: 'page-title', id: 'jobs-title', tabindex: -1, text: 'Jobs' });
  const filters = h('div', { class: 'seg jobs__filters', role: 'group', 'aria-label': 'Filter jobs' });
  const list = h('ul', { class: 'jobs__list', 'aria-label': 'Clip jobs' });
  const empty = emptyState({ icon: 'queue', title: FILTERS[0].empty, text: 'Videos you submit for clipping will appear here.' });
  empty.classList.add('jobs__empty', 'surface');
  const emptyTitle = empty.querySelector('h2');
  const emptyText = empty.querySelector('p');
  const loading = h('p', { class: 'loading-state', role: 'status', hidden: true }, spinner(), 'Loading job history…');
  const failureText = h('span');
  const failure = h('div', { class: 'callout callout--bad', role: 'alert', hidden: true },
    icon('warning-circle'), h('div', { class: 'callout__body' }, h('strong', { text: 'Could not load job history' }), failureText),
    button({ label: 'Try again', size: 'sm', onClick: refreshJobs }));
  const missing = h('p', { class: 'callout callout--warn', role: 'status', hidden: true },
    icon('warning'), 'This job is no longer available.');
  const options = FILTERS.map(({ label }, index) => {
    const count = h('span', { class: 'seg__count' });
    const control = h('button', { class: 'seg__item', type: 'button', onclick: () => {
      selected = index;
      render();
    } }, h('span', { text: label }), count);
    filters.append(control);
    return { control, count };
  });
  const el = h('section', { class: 'jobs', 'aria-labelledby': heading.id },
    h('header', { class: 'page-head' }, h('div', null, heading,
      h('p', { class: 'page-sub', text: 'Track clip jobs from this session.' }))),
    filters, loading, failure, missing, empty, list);

  function render() {
    const all = state.jobs;
    if (clips !== state.clips) {
      clips = state.clips;
      clipSources.clear();
      for (const clip of clips) {
        if (clip.jobId && clip.source?.key) clipSources.set(clip.jobId, clip.source.key);
      }
    }
    const active = [];
    const history = [];
    for (const job of all) (isActiveJob(job) ? active : history).push(job);
    const groups = [all, active, history];
    const items = groups[selected];
    const focused = document.activeElement?.closest('.job');
    const index = focused ? Array.from(list.children).indexOf(focused) : -1;
    filters.hidden = !all.length;
    options.forEach(({ control, count }, option) => {
      control.setAttribute('aria-pressed', String(option === selected));
      setText(count, groups[option].length);
    });
    list.hidden = !items.length;
    loading.hidden = !['idle', 'loading'].includes(state.jobsStatus);
    failure.hidden = state.jobsStatus !== 'error';
    setText(failureText, state.jobsError);
    empty.hidden = Boolean(items.length) || (!all.length && (!loading.hidden || !failure.hidden));
    missing.hidden = !currentJobId || Boolean(getJob(currentJobId)) || state.jobsStatus !== 'ready';
    setText(emptyTitle, FILTERS[all.length ? selected : 0].empty);
    emptyText.hidden = Boolean(all.length);
    const sorted = items.toReversed().sort((a, b) => b.queuedAt - a.queuedAt);
    const rows = reconcile(list, sorted, job => job.id,
      job => createRow(job, clipSources.get(job.id)),
      (row, job) => paintRow(row, job, clipSources.get(job.id)));
    for (const row of rows) row.toggleAttribute('data-current', row.job.id === currentJobId);
    if (index >= 0 && !focused.isConnected) {
      const next = rows[Math.min(index, rows.length - 1)]?.refs.title;
      (next ?? (filters.hidden ? heading : options[selected].control)).focus();
    }
  }

  subscribe(['jobs', 'clips', 'jobsStatus', 'jobsError'], () => { if (!el.hidden) render(); });
  return { el, refresh: refreshJobs, enter(route) {
    currentJobId = route.jobId;
    if (currentJobId) selected = 0;
    render();
    queueMicrotask(() => {
      if (!el.hidden && state.route.path === route.path) (list.querySelector('[data-current] h2') ?? heading).focus();
    });
  } };
}
