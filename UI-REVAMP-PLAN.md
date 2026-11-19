# ViralClip Studio — UI rebuild plan

Status: in progress. This file is the contract for the rebuild. Everything under `desktop-app/src` is written from scratch; the previous renderer is not a reference.

## 1. Goals

1. A modern, rounded, glass interface that looks designed rather than generated.
2. **Clips are grouped by their source video.** Adding a YouTube link (or a local file) produces one *source* card. Opening it shows every clip cut from that video in one place.
3. Fast: instant first paint, no framework, no layout thrash, cached posters, few blur surfaces.
4. Complete states everywhere: validation, loaders, spinners, skeletons, empty, error, success, cancel.
5. Easy to use: one obvious action on each screen, keyboard shortcuts for the rest.

## 2. Design direction — "Footage-tinted glass"

The interface chrome is neutral frosted glass. **Colour comes from the user's footage**: the ambient backdrop re-tints (smoothly) to the dominant colours of the clip or source in focus. There is no brand-coloured accent splash; the primary button is a plain light (dark theme) or ink (light theme) pill.

- **Shapes**: everything is round. Pills for buttons, chips, search, nav. 18–24px for inputs and clip tiles, 28–32px for cards and the composer, 32–36px for dialogs.
- **Glass**: true `backdrop-filter` only on a handful of large surfaces (top bar, composer, source header, clip sheet, dialogs, toasts). Repeated items (cards, tiles) use `.surface`, a gradient fill plus hairline border plus inner highlight that looks like glass without the scroll cost.
- **Type**: Bricolage Grotesque (display: page titles, source titles) + Geist (UI) + Geist Mono (numbers, keys, log). Tabular numerals wherever digits align.
- **Theme**: dark only (a light theme was tried and removed on purpose). Respect `prefers-reduced-motion`.
- **Density** (set after the client said "everything looks BIG"): body text 13-14px, controls 32-42px tall, page titles up to about 34px, card titles 14-15px, chips about 21-22px, radii 19-29px for cards/sheets. The composer is a single row on wide windows.
- **Glass material**: luminous translucent fill (`--glass-fill`, `--surface`) plus a diagonal sheen, a bright 1px top edge (`--hi`) and a soft depth shadow. `.glass` uses a 26px blur, `.surface` (cards, tiles) a 16px blur. The backdrop carries three strong footage-tinted colour blobs so the glass has something to refract. Flat or transparent-looking surfaces are a defect.
- **Motion** (purposeful, short): shared-element morph from source card cover to the source header (View Transitions API); staggered first-render rise of cards; dialog scale/fade; progress bars via `transform: scaleX`; button press scale; backdrop colour cross-fade via registered `@property` colours. Nothing loops except spinners, the live-job pulse and skeleton shimmer.
- **Icons**: Phosphor font, subset generated at build time (`scripts/icons.mjs`) from the icon names that appear in `src/**/*.{js,html}`. Always write icon names as plain string literals, e.g. `icon('film-strip')`. Fill weight: `icon('play', {fill:true})`.

## 3. Information architecture

```
Top bar (floating glass pill): brand · Library | Publishing · job pill · theme · [New clips]
Library  (#/)                    composer + grid of Source cards
Source   (#/source/<key>)        source header + filters + grid of Clip tiles
Clip sheet (dialog over Source)  player + details form + publish, prev/next clip
Publishing (#/publishing)        Ayrshare connection + destinations
Connect dialog                   API key entry
```

Library view keeps its scroll position and stays mounted when you open a source (instant back).

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

Grouping rules (main process, `library.js`):
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

### 4.3 Engine additions (`AI-Youtube-Shorts-Generator/autoclipper.py`)

Existing log lines stay. New meta fields: `sourceKey`, `sourceKind`, `sourceId`, `sourceFile`, `createdAt` (ISO UTC), `jobId`. New log lines: `Source loaded: <title>` and `Found <n> highlight(s).`

## 5. IPC / preload API (`window.studio`)

```
listClips(): Promise<Clip[]>                       async, mtime-cached
moveClip(id, from, to): Promise<true>
openFolder(status): Promise<void>
revealClip(id, status): Promise<void>              shows the file in Explorer
openExternal(url): Promise<void>                   https only; hosts: youtube.com, youtu.be, ayrshare.com (+subdomains)
resolveSources(videoIds: string[]): Promise<{[id]: {title, author}}>   YouTube oEmbed, cached on disk, failures omitted
chooseVideo(): Promise<string|null>
generate(source, count): Promise<void>             rejects Error('CANCELLED') after cancelGeneration()
cancelGeneration(): Promise<boolean>
accounts() / connectAccount(key) / publishClip(id, platforms, details)     unchanged
(removed: the app is dark-only)
onLog(cb): unsubscribe                             engine output chunks
onLibraryChanged(cb): unsubscribe                  fs watcher, debounced in main (250ms)
```

## 6. Renderer modules

