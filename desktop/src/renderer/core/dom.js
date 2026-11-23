// Tiny DOM toolkit. No virtual DOM: views build nodes once and patch them.

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function append(node, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid.nodeType ? kid : String(kid));
  }
}

/**
 * h('div', {class: 'x', dataset: {id: 1}, style: {'--p': 0.5}, onclick: fn, 'aria-label': 'y'}, ...children)
 * Falsy props are skipped. `text` sets textContent. Styles go through the CSSOM (allowed under our CSP).
 */
export function h(tag, props, ...kids) {
  const node = document.createElement(tag);
  if (props) {
    for (const key of Object.keys(props)) {
      const value = props[key];
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'style') {
        for (const name of Object.keys(value)) {
          if (name.startsWith('--')) node.style.setProperty(name, value[name]);
          else node.style[name] = value[name];
        }
      } else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key.includes('-') || key === 'role') node.setAttribute(key, value === true ? '' : value);
      else if (key in node) node[key] = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
  }
  append(node, kids);
  return node;
}

/** Phosphor icon. Names must be written as string literals so the build can subset the font. */
export function icon(name, { fill = false, cls = '' } = {}) {
  const node = document.createElement('i');
  node.className = (fill ? 'ph-fill ph-' : 'ph ph-') + name + (cls ? ' ' + cls : '');
  node.setAttribute('aria-hidden', 'true');
  return node;
}

export const clear = node => { node.replaceChildren(); return node; };

/**
 * Keyed reconcile of `parent`'s children (the parent must contain only nodes managed here).
 * Existing nodes are reused and reordered, stale ones removed, new ones created.
 */
export function reconcile(parent, items, getKey, create, update) {
  const existing = new Map();
  for (const child of parent.children) existing.set(child.dataset.key, child);
  const next = [];
  for (const item of items) {
    const key = String(getKey(item));
    let node = existing.get(key);
    if (node) {
      existing.delete(key);
      update?.(node, item);
    } else {
      node = create(item);
      node.dataset.key = key;
    }
    next.push(node);
  }
  for (const stale of existing.values()) stale.remove();
  let cursor = parent.firstChild;
  for (const node of next) {
    if (node === cursor) cursor = cursor.nextSibling;
    else parent.insertBefore(node, cursor);
  }
  return next;
}

/** Event delegation: delegate(root, 'click', '[data-id]', (event, matchedEl) => …) */
export function delegate(root, type, selector, handler, options) {
  const listener = event => {
    const target = event.target instanceof Element ? event.target.closest(selector) : null;
    if (target && root.contains(target)) handler(event, target);
  };
  root.addEventListener(type, listener, options);
  return () => root.removeEventListener(type, listener, options);
}

/** Replace the children of `node` only when the text really changed (avoids needless text-node churn). */
export function setText(node, text) {
  const value = String(text ?? '');
  if (node.textContent !== value) node.textContent = value;
}

/** Run a rise animation on freshly inserted nodes, staggered by index. Removes the class when done. */
export function stagger(nodes, limit = 14) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  nodes.slice(0, limit).forEach((node, index) => {
    node.style.setProperty('--i', index);
    node.classList.add('rise');
    node.addEventListener('animationend', () => { node.classList.remove('rise'); node.style.removeProperty('--i'); }, { once: true });
  });
}

export const raf = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function debounce(fn, ms) {
  let timer;
  const wrapped = (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}
export function isTyping(target) {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}
export function shake(field) {
  field.classList.remove('is-shaking');
  void field.offsetWidth;
  field.classList.add('is-shaking');
}
