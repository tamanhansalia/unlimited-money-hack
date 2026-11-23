# 2PixelHack — UI rebuild plan

> Paths in this document are relative to `desktop/` unless they start with `desktop/` or `engine/`. See [architecture.md](architecture.md) for the repository layout.

Status: in progress. This file is the contract for the rebuild. Everything under `desktop/src/renderer` is written from scratch; the previous renderer is not a reference.

## 1. Goals

1. A modern, rounded, glass interface that looks designed rather than generated.
2. **Clips are grouped by their source video.** Adding a YouTube link (or a local file) produces one *source* card. Opening it shows every clip cut from that video in one place.
3. Fast: instant first paint, no framework, no layout thrash, cached posters, few blur surfaces.
4. Complete states everywhere: validation, loaders, spinners, skeletons, empty, error, success, cancel.
5. Easy to use: one obvious action on each screen, keyboard shortcuts for the rest.

## 2. Design direction — "Footage-tinted glass"

The interface chrome is neutral frosted glass. **Colour comes from the user's footage**: the ambient backdrop re-tints (smoothly) to the dominant colours of the clip or source in focus. There is no brand-coloured accent splash; the primary button is a plain light (dark theme) or ink (light theme) pill.

- **Shapes**: everything is round. Pills for buttons, chips, search, nav. 18–24px for inputs and clip tiles, 28–32px for cards and the composer, 32–36px for dialogs.
- **Glass**: true `backdrop-filter` only on a handful of large surfaces (composer, source header, clip sheet, dialogs, toasts). Repeated items (cards, tiles) use `.surface`, a gradient fill plus hairline border plus inner highlight that looks like glass without the scroll cost.
- **Type**: Bricolage Grotesque (display: page titles, source titles) + Geist (UI) + Geist Mono (numbers, keys, log). Tabular numerals wherever digits align.
- **Theme**: dark only (a light theme was tried and removed on purpose). Respect `prefers-reduced-motion`.
- **Density** (set after the client said "everything looks BIG"): body text 13-14px, controls 32-42px tall, page titles up to about 34px, card titles 14-15px, chips about 21-22px, radii 19-29px for cards/sheets. The composer is a single row on wide windows.
- **Glass material**: luminous translucent fill (`--glass-fill`, `--surface`) plus a diagonal sheen, a bright 1px top edge (`--hi`) and a soft depth shadow. `.glass` uses a 26px blur, `.surface` (cards, tiles) a 16px blur. The backdrop carries three strong footage-tinted colour blobs so the glass has something to refract. Flat or transparent-looking surfaces are a defect.
- **Motion** (purposeful, short): shared-element morph from source card cover to the source header (View Transitions API); staggered first-render rise of cards; dialog scale/fade; progress bars via `transform: scaleX`; button press scale; backdrop colour cross-fade via registered `@property` colours. Nothing loops except spinners, the live-job pulse and skeleton shimmer.
- **Icons**: Phosphor font, subset generated at build time (`desktop/scripts/build-icons.mjs`) from the icon names that appear in `src/renderer/**/*.{js,html}`. Always write icon names as plain string literals, e.g. `icon('film-strip')`. Fill weight: `icon('play', {fill:true})`.

## 3. Information architecture

```
Sidebar (collapsible)            New clips · Library · Generate · Publishing · Jobs · Settings
Library  (#/)                    source entry + grid of Source cards
Generate (#/generate)            clip timing, framing, subtitle presets and CLI options
Jobs (#/jobs)                    per-job progress, output and cancellation
Source   (#/source/<key>)        source header + filters + grid of Clip tiles
Clip sheet (dialog over Source)  player + details form + publish, prev/next clip
Publishing (#/publishing)        Zernio connection + destinations
Settings (#/settings)            generation defaults and installed CLI management
Connect dialog                   API key entry
```

Library view keeps its scroll position and stays mounted when you open a source (instant back).

The sidebar and content scroll independently below the native title bar. The sidebar defaults to an icon rail in narrower windows and remembers a manual expand or collapse choice. Content layouts use the width available beside it. The sidebar and content resize together, and the labels fade out on collapse and back in on expansion. Route transitions animate the content pane so the sidebar stays responsive. With reduced motion enabled, changes take effect immediately.

