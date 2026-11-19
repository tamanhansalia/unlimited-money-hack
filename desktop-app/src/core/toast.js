import { h, icon } from './dom.js';

const ICONS = { success: 'check-circle', error: 'warning-circle', info: 'info' };
const MAX = 3;

/**
 * toast('Saved', { kind: 'success' | 'error' | 'info', action: { label, run }, ttl })
 * Returns a dismiss function.
 */
export function toast(text, { kind = 'success', action, ttl } = {}) {
  const region = document.getElementById('toasts');
  if (!region) return () => {};
  while (region.children.length >= MAX) region.firstElementChild.remove();

  let timer;
  let closed = false;
  const dismiss = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    node.classList.remove('is-in');
    setTimeout(() => node.remove(), 260);
  };
  const actions = h('div', { class: 'toast__actions' });
  if (action) actions.append(h('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: action.label, onclick: () => { dismiss(); action.run(); } }));
  actions.append(h('button', { class: 'icon-btn icon-btn--ghost icon-btn--sm', type: 'button', 'aria-label': 'Dismiss', onclick: dismiss }, icon('x')));

  const node = h('div', { class: 'toast toast--' + kind, role: kind === 'error' ? 'alert' : 'status' },
    icon(ICONS[kind] || 'info', { fill: true }),
    h('div', { class: 'toast__text', text }),
    actions);
  region.append(node);
  requestAnimationFrame(() => requestAnimationFrame(() => node.classList.add('is-in')));

  const lifetime = ttl ?? (kind === 'error' ? 9000 : action ? 7000 : 4500);
  const start = () => { timer = setTimeout(dismiss, lifetime); };
  node.addEventListener('pointerenter', () => clearTimeout(timer));
  node.addEventListener('pointerleave', start);
  start();
  return dismiss;
}
