# ViralClip Studio

ViralClip Studio is a Windows Electron app for generating, reviewing, and publishing vertical clips. It loads the interface and media on your computer. Launch `desktop-app/release/win-unpacked/ViralClip Studio.exe` from the built release. Keep the executable with the other files in `win-unpacked`.

## Develop and build

From `desktop-app`, run `npm ci` to install the locked dependencies. Use `npm start` to build the renderer and open Electron. Use `npm run package` to produce the Windows x64 application. The UI uses Vite, Tailwind CSS, and locally bundled fonts.

## Generate and review clips

Choose **Generate clips**, enter a YouTube video URL or select a local video, and choose how many clips to generate. The Python worker transcribes speech with faster-whisper, groups speech segments, renders captioned 720 × 1280 H.264 clips with FFmpeg, and adds them to **Ready**. A short source can produce fewer clips than requested. The studio shows progress and any errors from the worker.

The source workspace uses `AI-Youtube-Shorts-Generator/output/clips`. Each MP4 may have a matching `_meta.json` file. The **Ready** and **Completed** tabs read these folders. **Mark completed** and **Restore to ready** move a clip and its metadata together. The player supports seeking in local video files.

## Generator setup

The project already uses a Python virtual environment in `AI-Youtube-Shorts-Generator/venv`. On another computer, install Python, `faster-whisper`, `yt-dlp`, and FFmpeg with `ffprobe` on PATH. The first transcription downloads the Whisper base model. YouTube sources require internet access. The Windows release includes the generator script. Python, FFmpeg, the speech model, and personal media are external to the release.

The packaged app looks for the existing generator folder near the executable, then uses an `engine` directory in the app user-data folder. Set `VIRALCLIP_ENGINE_DIR` to the absolute generator directory to select a specific library. The engine looks for `venv` or `.venv` there before using system Python.

## Publish

In **Connections**, verify an Ayrshare API key for a profile with linked social accounts. Open a ready clip, edit the publishing details, select destinations, and confirm. The desktop process uploads the video to Ayrshare and submits it to each selected network. After the service accepts every selected destination, the studio moves the clip to **Completed**. Dispatch receipts prevent re-sending destinations that the service already accepted during a partial attempt.

Newly verified keys use Electron OS encryption under the user's app-data directory. Existing workspace Ayrshare settings can still be read from `social_credentials.json`. Keep personal credentials and media outside application distributions.