### 3.1 Library deletion

1. The Library card and source page offer group deletion. The clip sheet offers deletion of the current clip.
2. A shared confirmation names the selection and shows its Ready and Completed counts. Group deletion applies to the whole source even when a filter is active.
3. The main process checks that the confirmed selection still matches the library and moves the videos and sidecars together to the system Trash.
4. The renderer refreshes the Library. The clip sheet opens the next available clip after a deletion. If the last clip is deleted, the app returns to the Library.

### 3.2 Concurrent generation and stopping jobs

1. Open **Jobs** after submission. **New clips** opens a fresh setup while queued or running jobs continue.
2. Show each job's source, status, progress and output on the **Jobs** page. The sidebar link opens the page from any screen and shows the active count.
3. Use the same job ID to open the engine process, route progress, stop a running process or cancel a queued request. Run up to two jobs at once and start waiting requests in order.
4. Release a slot when its process closes. Refresh the Library, count the clips for that job ID and link to their source group.

## 4. Data model

### 4.1 Clip (main process → renderer, from `studio.listClips()`)

```js
{
  id,                      // file stem, unique across both folders
  status,                  // 'ready' | 'completed'   (UI label for completed: "Completed")
  title, creator, hook, description, xPost, tags,   // strings; tags is a comma-separated string
  durationSec,             // number | null
  fileSizeBytes,           // number
  videoUrl,                // clip-media://library/<status>/<id>
  updatedAt, createdAt,    // ms epoch (createdAt = meta.createdAt || file birthtime)
  startSec, endSec,        // position inside the source video, number | null
  source: {
    key,                   // grouping key: 'yt:<videoId>' | 'file:<hash>' | 'legacy:<prefix>'
    kind,                  // 'youtube' | 'file' | 'legacy'
    id,                    // YouTube video id or ''
    url,                   // canonical https://www.youtube.com/watch?v=<id> or ''
    title,                 // from meta.sourceTitle or ''
    creator,               // channel / uploader or ''
    file                   // base name of a local source file or ''
  }
}
```

Grouping rules (main process, `src/main/library.js`):
1. `meta.sourceKey` when present (new engine output).
2. else a YouTube id from `meta.sourceUrl`.
3. else a YouTube id found in `meta.description` (older clips contain "Watch Full Video on YouTube: https://…watch?v=ID").
4. else `legacy:` + clip id without a trailing `_NN` (e.g. `short_zakir_03` → `legacy:short_zakir`).

### 4.2 Source (renderer aggregate, `core/sources.js`)

```js
{ key, kind, title, channel, url, videoId, clips: Clip[],      // clips sorted by startSec, then id
  readyCount, completedCount, total, totalDuration,
  updatedAt, createdAt, coverClip }                              // coverClip = first clip in timeline
```
Title resolution: most common non-empty `clip.source.title` → `state.sourceInfo[key].title` (YouTube oEmbed via `studio.resolveSources`) → `${creator} · source video` → `Untitled source`.

### 4.3 Engine additions (`engine/autoclipper.py`)

Existing log lines stay. New meta fields: `sourceKey`, `sourceKind`, `sourceId`, `sourceFile`, `createdAt` (ISO UTC), `jobId`. New log lines: `Source loaded: <title>` and `Found <n> highlight(s).`

## 5. IPC / preload API (`window.studio`)

