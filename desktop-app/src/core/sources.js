// Groups clips by the video they were cut from. A Source is derived data: memoised on the identity of
// state.clips and state.sourceInfo, so calling getSources() from any view is cheap.

import { state, set, subscribe } from './store.js';
import { api } from './api.js';
import { debounce } from './dom.js';

const INFO_KEY = 'vc:sourceInfo:v1';
const RESOLVE_BATCH = 25;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Clips in timeline order: by startSec when every clip has one, otherwise by id with natural number order. */
export function timelineOrder(clips) {
  const byTime = clips.every(clip => Number.isFinite(clip.startSec));
  return [...clips].sort((a, b) => (byTime && a.startSec !== b.startSec ? a.startSec - b.startSec : collator.compare(a.id, b.id)));
}

function mostCommon(values) {
  const counts = new Map();
  let best = '';
  let bestCount = 0;
  for (const value of values) {
    if (!value) continue;
    const count = (counts.get(value) || 0) + 1;
    counts.set(value, count);
    if (count > bestCount) { best = value; bestCount = count; }
  }
  return best;
}

const legacyKey = id => 'legacy:' + String(id).replace(/_\d+$/, '');
const hasMetaTitle = clips => clips.some(clip => clip.source?.title);

/** Name of a local source file without its extension, for sources whose engine metadata has no title. */
const fileTitle = clips => mostCommon(clips.map(clip => clip.source?.file)).replace(/\.[^./\\]+$/, '');

function resolveTitle(key, clips, channel) {
  return mostCommon(clips.map(clip => clip.source?.title))
    || state.sourceInfo[key]?.title
    || fileTitle(clips)
    || (channel ? `${channel} · source video` : 'Untitled source');
}

function makeSource(key, members) {
  const clips = timelineOrder(members);
  const meta = clips.map(clip => clip.source || {});
  const youtube = key.startsWith('yt:');
  const kind = meta.find(item => item.kind)?.kind || (youtube ? 'youtube' : key.startsWith('file:') ? 'file' : 'legacy');
  const videoId = meta.find(item => item.id)?.id || (youtube ? key.slice(3) : '');
  const channel = mostCommon(meta.map(item => item.creator)) || state.sourceInfo[key]?.author || mostCommon(clips.map(clip => clip.creator));
  const url = meta.find(item => item.url)?.url || (videoId ? 'https://www.youtube.com/watch?v=' + videoId : '');

  let readyCount = 0;
  let totalDuration = 0;
  let updatedAt = 0;
  let createdAt = Infinity;
  for (const clip of clips) {
    if (clip.status === 'ready') readyCount += 1;
    if (Number.isFinite(clip.durationSec)) totalDuration += clip.durationSec;
    if (clip.updatedAt > updatedAt) updatedAt = clip.updatedAt;
    const created = Number.isFinite(clip.createdAt) ? clip.createdAt : clip.updatedAt;
    if (created < createdAt) createdAt = created;
  }
  return {
    key, kind, title: resolveTitle(key, clips, channel), channel, url, videoId, clips,
    readyCount, completedCount: clips.length - readyCount, total: clips.length, totalDuration,
    updatedAt, createdAt: Number.isFinite(createdAt) ? createdAt : updatedAt, coverClip: clips[0]
  };
}

function build() {
  const groups = new Map();
  for (const clip of state.clips) {
    const key = clip.source?.key || legacyKey(clip.id);
    const members = groups.get(key);
    if (members) members.push(clip); else groups.set(key, [clip]);
  }
  const list = [];
  for (const [key, members] of groups) list.push(makeSource(key, members));
  return list.sort((a, b) => b.updatedAt - a.updatedAt || (a.key < b.key ? -1 : 1));
}

let memo = { clips: null, info: null, list: [], byKey: new Map() };

/** Every source, most recently updated first. The returned array and its objects must be treated as read-only. */
export function getSources() {
  if (memo.clips !== state.clips || memo.info !== state.sourceInfo) {
    const list = build();
    memo = { clips: state.clips, info: state.sourceInfo, list, byKey: new Map(list.map(source => [source.key, source])) };
  }
  return memo.list;
}

export function getSource(key) {
  getSources();
  return memo.byKey.get(key) || null;
}

/** Display title: the title stored with the clips, else the YouTube title, else "<channel> · source video". */
export function sourceTitle(source) {
  return resolveTitle(source.key, source.clips, source.channel);
}

/** Zero-based position of a clip in the source's timeline, or -1. */
export function clipIndexIn(source, clipId) {
  return source.clips.findIndex(clip => clip.id === clipId);
}

/* ───────── YouTube titles for clips that were generated before the engine stored one ───────── */

const asked = new Set();

function loadSavedInfo() {
  try {
    const saved = JSON.parse(localStorage.getItem(INFO_KEY) || 'null');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).filter(([, info]) => typeof info?.title === 'string' && info.title));
  } catch { return {}; }
}

function saveInfo() {
  try {
    const live = new Set(getSources().map(source => source.key));
    const kept = Object.fromEntries(Object.entries(state.sourceInfo).filter(([key]) => live.has(key)));
    localStorage.setItem(INFO_KEY, JSON.stringify(kept));
  } catch { /* storage unavailable: titles are simply fetched again next launch */ }
}

/**
 * Ask YouTube (through the main process) for the title of every YouTube source that has none yet.
 * Each video id is requested once; results land in state.sourceInfo keyed by source key.
 */
export async function resolveSourceTitles() {
  const wanted = getSources().filter(source =>
    source.kind === 'youtube' && source.videoId && !hasMetaTitle(source.clips)
    && !state.sourceInfo[source.key] && !asked.has(source.videoId));
  if (!wanted.length) return;
  wanted.forEach(source => asked.add(source.videoId));

  for (let start = 0; start < wanted.length; start += RESOLVE_BATCH) {
    const batch = wanted.slice(start, start + RESOLVE_BATCH);
    try {
      const found = await api.resolveSources(batch.map(source => source.videoId));
      const merged = { ...state.sourceInfo };
      let changed = false;
      for (const source of batch) {
        const info = found?.[source.videoId];
        if (!info?.title) continue;
        merged[source.key] = { title: String(info.title), author: String(info.author || '') };
        changed = true;
      }
      if (changed) { set({ sourceInfo: merged }); saveInfo(); }
    } catch {
      // Offline or the bridge is unavailable: allow another attempt after the next library change.
      batch.forEach(source => asked.delete(source.videoId));
    }
  }
}

const saved = loadSavedInfo();
if (Object.keys(saved).length) set({ sourceInfo: saved });
subscribe('clips', debounce(() => { resolveSourceTitles(); }, 400));
