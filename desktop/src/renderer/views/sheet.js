// Clip sheet: a large dialog to watch, edit and publish one clip, with prev/next across its source.
import { h, icon, delegate, reconcile, setText, isTyping, shake } from '../core/dom.js';
import { state, subscribe } from '../core/store.js';
import { api, errorMessage } from '../core/api.js';
import { toast } from '../core/toast.js';
import { button, iconButton, chip, statusChip, spinner, progressBar, setBusy, setFieldState, openDialog } from '../core/components.js';
import { duration, bytes, plural } from '../core/format.js';
import { getSource } from '../core/sources.js';
import { hrefFor, navigate } from '../core/router.js';
import { moveClips, findClip } from '../core/library.js';
import { refreshAccount, reverifyAccount, platformInfo } from '../core/account.js';
import { LIMITS, parseTags, validateDetails, getDraft, setDraft, clearDraft, publishClip } from '../core/publish.js';
import { openProfileDialog } from './connect.js';
import { createProfileSelect } from './profiles.js';
import { confirmDeleteClips } from './delete-clips.js';

const FIELDS = [
  { name: 'title', label: 'Title', required: true, tag: 'input', placeholder: 'Give the clip a title', hint: 'The YouTube title. Other platforms show it above the description.' },
  { name: 'description', label: 'Description', tag: 'textarea', rows: 5, placeholder: 'Tell viewers what the clip is about', hint: 'Posted under the title as the caption.' },
  { name: 'tags', label: 'Tags', tag: 'input', placeholder: 'comedy, standup, shorts', hint: 'Separate tags with commas. Only YouTube uses them.' },
  { name: 'xPost', label: 'Post for X', tag: 'textarea', rows: 3, placeholder: 'Leave empty to post the title and description', hint: 'Leave empty to post your title and description.' }
];
const FIELD_NAMES = FIELDS.map(field => field.name);

const DEST_KEY = 'vc:sheet:destinations';
const PREVIEW_TIMEOUT_MS = 20_000;
const CONFIRM_GUARD_MS = 400;
const MAX_TAG_CHIPS = 30;

const VIDEO_ERRORS = {
  2: 'The clip file could not be read. Check that it still exists in the folder.',
  3: 'The clip file looks damaged and could not be decoded.',
  4: 'The clip file is missing or is not a playable video.'
};
const NOTE_TEXT = {
  loading: 'Checking publishing profiles…',
  error: 'Couldn’t load your publishing profiles. Try again.',
  empty: 'No YouTube, Instagram, Facebook or X account is connected in Zernio for this profile. Connect one there, then refresh.',
  legacy: 'This publishing profile was set up for Ayrshare. Add a Zernio API key to post with it.'
};
const NOTE_MODES = new Set(Object.keys(NOTE_TEXT));

const S = {
  open: false,
  sourceKey: '',
  clipId: '',
  clip: null,
  index: 0,
  base: {},              // field values stored on the clip
  values: {},            // field values as shown in the form
  touched: new Set(),    // fields whose errors may be shown
  phase: 'idle',         // idle | confirm | busy
  error: '',             // last publish failure
  moving: false,
  videoUrl: '',
  resolution: '',
  resumeAt: 0,
  confirmAt: 0,
  confirmAccount: null,
  profileId: null
};

let dialog = null;
let ui = null;
let video = null;
let offStore = null;
let videoTimer = 0;
let scrimDown = false;
let deletingClip = false;
const choices = new Map();
const publishRuns = new Map();

/* ───────── Pure helpers ───────── */

const clipValues = clip => ({ title: clip.title || '', description: clip.description || '', tags: clip.tags || '', xPost: clip.xPost || '' });
const isEdited = () => FIELD_NAMES.some(name => S.values[name] !== S.base[name]);
const joinNames = names => new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(names);
const connectedPlatforms = () => (Array.isArray(state.account?.platforms) ? state.account.platforms : []);
const chosenPlatforms = () => connectedPlatforms().filter(key => chosenForProfile().has(key));
const platformLabel = key => platformInfo(key).name;
const destinationLabel = (key, profile) => {
  const account = profile.destinations?.[key];
  return account ? platformLabel(key) + ' (' + account + ')' : platformLabel(key);
};
const isPlaying = () => Boolean(video && video.hasAttribute('src') && !video.paused && !video.ended);
const announce = text => { if (ui) setText(ui.live, text); };

function draftValues(clip) {
  const draft = getDraft(clip);
  const out = {};
  for (const name of FIELD_NAMES) if (typeof draft?.[name] === 'string') out[name] = draft[name];
  return out;
}