```
listClips(): Promise<Clip[]>                       async, mtime-cached
moveClip(id, from, to): Promise<true>
deleteClips(targets, sourceKey): Promise<void>     targets contain id, status, updatedAt and fileSizeBytes
openFolder(status): Promise<void>
revealClip(id, status): Promise<void>              shows the file in Explorer
openExternal(url): Promise<void>                   https only; hosts: youtube.com, youtu.be, zernio.com, docs.zernio.com
resolveSources(videoIds: string[]): Promise<{[id]: {title, author}}>   YouTube oEmbed, cached on disk, failures omitted
chooseVideo(): Promise<string|null>
inspectSource(source, previewAt?): Promise<{title, duration, width, height, active?, frame?}>
generate(id, source, count, provider, language, seoProvider, length, options?): Promise<string>
    Queues a job and resolves to its ID on completion. Rejects with Error('CANCELLED') when stopped.
cancelGeneration(id): Promise<boolean>
accounts() / connectAccount(key) / publishClip(id, platforms, details)     unchanged
(removed: the app is dark-only)
onGenerationStarted(cb(id)): unsubscribe           the engine process was launched
onLog(cb(id, chunk)): unsubscribe                  engine output for one job
onLibraryChanged(cb): unsubscribe                  fs watcher, debounced in main (250ms)
```

## 6. Renderer modules

```
src/renderer/index.html            static shell: native title bar strip, sidebar, #stage > #views, #toasts
src/renderer/main.js               bootstrap: router, views, sidebar controls, shortcuts
src/renderer/styles/index.css      @import of the files below (cascade layers declared in tokens.css)
src/renderer/styles/fonts.css tokens.css base.css ui.css shell.css   [foundation]
src/renderer/styles/icons.generated.css             [generated by scripts/build-icons.mjs, not committed]
src/renderer/styles/library.css source.css sheet.css publishing.css   [view owners]
src/renderer/core/dom.js store.js format.js router.js api.js toast.js theme.js components.js   [foundation]
src/renderer/core/thumbs.js sources.js library.js jobs.js account.js publish.js               [data layer]
src/renderer/views/library.js source.js sheet.js publishing.js connect.js delete-clips.js      [views]
```

Foundation APIs and the class vocabulary live in the source of those files; read them before writing a view. The signatures that cross ownership lines are fixed below.

### 6.1 `core/store.js`
`state` (plain object), `set(patch)`, `subscribe(keys: string|string[], fn(changedKeys)) → off`. Notifications are batched per microtask. Keys: `route`, `clips`, `clipsLoaded`, `clipsError`, `clipsRefreshing`, `sourceInfo`, `account`, `accountStatus` (`idle|loading|ready|error`), `accountError`, `jobs`, `generationPrefill`.

### 6.2 `core/thumbs.js`
```
attachPoster(img: HTMLImageElement, clip, {priority?: number, onTint?: (tint) => void}): () => void   lazy; sets img.src from cache/queue, toggles .is-loaded, calls onTint([a,b,c]) once known; returns detach (also safe to never call: disconnected images are swept)
getTint(clip): [string,string,string] | null                                  3 CSS colours, sync from cache
setBackdropFrom(clipOrNull): void                                             tints the page backdrop (async, race-safe); null restores default
pruneCache(clips): void
```
Poster = frame captured from the clip video (needs `video.crossOrigin='anonymous'`; main adds `corsEnabled` + `Access-Control-Allow-Origin`), 270×480 JPEG, cached in IndexedDB keyed `id|size|updatedAt`, concurrency 2, visible items first.

### 6.3 `core/sources.js`
`getSources(): Source[]` (memoised on `state.clips` + `state.sourceInfo`, sorted by `updatedAt` desc), `getSource(key)`, `sourceTitle(source)`, `clipIndexIn(source, clipId)`, `resolveSourceTitles()` (called automatically when clips change).

### 6.4 `core/library.js`
`startLibrarySync()` (hydrates from a localStorage snapshot for an instant first paint, then refreshes, then follows `onLibraryChanged`), `refreshLibrary({quiet})`, `moveClips(clips, to) → Promise<{moved: Clip[], failed: {clip, error}[]}>`, `deleteClips(clips, sourceKey) → Promise<void>`, `findClip(id)`.

