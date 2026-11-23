import { errorMessage } from './api.js';
import { h, icon } from './dom.js';

const ICONS = { success: 'check-circle', error: 'warning-circle', warning: 'warning', info: 'info' };
const MAX_VISIBLE = 4;
const visible = new Map();

export function syncToastHost() {
  const region = document.getElementById('toasts');
  const host = [...document.querySelectorAll('dialog:modal')].at(-1) ?? document.body;
  if (region && region.parentNode !== host) host.append(region);
  return region;
}

document.addEventListener('close', syncToastHost, true);

/** Show a notification and return its dismiss function. Use ttl: 0 to keep it until dismissed. */
export function toast(text, { kind = 'success', action, ttl } = {}) {
  const region = syncToastHost();
  const message = String(text ?? '').trim();
  if (!region || !message) return () => {};
  if (!Object.hasOwn(ICONS, kind)) kind = 'info';
  const key = action ? Symbol() : kind + ':' + message;
  const existing = visible.get(key);
  if (existing) { existing.restart(); return existing.dismiss; }

  if (visible.size >= MAX_VISIBLE) {
    const candidates = [...visible.values()].filter(item => !item.engaged());
    const victim = candidates.find(item => item.kind === 'success' || item.kind === 'info') ?? candidates[0];
    if (!victim || (['success', 'info'].includes(kind) && ['warning', 'error'].includes(victim.kind))) return () => {};
    victim.dismiss();
  }

  let timer;
  let hovering = false;
  let pending = false;
  let closed = false;
  let returnFocus;
  const lifetime = ttl ?? (kind === 'error' || kind === 'warning' ? 12000 : action ? 10000 : 5000);
  const focused = () => node.contains(document.activeElement);
  const engaged = () => hovering || pending || focused();
  const restart = () => {
    clearTimeout(timer);
    if (!closed && lifetime > 0 && !engaged()) {
      timer = setTimeout(() => { if (!engaged()) dismiss(); }, lifetime);
    }
  };
  function dismiss() {
    if (closed) return;
    const restore = focused();
    closed = true;
    clearTimeout(timer);
    visible.delete(key);
    node.remove();
    if (restore && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }

  const closeButton = h('button', {
    class: 'icon-btn icon-btn--ghost icon-btn--sm', type: 'button', 'aria-label': 'Dismiss notification', title: 'Dismiss notification', onclick: dismiss
  }, icon('x'));
  const actionButton = action && h('button', {
    class: 'btn btn--ghost btn--sm', type: 'button', text: action.label, onclick: async () => {
      if (pending || closed) return;
      pending = true;
      clearTimeout(timer);
      actionButton.setAttribute('aria-busy', 'true');
      actionButton.setAttribute('aria-disabled', 'true');
      actionButton.textContent = 'Working…';
      try {
        await action.run();
        dismiss();
      } catch (error) {
        toast(errorMessage(error), { kind: 'error' });
      } finally {
        pending = false;
        actionButton.removeAttribute('aria-busy');
        actionButton.removeAttribute('aria-disabled');
        actionButton.textContent = action.label;
        restart();
      }
    }
  });
  const node = h('div', { class: 'toast toast--' + kind },
    icon(ICONS[kind], { fill: true }),
    h('p', { class: 'toast__text', text: message }),
    h('div', { class: 'toast__actions' }, actionButton, closeButton));
  node.addEventListener('pointerenter', () => { hovering = true; clearTimeout(timer); });
  node.addEventListener('pointerleave', () => { hovering = false; restart(); });
  node.addEventListener('focusin', event => {
    if (event.relatedTarget instanceof HTMLElement && !node.contains(event.relatedTarget)) returnFocus = event.relatedTarget;
    clearTimeout(timer);
  });
  node.addEventListener('focusout', () => queueMicrotask(restart));
  visible.set(key, { kind, engaged, restart, dismiss });
  region.querySelector('.toasts__stack').append(node);
  const live = region.querySelector(kind === 'error' ? '[role="alert"]' : '[role="status"]');
  const announcement = h('span', { text: message });
  live.append(announcement);
  setTimeout(() => announcement.remove(), 1500);
  restart();
  return dismiss;
}
