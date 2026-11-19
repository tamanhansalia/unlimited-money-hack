// Publishing details: field limits and validation, per-clip drafts, and the publish call.
// `values` is always { title, description, tags, xPost } with string fields (tags is comma separated).

import { state, subscribe } from './store.js';
import { api } from './api.js';
import { refreshLibrary } from './library.js';

export const LIMITS = { title: 100, description: 2200, tags: 500, xPost: 280 };

const FIELDS = ['title', 'description', 'tags', 'xPost'];
const X_PLATFORMS = ['twitter', 'x'];

const text = (values, field) => String(values?.[field] ?? '').trim();

/** Unique, trimmed, non-empty tags. Duplicates are matched ignoring case, keeping the first spelling. */
export function parseTags(value) {
  const seen = new Set();
  const tags = [];
  for (const part of [].concat(value ?? []).join(',').split(',')) {
    const tag = part.trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

/** The text posted to X: the dedicated "Post for X" if there is one, else the title and description. */
export function xPostText(values) {
  return text(values, 'xPost') || [text(values, 'title'), text(values, 'description')].filter(Boolean).join('\n\n');
}

function isTouched(touched, field) {
  if (!touched) return false;
  if (touched instanceof Set) return touched.has(field);
  if (Array.isArray(touched)) return touched.includes(field);
  return Boolean(touched[field]);
}

/**
 * Validate the publishing fields.
 * → { errors, warnings, counts, ok, firstInvalid }
 *   errors / warnings: field → message. Errors are only listed for touched fields unless `force`, but `ok`
 *   always reflects real validity. `touched` may be a Set, an array or a { field: true } object.
 *   Pass `platforms` to also check the default X post (title and description) when X is a destination.
 */
export function validateDetails(values, { force = false, touched, platforms = [] } = {}) {
  const title = text(values, 'title');
  const description = text(values, 'description');
  const xPost = text(values, 'xPost');
  const tagsLength = parseTags(values?.tags).join(',').length;
  const counts = { title: title.length, description: description.length, tags: tagsLength, xPost: xPost.length };

  const problems = {};
  if (!title) problems.title = 'Add a title before publishing.';
  if (tagsLength > LIMITS.tags) {
    problems.tags = `Tags use ${tagsLength} of YouTube’s ${LIMITS.tags} characters. Remove ${tagsLength - LIMITS.tags} or shorten some.`;
  }
  if (xPost.length > LIMITS.xPost) {
    problems.xPost = `The post for X is ${xPost.length} characters, ${xPost.length - LIMITS.xPost} over the ${LIMITS.xPost} limit. Shorten it.`;
  } else if (!xPost && platforms.some(name => X_PLATFORMS.includes(name))) {
    const fallback = xPostText(values).length;
    if (fallback > LIMITS.xPost) {
      problems.xPost = `X will use your title and description (${fallback} characters). Write a shorter “Post for X”, ${LIMITS.xPost} characters at most.`;
    }
  }

  const warnings = {};
  if (title.length > LIMITS.title) warnings.title = `YouTube keeps only the first ${LIMITS.title} characters of the title.`;
  if (description.length > LIMITS.description) {
    warnings.description = `Instagram captions are limited to ${LIMITS.description.toLocaleString()} characters. Shorten this before posting to Instagram.`;
  }

  const errors = {};
  for (const field of FIELDS) {
    if (problems[field] && (force || isTouched(touched, field))) errors[field] = problems[field];
  }
  const firstInvalid = FIELDS.find(field => problems[field]) || null;
  return { errors, warnings, counts, ok: firstInvalid === null, firstInvalid };
}

/* ───────── Drafts ───────── */

const drafts = new Map(); // clip id -> values; in memory only, so a restart starts from the saved metadata

const copyValues = values => Object.fromEntries(FIELDS.map(field => [field, String(values?.[field] ?? '')]));

export function getDraft(clip) {
  const draft = drafts.get(clip.id);
  return draft ? { ...draft } : null;
}
export function setDraft(clip, values) { drafts.set(clip.id, copyValues(values)); }
export function clearDraft(clip) { drafts.delete(clip.id); }
export const hasDraft = clip => drafts.has(clip.id);

// Forget drafts of clips that no longer exist.
subscribe('clips', () => {
  if (!state.clipsLoaded || !state.clips.length || !drafts.size) return;
  const ids = new Set(state.clips.map(clip => clip.id));
  for (const id of [...drafts.keys()]) if (!ids.has(id)) drafts.delete(id);
});

/* ───────── Publish ───────── */

const publishing = new Set();

/**
 * Publish a Ready clip to the given platforms, then refresh the library (the main process moves the clip to
 * Completed on success). Rejects with a readable message; the draft is kept on failure.
 */
export async function publishClip(clip, platforms, values) {
  if (!clip?.id) throw new Error('Choose a clip to publish.');
  if (clip.status !== 'ready') throw new Error('Only clips in Ready can be published. Restore this clip to Ready first.');
  const targets = [...new Set([].concat(platforms ?? []).map(String))];
  if (!targets.length) throw new Error('Choose at least one destination.');
  const check = validateDetails(values, { force: true, platforms: targets });
  if (!check.ok) throw new Error(check.errors[check.firstInvalid]);
  if (publishing.has(clip.id)) throw new Error('This clip is already being published.');

  publishing.add(clip.id);
  try {
    const result = await api.publishClip(clip.id, targets, {
      title: text(values, 'title'),
      description: text(values, 'description'),
      tags: parseTags(values?.tags).join(', '),
      xPost: text(values, 'xPost')
    });
    clearDraft(clip);
    await refreshLibrary({ quiet: true });
    return result && typeof result === 'object' ? result : { message: 'Accepted by Ayrshare.' };
  } finally {
    publishing.delete(clip.id);
  }
}
