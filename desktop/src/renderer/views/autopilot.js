// Autopilot page: niche profiles that find videos, cut Shorts, write the copy and schedule posts on their own.
import { h, icon, reconcile, setText, stagger } from '../core/dom.js';
import { state, subscribe } from '../core/store.js';
import { plural } from '../core/format.js';
import { errorMessage } from '../core/api.js';
import { toast } from '../core/toast.js';
import { button, chip, emptyState, openDialog, setBusy, spinner } from '../core/components.js';
import { SUPPORTED, platformInfo, refreshAccount } from '../core/account.js';
import { CLIP_LENGTHS, SUBTITLE_STYLES, clipLengthById, readGenerationSettings } from '../core/generation-settings.js';
import { getJob, isActiveJob, stageLabel } from '../core/jobs.js';
import { navigate, hrefFor } from '../core/router.js';
import {
  FRAMING_CHOICES, REPEAT_CHOICES, blankProfile, refreshAutopilot, removeAutopilot, saveAutopilot,
  startAutopilot, stopAutopilot, hindiStandUpPreset
} from '../core/autopilot.js';
import { createCliFields, sourceLanguageSelect } from './cli-fields.js';

const ACTIVITY_PREVIEW = 6;
const MAX_TIMES = 8;
const STEPS = [
  { icon: 'magnifying-glass', title: 'Find', text: 'Ranks new uploads by how far they beat their channel’s usual views.', skill: 'yt-viral' },
  { icon: 'scissors', title: 'Cut', text: 'Picks moments that stand on their own, with a setup and a payoff.', skill: 'yt-shorts' },
  { icon: 'text-aa', title: 'Package', text: 'Writes the title, on-screen hook, description and tags, then checks them.', skill: 'yt-package · yt-seo' },
  { icon: 'calendar-check', title: 'Schedule', text: 'Spreads posts over your posting times, or keeps clips for review.', skill: 'Zernio' }
];

/* ───────── Text helpers ───────── */

