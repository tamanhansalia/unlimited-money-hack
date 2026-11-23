// Hash router with View Transitions. Views stay mounted; the router shows one and hides the rest.
//
// A view is { el, enter(route), leave(), sharedElement?(otherRoute) → HTMLElement | null }.
// sharedElement lets two views name the same element (e.g. source card cover ↔ source header cover) so the
// browser morphs one into the other. It is called on the leaving view (with the new route) before the
// snapshot, and on the entering view (with the old route) after the swap.

import { set, state } from './store.js';
import { button, emptyState } from './components.js';
import { toast } from './toast.js';

const views = new Map();
const scrollMemory = new Map();
let stage;
let outlet;
let fallback;
let current = null;
let started = false;
let pageTransition = null;

const ROUTES = [
  { name: 'source', pattern: /^\/source\/(.+)$/, params: match => ({ key: sourceKey(match[1]) }) },
  { name: 'publishing', pattern: /^\/publishing\/?$/, params: () => ({}) },
  { name: 'generate', pattern: /^\/generate\/?$/, params: () => ({}) },
  { name: 'jobs', pattern: /^\/jobs(?:\/([a-f0-9]{32}))?\/?$/, params: match => ({ jobId: match[1] }) },
  { name: 'jobs', pattern: /^\/generate\/jobs\/?$/, params: () => ({}) },
  { name: 'settings', pattern: /^\/settings\/?$/, params: () => ({}) },
  { name: 'autopilot', pattern: /^\/autopilot\/?$/, params: () => ({}) },
  { name: 'library', pattern: /^\/?$/, params: () => ({}) }
];

function sourceKey(value) {
  try { return decodeURIComponent(value); }
  catch { return ''; }
}

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
  generate: () => '#/generate',
  jobs: id => id ? '#/jobs/' + id : '#/jobs',
  publishing: () => '#/publishing',
  autopilot: () => '#/autopilot'
};

export function navigate(hash) {
  const target = hash.startsWith('#') ? hash : '#' + hash;
  if (location.hash === target || (target === '#/' && !location.hash)) return;
  location.hash = target;
}

export function openGeneration(prefill = {}) {
  set({ generationPrefill: prefill });
  navigate(hrefFor.generate());
}

export function registerView(name, create) {
  views.set(name, { create, view: null });
}

function showView(route, previous) {
  fallback?.remove();
  const entry = views.get(route.name);
  if (!entry) return;
  try {
    if (!entry.view) {
      const view = entry.create();
      view.el.classList.add('view');
      view.el.dataset.view = route.name;
      outlet.append(view.el);
      entry.view = view;
    }
    entry.view.el.hidden = false;
    entry.view.enter?.(route, previous);
  } catch (error) {
    console.error('Could not open page:', error);
    if (entry.view) entry.view.el.hidden = true;
    fallback = emptyState({
      icon: 'warning-circle', tone: 'bad', title: 'Could not open this page',
      actions: [button({ label: 'Try again', onClick: () => showView(route, previous) })]
    });
    outlet.append(fallback);
    fallback.querySelector('button').focus({ preventScroll: true });
  }
}

export async function refreshCurrentView() {
  if (!current) return;
  if (fallback?.isConnected) { showView(current); return; }
  try { await views.get(current.name)?.view?.refresh?.(); }
  catch (error) {
    console.error('Could not refresh page:', error);
    toast('Could not refresh this page. Try again.', { kind: 'error' });
  }
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

function nameViewElement(view, route) {
  try { nameShared(view?.sharedElement?.(route)); }
  catch (error) { console.error('Could not animate page:', error); }
}

export function skipPageAnimation() {
  pageTransition?.animation.skipTransition();
}

function swap(from, to) {
  const outgoing = from ? views.get(from.name)?.view : null;
  if (from) scrollMemory.set(from.path, stage.scrollTop);
  const sameView = from && from.name === to.name;
  if (outgoing && !sameView) {
    try { outgoing.leave?.(); }
    catch (error) { console.error('Could not leave page:', error); }
    outgoing.el.hidden = true;
  }
  showView(to, from);
  stage.scrollTop = scrollMemory.get(to.path) ?? 0;
  current = to;
  set({ route: to });
  const activeNav = to.name === 'source' ? 'library' : to.name;
  document.querySelectorAll('[data-nav]').forEach(link => {
    const active = link.dataset.nav === activeNav;
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function render() {
  const next = parse();
  const previous = current;
  if ((pageTransition?.path ?? previous?.path) === next.path) return;
  skipPageAnimation();
  pageTransition = null;
  clearSharedNames();
  if (previous?.path === next.path) return;

  const sidebarResizing = document.getElementById('studio-sidebar')?.getAnimations()
    .some(animation => animation.transitionProperty === 'width' && animation.playState === 'running');
  const canMorph = previous && typeof document.startViewTransition === 'function' &&
    !reducedMotion() && !sidebarResizing;
  if (!canMorph) { swap(previous, next); return; }

  nameViewElement(views.get(previous.name)?.view, next);
  let animation;
  try {
    animation = document.startViewTransition(() => {
      if (pageTransition?.animation !== animation) return;
      swap(previous, next);
      if (!fallback?.isConnected) nameViewElement(views.get(next.name)?.view, previous);
    });
  } catch (error) {
    console.error('Could not start page transition:', error);
    clearSharedNames();
    swap(previous, next);
    return;
  }
  pageTransition = { path: next.path, animation };
  // A transition is skipped (and its promises reject) when the document is hidden or another navigation interrupts
  // it. The DOM swap still ran, so that is not an error; anything else is worth seeing in the console.
  const quiet = error => { if (error?.name !== 'InvalidStateError' && error?.name !== 'AbortError') console.error(error); };
  animation.ready.catch(quiet);
  animation.updateCallbackDone.catch(quiet);
  animation.finished.catch(quiet).finally(() => {
    if (pageTransition?.animation !== animation) return;
    pageTransition = null;
    clearSharedNames();
  });
}

export function startRouter(stageEl, viewsEl) {
  if (started) return;
  started = true;
  stage = stageEl;
  outlet = viewsEl;
  window.addEventListener('hashchange', render);
  const first = parse();
  swap(null, first);
}

export const currentRoute = () => current || state.route;
