<img src="desktop/resources/logo.svg" alt="2PixelHack logo" width="72" height="72">

# 2PixelHack

2PixelHack is a desktop app for turning long videos into captioned vertical clips. You can then review them and publish them to social platforms.

You give it a YouTube link or a local video. A Python engine transcribes the speech, and an AI CLI you have installed (Claude Code, Codex, Gemini and others) picks the strongest moments. The engine then renders 720 × 1280 clips with Roman Hinglish captions. The Electron app groups clips by source video, lets you edit the publishing copy, and posts through [Zernio](https://zernio.com).

Paste a YouTube link on the Library or choose **New clips** to open Generate. **Auto highlights** lets you choose the count and a duration range. **Manual timestamps** cuts the source at the times you enter. Choose how to frame the video, load a frame to preview your setup, and select a subtitle style before clicking **Generate clips**.

**Autopilot** does all of this on its own. A profile names a niche and the channels or searches to watch. Each run ranks new uploads by how far they beat their channel's usual views, cuts the best ones, writes the title, on-screen hook and description, and keeps the clips for review or schedules them through Zernio. Runs can repeat every 6, 12 or 24 hours. See [docs/autopilot.md](docs/autopilot.md).

The left sidebar contains **New clips**, **Library**, **Generate**, **Autopilot**, **Publishing**, **Jobs**, and **Settings**. Use the sidebar toggle to switch between labeled navigation and an icon rail. The app remembers your choice.

Submit another video as soon as the first one starts. Two jobs can run at once, and additional videos wait in submission order. Open **Jobs** from the sidebar, then use **Stop** on a running job or **Cancel** on a queued job. The queue lives in the current app session.

Open **Settings** to choose the default **Generation CLI** for highlights and subtitles, the **SEO CLI** for titles, descriptions, tags and X posts, the source language, and the clip length. Choose **Same as generation** to use one CLI for both. Open **Advanced** in Generate to change either CLI for a single run.

Use **Delete clip** in the clip preview or **Delete group** on its source page to move generated files to the system Trash. You can also delete a group from its Library card. The confirmation lists the Ready and Completed clips included in the deletion. To recover them, copy the videos and their metadata from the `2PixelHack deleted clips` folder in Trash to the corresponding `ready` and `completed` library folders.

## Repository layout

```
.
├── desktop/                  Electron desktop app (Node.js)
│   ├── src/
│   │   ├── main/             Main process: window, IPC, engine runner, clip library, publishing
│   │   ├── preload/          Context-isolated bridge that exposes window.studio
│   │   └── renderer/         UI, bundled by Vite (no framework)
│   │       ├── core/         State, routing, IPC client, data layer
│   │       ├── views/        Library, Generate, Settings, source, clip sheet and Publishing
│   │       └── styles/       Design tokens and per-view stylesheets
│   ├── scripts/              Build helpers (icon font subsetting, app icon rendering)
│   ├── resources/            Logo (logo.svg) and app icon (icon.svg, icon.png, icon.ico)
│   ├── package.json
│   └── vite.config.mjs
├── engine/                   Python clip engine, run by the desktop app
│   ├── autoclipper.py        CLI entry point: source → transcript → highlights → rendered clips
│   ├── clip_ai.py            AI CLI discovery, highlight ranking, Hinglish copywriting
│   └── requirements.txt
├── docs/                     Architecture, development guide, UI design contract
├── package.json              Workspace scripts that forward to desktop/
└── .editorconfig, .gitignore
```

Local-only folders are ignored by Git: `desktop/node_modules`, `desktop/dist`, `desktop/release`, `engine/.venv` and `engine/output` (your clip library).

## Quick start

You need Node.js 22.12+, Python 3.10+, and FFmpeg with `ffmpeg` and `ffprobe` on your `PATH`.

```bash
# 1. Desktop dependencies
npm run setup

# 2. Engine environment (macOS / Linux)
python3 -m venv engine/.venv
engine/.venv/bin/python -m pip install -r engine/requirements.txt
#    Windows: py -m venv engine\.venv && engine\.venv\Scripts\python -m pip install -r engine\requirements.txt

# 3. Run the app
npm start
```

## Local AI CLIs

2PixelHack discovers supported local AI CLIs when you open **Settings** or **Generate clips**. The Settings page lists each CLI’s install status and terminal command. **Rescan** looks for new installs and each **Test CLI** button sends a small sample prompt to check sign-in and model access.

| Provider | Terminal command |
|---|---|
| Codex CLI | `codex` |
| Claude Code | `claude` |
| Gemini CLI | `gemini` |
| Grok Build | `grok` |
| Google Antigravity CLI | `agy` |
| Cursor Agent | `cursor-agent` |
| Muse Code | `muse` |

Each selected CLI uses its own account and model access to process the transcript. From `engine/`, run `python autoclipper.py --list-clis` to see the provider IDs or `python autoclipper.py --test-cli <provider-id>` to test one.

## Scripts

Run these from the repository root.

| Command | What it does |
|---|---|
| `npm run setup` | Installs the locked desktop dependencies (`npm ci`) |
| `npm start` | Builds the UI and opens the app |
| `npm run build` | Builds the UI into `desktop/dist` |
| `npm run package` | Builds a Windows app folder in `desktop/release` |

## Documentation

- [docs/architecture.md](docs/architecture.md): how the processes fit together, data locations, packaging
- [docs/development.md](docs/development.md): setup details, conventions, troubleshooting
- [docs/autopilot.md](docs/autopilot.md): Autopilot profiles that find, clip and schedule on their own
- [docs/ui-rebuild-plan.md](docs/ui-rebuild-plan.md): UI design direction, data model and IPC contract
- [engine/README.md](engine/README.md): engine CLI and clip metadata format

## Credentials

Publishing goes through [Zernio](https://zernio.com). The first two connected social accounts are free.

1. Sign up at zernio.com and connect YouTube, Instagram, Facebook or X in its dashboard. For several YouTube channels, make one Zernio profile per channel.
2. Create an API key at [zernio.com/dashboard/api-keys](https://zernio.com/dashboard/api-keys).
3. Open **Publishing → Add profile**, enter a name, paste the key, and pick a Zernio profile if you have more than one.

The app verifies the connection, shows its linked destinations, and remembers your selection. Use the sidebar or the clip review screen to switch publishing profiles. Profiles saved by the earlier Ayrshare version keep their name and Autopilot settings and ask for a Zernio key before they can publish. Posting to X through Zernio is billed from a prepaid Zernio balance. See [docs/zernio-migration-plan.md](docs/zernio-migration-plan.md).

The app stores the keys with the operating system's encrypted storage in its user-data folder. Never commit credentials, `.env` files or `social_credentials.json`.
