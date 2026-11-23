import { button } from '../core/components.js';
import { errorMessage, withTimeout } from '../core/api.js';
import { h, icon, setText } from '../core/dom.js';
import { SUBTITLE_MARGINS, SUBTITLE_STYLES } from '../core/generation-settings.js';

const samples = import.meta.glob('../assets/subtitle-previews/*.{png,webm}', {
  eager: true, import: 'default', query: '?url'
});
const sampleUrl = (id, extension) => samples['../assets/subtitle-previews/' + id + '.' + extension];

export function createSubtitleControls(onChange) {
  const radios = new Map();
  const picker = h('fieldset', { class: 'gen-subtitles' },
    h('legend', { text: 'Subtitle style' }),
    h('div', { class: 'gen-subtitle-grid' }, SUBTITLE_STYLES.map(({ id, label }) => {
      const radio = h('input', { class: 'sr-only', type: 'radio', name: 'gen-subtitle-style', value: id, onchange: onChange });
      radios.set(id, radio);
      const sample = id === 'off'
        ? icon('closed-captioning', { cls: 'gen-subtitle-off' })
        : h('img', { src: sampleUrl(id, 'png'), alt: '' });
      return h('label', { class: 'gen-subtitle-option' }, radio,
        h('span', { class: 'gen-subtitle-thumb', 'aria-hidden': 'true' }, sample), h('span', { text: label }));
    })));

  const poster = h('img', { alt: '', hidden: true });
  const animation = h('video', { muted: true, playsInline: true, preload: 'none', hidden: true });
  const overlay = h('div', { class: 'gen-subtitle-overlay', 'aria-hidden': 'true' }, poster, animation);
  const play = button({ label: 'Play sample', size: 'sm', variant: 'ghost' });
  const playLabel = play.querySelector('.btn__label');
  const status = h('span', { role: 'status' });
  const sampleControls = h('div', { class: 'gen-subtitle-sample' },
    h('span', { text: 'Sample subtitles' }), play, status);
  let selected;
  let playing = false;
  let playback = 0;

  function stop() {
    playback++;
    playing = false;
    if (animation.hasAttribute('src')) {
      animation.pause();
      animation.removeAttribute('src');
      animation.load();
    }
    animation.hidden = true;
    poster.hidden = !selected || selected === 'off';
    setText(playLabel, 'Play sample');
    play.removeAttribute('aria-busy');
    setText(status, '');
  }

  play.onclick = async () => {
    if (playing) { stop(); return; }
    const request = ++playback;
    playing = true;
    setText(playLabel, 'Stop sample');
    play.setAttribute('aria-busy', 'true');
    setText(status, 'Loading animated sample…');
    animation.src = sampleUrl(selected, 'webm');
    try {
      await withTimeout(animation.play(), 8000, 'The animated sample did not load. Try again.');
      if (request !== playback) return;
      poster.hidden = true;
      animation.hidden = false;
      play.removeAttribute('aria-busy');
      setText(status, '');
    } catch (error) {
      if (request !== playback) return;
      stop();
      setText(status, error.name === 'NotSupportedError' ? 'The animated sample could not be played.' : errorMessage(error));
    }
  };
  animation.onended = stop;

  function read() { return picker.querySelector('input:checked').value; }

  function restore(id) { (radios.get(id) ?? radios.get('classic')).checked = true; }

  function refresh(layout, height) {
    const margin = SUBTITLE_MARGINS[layout === 'split' ? 'split' : 'standard'];
    overlay.style.bottom = 100 * (margin - SUBTITLE_MARGINS.previewInset) / height + '%';
    const next = read();
    if (next === selected) return;
    selected = next;
    stop();
    play.hidden = !sampleUrl(selected, 'webm');
    sampleControls.hidden = selected === 'off';
    if (selected !== 'off') poster.src = sampleUrl(selected, 'png');
    else poster.removeAttribute('src');
  }

  return { picker, overlay, sampleControls, refresh, read, restore, stop };
}
