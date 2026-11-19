// Small shared building blocks. Class names come from css/ui.css.
import { h, icon } from './dom.js';

export function spinner(size) {
  return h('span', { class: 'spinner' + (size ? ' spinner--' + size : ''), 'aria-hidden': 'true' });
}

/**
 * button({ label, icon:'plus', variant:'primary'|'ghost'|'danger'|undefined, size:'sm'|'lg', onClick, title, ariaLabel, type })
 */
export function button({ label, icon: iconName, fill, variant, size, onClick, title, ariaLabel, type = 'button', cls = '', kbd } = {}) {
  const classes = ['btn', variant && 'btn--' + variant, size && 'btn--' + size, cls].filter(Boolean).join(' ');
  return h('button', { class: classes, type, title, 'aria-label': ariaLabel, onclick: onClick },
    iconName && icon(iconName, { fill }),
    label && h('span', { class: 'btn__label', text: label }),
    kbd && h('kbd', { class: 'kbd', text: kbd }));
}

export function iconButton({ icon: iconName, fill, label, onClick, size, ghost, title, cls = '' } = {}) {
  const classes = ['icon-btn', size && 'icon-btn--' + size, ghost && 'icon-btn--ghost', cls].filter(Boolean).join(' ');
  return h('button', { class: classes, type: 'button', 'aria-label': label, title: title || label, onclick: onClick }, icon(iconName, { fill }));
}

/**
 * Put a button into a busy state: spinner + label, disabled, aria-busy. Restores the original content when idle.
 */
export function setBusy(btn, busy, label) {
  if (busy) {
    if (!btn._idle) btn._idle = [...btn.childNodes].map(node => node.cloneNode(true));
    btn.replaceChildren(spinner(), h('span', { class: 'btn__label', text: label ?? btn.textContent.trim() }));
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
  } else {
    if (btn._idle) btn.replaceChildren(...btn._idle);
    btn._idle = null;
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
  }
}

/** chip('3 ready', { kind: 'ready'|'ok'|'warn'|'bad', icon, dot, media, small }) */
export function chip(text, { kind, icon: iconName, fill, dot, media, small, title } = {}) {
  const classes = ['chip', kind && 'chip--' + kind, dot && 'chip--dot', media && 'chip--media', small && 'chip--sm'].filter(Boolean).join(' ');
  return h('span', { class: classes, title }, iconName && icon(iconName, { fill }), text !== undefined && text !== '' && h('span', { text }));
}

export function statusChip(status, opts = {}) {
  return status === 'completed'
    ? chip('Completed', { kind: 'ok', dot: true, ...opts })
    : chip('Ready', { kind: 'ready', dot: true, ...opts });
}

/** emptyState({ icon, title, text, actions: [HTMLElement], tone: 'bad' }) */
export function emptyState({ icon: iconName, title, text, actions = [], tone } = {}) {
  return h('div', { class: 'empty' + (tone ? ' empty--' + tone : '') },
    h('div', { class: 'empty__icon' }, icon(iconName)),
    h('h2', { text: title }),
    text && h('p', { text }),
    actions.length > 0 && h('div', { class: 'empty__actions' }, actions));
}

/** Set a 0..1 value on a .progress or .ring element. */
export function setProgress(node, value) {
  node.style.setProperty('--p', String(Math.max(0, Math.min(1, value || 0))));
}

export function progressBar({ value = 0, thin, indeterminate } = {}) {
  const node = h('span', { class: ['progress', thin && 'progress--thin', indeterminate && 'progress--indeterminate'].filter(Boolean).join(' '), role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' },
    h('span', { class: 'progress__bar' }));
  setProgress(node, value);
  return node;
}

/**
 * Field message helper. level: 'error' | 'warn' | 'ok' | ''. Also marks the input aria-invalid for errors.
 * field = the .field element; the message node is .field__msg; the control is `input`.
 */
export function setFieldState(field, input, level, text, fallback = '') {
  const msg = field.querySelector('.field__msg');
  const shown = text || fallback;
  if (level && text) field.dataset.state = level; else delete field.dataset.state;
  if (msg) {
    msg.replaceChildren();
    if (level && text) msg.append(icon(level === 'error' ? 'warning-circle' : level === 'warn' ? 'warning' : 'check-circle'));
    if (shown) msg.append(h('span', { text: shown }));
  }
  if (input) {
    if (level === 'error' && text) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
}

export function setCounter(node, length, limit) {
  node.textContent = length ? `${length.toLocaleString()} / ${limit.toLocaleString()}` : '';
  node.classList.toggle('is-near', length > limit * 0.9 && length <= limit);
  node.classList.toggle('is-over', length > limit);
}

/** Open a <dialog> and restore focus to the opener when it closes. */
export function openDialog(dialog, focusEl) {
  const opener = document.activeElement;
  if (!dialog.open) dialog.showModal();
  if (focusEl) focusEl.focus();
  dialog.addEventListener('close', () => { if (opener instanceof HTMLElement && document.contains(opener)) opener.focus({ preventScroll: true }); }, { once: true });
}