const when = iso => {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const today = new Date().toDateString() === date.toDateString();
  return date.toLocaleString(undefined, today
    ? { hour: 'numeric', minute: '2-digit' }
    : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const platformList = keys => keys.map(key => platformInfo(key).name).join(', ');
const repeatLabel = hours => REPEAT_CHOICES.find(choice => choice.hours === hours)?.label || 'Once';
const timeLabel = value => {
  const [hours, minutes] = value.split(':').map(Number);
  return new Date(2000, 0, 1, hours, minutes).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

function facts(profile) {
  const sources = [profile.channels.length && plural(profile.channels.length, 'channel'),
    profile.keywords.length && plural(profile.keywords.length, 'search', 'searches')].filter(Boolean).join(' · ');
  const clips = profile.clips === 'auto' ? 'Auto clips' : `Up to ${plural(profile.clips, 'clip')} each`;
  const posting = profile.publish.mode === 'schedule'
    ? `${platformList(profile.publish.platforms)} at ${profile.publish.times.map(timeLabel).join(', ')}`
    : 'Kept in the Library for review';
  const { state: run } = profile;
  const history = [plural(run.processed, 'video') + ' clipped', profile.publish.mode === 'schedule' && `${run.scheduled} scheduled`]
    .filter(Boolean).join(' · ');
  return [
    ['Sources', sources],
    ['Each run', `${plural(profile.videosPerRun, 'video')} · ${clips} · ${clipLengthById(profile.length).label}`],
    ['Posting', posting],
    ['Repeats', repeatLabel(profile.repeatHours)],
    ['So far', history + (run.nextPostAt ? ` · next post ${when(run.nextPostAt)}` : '')]
  ];
}

function status(profile) {
  const run = profile.state;
  if (run.stopping) return { key: 'stopping', text: 'Stopping…', kind: 'warn' };
  if (run.running) return { key: 'running', text: 'Running', kind: 'ready' };
  if (run.enabled) return { key: 'on', text: run.nextRunAt ? `On · next run ${when(run.nextRunAt)}` : 'On', kind: 'ok' };
  if (run.lastError) return { key: 'error', text: 'Needs attention', kind: 'bad' };
  return { key: 'off', text: 'Off' };
}

/* ───────── Profile cards ───────── */

function logItem(entry) {
  return h('li', { class: 'ap-log', dataset: { level: entry.level } },
    h('time', { class: 'ap-log__time', dateTime: entry.at, text: when(entry.at) }),
    h('span', { class: 'ap-log__text', text: entry.text }));
}

function createCard(profile, { onEdit }) {
  const name = h('h2', { class: 'ap-card__name truncate' });
  const niche = h('p', { class: 'ap-card__niche' });
  const statusSlot = h('span', { class: 'ap-card__status' });
  const workTitle = h('strong', { class: 'truncate' });
  const workDetail = h('span');
  const now = h('div', { class: 'ap-now', role: 'status' }, spinner(),
    h('div', { class: 'ap-now__text' }, workTitle, workDetail));
  const factList = h('dl', { class: 'ap-facts' });
  const error = h('p', { class: 'callout callout--bad ap-card__error', hidden: true });
  const toggle = button({ label: 'Start', icon: 'play', variant: 'primary' });
  const runNow = button({ label: 'Run now', icon: 'play', variant: 'primary' });
  const viewJob = h('a', { class: 'btn' }, 'View job', icon('arrow-right'));
  const edit = button({ label: 'Edit', icon: 'pencil-simple' });
  const remove = button({ label: 'Delete', icon: 'trash', variant: 'ghost', ariaLabel: 'Delete autopilot profile' });
  const logList = h('ol', { class: 'ap-log-list' });
  const more = button({ label: 'Show all activity', variant: 'ghost', size: 'sm' });
  const activity = h('section', { class: 'ap-activity' },
    h('h3', { class: 'ap-activity__title', text: 'Activity' }), logList, more);
  const card = h('article', { class: 'ap-card glass' },
    h('header', { class: 'ap-card__head' },
      h('span', { class: 'ap-card__icon' }, icon('robot')),
      h('div', { class: 'ap-card__id' }, name, niche), statusSlot),
    now, error, factList,
    h('div', { class: 'ap-card__actions' }, toggle, runNow, viewJob, edit, remove), activity);
  let current = profile;
  let expanded = false;
  let busy = false;

  async function act(run, label, control = toggle) {
    if (busy) return;
    busy = true;
    setBusy(control, true, label);
    toggle.disabled = runNow.disabled = edit.disabled = remove.disabled = true;
    try {
      await run(current.id);
      toast(run === startAutopilot ? `${current.name} started.` : `Stop requested for ${current.name}.`);
    }
    catch (cause) { toast(errorMessage(cause), { kind: 'error' }); }
    finally {
      busy = false;
      setBusy(control, false);
      paint(current);
    }
  }

  toggle.addEventListener('click', () => {
    if (current.state.running || current.state.enabled) void act(stopAutopilot, 'Stopping…');
    else void act(startAutopilot, 'Starting…');
  });
  runNow.addEventListener('click', () => void act(startAutopilot, 'Starting…', runNow));
  edit.addEventListener('click', () => onEdit(current));
  remove.addEventListener('click', () => confirmRemove(current));
  more.addEventListener('click', () => { expanded = !expanded; paint(current); });

  function paintWork() {
    const run = current.state;
    const job = run.jobId && getJob(run.jobId);
    now.hidden = !run.running;
    setText(workTitle, run.step || 'Working');
    setText(workDetail, !run.stopping && job && isActiveJob(job) ? stageLabel(job) : run.detail);
    viewJob.hidden = !job;
    if (job) viewJob.href = hrefFor.jobs(job.id);
  }

  function paint(next) {
    current = next;
    const run = next.state;
    paintWork();
    setText(name, next.name);
    setText(niche, next.niche || 'No niche description');
    const badge = status(next);
    if (statusSlot.dataset.key !== badge.key + badge.text) {
      statusSlot.dataset.key = badge.key + badge.text;
      statusSlot.replaceChildren(chip(badge.text, { kind: badge.kind, dot: Boolean(badge.kind) }));
    }
    error.hidden = !run.lastError || run.running;
    if (!error.hidden) setText(error, 'Last run needs attention. ' + run.lastError);
    factList.replaceChildren(...facts(next).map(([term, value]) =>
      h('div', { class: 'ap-fact' }, h('dt', { text: term }), h('dd', { text: value }))));
    if (!busy) {
      const on = run.running || run.enabled;
      toggle.replaceChildren(icon(on ? 'stop' : 'play', { fill: true }), h('span', { class: 'btn__label', text: on ? 'Stop' : 'Start' }));
      toggle.className = 'btn ' + (on ? '' : 'btn--primary');
      toggle.disabled = run.stopping;
      runNow.disabled = false;
    }
    runNow.hidden = !run.enabled || run.running;
    edit.disabled = run.running || busy;
    remove.disabled = run.running || busy;
    const entries = expanded ? run.activity : run.activity.slice(0, ACTIVITY_PREVIEW);
    reconcile(logList, entries, entry => entry.at + entry.text, logItem);
    activity.hidden = !run.activity.length;
    more.hidden = run.activity.length <= ACTIVITY_PREVIEW;
    setText(more.querySelector('.btn__label'), expanded ? 'Show less' : `Show all ${run.activity.length}`);
  }

  paint(profile);
  return { card, paint, paintWork };
}

function confirmRemove(profile) {
  if (document.querySelector('#ap-remove-heading')) return;
  const cancel = button({ label: 'Cancel', onClick: () => dialog.close() });
  const confirm = button({ label: 'Delete profile', icon: 'trash', variant: 'danger' });
  const error = h('p', { class: 'callout callout--bad', role: 'alert', hidden: true });
  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'ap-remove-heading' },
    h('div', { class: 'dialog__panel' },
      h('div', { class: 'dialog__head' },
        h('span', { class: 'dialog__icon' }, icon('trash')),
        h('div', { class: 'dialog__title' }, h('h2', { id: 'ap-remove-heading', text: 'Delete this autopilot?' }))),
      h('div', { class: 'dialog__body' },
        h('strong', { class: 'delete-clips__name', text: profile.name }),
        h('p', { text: 'Its settings and activity are removed. Clips it made stay in the Library, and posts it already scheduled stay scheduled in Zernio.' }), error),
      h('div', { class: 'dialog__foot' }, cancel, confirm)));
  confirm.addEventListener('click', async () => {
    if (confirm.disabled) return;
    error.hidden = true;
    setBusy(confirm, true, 'Deleting…');
    cancel.disabled = true;
    try {
      await removeAutopilot(profile.id);
      toast(`${profile.name} deleted.`);
      dialog.close();
    } catch (cause) {
      setText(error, errorMessage(cause));
      error.hidden = false;
    } finally {
      setBusy(confirm, false);
      cancel.disabled = false;
      if (dialog.open) confirm.focus();
    }
  });
  dialog.addEventListener('cancel', event => { if (cancel.disabled) event.preventDefault(); });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  openDialog(dialog, cancel);
}

/* ───────── Editor ───────── */

function card(id, title, detail, symbol, ...rows) {
  return h('section', { class: 'settings-card glass', 'aria-labelledby': id },
    h('header', { class: 'settings-card__head' },
      h('span', { class: 'settings-card__icon' }, icon(symbol)),
      h('div', { class: 'settings-card__heading' }, h('h2', { id, text: title }), h('p', { text: detail }))),
    h('div', { class: 'settings-card__rows' }, rows));
}

function row(control, label, hint) {
  return h('div', { class: 'settings-row' },
    h('div', null, h('label', { htmlFor: control.id, text: label }), hint && h('p', { class: 'settings-row__hint', text: hint })),
    control);
}

const select = (id, items) => h('select', { class: 'input', id },
  items.map(([value, label]) => h('option', { value: String(value), text: label })));

function segmented(label, items) {
  const buttons = items.map(([value, text]) => h('button', { class: 'seg__item', type: 'button', 'aria-pressed': 'false', value: String(value), text }));
  const root = h('div', { class: 'seg', role: 'group', 'aria-label': label }, buttons);
  return {
    root,
    get value() { return buttons.find(item => item.getAttribute('aria-pressed') === 'true')?.value; },
    set value(next) { buttons.forEach(item => item.setAttribute('aria-pressed', String(item.value === String(next)))); },
    buttons
  };
}

function createEditor({ onClose }) {
  let editing = null;
  let submitting = false;
  let desiredPlatforms = [];
  const heading = h('h1', { class: 'page-title', id: 'ap-editor-title', tabIndex: -1 });
  const feedback = h('p', { class: 'settings-feedback ap-editor__error', role: 'alert' });
  const cancel = button({ label: 'Cancel', variant: 'ghost', onClick: () => onClose() });
  const save = button({ label: 'Save', icon: 'check', type: 'submit' });
  const saveStart = button({ label: 'Save and start', icon: 'play', fill: true, variant: 'primary' });

  const nameInput = h('input', { class: 'input', id: 'ap-name', maxLength: 60, placeholder: 'Stand-up comedy', autocomplete: 'off' });
  const nicheInput = h('input', { class: 'input', id: 'ap-niche', maxLength: 80, placeholder: 'Hindi stand-up comedy', autocomplete: 'off' });
  const template = button({ label: 'Use Hindi stand-up preset', size: 'sm' });
  const channels = h('textarea', { class: 'input', id: 'ap-channels', rows: 4, placeholder: '@yourchannel\nhttps://www.youtube.com/@approvedcreator' });
  const keywords = h('textarea', { class: 'input', id: 'ap-keywords', rows: 3, placeholder: 'hindi stand up comedy\ncrowd work india' });
  channels.spellcheck = keywords.spellcheck = false;
  const videos = select('ap-videos', [1, 2, 3, 4, 5].map(count => [count, plural(count, 'video')]));
  const minMinutes = select('ap-min', [[3, '3 minutes'], [5, '5 minutes'], [10, '10 minutes'], [20, '20 minutes'], [45, '45 minutes']]);
  const maxMinutes = select('ap-max', [10, 15, 25, 45, 60, 90, 120, 240].map(minutes => [minutes, plural(minutes, 'minute')]));
  const maxAge = select('ap-age', [[7, 'Last week'], [30, 'Last 30 days'], [60, 'Last 60 days'], [180, 'Last 6 months'], [365, 'Last year'], [3650, 'Any time']]);
  const ranking = select('ap-ranking', [['outliers', 'Breakout uploads only (1.5× median)'], ['eligible', 'All eligible uploads, ranked']]);
  const clips = select('ap-clips', [['auto', 'Auto'], ...Array.from({ length: 10 }, (_, index) => [index + 1, plural(index + 1, 'clip')])]);
  const length = select('ap-length', CLIP_LENGTHS.map(item => [item.id, item.label]));
  const subtitles = select('ap-subtitles', SUBTITLE_STYLES.map(style => [style.id, style.label]));
  const layout = select('ap-layout', FRAMING_CHOICES.map(item => [item.id, item.label]));
  const language = sourceLanguageSelect('ap-language');
  const hook = h('input', { type: 'checkbox', class: 'sr-only', id: 'ap-hook' });
  const hookToggle = h('label', { class: 'sheet-dest ap-toggle' }, hook, icon('text-t'),
    h('span', { text: 'Show the hook on screen' }), h('span', { class: 'sheet-dest__tick' }, icon('check')));
  const cli = createCliFields({ generationId: 'ap-cli', seoId: 'ap-seo', onUpdate: paintSubmit });

  const mode = segmented('What happens to new clips', [['review', 'Keep for review'], ['schedule', 'Schedule posts']]);
  const publishProfile = h('select', { class: 'input', id: 'ap-publish-profile' });
  const platforms = h('div', { class: 'sheet-dests', role: 'group', 'aria-label': 'Platforms' });
  const times = h('div', { class: 'ap-times' });
  const addTime = button({ label: 'Add time', icon: 'plus', size: 'sm', onClick: () => { appendTime('12:00'); paintPublishing(); } });
  const publishHint = h('p', { class: 'callout ap-publish-hint', hidden: true });
  const repeat = segmented('How often Autopilot runs', REPEAT_CHOICES.map(choice => [choice.hours, choice.label]));
  const scheduleRows = [
    row(publishProfile, 'Publishing profile', 'The Zernio account Autopilot posts with.'),
    h('div', { class: 'settings-row ap-stack' }, h('div', null, h('strong', { text: 'Platforms' }),
      h('p', { class: 'settings-row__hint', text: 'Only platforms linked to that profile can be chosen.' })), platforms),
    h('div', { class: 'settings-row ap-stack' }, h('div', null, h('strong', { text: 'Posting times' }),
      h('p', { class: 'settings-row__hint', text: 'One post per time, on this computer’s clock. Zernio posts even when 2PixelHack is closed.' })),
    h('div', { class: 'ap-times-field' }, times, addTime))
  ];

  const form = h('form', { class: 'settings ap-editor', novalidate: true, 'aria-labelledby': heading.id },
    h('header', { class: 'page-head settings-head' },
      h('div', null, heading, h('p', { class: 'page-sub', text: 'Autopilot runs these steps on its own. Nothing here asks you to confirm.' })),
      h('div', { class: 'settings-actions' }, feedback, cancel, save, saveStart)),
    h('fieldset', { class: 'settings-grid ap-editor__fields' },
      h('div', { class: 'settings-column' },
        card('ap-niche-title', 'Niche', 'Name this autopilot and tell the AI who the clips are for.', 'robot',
          h('div', { class: 'settings-row', id: 'ap-template' }, template),
          row(nameInput, 'Name'), row(nicheInput, 'Niche', 'Used in every prompt, for example Hindi stand-up comedy.')),
        card('ap-find-title', 'Find videos', 'Where to look and which uploads count.', 'magnifying-glass',
          row(channels, 'Channels', 'One per line: @handle or a channel link. Each upload is ranked against its own channel.'),
          row(keywords, 'YouTube searches', 'One per line. Leave blank to stay within the channels you listed.'),
          row(videos, 'Videos per run'), row(minMinutes, 'Shortest video'), row(maxMinutes, 'Longest video'),
          row(maxAge, 'Uploaded within'), row(ranking, 'Video selection'),
          h('div', { class: 'callout callout--warn ap-rights' }, icon('warning'), h('div', { class: 'callout__body' },
            h('strong', { text: 'Only clip videos you have the rights to use' }),
            h('span', { text: 'Use your own channel, creators who gave you permission, or official clipping programmes. Reposting other people’s videos can bring copyright strikes and demonetisation.' })))),
        card('ap-clips-title', 'Clips', 'How each video is cut and styled.', 'film-strip',
          row(clips, 'Clips per video', 'Auto keeps every strong moment.'), row(length, 'Clip length'),
          row(subtitles, 'Subtitles'), row(layout, 'Framing'), row(language, 'Spoken language'),
          h('div', { class: 'settings-row' }, h('div', null, h('strong', { text: 'Hook' }),
            h('p', { class: 'settings-row__hint', text: 'A 2 to 4 word line on screen for the first 2.5 seconds.' })), hookToggle))),
      h('div', { class: 'settings-column' },
        card('ap-ai-title', 'AI', 'Installed CLIs that write highlights, subtitles and SEO.', 'cpu',
          h('div', { class: 'cli-scan-row' }, cli.rescan, cli.notice), cli.generation, cli.seo),
        card('ap-publish-title', 'Publishing', 'Keep clips for review, or schedule them automatically.', 'paper-plane-tilt',
          h('div', { class: 'settings-row ap-stack' }, h('div', null, h('strong', { text: 'New clips' })), mode.root),
          publishHint, ...scheduleRows),
        card('ap-repeat-title', 'Schedule', 'Runs continue while 2PixelHack is open.', 'clock-clockwise',
          h('div', { class: 'settings-row ap-stack' }, h('div', null, h('strong', { text: 'Run' })), repeat.root)))));

  const fields = form.querySelector('fieldset');

  function paintSubmit() {
    save.disabled = saveStart.disabled = submitting || cli.scanning;
    cancel.disabled = submitting;
    fields.disabled = submitting;
    form.setAttribute('aria-busy', String(submitting));
  }

  function appendTime(value) {
    if (times.children.length >= MAX_TIMES) return;
    const input = h('input', { class: 'input ap-time', type: 'time', step: 60, value, 'aria-label': 'Posting time' });
    const removeTime = h('button', { class: 'icon-btn icon-btn--sm icon-btn--ghost', type: 'button', 'aria-label': 'Remove posting time' }, icon('x'));
    const item = h('div', { class: 'ap-time-row' }, input, removeTime);
    removeTime.addEventListener('click', () => { item.remove(); paintPublishing(); });
    times.append(item);
  }

  function chosenPlatforms() {
    return [...platforms.querySelectorAll('input:checked')].map(input => input.value);
  }

  function paintPlatforms(selected) {
    const target = state.profiles.find(item => item.id === publishProfile.value);
    const linked = new Set(target?.platforms || []);
    platforms.replaceChildren(...SUPPORTED.map(key => {
      const handle = target?.destinations?.[key];
      const detail = linked.has(key) ? handle : 'Not linked';
      return h('label', { class: 'sheet-dest' },
        h('input', { type: 'checkbox', class: 'sr-only', value: key, checked: linked.has(key) && selected.includes(key), disabled: !linked.has(key) }),
        icon(platformInfo(key).icon), h('span', { text: [platformInfo(key).name, detail].filter(Boolean).join(' · ') }),
        h('span', { class: 'sheet-dest__tick' }, icon('check')));
    }));
  }

  function paintPublishing() {
    const schedule = mode.value === 'schedule';
    const noProfiles = !state.profiles.length;
    for (const node of scheduleRows) node.hidden = !schedule || noProfiles;
    publishHint.hidden = !schedule || (!noProfiles && state.accountStatus === 'ready');
    if (!publishHint.hidden) {
      const loading = ['idle', 'loading'].includes(state.accountStatus);
      const failed = state.accountStatus === 'error';
      publishHint.replaceChildren(loading ? spinner() : icon(failed ? 'warning-circle' : 'info'),
        h('span', { text: loading ? 'Loading publishing profiles…' : failed ? state.accountError : 'Add a publishing profile in Publishing first.' }),
        failed && button({ label: 'Try again', size: 'sm', onClick: () => refreshAccount({ force: true }) }),
        !loading && !failed && button({ label: 'Open Publishing', size: 'sm', onClick: () => navigate(hrefFor.publishing()) }));
    }
    addTime.disabled = times.children.length >= MAX_TIMES;
    for (const item of times.children) item.lastElementChild.disabled = times.children.length === 1;
  }

  function fillProfiles(selectedId) {
    const missing = selectedId && !state.profiles.some(item => item.id === selectedId);
    publishProfile.replaceChildren(
      h('option', { value: '', disabled: true, text: 'Choose a publishing profile' }),
      missing && h('option', { value: selectedId, disabled: true, text: 'Saved profile unavailable' }),
      ...state.profiles.map(item => h('option', { value: item.id, text: item.name })));
    publishProfile.value = selectedId || '';
  }

  function setRangeChoice(control, value, label) {
    control.querySelector('[data-custom]')?.remove();
    control.value = String(value);
    if (control.value) return;
    control.append(h('option', { value: String(value), text: label, dataset: { custom: '' } }));
    control.value = String(value);
  }

  function fillCampaign(draft) {
    nameInput.value = draft.name;
    nicheInput.value = draft.niche;
    videos.value = String(draft.videosPerRun);
    setRangeChoice(minMinutes, draft.minMinutes, plural(draft.minMinutes, 'minute'));
    const max = draft.maxMinutes ?? 240;
    setRangeChoice(maxMinutes, max, plural(max, 'minute'));
    setRangeChoice(maxAge, draft.maxAgeDays, `Last ${plural(draft.maxAgeDays, 'day')}`);
    ranking.value = draft.ranking ?? 'outliers';
    clips.value = String(draft.clips);
    length.value = clipLengthById(draft.length).id;
    subtitles.value = draft.subtitles;
    layout.value = draft.layout;
    language.value = draft.language;
    hook.checked = draft.hook;
    repeat.value = draft.repeatHours;
  }

  function open(profile) {
    editing = profile;
    const draft = profile || { ...blankProfile(), provider: readGenerationSettings().provider };
    setText(heading, profile ? `Edit ${profile.name}` : 'New autopilot');
    feedback.textContent = '';
    template.parentElement.hidden = Boolean(profile);
    for (const input of fields.querySelectorAll('[aria-invalid]')) input.removeAttribute('aria-invalid');
    fillCampaign(draft);
    channels.value = draft.channels.join('\n');
    keywords.value = draft.keywords.join('\n');
    cli.setValues({ provider: draft.provider, seoProvider: draft.seoProvider });
    mode.value = draft.publish.mode;
    fillProfiles(draft.publish.profileId);
    desiredPlatforms = draft.publish.platforms.length ? draft.publish.platforms : ['youtube'];
    paintPlatforms(desiredPlatforms);
    times.replaceChildren();
    draft.publish.times.forEach(appendTime);
    paintPublishing();
    void cli.scan();
    void refreshAccount();
    queueMicrotask(() => heading.focus({ preventScroll: true }));
  }

  function read() {
    const reject = (control, message) => {
      control?.setAttribute('aria-invalid', 'true');
      control?.focus();
      throw new Error(message);
    };
    const countLines = input => new Set(input.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)).size;
    if (!nameInput.value.trim()) reject(nameInput, 'Enter a name for this autopilot.');
    const channelCount = countLines(channels);
    const searchCount = countLines(keywords);
    if (!channelCount && !searchCount) reject(channels, 'Add at least one channel or YouTube search.');
    if (channelCount > 20) reject(channels, 'List up to 20 channels.');
    if (searchCount > 10) reject(keywords, 'List up to 10 searches.');
    if (Number(maxMinutes.value) <= Number(minMinutes.value)) reject(maxMinutes, 'The longest video must be longer than the shortest video.');
    const selection = cli.selection();
    if (!selection) reject(cli.rescan, cli.notice.textContent || 'Choose an installed generation and SEO CLI.');
    const destinations = chosenPlatforms();
    const timeInputs = [...times.querySelectorAll('input')];
    const selectedTimes = timeInputs.map(input => input.value);
    const validTimes = selectedTimes.filter(Boolean);
    const destination = state.profiles.find(profile => profile.id === publishProfile.value);
    if (mode.value === 'schedule') {
      if (state.accountStatus !== 'ready') reject(null, 'Load your publishing profiles before scheduling posts.');
      if (!destination || destination.needsKey) {
        reject(scheduleRows[0].hidden ? null : publishProfile, 'Choose a connected publishing profile before scheduling posts.');
      }
      if (!destinations.length) reject(platforms.querySelector('input:enabled'), 'Choose at least one linked platform.');
      if (!timeInputs.length || selectedTimes.includes('')) reject(timeInputs.find(input => !input.value), 'Enter a valid time for each scheduled post.');
      if (new Set(selectedTimes).size !== selectedTimes.length) {
        reject(timeInputs.find((input, index) => selectedTimes.indexOf(input.value) < index), 'Choose different posting times.');
      }
    }
    return {
      id: editing?.id || '', name: nameInput.value, niche: nicheInput.value,
      channels: channels.value, keywords: keywords.value,
      videosPerRun: Number(videos.value), minMinutes: Number(minMinutes.value), maxMinutes: Number(maxMinutes.value),
      maxAgeDays: Number(maxAge.value), ranking: ranking.value,
      clips: clips.value === 'auto' ? 'auto' : Number(clips.value), length: length.value,
      subtitles: subtitles.value, layout: layout.value, language: language.value, hook: hook.checked,
      provider: selection.provider, seoProvider: selection.seoProvider || '',
      publish: {
        mode: mode.value, profileId: publishProfile.value, platforms: destinations,
        connectionId: destination?.connectionId,
        times: validTimes.length ? validTimes : undefined
      },
      repeatHours: Number(repeat.value)
    };
  }

  async function submit(andStart) {
    if (submitting) return;
    feedback.textContent = '';
    let input;
    try { input = read(); }
    catch (cause) { feedback.textContent = errorMessage(cause); return; }
    const buttonNode = andStart ? saveStart : save;
    submitting = true;
    setBusy(buttonNode, true, andStart ? 'Starting…' : 'Saving…');
    paintSubmit();
    let saved;
    try {
      const snapshot = await saveAutopilot(input);
      saved = snapshot.profiles.find(item => input.id ? item.id === input.id : item.name.toLowerCase() === input.name.trim().replace(/\s+/g, ' ').toLowerCase());
      if (!saved) throw new Error('Could not confirm the saved autopilot. Refresh Autopilot before trying again.');
      editing = saved;
      setText(heading, `Edit ${saved.name}`);
      if (andStart) await startAutopilot(saved.id);
      toast(andStart ? `${saved.name} started.` : 'Autopilot saved.');
      onClose();
    } catch (cause) {
      feedback.textContent = (saved ? 'Saved. Could not start. ' : '') + errorMessage(cause);
      if (form.closest('[hidden]')) toast(feedback.textContent, { kind: 'error' });
    } finally {
      submitting = false;
      setBusy(buttonNode, false);
      paintSubmit();
    }
  }

  template.addEventListener('click', () => {
    fillCampaign({ ...blankProfile(), ...hindiStandUpPreset });
    mode.value = 'review';
    paintPublishing();
    channels.focus();
  });
  for (const item of mode.buttons) item.addEventListener('click', () => { mode.value = item.value; paintPublishing(); });
  for (const item of repeat.buttons) item.addEventListener('click', () => { repeat.value = item.value; });
  publishProfile.addEventListener('change', () => paintPlatforms(desiredPlatforms));
  platforms.addEventListener('change', () => { desiredPlatforms = chosenPlatforms(); });
  form.addEventListener('submit', event => { event.preventDefault(); void submit(false); });
  saveStart.addEventListener('click', () => void submit(true));
  form.addEventListener('input', event => { event.target.removeAttribute('aria-invalid'); feedback.textContent = ''; });
  form.addEventListener('keydown', event => { if (event.key === 'Escape' && !submitting && !document.querySelector('dialog[open]')) onClose(); });

  function refreshProfiles() {
    if (form.hidden) return;
    fillProfiles(publishProfile.value);
    paintPlatforms(desiredPlatforms);
    paintPublishing();
  }

  return { el: form, open, refreshProfiles, get submitting() { return submitting; } };
}