function accountMode() {
  if (state.accountStatus === 'error') return 'error';
  if (state.accountStatus !== 'ready' || state.accountPending) return 'loading';
  if (!state.account) return 'connect';
  if (state.account.needsKey) return 'legacy';
  return connectedPlatforms().length ? 'ready' : 'empty';
}

function loadChosen(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    return new Set(Array.isArray(saved) ? saved.filter(item => typeof item === 'string') : []);
  } catch { return new Set(); }
}

function choiceKey() {
  const id = state.account?.id;
  return id === 'default' ? DEST_KEY : DEST_KEY + ':' + (id ?? '');
}

function chosenForProfile() {
  const key = choiceKey();
  if (!choices.has(key)) choices.set(key, loadChosen(key));
  return choices.get(key);
}

const sourceClips = () => getSource(S.sourceKey)?.clips ?? [];

function position() {
  const clips = sourceClips();
  return { clips, index: clips.findIndex(item => item.id === S.clipId) };
}

/* ───────── Build (once) ───────── */

function ensureBuilt() {
  if (dialog) return;
  ui = { field: {} };
  ui.live = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  dialog = h('dialog', { class: 'dialog sheet-dialog', 'aria-labelledby': 'sheet-heading' },
    h('div', { class: 'dialog__panel sheet' }, buildMedia(), buildSide(), ui.live));
  dialog.addEventListener('close', onClosed);
  dialog.addEventListener('pointerdown', event => { scrimDown = event.target === dialog; });
  dialog.addEventListener('click', event => {
    if (event.target === dialog && scrimDown) closeClipSheet();
    scrimDown = false;
  });
  ui.form.addEventListener('input', onInput);
  ui.form.addEventListener('focusout', onBlur);
  delegate(ui.dests, 'change', 'input', onDestChange);
  document.body.append(dialog);
}

function buildMedia() {
  ui.loader = h('div', { class: 'sheet-overlay sheet-overlay--loading', hidden: true, role: 'status' },
    h('span', { class: 'sheet-loader' }, spinner('lg')), h('span', { class: 'sr-only', text: 'Loading clip preview…' }));
  ui.videoError = h('p', { class: 'sheet-overlay__text' });
  const retryVideo = button({ label: 'Retry preview', icon: 'arrow-clockwise', size: 'sm', onClick: () => {
    if (!S.clip) return;
    releaseVideo();
    loadVideo(S.clip);
  } });
  ui.revealMedia = button({ label: 'Show in folder', icon: 'folder-open', size: 'sm', onClick: () => revealCurrent(ui.revealMedia) });
  ui.errorBox = h('div', { class: 'sheet-overlay sheet-overlay--error', hidden: true, role: 'alert' },
    icon('video-camera-slash'), ui.videoError, retryVideo, ui.revealMedia);
  ui.frame = h('div', { class: 'sheet-frame', dataset: { state: 'loading' } }, ui.loader, ui.errorBox);

  ui.prev = iconButton({ icon: 'caret-left', label: 'Previous clip', title: 'Previous clip (Left arrow)', onClick: () => go(-1) });
  ui.next = iconButton({ icon: 'caret-right', label: 'Next clip', title: 'Next clip (Right arrow)', onClick: () => go(1) });
  ui.count = h('span', { class: 'sheet-pager__count num' });
  ui.status = h('span', { class: 'sheet-status' });
  ui.meta = h('span', { class: 'sheet-meta__text num' });

  return h('section', { class: 'sheet-media', 'aria-label': 'Clip preview' },
    h('div', { class: 'sheet-stage' }, ui.frame),
    h('div', { class: 'sheet-pager' }, ui.prev, ui.count, ui.next),
    h('div', { class: 'sheet-meta' }, ui.status, ui.meta));
}

function buildSide() {
  ui.eyebrow = h('p', { class: 'sheet-eyebrow truncate' });
  ui.title = h('h2', { class: 'sheet-title clamp-2', id: 'sheet-heading' });
  ui.close = iconButton({ icon: 'x', label: 'Close', title: 'Close (Esc)', cls: 'sheet-close', onClick: () => closeClipSheet() });

  ui.reset = button({ label: 'Reset edits', icon: 'arrow-u-up-left', variant: 'ghost', size: 'sm', onClick: resetEdits });
  ui.reset.hidden = true;
  ui.fields = h('fieldset', { class: 'sheet-fields' }, FIELDS.map(buildField));
  ui.form = h('form', { class: 'sheet-form', novalidate: true, 'aria-labelledby': 'sheet-form-heading', onsubmit: event => event.preventDefault() },
    h('div', { class: 'sheet-form__head' },
      h('div', { class: 'sheet-form__title' },
        h('h3', { id: 'sheet-form-heading', text: 'Publishing details' }),
        h('p', { class: 'sheet-form__note', text: 'Edits are kept while the app is open and used when you publish.' })),
      ui.reset),
    ui.fields);

  return h('section', { class: 'sheet-side' },
    h('header', { class: 'sheet-head' }, h('div', { class: 'sheet-head__text' }, ui.eyebrow, ui.title), ui.close),
    ui.form,
    buildFooter());
}

