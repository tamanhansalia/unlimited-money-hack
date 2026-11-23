import { h } from '../core/dom.js';
import { button, setBusy, spinner } from '../core/components.js';
import { api, errorMessage, withTimeout } from '../core/api.js';
import { validDuration } from '../core/generation-settings.js';
import { createSubtitleControls } from './subtitle-controls.js';

function option(id, label) { return h('option', { value: id, text: label }); }
function select(id, label, values) {
  const input = h('select', { class: 'input', id }, values.map(([value, title]) => option(value, title)));
  return { input, el: field(label, input) };
}
function field(label, input) { return h('label', { class: 'field' }, h('span', { text: label }), input); }
function numeric(id, { min = 0, max, step = 1 } = {}) {
  return h('input', { class: 'input num', id, type: 'number', min, max, step });
}

export function timestampMs(value) {
  const parts = String(value).trim().split(':');
  if (parts.length > 3 || !/^\d+(?:\.\d{1,3})?$/.test(parts.at(-1))) return NaN;
  if (parts.slice(0, -1).some(part => !/^\d+$/.test(part))) return NaN;
  if (parts.length > 1 && parts.slice(1).some(part => Number(part) >= 60)) return NaN;
  const ms = Math.round(1000 * parts.reduce((seconds, part) => seconds * 60 + Number(part), 0));
  return Number.isSafeInteger(ms) ? ms : NaN;
}

function contained(context, image, source, target, fill = false, position = 0.5) {
  const [sx, sy, sw, sh] = source;
  const [dx, dy, dw, dh] = target;
  const scale = fill ? Math.max(dw / sw, dh / sh) : Math.min(dw / sw, dh / sh);
  const anchor = fill ? position : 0.5;
  context.save();
  context.beginPath();
  context.rect(dx, dy, dw, dh);
  context.clip();
  context.drawImage(image, sx, sy, sw, sh, dx + (dw - sw * scale) * anchor,
    dy + (dh - sh * scale) * anchor, sw * scale, sh * scale);
  context.restore();
}

