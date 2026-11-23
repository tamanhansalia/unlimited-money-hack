# Development guide

## Prerequisites

- **Node.js 22.12+** and npm
- **Python 3.10+**
- **FFmpeg** with `ffmpeg` and `ffprobe` on `PATH`
- At least one supported AI CLI, installed and signed in: Claude Code, Codex CLI, Gemini CLI, Grok Build, Antigravity CLI, Cursor Agent or Muse Code

## First-time setup

```bash
npm run setup                                   # desktop/node_modules (npm ci)

python3 -m venv engine/.venv                    # engine virtual environment
engine/.venv/bin/python -m pip install -r engine/requirements.txt
```

On Windows, use `py -m venv engine\.venv` and `engine\.venv\Scripts\python -m pip install -r engine\requirements.txt`.

The first transcription downloads the Whisper model. YouTube sources need internet access and use Deno 2.3+ or Node.js 22+ on `PATH` to solve YouTube's JavaScript challenges.

## Everyday commands

From the repository root:

| Command | Purpose |
|---|---|
| `npm start` | Build the UI and open the app |
| `npm run build` | Build the UI into `desktop/dist` (also regenerates the icon subset) |
| `npm run package` | Build a Windows app folder in `desktop/release` |
| `node --test desktop/test/*.test.js` | Test the generation queue, cancellation, library deletion, and publishing profiles |

Run the engine on its own from `engine/`:

```bash
.venv/bin/python autoclipper.py --list-clis
.venv/bin/python autoclipper.py "https://www.youtube.com/watch?v=VIDEO_ID" --provider claude --clips 3
```

## Where to put new code

| Change | Location |
|---|---|
| New IPC method | Add the handler in `desktop/src/main/index.js` and expose it in `desktop/src/preload/index.js`. Call it through `desktop/src/renderer/core/api.js`. |
| Main-process feature with its own state or storage | New module in `desktop/src/main/`, required from `index.js` |
| New screen | `desktop/src/renderer/views/<name>.js`, plus `styles/<name>.css` imported from `styles/index.css`. Register the route in `main.js`. |
| Shared UI helper or data logic | `desktop/src/renderer/core/` |
| Design tokens (colour, radius, type, motion) | `desktop/src/renderer/styles/tokens.css` |
| Engine behaviour | `engine/autoclipper.py` (pipeline, rendering) or `engine/clip_ai.py` (AI providers, prompts) |
| Engine dependency | `engine/requirements.txt` |
| Documentation | `docs/` |

## Conventions

- **Icons:** write Phosphor icon names as plain string literals, for example `icon('film-strip')`. `scripts/build-icons.mjs` scans the renderer source for names, so names built at runtime will not get a glyph.
- **Logo and app icon:** `desktop/resources/logo.svg` is the mark (the sidebar inlines the same SVG) and `desktop/resources/icon.svg` is the app icon. After editing `icon.svg`, run `npm run app-icon --prefix desktop` to regenerate `icon.png` and `icon.ico`, and commit all three.
- **Generated files are not committed:** `desktop/dist/`, `desktop/release/` and `styles/icons.generated.css` are all rebuilt by `npm run build`.
- **Formatting:** `.editorconfig` sets UTF-8, LF line endings, 2-space indents for JS, CSS, HTML and JSON, and 4 spaces for Python.
- **Security:** the renderer has no Node access. Anything that touches the file system, network credentials or child processes belongs in the main process, behind a validated IPC handler.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Python could not be started" | Create `engine/.venv` as shown above, or put Python on `PATH` |
| "A Python package the generator needs is missing" | `engine/.venv/bin/python -m pip install -r engine/requirements.txt` |
| "ffmpeg is required" | Install FFmpeg and make sure `ffmpeg` and `ffprobe` are on `PATH` |
| AI CLI shown as not installed | Install it and sign in, then reopen the Generate dialog. GUI launches only see the system `PATH` plus common user bin folders. |
| Testing without touching your real settings | `PIXELHACK_USER_DATA=/tmp/2pixelhack-test npm start` |