function buildField(def) {
  const id = 'sheet-' + def.name.toLowerCase();
  const input = h(def.tag, { class: 'input', id, name: def.name, rows: def.rows, placeholder: def.placeholder, autocomplete: 'off', 'aria-describedby': id + '-msg', dataset: { field: def.name } });
  input.spellcheck = def.name !== 'tags';
  const counter = h('span', { class: 'field__counter num' });
  const preview = def.name === 'tags' ? h('ul', { class: 'sheet-tags', 'aria-label': 'Parsed tags' }) : null;
  const root = h('div', { class: 'field', dataset: { name: def.name } },
    h('div', { class: 'field__label' },
      h('label', { for: id }, def.label, def.required && h('span', { class: 'req', text: ' required' })),
      counter),
    input,
    preview,
    h('div', { class: 'field__msg', id: id + '-msg', 'aria-live': 'polite' }));
  ui.field[def.name] = { root, input, counter, preview, msgKey: null, tagsKey: null };
  return root;
}

function buildFooter() {
  ui.alertText = h('span');
  ui.retry = button({ label: 'Try again', icon: 'arrows-clockwise', size: 'sm', onClick: () => startPublish() });
  ui.alert = h('div', { class: 'callout callout--bad sheet-alert fade-in', role: 'alert', hidden: true },
    icon('warning-circle', { fill: true }),
    h('div', { class: 'callout__body' }, h('strong', { text: 'Publishing needs attention' }), ui.alertText),
    ui.retry);

  ui.complete = button({ label: 'Mark completed', icon: 'check-circle', size: 'sm', onClick: () => moveCurrent('completed') });
  ui.restore = button({ label: 'Restore to Ready', icon: 'arrow-counter-clockwise', size: 'sm', onClick: () => moveCurrent('ready') });
  ui.reveal = iconButton({ icon: 'folder-open', label: 'Show in folder', size: 'sm', onClick: () => revealCurrent(ui.reveal) });
  ui.delete = iconButton({ icon: 'trash', label: 'Delete clip', size: 'sm', onClick: deleteCurrent });

  ui.destsLabel = h('span', { class: 'sheet-dests__label', id: 'sheet-dests-label' });
  ui.dests = h('div', { class: 'sheet-dests', role: 'group', 'aria-labelledby': 'sheet-dests-label' });
  ui.destsRow = h('div', { class: 'sheet-foot__dests' }, ui.destsLabel, ui.dests);
  ui.profile = createProfileSelect();
  ui.publishLabel = h('span', { class: 'btn__label' });
  ui.publish = h('button', { class: 'btn btn--primary', type: 'button', onclick: () => startPublish() }, icon('paper-plane-tilt', { fill: true }), ui.publishLabel);
  ui.connect = h('button', { class: 'btn sheet-connect', type: 'button', onclick: () => openProfileDialog() },
    icon('plugs-connected'), h('span', { class: 'btn__label', text: 'Add publishing profile' }));
  ui.note = h('div', { class: 'sheet-note', role: 'status' });
  ui.done = h('div', { class: 'callout callout--ok sheet-done', tabindex: '-1' },
    icon('seal-check', { fill: true }),
    h('div', { class: 'callout__body' }, h('strong', { text: 'Completed' }), h('span', { text: 'Restore it to Ready to choose publishing destinations.' })));

  ui.main = h('div', { class: 'sheet-foot__main fade-in' },
    ui.profile.el, ui.destsRow,
    h('div', { class: 'sheet-foot__bar' },
      h('div', { class: 'sheet-foot__left' }, ui.complete, ui.restore, ui.reveal, ui.delete),
      h('div', { class: 'sheet-foot__right' }, ui.publish, ui.connect, ui.note, ui.done)));

  ui.confirmText = h('p', { class: 'sheet-confirm__text' });
  ui.cancel = button({ label: 'Cancel', onClick: () => cancelConfirm() });
  ui.go = button({ label: 'Publish now', icon: 'paper-plane-tilt', fill: true, variant: 'primary', onClick: onConfirmClick });
  ui.confirm = h('div', { class: 'sheet-confirm fade-in', role: 'group', 'aria-label': 'Confirm publishing', hidden: true },
    h('div', { class: 'sheet-confirm__lead' }, icon('globe'), ui.confirmText),
    h('div', { class: 'sheet-confirm__actions' }, ui.cancel, ui.go));

  ui.busyText = h('p', { class: 'sheet-busy__text', tabindex: '-1', 'aria-live': 'polite' });
  const bar = progressBar({ indeterminate: true, thin: true });
  bar.setAttribute('aria-label', 'Publishing progress');
  ui.busy = h('div', { class: 'sheet-busy fade-in', hidden: true },
    h('div', { class: 'sheet-busy__head' }, spinner(), ui.busyText),
    bar,
    h('p', { class: 'sheet-busy__hint', text: 'You can close this preview while publishing continues.' }));

  return h('footer', { class: 'sheet-foot' }, ui.alert, ui.main, ui.confirm, ui.busy);
}