export function createGenerationControls({ countField, lengthField, getLength }) {
  const mode = select('gen-clip-mode', 'Clipping mode', [['auto', 'Auto highlights'], ['manual', 'Manual timestamps']]);
  const min = numeric('gen-duration-min', { min: 0.04, max: 300, step: 0.001 });
  const max = numeric('gen-duration-max', { min: 0.04, max: 300, step: 0.001 });
  const custom = h('div', { class: 'field', hidden: true },
    h('div', { class: 'gen-pair' }, field('Minimum length in seconds', min), field('Maximum length in seconds', max)),
    h('p', { class: 'gen-card__sub', text: 'Set both values to the same number for a fixed duration.' }));
  const rows = h('div', { class: 'gen-ranges' });
  const add = button({ label: 'Add clip range', size: 'sm', variant: 'ghost' });
  const manual = h('div', { class: 'field', hidden: true }, rows, add,
    h('p', { class: 'gen-card__sub', text: 'Use seconds, MM:SS or HH:MM:SS.' }));
  const clipControls = h('section', { class: 'gen-section', 'aria-labelledby': 'gen-clips-title' },
    h('h2', { id: 'gen-clips-title', class: 'gen-card__title', text: 'Clips' }), mode.el, countField, lengthField, custom, manual);
  const orientation = select('gen-orientation', 'Source orientation', [['auto', 'Auto-detect'], ['vertical', 'Vertical'], ['horizontal', 'Horizontal']]);
  const layout = select('gen-layout', 'Framing', [['auto', 'Use source orientation'], ['fit', 'Fit full frame'],
    ['fill', 'Fill frame'], ['split', 'Camera + screen'], ['reframe', 'Auto reframe']]);
  const position = h('input', { id: 'gen-position', type: 'range', min: 0, max: 100, value: 50 });
  const cropPosition = field('Crop position', position);
  const activeRegion = select('gen-active-region', 'Region to edit', [['0', 'Camera'], ['1', 'Screen']]);
  const flip = h('input', { id: 'gen-split-flip', type: 'checkbox' });
  const regionInputs = ['Left', 'Top', 'Width', 'Height'].map((label, index) => ({ label, input: numeric(`gen-region-${index}`, { max: 100, step: 0.1 }) }));
  const canvas = h('canvas', { class: 'gen-source-frame', hidden: true, 'aria-label': 'Drag to select a region of the source frame' });
  const split = h('div', { class: 'field', hidden: true }, activeRegion.el,
    h('p', { class: 'gen-card__sub', text: 'Load a frame and drag over the camera and screen, or enter each region as percentages.' }),
    canvas, h('div', { class: 'gen-pair' }, regionInputs.map(({ label, input }) => field(`${label} %`, input))),
    h('label', { class: 'gen-check' }, flip, 'Screen above camera'));
  const subtitles = createSubtitleControls(refreshControls);
  const reframeHint = h('p', { class: 'gen-card__sub', hidden: true,
    text: 'The preview shows the full frame. Auto reframe samples each clip during export.' });
  const visualControls = h('section', { class: 'gen-section', 'aria-labelledby': 'gen-framing-title' },
    h('h2', { id: 'gen-framing-title', class: 'gen-card__title', text: 'Framing and subtitles' }),
    h('div', { class: 'gen-pair' }, orientation.el, layout.el), reframeHint, cropPosition, split, subtitles.picker);

  const output = h('canvas', { width: 360, height: 640, 'aria-hidden': 'true' });
  const readyFrame = button({ label: 'Load frame', icon: 'image', size: 'sm' });
  const retryDetails = button({ label: 'Check source again', size: 'sm', variant: 'ghost' });
  retryDetails.hidden = true;
  const previewTime = h('input', { class: 'input num', id: 'gen-preview-time', placeholder: '0:00', value: '0' });
  const meta = h('p', { class: 'gen-card__sub', role: 'status' });
  const loading = h('p', { class: 'loading-state', role: 'status', hidden: true }, spinner(), 'Reading source details…');
  const preview = h('section', { class: 'gen-card gen-preview glass', 'aria-labelledby': 'gen-preview-title' },
    h('h2', { id: 'gen-preview-title', class: 'gen-card__title', text: 'Preview' }),
    h('div', { class: 'gen-output' }, output, subtitles.overlay), subtitles.sampleControls,
    h('div', { class: 'gen-preview-controls' }, field('Preview time', previewTime), readyFrame), loading, meta, retryDetails);
  let source = '';
  let metadata = null;
  let frame = null;
  let probeVersion = 0;
  let previewPending = false;
  let detailsPending = false;
  let regions = [null, null];
  let origin;

  function addRange(start = '', end = '') {
    const index = rows.children.length + 1;
    const from = h('input', { class: 'input num', placeholder: '0:00', value: start });
    const to = h('input', { class: 'input num', placeholder: '0:30', value: end });
    const status = h('p', { class: 'gen-card__sub', role: 'status' });
    const remove = button({ label: 'Remove range', size: 'sm', variant: 'ghost' });
    const row = h('div', { class: 'gen-range' }, h('div', { class: 'gen-pair' }, field('Start', from), field('End', to)), status, remove);
    const update = () => {
      const range = rangeFrames(from.value, to.value);
      status.textContent = range ? `${range[0] / 1000}s to ${range[1] / 1000}s · ${(range[1] - range[0]) / 1000}s` : '';
    };
    from.addEventListener('input', update);
    to.addEventListener('input', update);
    remove.onclick = () => { row.remove(); syncRanges(); };
    row.dataset.range = index;
    row.inputs = [from, to];
    rows.append(row);
    syncRanges();
    update();
    return from;
  }

  function syncRanges() {
    add.disabled = rows.children.length >= 10;
    for (const row of rows.children) row.lastElementChild.hidden = rows.children.length === 1;
  }

  function rangeFrames(from, to) {
    const start = timestampMs(from), end = timestampMs(to);
    const aligned = [Math.ceil(start / 40) * 40, Math.floor(end / 40) * 40];
    return aligned[0] < aligned[1] ? aligned : null;
  }

  function refreshControls() {
    const automatic = mode.input.value === 'auto';
    countField.hidden = lengthField.hidden = !automatic;
    custom.hidden = !automatic || getLength() !== 'custom';
    manual.hidden = automatic;
    cropPosition.hidden = layout.input.value !== 'fill';
    split.hidden = layout.input.value !== 'split';
    reframeHint.hidden = layout.input.value !== 'reframe';
    subtitles.refresh(layout.input.value, output.height * 2);
    readyFrame.disabled = !source || previewPending || detailsPending;
    draw();
  }

  function positionedLayout() {
    if (layout.input.value !== 'auto') return layout.input.value === 'reframe' ? 'fit' : layout.input.value;
    const vertical = orientation.input.value === 'vertical' || (orientation.input.value === 'auto' && metadata?.height > metadata?.width);
    return vertical ? 'fill' : 'fit';
  }

  function draw(temporary) {
    const context = output.getContext('2d');
    context.fillStyle = '#101014';
    context.fillRect(0, 0, output.width, output.height);
    canvas.hidden = !frame;
    if (!frame) return;
    const width = frame.naturalWidth, height = frame.naturalHeight;
    const arrangement = positionedLayout();
    if (arrangement === 'split') {
      const selected = flip.checked ? [...regions].reverse() : regions;
      selected.forEach((region, index) => {
        if (region?.every(Number.isFinite) && region[2] > 0 && region[3] > 0) {
          contained(context, frame, region.map((value, i) => value * (i % 2 ? height : width)), [0, index * 320, 360, 320]);
        }
      });
    } else contained(context, frame, [0, 0, width, height], [0, 0, 360, 640], arrangement === 'fill', Number(position.value) / 100);
    canvas.width = width;
    canvas.height = height;
    const sourceContext = canvas.getContext('2d');
    sourceContext.drawImage(frame, 0, 0);
    regions.forEach((region, index) => {
      const points = Number(activeRegion.input.value) === index && temporary ? temporary : region;
      if (!points?.every(Number.isFinite)) return;
      sourceContext.strokeStyle = index ? '#56dcef' : '#ffd362';
      sourceContext.lineWidth = Math.max(2, width / 200);
      sourceContext.strokeRect(...points.map((value, i) => value * (i % 2 ? height : width)));
    });
  }

  function syncRegionFields() {
    const region = regions[Number(activeRegion.input.value)];
    regionInputs.forEach(({ input }, index) => {
      input.value = Number.isFinite(region?.[index]) ? Math.round(region[index] * 1000) / 10 : '';
    });
    draw();
  }

  const coordinate = event => {
    const bounds = canvas.getBoundingClientRect();
    return [(event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height]
      .map(value => Math.min(1, Math.max(0, value)));
  };
  function regionAt(event) {
    const [x, y] = coordinate(event);
    return [Math.min(x, origin[0]), Math.min(y, origin[1]), Math.abs(x - origin[0]), Math.abs(y - origin[1])];
  }
  canvas.onpointerdown = event => { origin = coordinate(event); canvas.setPointerCapture(event.pointerId); };
  canvas.onpointermove = event => { if (origin) draw(regionAt(event)); };
  canvas.onpointercancel = () => { origin = undefined; draw(); };
  canvas.onpointerup = event => {
    if (!origin) return;
    const region = regionAt(event);
    origin = undefined;
    if (validRegion(region)) regions[Number(activeRegion.input.value)] = region;
    syncRegionFields();
  };
  const validRegion = region => region?.every(value => Number.isFinite(value) && value >= 0 && value <= 1)
    && region[2] >= 0.02 && region[3] >= 0.02 && region[0] + region[2] <= 1.000001 && region[1] + region[3] <= 1.000001;
  regionInputs.forEach(({ input }) => input.addEventListener('input', () => {
    regions[Number(activeRegion.input.value)] = regionInputs.map(({ input: item }) => item.valueAsNumber / 100);
    draw();
  }));
  activeRegion.input.onchange = syncRegionFields;
  add.onclick = () => addRange().focus();
  for (const input of [mode.input, orientation.input, layout.input, position, flip]) input.addEventListener('input', refreshControls);

  async function inspect(key, previewAt) {
    const current = ++probeVersion;
    const details = previewAt === undefined;
    detailsPending = details;
    previewPending = !details;
    loading.hidden = !details;
    retryDetails.hidden = true;
    meta.textContent = '';
    preview.setAttribute('aria-busy', 'true');
    if (!details) setBusy(readyFrame, true, 'Loading frame…');
    readyFrame.disabled = true;
    try {
      const info = await api.inspectSource(key, previewAt);
      if (current !== probeVersion) return;
      if (!info || typeof info !== 'object' || Array.isArray(info) ||
          (!info.active && !(Number.isFinite(info.duration) && info.duration > 0))) {
        throw new Error('Could not read the video duration. Check the source and try again.');
      }
      metadata = info;
      if (info.active) meta.textContent = 'This stream can be processed after it ends.';
      else meta.textContent = [info.title, info.width && info.height && (info.width === info.height ? 'Square' : info.width > info.height ? 'Horizontal' : 'Vertical'),
        Number.isFinite(info.duration) && `${Math.floor(info.duration / 60)}:${String(Math.floor(info.duration % 60)).padStart(2, '0')}`].filter(Boolean).join(' · ');
      retryDetails.hidden = !info.active && Number.isFinite(info.duration);
      if (!details && !info.active) {
        if (!info.frame) throw new Error('No frame was returned. Try another preview time.');
        const image = new Image();
        image.src = info.frame;
        await withTimeout(image.decode(), 8000, 'Could not decode the preview frame in time.');
        if (current === probeVersion) frame = image;
      }
    } catch (error) {
      if (current !== probeVersion) return;
      const message = errorMessage(error);
      if (/live event|is live|will begin|stream ends/i.test(message)) metadata = { active: true };
      meta.textContent = metadata?.active ? 'This stream can be processed after it ends.' : message;
      retryDetails.hidden = Boolean(metadata?.duration) && !metadata?.active;
    } finally {
      if (current === probeVersion) {
        setBusy(readyFrame, false);
        detailsPending = previewPending = false;
        loading.hidden = true;
        preview.removeAttribute('aria-busy');
        refreshControls();
      }
    }
  }

  function setSource(key) {
    if (key === source) return;
    source = key;
    probeVersion++;
    detailsPending = previewPending = false;
    loading.hidden = true;
    preview.removeAttribute('aria-busy');
    setBusy(readyFrame, false);
    frame = metadata = null;
    regions = [null, null];
    flip.checked = false;
    retryDetails.hidden = true;
    rows.replaceChildren();
    addRange();
    meta.textContent = '';
    syncRegionFields();
    refreshControls();
    if (source) void inspect(source);
  }

  retryDetails.onclick = () => { if (source && !detailsPending && !previewPending) void inspect(source); };
  previewTime.oninput = () => previewTime.removeAttribute('aria-invalid');
  readyFrame.onclick = () => {
    const time = timestampMs(previewTime.value);
    if (!Number.isFinite(time) || time >= metadata?.duration * 1000) {
      previewTime.setAttribute('aria-invalid', 'true');
      meta.textContent = 'Enter a preview time inside the video.';
      previewTime.focus();
      return;
    }
    if (source && !detailsPending && !previewPending) void inspect(source, time / 1000);
  };

  function restore(options = {}, duration) {
    mode.input.value = options.mode || 'auto';
    orientation.input.value = options.orientation || 'auto';
    layout.input.value = options.layout || 'auto';
    subtitles.restore(options.subtitles);
    position.value = (options.position ?? 0.5) * 100;
    flip.checked = Boolean(options.cameraLast);
    regions = options.regions ? [...options.regions] : [null, null];
    if (flip.checked) regions.reverse();
    min.value = duration ? duration[0] / 1000 : '';
    max.value = duration ? duration[1] / 1000 : '';
    rows.replaceChildren();
    if (options.ranges?.length) options.ranges.forEach(([start, end]) => addRange(start / 1000, end / 1000));
    else addRange();
    syncRegionFields();
    refreshControls();
  }

  function read() {
    const reject = (control, message) => {
      control.setAttribute('aria-invalid', 'true');
      control.focus();
      throw new Error(message);
    };
    const options = { mode: mode.input.value, layout: layout.input.value, orientation: orientation.input.value,
      subtitles: subtitles.read(), position: Number(position.value) / 100 };
    if (metadata?.active) throw new Error('This stream can be processed after it ends.');
    if (options.layout === 'split') {
      const invalid = regions.findIndex(region => !validRegion(region));
      if (invalid >= 0) {
        activeRegion.input.value = String(invalid);
        syncRegionFields();
        reject(regionInputs[0].input, 'Choose valid camera and screen regions inside the source frame.');
      }
      options.cameraLast = flip.checked;
      options.regions = flip.checked ? [...regions].reverse() : regions;
    }
    if (options.mode === 'manual') {
      if (!Number.isFinite(metadata?.duration)) throw new Error('Load the source duration before choosing manual timestamps.');
      const ranges = [...rows.children].map(row => {
        const [from, to] = row.inputs.map(input => input.value);
        if (timestampMs(to) > metadata.duration * 1000) reject(row.inputs[1], 'A manual clip ends after the video.');
        const range = rangeFrames(from, to);
        if (!range) reject(row.inputs[!Number.isFinite(timestampMs(from)) ? 0 : 1], 'Enter a start and end time at least one frame apart.');
        return range;
      });
      ranges.sort(([a], [b]) => a - b);
      if (ranges.some(([start], index) => start < (ranges[index - 1]?.[1] ?? 0))) throw new Error('Manual clip ranges must not overlap.');
      options.ranges = ranges;
    } else if (getLength() === 'custom') {
      options.duration = [min.valueAsNumber, max.valueAsNumber].map(value => Math.round(value * 1000));
      if (!validDuration(options.duration)) reject(min, 'Choose a duration range from 0.04 to 300 seconds that fits whole video frames.');
    }
    return options;
  }

  const clearInvalid = event => event.target.removeAttribute('aria-invalid');
  clipControls.addEventListener('input', clearInvalid);
  visualControls.addEventListener('input', clearInvalid);
  restore();
  return { clipControls, visualControls, preview, setSource, restore, read, refreshControls, stopSubtitlePreview: subtitles.stop };
}
