# Architecture

2PixelHack has two parts:

- an Electron desktop app in `desktop/`
- a Python clip engine in `engine/`

The desktop app owns the UI, the clip library and publishing. It runs the engine as a child process for each generation job.

```
┌──────────────────────────── desktop/ (Electron) ─────────────────────────────┐
│                                                                              │
│  src/renderer/  ──window.studio──▶  src/preload/  ──ipc "studio:*"──▶  src/main/  │
│  (UI, Vite)        (contextBridge)                    (Node.js)               │
│                                                            │                 │
└────────────────────────────────────────────────────────────┼─────────────────┘
                                                             │ spawn python -u
                                                             ▼
                                   engine/autoclipper.py ──▶ engine/clip_ai.py ──▶ AI CLI
                                     │  yt-dlp, faster-whisper, ffmpeg              (claude, codex, …)
                                     ▼
                           engine/output/clips/ready/<id>.mp4 + <id>_meta.json
```

## Desktop app (`desktop/`)

### Main process: `src/main/`

| File | Responsibility |
|---|---|
| `index.js` | App lifecycle, window creation, IPC registration, engine discovery and validation |
| `generation.js` | In-memory queue, Python child processes, job-scoped logging and cancellation |
| `library.js` | Reads and watches the clip library folders, moves and deletes clips, serves video through the `clip-media://` protocol |
| `publishing.js` | Zernio publishing profiles, API keys encrypted with `safeStorage`, account discovery, presigned uploads, posting or scheduling, and retry receipts |
| `source-info.js` | Looks up YouTube video titles and channels (oEmbed) and caches them on disk |
| `automation.js` | Autopilot: niche profiles that find videos, queue generation jobs and schedule posts on a timer. See [autopilot.md](autopilot.md). |

Every IPC handler checks that the call comes from the app's own window and frame before it runs.

Generation runs up to two engine processes at once and starts queued requests in submission order. The renderer assigns a job ID before submitting each request, and the main process uses that ID for start events, output, cancellation and the engine's clip metadata. Cancelling a queued request removes it from the queue. Stopping a running request terminates its process tree and cleans up its temporary work. Completed clip files stay available in the Library.

Deleting a clip or source group passes the confirmed clip IDs, statuses and file revisions to the main process. The library checks that the selection still matches and moves the selected videos and metadata to the system Trash in one folder. If Trash rejects the request, the library moves the files back to their original paths.

### Preload: `src/preload/index.js`

This file exposes the `window.studio` API to the page with `contextBridge`. The renderer runs with `sandbox: true`, `contextIsolation: true` and no Node integration.

### Renderer: `src/renderer/`

The renderer is a hash-routed single page with no framework, bundled by Vite into `desktop/dist/`.

- `core/`: the store, router, IPC client (`api.js`), DOM helpers, toasts, and the data layer (`library`, `sources`, `jobs`, `account`, `publish`, `thumbs`)
- `views/`: Library, Generate, Jobs, Settings, Source, Clip sheet, Publishing and Connect screens
- `styles/`: `index.css` imports design tokens, fonts, base and shared UI styles, then one stylesheet per view

`styles/icons.generated.css` is created at build time by `scripts/build-icons.mjs`. It contains only the Phosphor icons the source uses, and it is not committed.

The Settings route (`#/settings`) keeps an editable draft and saves changed defaults through `core/generation-settings.js`. The Library hands new sources to `#/generate`, where the job saves its timing, framing, caption preset and CLI selections before enqueueing. Settings and Generate share CLI discovery and testing controls. Submitting opens the job in `#/jobs`. The main process forwards Autopilot jobs to the renderer, where both kinds of jobs share progress tracking and the sidebar count. Result links use the current clip library.

Publishing profiles share the Studio clip library. The Publishing page manages the saved credentials and linked destinations for the selected profile. The sidebar and clip sheet can change that selection, and the clip sheet remembers which platforms were checked for each profile. A publish request carries the confirmed profile and connection IDs. The main process checks both before uploading. Each profile stores a Zernio API key, an optional Zernio profile, and the pinned Zernio account ID for each platform. Local receipts follow the clip version and destination account across API key changes. Each submission has its own `Idempotency-Key` and `externalId`. Unresolved submissions are looked up after a key change or once the retry window expires. Immediate posts still processing in Zernio stay in Ready so Retry can check the same post.