/* ───────── Paint ───────── */

function paintAll() {
  paintHeader();
  paintStatus();
  paintMeta();
  paintFields();
  paintReset();
  paintFooter();
  paintLocked();
}

function paintHeader() {
  setText(ui.eyebrow, getSource(S.sourceKey)?.title || 'Source video');
  setText(ui.title, S.values.title.trim() || 'Untitled clip');
}

function paintStatus() {
  if (ui.status.dataset.status === S.clip.status) return;
  ui.status.dataset.status = S.clip.status;
  ui.status.replaceChildren(statusChip(S.clip.status));
}

function paintMeta() {
  const length = duration(S.clip.durationSec ?? video?.duration);
  setText(ui.meta, [length, bytes(S.clip.fileSizeBytes), S.resolution].filter(Boolean).join(' · '));
}

function paintPager() {
  const { clips, index } = position();
  S.index = Math.max(index, 0);
  const locked = S.phase === 'busy' || S.moving;
  setText(ui.count, index < 0 ? '' : `${index + 1} of ${clips.length}`);
  ui.prev.disabled = locked || index <= 0;
  ui.next.disabled = locked || index >= clips.length - 1;
  rescueFocus();
}

// A focused control that becomes disabled would drop focus out of the dialog.
function rescueFocus() {
  const active = document.activeElement;
  if (!(active === ui.prev || active === ui.next) || !active.disabled) return;
  const other = active === ui.prev ? ui.next : ui.prev;
  (other.disabled ? ui.close : other).focus();
}

function paintFields() {
  const result = validateDetails(S.values, { touched: S.touched, platforms: chosenPlatforms() });
  for (const def of FIELDS) paintField(def, result);
  return result;
}

function paintCounter(node, count, limit) {
  setText(node, `${count.toLocaleString()} / ${limit.toLocaleString()}`);
  node.classList.toggle('is-near', count > limit * 0.9 && count <= limit);
  node.classList.toggle('is-over', count > limit);
}

function paintField(def, result) {
  const refs = ui.field[def.name];
  const value = S.values[def.name];
  if (refs.input.value !== value) refs.input.value = value;
  paintCounter(refs.counter, result.counts[def.name], LIMITS[def.name]);

  const error = result.errors[def.name] || '';
  const warning = result.warnings[def.name] || '';
  const level = error ? 'error' : warning ? 'warn' : '';
  const message = error || warning;
  const key = `${level}|${message}`;
  if (refs.msgKey !== key) {
    refs.msgKey = key;
    setFieldState(refs.root, refs.input, level, message, def.hint);
  }
  if (refs.preview) paintTags(refs);
}

function tagItems(tags) {
  const items = tags.slice(0, MAX_TAG_CHIPS).map(tag => ({ key: 'tag:' + tag, label: tag, icon: 'hash' }));
  if (tags.length > MAX_TAG_CHIPS) items.push({ key: 'more:' + tags.length, label: `+${tags.length - MAX_TAG_CHIPS} more` });
  return items;
}

function paintTags(refs) {
  const tags = parseTags(S.values.tags);
  const key = JSON.stringify(tags);
  if (refs.tagsKey === key) return;
  refs.tagsKey = key;
  reconcile(refs.preview, tagItems(tags), item => item.key, item => h('li', null, chip(item.label, { icon: item.icon, small: true })));
}

function paintReset() {
  ui.reset.hidden = !isEdited();
}

