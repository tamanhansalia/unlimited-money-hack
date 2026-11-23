import presets from '../../../../engine/generation-presets.json';

export const SETTINGS_KEY = 'vc:generation-settings';

export const CLIP_LENGTHS = Object.entries(presets.lengths)
  .filter(([, item]) => !item.hidden)
  .map(([id, item]) => ({ id, ...item }));
export const SUBTITLE_STYLES = presets.subtitles;
export const SUBTITLE_MARGINS = presets.subtitleMargins;
export const SOURCE_LANGUAGES = [
  { id: 'hi', label: 'Hindi or Hinglish' },
  { id: 'en', label: 'English' },
  { id: 'auto', label: 'Auto-detect' }
];

const sourceLanguage = id => SOURCE_LANGUAGES.find(language => language.id === id)?.id || 'hi';

export function clipLengthById(id) {
  if (id === 'custom') return { id, label: 'Custom range' };
  return CLIP_LENGTHS.find(item => item.id === id) || CLIP_LENGTHS[0];
}

/** A missing length is Auto. An unknown length is rejected so a bad value cannot start a job. */
export function resolveClipLength(id) {
  if (id === undefined || id === null || id === '') return CLIP_LENGTHS[0];
  return CLIP_LENGTHS.find(item => item.id === id) || (Object.hasOwn(presets.lengths, id) ? { id } : null);
}

export function readGenerationSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { saved = {}; }
  const duration = saved.length === '30' ? [25000, 35000] : saved.duration;
  const validCustom = (saved.length === '30' || saved.length === 'custom') && validDuration(duration);
  return {
    duration: validCustom ? duration : null,
    provider: typeof saved.provider === 'string' ? saved.provider : '',
    seoProvider: typeof saved.seoProvider === 'string' ? saved.seoProvider : '',
    language: sourceLanguage(saved.language),
    length: validCustom ? 'custom' : CLIP_LENGTHS.find(item => item.id === saved.length)?.id || 'auto'
  };
}

/** Merge a patch into the saved defaults. An empty seoProvider clears the separate SEO CLI. */
export function writeGenerationSettings(patch) {
  const next = { ...readGenerationSettings(), ...patch };
  const stored = {
    provider: typeof next.provider === 'string' ? next.provider : '',
    language: sourceLanguage(next.language),
    length: next.length === 'custom' && validDuration(next.duration) ? 'custom'
      : CLIP_LENGTHS.find(item => item.id === next.length)?.id || 'auto'
  };
  if (stored.length === 'custom') stored.duration = next.duration;
  if (typeof next.seoProvider === 'string' && next.seoProvider) stored.seoProvider = next.seoProvider;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(stored));
  return stored;
}

export function validDuration(duration) {
  return Array.isArray(duration) && duration.length === 2 && duration.every(Number.isSafeInteger)
    && duration[0] >= 40 && duration[1] <= 300000 && Math.ceil(duration[0] / 40) <= Math.floor(duration[1] / 40);
}
