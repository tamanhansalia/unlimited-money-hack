// Hash router with View Transitions. Views stay mounted; the router shows one and hides the rest.
//
// A view is { el, enter(route), leave(), sharedElement?(otherRoute) → HTMLElement | null }.
// sharedElement lets two views name the same element (e.g. source card cover ↔ source header cover) so the
// browser morphs one into the other. It is called on the leaving view (with the new route) before the
// snapshot, and on the entering view (with the old route) after the swap.

import { set, state } from './store.js';

const views = new Map();
const scrollMemory = new Map();
let stage;
let current = null;
let started = false;

const ROUTES = [
  { name: 'source', pattern: /^\/source\/(.+)$/, params: match => ({ key: decodeURIComponent(match[1]) }) },
  { name: 'publishing', pattern: /^\/publishing\/?$/, params: () => ({}) },
  { name: 'library', pattern: /^\/?$/, params: () => ({}) }
];

export function parse(hash = location.hash) {
  const path = String(hash).replace(/^#/, '') || '/';
  for (const route of ROUTES) {
    const match = route.pattern.exec(path);
    if (match) return { name: route.name, ...route.params(match), path };
  }
  return { name: 'library', path: '/' };
}

export const hrefFor = {
  library: () => '#/',
  source: key => '#/source/' + encodeURIComponent(key),
  publishing: () => '#/publishing'
};

export function navigate(hash) {
  const target = hash.startsWith('#') ? hash : '#' + hash;
  if (location.hash === target || (target === '#/' && !location.hash)) return;
  location.hash = target;
}

export function registerView(name, view) {
  views.set(name, view);
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function clearSharedNames() {
  document.querySelectorAll('[data-vt-active]').forEach(node => {
    node.style.viewTransitionName = '';
    node.removeAttribute('data-vt-active');
  });
}
function nameShared(node) {
  if (!node) return;
  node.style.viewTransitionName = 'shared-cover';
  node.setAttribute('data-vt-active', '');
}

function swap(from, to) {
  const outgoing = from ? views.get(from.name) : null;
  const incoming = views.get(to.name);
  if (from) scrollMemory.set(from.path, stage.scrollTop);
  const sameView = from && from.name === to.name;
  if (outgoing && !sameView) {
    outgoing.leave?.();
    outgoing.el.hidden = true;
  }
  if (incoming) {
    incoming.el.hidden = false;
    incoming.enter?.(to, from);
  }
  stage.scrollTop = scrollMemory.get(to.path) ?? 0;
  current = to;
  set({ route: to });
  document.querySelectorAll('[data-nav]').forEach(link => {
    const active = link.dataset.nav === (to.name === 'source' ? 'library' : to.name);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function render() {
  const next = parse();
  const previous = current;
  if (previous && previous.path === next.path) return;
  const canMorph = typeof document.startViewTransition === 'function' && !reducedMotion() && previous;
  if (!canMorph) { swap(previous, next); return; }

  clearSharedNames();
  nameShared(views.get(previous.name)?.sharedElement?.(next));
  const transition = document.startViewTransition(() => {
    swap(previous, next);
    nameShared(views.get(next.name)?.sharedElement?.(previous));
  });
  // A transition is skipped (and its promises reject) when the document is hidden or another navigation interrupts
  // it. The DOM swap still ran, so that is not an error; anything else is worth seeing in the console.
  const quiet = error => { if (error?.name !== 'InvalidStateError' && error?.name !== 'AbortError') console.error(error); };
  transition.ready.catch(quiet);
  transition.updateCallbackDone.catch(quiet);
  transition.finished.catch(quiet).finally(clearSharedNames);
}

export function startRouter(stageEl) {
  if (started) return;
  started = true;
  stage = stageEl;
  window.addEventListener('hashchange', render);
  const first = parse();
  swap(null, first);
}

export const currentRoute = () => current || state.route;
