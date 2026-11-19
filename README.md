# ViralClip Studio

ViralClip Studio is a Windows desktop app for generating, reviewing, and publishing vertical video clips. It uses the Python generator in `AI-Youtube-Shorts-Generator` and supports AI-assisted highlight selection and Roman Hinglish publishing copy.

## Run locally

1. Install Node.js, Python, and FFmpeg with `ffmpeg` and `ffprobe` available on your PATH.
2. Install Python packages from `AI-Youtube-Shorts-Generator/requirements-local.txt` in a Python virtual environment.
3. Install desktop app dependencies from `desktop-app` with `npm ci`.
4. Run `npm start` from `desktop-app`.

The app can also be launched from the workspace root with `npm start`. To build a Windows app folder, run `npm run package` from `desktop-app`.

The first launch creates the clip library under the generator's ignored `output/clips` folder. Generated videos, audio, transcripts, frames, credentials, dependency folders, and packaged builds are local data and are excluded from Git.

## AI CLI

Install and sign in to Codex CLI, Claude Code, or Gemini CLI. Choose the CLI in the app's Settings or in the Generate dialog. The app checks which CLIs are available when the dialog opens.

## Publishing

Social publishing requires an Ayrshare account configured in the app. Credentials are stored locally by the operating system's encrypted storage. Do not commit credentials or private account data.