/* ───────── View ───────── */

export function createAutopilotView() {
  const add = button({ label: 'New autopilot', icon: 'plus', variant: 'primary' });
  const list = h('div', { class: 'ap-list' });
  const empty = h('div', { class: 'ap-empty glass', hidden: true });
  const loading = h('p', { class: 'loading-state', role: 'status', hidden: true }, spinner(), 'Loading Autopilot profiles…');
  const failure = h('div', { class: 'ap-empty glass', hidden: true });
  const steps = h('ol', { class: 'ap-steps', 'aria-label': 'What each run does' },
    STEPS.map((step, index) => h('li', { class: 'ap-step' },
      h('span', { class: 'ap-step__icon' }, icon(step.icon)),
      h('div', { class: 'ap-step__body' },
        h('strong', { text: `${index + 1}. ${step.title}` }), h('span', { text: step.text }),
        h('small', { class: 'ap-step__skill', text: step.skill })))));
  const overview = h('section', { class: 'ap', 'aria-labelledby': 'ap-title' },
    h('header', { class: 'page-head' },
      h('div', null, h('h1', { class: 'page-title', id: 'ap-title', tabIndex: -1, text: 'Autopilot' }),
        h('p', { class: 'page-sub', text: 'Finds videos in your niche, cuts Shorts, writes the SEO and schedules the posts on its own.' })),
      add),
    steps, loading, failure, empty, list);
  const editor = createEditor({ onClose: closeEditor });
  editor.el.hidden = true;
  const el = h('div', { class: 'ap-view' }, overview, editor.el);
  const cards = new Map();
  let introduced = false;

  function openEditor(profile) {
    overview.hidden = true;
    editor.el.hidden = false;
    editor.open(profile);
  }

  function closeEditor() {
    editor.el.hidden = true;
    overview.hidden = false;
    paint();
    queueMicrotask(() => { if (!el.hidden) overview.querySelector('#ap-title').focus({ preventScroll: true }); });
  }

  add.addEventListener('click', () => openEditor(null));

  function paint() {
    const { profiles, status, error } = state.autopilot;
    loading.hidden = !['idle', 'loading'].includes(status);
    failure.hidden = status !== 'error';
    add.disabled = status !== 'ready';
    if (!failure.hidden && failure.dataset.error !== error) {
      failure.dataset.error = error;
      failure.replaceChildren(emptyState({ icon: 'warning-circle', tone: 'bad', title: 'Autopilot is unavailable', text: error,
        actions: [button({ label: 'Try again', onClick: () => refreshAutopilot() })] }));
    }
    empty.hidden = status !== 'ready' || profiles.length > 0;
    if (!empty.hidden && !empty.firstChild) {
      empty.append(emptyState({ icon: 'robot', title: 'Set up your first autopilot',
        text: 'Pick a niche and the channels to watch. Autopilot finds the strongest new uploads, cuts them into Shorts and schedules them.',
        actions: [button({ label: 'New autopilot', icon: 'plus', variant: 'primary', onClick: () => openEditor(null) })] }));
    }
    const created = [];
    reconcile(list, profiles, profile => profile.id, profile => {
      const entry = createCard(profile, { onEdit: openEditor });
      cards.set(profile.id, entry);
      created.push(entry.card);
      return entry.card;
    }, (node, profile) => cards.get(profile.id)?.paint(profile));
    for (const id of cards.keys()) if (!profiles.some(profile => profile.id === id)) cards.delete(id);
    if (created.length && introduced) stagger(created);
  }

  subscribe('autopilot', paint);
  subscribe('jobs', () => { if (!el.hidden) for (const card of cards.values()) card.paintWork(); });
  subscribe(['profiles', 'account', 'accountStatus', 'accountError'], () => editor.refreshProfiles());

  return {
    el,
    refresh: refreshAutopilot,
    enter() {
      void refreshAutopilot();
      void refreshAccount();
      paint();
      if (!introduced) {
        introduced = true;
        stagger([steps, list]);
      }
      if (editor.el.hidden) queueMicrotask(() => overview.querySelector('#ap-title').focus({ preventScroll: true }));
    },
    leave() {
      if (!editor.el.hidden && !editor.submitting) closeEditor();
    },
    sharedElement: () => null
  };
}