function paintFooter() {
  const idle = S.phase === 'idle';
  const completed = S.clip.status === 'completed';
  ui.alert.hidden = !(idle && S.error);
  setText(ui.alertText, S.error);
  ui.main.hidden = !idle;
  ui.confirm.hidden = S.phase !== 'confirm';
  ui.busy.hidden = S.phase !== 'busy';
  ui.complete.hidden = completed;
  ui.restore.hidden = !completed;
  setText(ui.busyText, publishRuns.get(S.clip.id));
  if (S.phase === 'confirm') {
    const names = chosenPlatforms().map(key => destinationLabel(key, S.confirmAccount));
    setText(ui.confirmText, `Publish as “${S.confirmAccount.name}” to ${joinNames(names)}? The post will be public.`);
  }
  paintPublishArea();
}

function paintPublishArea() {
  const mode = S.clip.status === 'completed' ? 'done' : accountMode();
  const ready = mode === 'ready';
  ui.profile.el.hidden = mode === 'done' || !state.account;
  ui.profile.paint();
  ui.done.hidden = mode !== 'done';
  ui.destsRow.hidden = !ready;
  ui.publish.hidden = !ready;
  ui.connect.hidden = mode !== 'connect';
  ui.note.hidden = !NOTE_MODES.has(mode);
  if (ready) paintDestinations();
  else if (!ui.note.hidden) paintNote(mode);
}

function paintDestinations() {
  reconcile(ui.dests, connectedPlatforms(), key => key, createDest, updateDest);
  const count = chosenPlatforms().length;
  setText(ui.destsLabel, count ? 'Post to' : 'Choose where to post');
  setText(ui.publishLabel, count ? `Publish to ${count}` : 'Publish');
  ui.publish.disabled = count === 0 || S.moving;
  ui.publish.title = count ? '' : 'Choose at least one destination';
}

function createDest(key) {
  return h('label', { class: 'sheet-dest' },
    h('input', { type: 'checkbox', class: 'sr-only', value: key, checked: chosenForProfile().has(key) }),
    icon(platformInfo(key).icon),
    h('span', { text: platformLabel(key) }),
    h('span', { class: 'sheet-dest__tick' }, icon('check')));
}

function updateDest(node, key) {
  node.firstElementChild.checked = chosenForProfile().has(key);
}

// Rebuilt only when its content changes, so a focused Retry button is not replaced by every repaint.
function paintNote(mode) {
  const text = mode === 'error' && state.accountError ? state.accountError : NOTE_TEXT[mode];
  const key = `${mode}|${text}`;
  if (ui.noteKey === key) return;
  ui.noteKey = key;
  ui.note.replaceChildren(
    mode === 'loading' ? spinner() : icon('warning'),
    h('span', { class: 'sheet-note__text', text }),
    mode !== 'loading' && button({ label: mode === 'error' ? 'Retry' : mode === 'legacy' ? 'Add Zernio key' : 'Verify again', size: 'sm', onClick: async () => {
      if (mode === 'legacy') openProfileDialog('keys');
      else if (mode === 'error') await refreshAccount({ force: true });
      else {
        try { await reverifyAccount(); }
        catch (error) { toast(errorMessage(error), { kind: 'error' }); }
      }
    } }));
}

function paintLocked() {
  const locked = S.phase === 'busy';
  dialog.classList.toggle('is-busy', locked);
  ui.fields.disabled = locked;
  ui.reset.disabled = locked;
  paintPager();
}

function setPhase(phase) {
  S.phase = phase;
  paintFooter();
  paintLocked();
}

function ensurePhaseValid() {
  if (S.phase === 'confirm' && (accountMode() !== 'ready' || !chosenPlatforms().length ||
      S.clip.status !== 'ready' || S.confirmAccount.connectionId !== state.account?.connectionId)) {
    S.phase = 'idle';
  }
}

/* ───────── Clip data ───────── */

/** Make `clip` the displayed clip. `fresh` restarts the form from the clip plus its saved draft; otherwise unsaved edits survive. */
function adopt(clip, { fresh = false } = {}) {
  const base = clipValues(clip);
  if (fresh) {
    S.values = { ...base, ...draftValues(clip) };
    S.touched.clear();
    S.error = '';
    S.phase = publishRuns.has(clip.id) ? 'busy' : 'idle';
  } else {
    S.values = Object.fromEntries(FIELD_NAMES.map(name => [name, S.values[name] !== S.base[name] ? S.values[name] : base[name]]));
  }
  S.base = base;
  S.clip = clip;
  ensurePhaseValid();
  paintAll();
}

function switchTo(clip, autoplay) {
  S.clipId = clip.id;
  adopt(clip, { fresh: true });
  loadVideo(clip, { autoplay });
  ui.form.scrollTop = 0;
}