### 6.5 `core/jobs.js`
```
state.jobs = [{ id, status: 'queued'|'running'|'done'|'error'|'cancelled', kind: 'url'|'file',
                source, label, count, length, stage, clip, total, saved, progress: 0..1, log,
                startedAt, endedAt, error, sourceKey, addedCount }]
validateYouTube(raw) → {ok, empty?, id?, normalized?, message}
startJob({kind, source, label, count, provider, providerLabel, language, seoProvider, seoProviderLabel, length, options}) → id | null
getJob(id), cancelJob(id), dismissJob(id), stageLabel(job)
jobSteps(job) → [{id,label,detail,state:'todo'|'active'|'done'|'error'}]
```
After a successful job, refresh the library and match outputs by job ID to show the clip count and link to the source.

### 6.6 `core/account.js`
`PLATFORMS`, `SUPPORTED`, `platformInfo(name) → {name, icon}`, `refreshAccount({force})`, `connectAccount(key)`, `reverifyAccount()`; maintains `state.account` (`{hasKey, platforms, lastVerified}`), `accountStatus`, `accountError`.

### 6.7 `core/publish.js`
`LIMITS`, `parseTags(str)`, `validateDetails(values, {force, touched}) → {errors, warnings, counts, ok}`, `xPostText(values)`, `getDraft(clip) / setDraft(clip, values) / clearDraft(clip) / hasDraft(clip)`, `publishClip(clip, platforms, values) → Promise<{message}>` (calls the API, then refreshes the library).

### 6.8 Views
Each module exports a factory returning `{ el, enter(route), leave(), sharedElement(otherRoute) }`. `enter` runs synchronously inside a View Transition callback, so it must render from the store immediately (no awaiting). Hidden views must not re-render on store changes; mark dirty and render in `enter`. CSS class prefixes: library `lib-`, source `src-`, sheet `sheet-`, publishing `pub-`, connect `conn-`. Wrap each view stylesheet in `@layer views { … }`.

**Generate more**, the Library source form and job retries use `openGeneration(prefill)` to pass their data to Generate. The Generate view consumes the prefill on entry. [Generation setup](generation-setup-plan.md)

## 7. Work breakdown and ownership

| Owner | Files |
|---|---|
| Foundation (done first) | `styles/{fonts,tokens,base,ui,shell}.css`, `core/{dom,store,format,router,api,toast,theme,components}.js`, `index.html`, `main.js`, `styles/index.css`, `scripts/build-icons.mjs`, vite/package config |
| Backend | `desktop/src/main/{index,library,source-info}.js`, `desktop/src/preload/index.js`, `engine/autoclipper.py` |
| Data layer | `core/{thumbs,sources,library,jobs,account,publish}.js` |
| Library view | `views/library.js`, `styles/library.css` |
| Source view | `views/source.js`, `styles/source.css` |
| Clip sheet | `views/sheet.js`, `styles/sheet.css` |
| Publishing | `views/publishing.js`, `views/connect.js`, `styles/publishing.css` |
| Integration (after) | wiring, build, fixes |
| Review (after) | visual QA, performance with a 300-clip library, correctness/a11y, main-process review → fixes |

## 8. Performance budget

- Cold start to first meaningful paint: snapshot from localStorage renders immediately; no blocking IPC before paint.
- Library of 300+ clips: list render under 50 ms (keyed reconcile, `content-visibility:auto`), scrolling at 60 fps (no `backdrop-filter` on repeated items), at most two concurrent poster captures, and the preview `<video>` exists only while the sheet is open.
- Bundle: one JS file, one CSS file, three variable fonts (latin) and two icon fonts, no framework, no Tailwind.
- Main process: async directory scan with a metadata cache keyed by `path|mtime|size`; fs watcher instead of polling.

## 9. Acceptance checklist

- [ ] Adding a YouTube link creates (or extends) one source card; opening it lists all of its clips.
- [ ] Existing clips are grouped correctly (Zakir Khan source: 3 clips; Samay Raina source: 3 clips, one completed).
- [ ] Every async action shows a spinner, skeleton or progress and a result (toast or inline).
- [ ] Every form validates inline with specific messages; submit is blocked while invalid.
- [ ] Text is legible on the glass; focus rings visible; all icon buttons labelled; reduced motion honoured.
- [ ] Works from 760px wide to 4K; no horizontal page scroll.
- [ ] `npm run package` produces a working `win-unpacked` build.