```
src/index.html            static shell: backdrop, top bar, #stage > #views, #toasts
src/main.js               bootstrap: theme, router, views, top bar wiring, shortcuts
src/styles.css            @import of the css files below (cascade layers declared in tokens.css)
src/css/fonts.css tokens.css base.css ui.css shell.css            [foundation]
src/css/icons.generated.css                                       [generated by scripts/icons.mjs]
src/css/library.css source.css sheet.css publishing.css           [view owners]
src/core/dom.js store.js format.js router.js api.js toast.js theme.js components.js   [foundation]
src/core/thumbs.js sources.js library.js jobs.js account.js publish.js               [data layer]
src/views/library.js source.js sheet.js publishing.js connect.js                      [views]
```

Foundation APIs and the class vocabulary live in the source of those files; read them before writing a view. The signatures that cross ownership lines are fixed below.

### 6.1 `core/store.js`
`state` (plain object), `set(patch)`, `subscribe(keys: string|string[], fn(changedKeys)) → off`. Notifications are batched per microtask. Keys: `route`, `clips`, `clipsLoaded`, `clipsError`, `clipsRefreshing`, `sourceInfo`, `account`, `accountStatus` (`idle|loading|ready|error`), `accountError`, `job`, `jobLog`, `theme`, `composerPrefill`.

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
`startLibrarySync()` (hydrates from a localStorage snapshot for an instant first paint, then refreshes, then follows `onLibraryChanged`), `refreshLibrary({quiet})`, `moveClips(clips, to) → Promise<{moved: Clip[], failed: {clip, error}[]}>`, `findClip(id)`.

### 6.5 `core/jobs.js`
```
state.job = { status: 'idle'|'running'|'done'|'error'|'cancelled', kind: 'url'|'file', source, label, count,
              stage: 'starting'|'source'|'transcribe'|'select'|'render'|'finishing', clip, total, saved,
              progress: 0..1, startedAt, endedAt, error, sourceKey, newClipIds: string[], addedCount }
state.jobLog = string
validateYouTube(raw) → {ok, empty?, id?, normalized?, message}
startJob({kind, source, label, count}) → Promise<void>      never rejects; result is in state.job
cancelJob(), dismissJob(), stageLabel(job), jobSteps(job) → [{id,label,detail,state:'todo'|'active'|'done'|'error'}]
```
After a successful job: refresh library, compute `newClipIds`, `sourceKey` (source of the first new clip), fire a toast.

### 6.6 `core/account.js`
`PLATFORMS`, `SUPPORTED`, `platformInfo(name) → {name, icon}`, `refreshAccount({force})`, `connectAccount(key)`, `reverifyAccount()`; maintains `state.account` (`{hasKey, platforms, lastVerified}`), `accountStatus`, `accountError`.

### 6.7 `core/publish.js`
`LIMITS`, `parseTags(str)`, `validateDetails(values, {force, touched}) → {errors, warnings, counts, ok}`, `xPostText(values)`, `getDraft(clip) / setDraft(clip, values) / clearDraft(clip) / hasDraft(clip)`, `publishClip(clip, platforms, values) → Promise<{message}>` (calls the API, then refreshes the library).

### 6.8 Views
Each module exports a factory returning `{ el, enter(route), leave(), sharedElement(otherRoute) }`. `enter` runs synchronously inside a View Transition callback, so it must render from the store immediately (no awaiting). Hidden views must not re-render on store changes; mark dirty and render in `enter`. CSS class prefixes: library `lib-`, source `src-`, sheet `sheet-`, publishing `pub-`, connect `conn-`. Wrap each view stylesheet in `@layer views { … }`.

"Generate more" on a source sets `state.composerPrefill = {url}` and navigates to the library; the library view consumes it in `enter`. `focusComposer({url?, reveal?})` focuses (and optionally scrolls to) the composer.
`views/library.js → createLibraryView()` plus `focusComposer({url?})`; `views/source.js → createSourceView()`; `views/publishing.js → createPublishingView()`; `views/sheet.js → openClipSheet(sourceKey, clipId)` and `closeClipSheet()`; `views/connect.js → openConnectDialog()`.

## 7. Work breakdown and ownership

| Owner | Files |
|---|---|
| Foundation (done first) | `css/{fonts,tokens,base,ui,shell}.css`, `core/{dom,store,format,router,api,toast,theme,components}.js`, `index.html`, `main.js`, `styles.css`, `scripts/icons.mjs`, vite/package config |
| Backend | `desktop-app/{main,preload,library}.js`, new `source-info.js`, `AI-Youtube-Shorts-Generator/autoclipper.py` |
| Data layer | `core/{thumbs,sources,library,jobs,account,publish}.js` |
| Library view | `views/library.js`, `css/library.css` |
| Source view | `views/source.js`, `css/source.css` |
| Clip sheet | `views/sheet.js`, `css/sheet.css` |
| Publishing | `views/publishing.js`, `views/connect.js`, `css/publishing.css` |
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