function go(step) {
  if (S.phase === 'busy' || S.moving) return;
  const { clips, index } = position();
  const next = clips[index + step];
  if (!next) return;
  switchTo(next, isPlaying());
  announce(`Clip ${index + step + 1} of ${clips.length}: ${next.title || 'Untitled clip'}`);
}

/** Re-read the clip from the store (library refresh, move, publish) without losing unsaved edits or the playback position. */
function syncClip() {
  const clips = sourceClips();
  const clip = clips.find(item => item.id === S.clipId);
  if (!clip) {
    if (!state.clipsLoaded) return;
    const neighbour = clips[Math.min(S.index, clips.length - 1)];
    if (neighbour) switchTo(neighbour, isPlaying());
    else {
      closeClipSheet();
      if (!deletingClip) toast('This source has no clips left.', { kind: 'info' });
    }
    return;
  }
  const moved = clip.videoUrl !== S.videoUrl;
  const resumeAt = video?.currentTime ?? 0;
  const autoplay = isPlaying();
  adopt(clip);
  if (moved) loadVideo(clip, { autoplay, resumeAt });
}

function onStore(changed) {
  if (!S.open || !S.clip) return;
  if (changed.has('clips')) syncClip();
  else if (changed.has('sourceInfo')) paintHeader();
  if (['account', 'accountStatus', 'accountPending'].some(key => changed.has(key)) && S.open && S.clip) {
    const id = state.account?.id;
    if (id !== S.profileId) S.error = '';
    S.profileId = id;
    ensurePhaseValid();
    paintFooter();
    paintFields();
  }
}

/* ───────── Form events ───────── */

function persistDraft() {
  if (isEdited()) setDraft(S.clip, { ...S.values });
  else clearDraft(S.clip);
}

function onInput(event) {
  const name = event.target.dataset?.field;
  if (!name || !S.clip) return;
  S.values[name] = event.target.value;
  persistDraft();
  if (S.phase === 'confirm') setPhase('idle');
  paintHeader();
  paintFields();
  paintReset();
}

function onBlur(event) {
  const name = event.target.dataset?.field;
  if (!name || S.touched.has(name)) return;
  S.touched.add(name);
  paintFields();
}

function onDestChange(_event, input) {
  const chosen = chosenForProfile();
  if (input.checked) chosen.add(input.value);
  else chosen.delete(input.value);
  try { localStorage.setItem(choiceKey(), JSON.stringify([...chosen])); } catch { /* Keep the choice for this session. */ }
  ensurePhaseValid();
  paintFooter();
  paintFields(); // the default X post is only checked while X is a destination
}

function resetEdits() {
  clearDraft(S.clip);
  S.values = { ...S.base };
  S.touched.clear();
  paintHeader();
  paintFields();
  paintReset();
  ui.field.title.input.focus();
}

/* ───────── Publish ───────── */

function startPublish() {
  if (!S.clip || S.clip.status !== 'ready' || S.phase === 'busy' || S.moving || accountMode() !== 'ready' ||
      !chosenPlatforms().length) return;
  FIELD_NAMES.forEach(name => S.touched.add(name));
  const { errors } = paintFields();
  const invalid = FIELD_NAMES.filter(name => errors[name]);
  if (invalid.length) {
    rejectSubmit(invalid);
    return;
  }
  S.error = '';
  S.confirmAccount = state.account;
  S.confirmAt = performance.now();
  setPhase('confirm');
  ui.go.focus();
}

function rejectSubmit(invalid) {
  const first = ui.field[invalid[0]];
  first.input.focus();
  shake(first.root);
  const labels = invalid.map(name => FIELDS.find(def => def.name === name).label);
  toast(`Fix ${plural(invalid.length, 'field')} before publishing: ${labels.join(', ')}.`, { kind: 'error' });
}

function cancelConfirm() {
  setPhase('idle');
  ui.publish.focus();
}

// A held Enter key repeats into the button that just received focus; ignore keyboard clicks that arrive straight away.
function onConfirmClick(event) {
  if (event.detail === 0 && performance.now() - S.confirmAt < CONFIRM_GUARD_MS) return;
  runPublish();
}

async function runPublish() {
  ensurePhaseValid();
  if (S.phase !== 'confirm') {
    paintFooter();
    return;
  }
  const clip = S.clip;
  const platforms = chosenPlatforms();
  const profile = S.confirmAccount;
  const names = platforms.map(platformLabel);
  if (publishRuns.has(clip.id)) return;
  publishRuns.set(clip.id, `Publishing to ${joinNames(names)}…`);
  S.error = '';
  setPhase('busy');
  ui.busyText.focus();
  let failure = '';
  try {
    const result = await publishClip(clip, platforms, { ...S.values }, profile);
    toast(`Submitted to ${joinNames(names)} as “${profile.name}”. Moved to Completed.`);
    if (!result.refreshed) toast('Could not refresh the library after publishing.', { kind: 'warning', action: {
      label: 'Refresh library', run: async () => { if (!await refreshLibrary()) throw new Error(state.clipsError); }
    } });
  } catch (error) {
    failure = errorMessage(error);
  } finally {
    finishPublish(clip.id, failure);
  }
}