## Engine (`engine/`)

`autoclipper.py` is a command-line program. The desktop app uses it for source inspection, CLI discovery and generation.

| Call | Purpose |
|---|---|
| `autoclipper.py --list-clis` | JSON list of supported AI CLIs and whether each is installed |
| `autoclipper.py --test-cli <id>` | Checks that a CLI can actually answer a prompt |
| `autoclipper.py --inspect-source <source> [--preview-at <seconds>]` | Reads video details and loads a still when requested |
| `autoclipper.py --find-videos --options <json>` | Autopilot's finder: ranks channel uploads and search results by views over their own channel's median |
| `autoclipper.py <source> --provider <id> [--seo-provider <id>] --source-language hi\|en\|auto --clips auto\|1-10 --output-dir <engine>/output` | Generates clips with an automatic or fixed maximum |

A generation job runs these steps:

1. Download (yt-dlp) or open the source.
2. Transcribe the source with faster-whisper. Manual cuts transcribe the selected intervals.
3. Rank automatic highlights with the generation CLI. Resolve their final bounds in the engine. The generation CLI writes Roman Hinglish subtitles when enabled. The SEO CLI writes publishing copy and defaults to the generation CLI.
4. Render clips with FFmpeg using the chosen framing and subtitle preset. Check the exported video duration before installing it in the Library.

The engine prints progress lines that the renderer turns into job stages. Clips are rendered into a temporary `.render-*` folder and moved into `ready/` only when complete, so the library never shows a half-written clip.

## Where data lives

| Data | Location |
|---|---|
| Clip library | `<engine>/output/clips/ready` and `<engine>/output/clips/completed` (MP4 + `_meta.json` sidecar) |
| Publishing profiles, encrypted keys and active selection | `<userData>/publishing-profiles.json` |
| Publish receipts | `<userData>/publish-receipts/` |
| Autopilot profiles, run history and booked posting times | `<userData>/autopilot.json` |
| YouTube title cache | `<userData>/source-info.json` |

`<userData>` is Electron's per-user app data folder, for example `~/Library/Application Support/2PixelHack` on macOS or `%APPDATA%\2PixelHack` on Windows. The app was called ViralClip Studio before; on the first launch under the new name it moves the old `ViralClip Studio` folder's contents into the new one.

Profiles saved by the earlier Ayrshare version stay in the registry with their ids and names, so Autopilot and the clip sheet still find them. They are reported with `needsKey: true` and publish only after **Add Zernio key** replaces their credentials. The older Ayrshare files are left untouched.

## Finding the engine

`findEngine()` in `src/main/index.js` checks these locations in order:

1. `PIXELHACK_ENGINE_DIR`, if set.
2. In development: `../engine` next to `desktop/`.
3. When packaged: a folder named `engine` containing `autoclipper.py`, in the executable's folder or up to three levels above it.
4. Otherwise: `<userData>/engine`.

Python is taken from `<engine>/.venv` or `<engine>/venv` if one exists, otherwise `python3` (or `python` on Windows) from `PATH`.

## Packaging

`npm run package` runs electron-builder and writes a Windows app folder to `desktop/release/`. The app archive holds `dist/`, `src/main/`, `src/preload/`, `resources/icon.ico`, `resources/icon.png` and `package.json`. The Python modules, shared generation presets and subtitle fonts are copied to `resources/engine/`.

Python, FFmpeg, the Whisper model and the clip library stay outside the release.

## Environment variables

| Variable | Effect |
|---|---|
| `PIXELHACK_ENGINE_DIR` | Uses this engine folder, and therefore this clip library |
| `PIXELHACK_USER_DATA` | Uses a separate user-data folder, so a test instance can run next to the real app |
| `PIXELHACK_DIST` | Development only: loads the UI from another build folder |
