import { api, errorMessage } from '../core/api.js';
import { button, setBusy } from '../core/components.js';
import { h } from '../core/dom.js';
import { SOURCE_LANGUAGES } from '../core/generation-settings.js';

const SAME = 'same';

export function sourceLanguageSelect(id) {
  return h('select', { class: 'input', id },
    SOURCE_LANGUAGES.map(({ id, label }) => h('option', { value: id, text: label })));
}

function providerField(id, label, hint) {
  const select = h('select', { class: 'input', id, 'aria-describedby': `${id}-hint ${id}-status` });
  const test = button({ label: 'Test CLI', ariaLabel: `Test ${label}`, size: 'sm' });
  const message = h('p', { class: 'field__msg', id: `${id}-status`, role: 'status' });
  const root = h('div', { class: 'field cli-field' },
    h('label', { class: 'field__label', htmlFor: id, text: label }),
    select, h('p', { class: 'field__msg cli-field__hint', id: `${id}-hint`, text: hint }),
    h('div', { class: 'field__actions cli-field__actions' }, test, message));
  return { select, test, message, root };
}

/** Discovery and testing are shared by Settings and Generate. */
export function createCliFields({ generationId, seoId, onChange, onUpdate }) {
  const fields = {
    provider: providerField(generationId, 'Generation CLI', 'Finds highlights and writes subtitles.'),
    seoProvider: providerField(seoId, 'SEO CLI', 'Writes titles, descriptions, tags and X posts.')
  };
  const rescan = button({ label: 'Rescan', ariaLabel: 'Rescan installed CLIs', icon: 'arrows-clockwise', size: 'sm' });
  const notice = h('p', { class: 'field__msg cli-notice', role: 'status' });
  let values = { provider: '', seoProvider: '' };
  let catalog = [];
  let installed = new Map();
  let scanning = false;
  let scanError = '';
  let testing = '';
  const results = new Map();

  const generationIdForRun = () => values.provider || installed.keys().next().value;
  const effectiveId = role => (role === 'seoProvider' && values.seoProvider) || generationIdForRun();
  const hasInstalled = id => installed.has(id);

  function selection() {
    const provider = installed.get(effectiveId('provider'));
    const seo = installed.get(effectiveId('seoProvider'));
    if (scanning || testing || !provider || !seo) return null;
    return { provider: provider.id, providerLabel: provider.label, seoProvider: values.seoProvider || undefined,
      seoProviderLabel: seo.label };
  }

  function paintOptions() {
    const options = [...catalog].sort((a, b) => Number(b.installed) - Number(a.installed));
    for (const [role, field] of Object.entries(fields)) {
      const seo = role === 'seoProvider';
      const explicit = values[role];
      field.select.replaceChildren(
        h('option', { value: '', disabled: true, text: 'Choose an installed CLI' }),
        seo && h('option', { value: SAME, text: 'Same as generation' }),
        explicit && !catalog.some(item => item.id === explicit) &&
          h('option', { value: explicit, disabled: true, text: explicit + ' · unavailable' }),
        ...options.map(item => h('option', { value: item.id, disabled: !item.installed,
          text: item.label + (item.installed ? '' : ' · not installed') })));
      field.select.value = explicit || (seo ? SAME : generationIdForRun() || '');
    }
  }

  function publishStatus() {
    const isBusy = scanning || Boolean(testing);
    rescan.disabled = isBusy;
    notice.textContent = scanning ? 'Checking installed CLIs…' : scanError ||
      (!installed.size ? 'Install and sign in to a supported CLI, then rescan.' : '');
    notice.dataset.tone = scanError ? 'error' : '';
    for (const [role, field] of Object.entries(fields)) {
      const id = effectiveId(role);
      const result = results.get(id);
      const unavailable = !scanning && !scanError && values[role] && !hasInstalled(id);
      field.select.disabled = isBusy || (!installed.size && role === 'provider');
      field.test.disabled = isBusy || !hasInstalled(id);
      field.message.textContent = unavailable ? 'This CLI is unavailable. Choose an installed CLI.' : result?.text || '';
      field.message.dataset.tone = unavailable ? 'error' : result?.tone || '';
    }
    onUpdate?.();
  }

  function setValues(settings) {
    values = { provider: settings.provider || '', seoProvider: settings.seoProvider || '' };
    paintOptions();
    publishStatus();
  }

  async function scan() {
    if (scanning || testing) return;
    scanning = true;
    scanError = '';
    results.clear();
    setBusy(rescan, true, 'Scanning…');
    publishStatus();
    try {
      const response = await api.listClis();
      if (!Array.isArray(response) || response.some(item => typeof item?.id !== 'string' || typeof item.label !== 'string')) {
        throw new Error('The CLI scan returned an unexpected response.');
      }
      catalog = response;
      installed = new Map(catalog.filter(item => item.installed).map(item => [item.id, item]));
    } catch (error) {
      catalog = [];
      installed.clear();
      scanError = 'Could not check installed CLIs. ' + errorMessage(error);
    } finally {
      scanning = false;
      paintOptions();
      setBusy(rescan, false);
      publishStatus();
    }
  }

  async function test(role) {
    const cli = installed.get(effectiveId(role));
    if (scanning || testing || !cli) return;
    testing = cli.id;
    results.set(cli.id, { text: `Testing ${cli.label}…` });
    const control = fields[role].test;
    setBusy(control, true, 'Testing…');
    publishStatus();
    try {
      await api.testCli(cli.id);
      results.set(cli.id, { text: `${cli.label} is ready.`, tone: 'ok' });
    } catch (error) {
      results.set(cli.id, { text: errorMessage(error), tone: 'error' });
    } finally {
      testing = '';
      setBusy(control, false);
      publishStatus();
    }
  }

  for (const [role, field] of Object.entries(fields)) {
    field.select.onchange = () => {
      values[role] = field.select.value === SAME ? '' : field.select.value;
      onChange?.(role, values[role]);
      publishStatus();
    };
    field.test.onclick = () => test(role);
  }
  rescan.onclick = scan;

  return {
    generation: fields.provider.root, seo: fields.seoProvider.root, rescan, notice,
    scan, setValues, selection, hasInstalled,
    get catalog() { return catalog; },
    get scanning() { return scanning; }
  };
}