function finishPublish(id, message) {
  publishRuns.delete(id);
  if (!dialog.open || S.clip?.id !== id) {
    if (message) toast(message, { kind: 'error' });
    return;
  }
  S.phase = 'idle';
  S.error = message;
  if (!message && isEdited()) persistDraft(); // publishClip clears the draft; keep what was published visible
  syncClip();
  if (!dialog.open || S.clip?.id !== id) return;
  if (message) ui.retry.focus();
  else (ui.done.offsetParent ? ui.done : ui.close).focus({ preventScroll: true });
}

/* ───────── Move and reveal ───────── */

async function moveCurrent(to) {
  const clip = S.clip;
  if (!clip || S.moving || S.phase === 'busy' || clip.status === to) return;
  const control = to === 'completed' ? ui.complete : ui.restore;
  const refocus = document.activeElement === control;
  S.moving = true;
  ui.delete.disabled = true;
  setBusy(control, true, 'Moving…');
  paintPublishArea();
  paintPager();
  try {
    const { failed } = await moveClips([clip], to);
    if (failed.length) throw failed[0].error;
    const back = to === 'completed' ? 'ready' : 'completed';
    toast(to === 'completed' ? 'Moved to Completed.' : 'Restored to Ready.', { kind: 'success', action: { label: 'Undo', run: () => undoMove(clip.id, back) } });
  } catch (error) {
    toast(`Couldn’t move this clip. ${errorMessage(error)}`, { kind: 'error' });
  } finally {
    S.moving = false;
    ui.delete.disabled = false;
    setBusy(control, false);
    if (dialog.open && S.clip) {
      syncClip();
      if (refocus && S.clip?.id === clip.id) (S.clip.status === 'completed' ? ui.restore : ui.complete).focus();
    }
  }
}

async function undoMove(id, to) {
  const clip = findClip(id);
  if (!clip || clip.status === to) return;
  try {
    const { failed } = await moveClips([clip], to);
    if (failed.length) throw failed[0].error;
    toast(to === 'ready' ? 'Back in Ready.' : 'Back in Completed.', { kind: 'success' });
  } catch (error) {
    toast(`Couldn’t undo the move. ${errorMessage(error)}`, { kind: 'error' });
  }
}

async function revealCurrent(control) {
  const clip = S.clip;
  if (!clip) return;
  control.disabled = true;
  control.setAttribute('aria-busy', 'true');
  try {
    await api.revealClip(clip.id, clip.status);
  } catch (error) {
    toast(`Couldn’t open the folder. ${errorMessage(error)}`, { kind: 'error' });
  } finally {
    control.disabled = false;
    control.removeAttribute('aria-busy');
  }
}

async function deleteCurrent() {
  const { clip, sourceKey } = S;
  if (!clip || S.moving || S.phase !== 'idle') return;
  let playback;
  const removed = await confirmDeleteClips({
    clip,
    beforeDelete() {
      deletingClip = true;
      playback ??= { resumeAt: video?.currentTime ?? 0, autoplay: isPlaying() };
      releaseVideo();
    }
  });
  deletingClip = false;
  if (!removed && playback && S.open && S.clip?.id === clip.id && !video) loadVideo(S.clip, playback);
  if (removed && state.route.name === 'source' && state.route.key === sourceKey && !getSource(sourceKey)) {
    navigate(hrefFor.library());
    document.querySelector('[data-nav="library"]')?.focus({ preventScroll: true });
  }
}

/* ───────── Video ───────── */

function ensureVideo() {
  if (video) return;
  const el = h('video', { class: 'sheet-video', controls: true, playsInline: true, preload: 'metadata' });
  el.setAttribute('controlslist', 'nodownload noremoteplayback');
  video = el;
  // Ignore events that arrive after the source was cleared or the element replaced.
  const when = handler => () => { if (el === video && el.hasAttribute('src')) handler(); };
  el.addEventListener('loadstart', when(() => setVideoState('loading')));
  el.addEventListener('waiting', when(() => setVideoState('loading')));
  el.addEventListener('stalled', when(() => { if (el.readyState < el.HAVE_FUTURE_DATA) setVideoState('loading'); }));
  for (const type of ['loadeddata', 'canplay', 'playing']) el.addEventListener(type, when(() => setVideoState('ready')));
  el.addEventListener('loadedmetadata', when(onMetadata));
  el.addEventListener('error', when(onVideoError));
  ui.frame.prepend(el);
}

function loadVideo(clip, { autoplay = false, resumeAt = 0 } = {}) {
  ensureVideo();
  S.videoUrl = clip.videoUrl;
  S.resolution = '';
  S.resumeAt = resumeAt;
  video.setAttribute('aria-label', `Preview of ${clip.title || 'clip'}`);
  setVideoState('loading');
  video.src = clip.videoUrl;
  if (autoplay) video.play().catch(() => {});
  paintMeta();
}

function setVideoState(next) {
  if (next !== 'loading') {
    clearTimeout(videoTimer);
    videoTimer = 0;
  } else if (!videoTimer) {
    const expected = video;
    videoTimer = setTimeout(() => {
      if (video !== expected) return;
      setText(ui.videoError, 'The clip preview stopped responding. Retry it or open the file in its folder.');
      setVideoState('error');
    }, PREVIEW_TIMEOUT_MS);
  }
  ui.frame.dataset.state = next;
  ui.frame.setAttribute('aria-busy', String(next === 'loading'));
  ui.loader.hidden = next !== 'loading';
  ui.errorBox.hidden = next !== 'error';
}

function onMetadata() {
  if (S.resumeAt > 0) {
    video.currentTime = Math.min(S.resumeAt, video.duration || S.resumeAt);
    S.resumeAt = 0;
  }
  S.resolution = video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : '';
  setVideoState('ready');
  paintMeta();
}

function onVideoError() {
  const code = video.error?.code;
  if (code === 1) return;
  setText(ui.videoError, VIDEO_ERRORS[code] || 'The clip could not be played.');
  setVideoState('error');
}

function releaseVideo() {
  clearTimeout(videoTimer);
  videoTimer = 0;
  if (!video) return;
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.remove();
  video = null;
  S.videoUrl = '';
}

/* ───────── Open and close ───────── */

function ownsFocus(target) {
  const host = target instanceof Element ? target.closest('dialog') : null;
  return host ? host === dialog : document.querySelectorAll('dialog[open]').length === 1;
}

function onKey(event) {
  if (!dialog.open || !ownsFocus(event.target)) return;
  if (event.key === 'Escape') {
    if (S.phase === 'confirm') { event.preventDefault(); cancelConfirm(); }
    return;
  }
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || isTyping(event.target)) return;
  event.preventDefault();
  event.stopPropagation(); // keep the native video controls from seeking
  go(event.key === 'ArrowLeft' ? -1 : 1);
}

// The Connect dialog restores focus to a button that disappears once the account is connected.
function onNestedClose(event) {
  if (event.target === dialog) return;
  requestAnimationFrame(() => {
    if (!S.open || document.querySelectorAll('dialog[open]').length !== 1 || dialog.contains(document.activeElement)) return;
    (!ui.publish.hidden && !ui.publish.disabled ? ui.publish : ui.close).focus();
  });
}

const onHashChange = () => closeClipSheet();

function teardown() {
  if (!S.open) return;
  S.open = false;
  S.clip = null;
  offStore?.();
  offStore = null;
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('close', onNestedClose, true);
  window.removeEventListener('hashchange', onHashChange);
  releaseVideo();
}

function onClosed() {
  if (dialog.open) return; // reopened before this event ran
  teardown();
}

export function openClipSheet(sourceKey, clipId) {
  const clip = getSource(sourceKey)?.clips.find(item => item.id === clipId);
  if (!clip) {
    toast('That clip is no longer in the library. Refresh the library and try again.', { kind: 'error' });
    return;
  }
  ensureBuilt();
  if (dialog.open) {
    if (S.phase === 'busy') return;
    S.sourceKey = sourceKey;
    switchTo(clip, isPlaying());
    return;
  }
  teardown(); // a close that has not been reported yet
  S.open = true;
  S.sourceKey = sourceKey;
  S.clipId = clip.id;
  S.profileId = state.account?.id;
  offStore = subscribe(['clips', 'sourceInfo', 'account', 'accountStatus', 'accountPending'], onStore);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('close', onNestedClose, true);
  window.addEventListener('hashchange', onHashChange);
  adopt(clip, { fresh: true });
  loadVideo(clip);
  openDialog(dialog, ui.close);
  refreshAccount();
}

export function closeClipSheet() {
  if (dialog?.open) dialog.close();
}
