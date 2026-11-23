# 2PixelHack engine

This is the Python program that turns a source video into captioned vertical clips. The desktop app runs it as a child process. You can also run it on its own.

## Files

| File | Purpose |
|---|---|
| `autoclipper.py` | CLI entry point. Loads the source (yt-dlp or a local file), transcribes it (faster-whisper), groups highlights, renders clips (FFmpeg) and writes metadata. |
| `clip_ai.py` | Finds supported AI CLIs, ranks transcript spans and writes Roman Hinglish captions and publishing copy through the selected CLIs |
| `generation_options.py` | Validates render options, resolves source intervals and builds FFmpeg layouts |
| `playbook.py` | Short-form rules from the YouTube agent skills (yt-shorts, yt-package, yt-seo) and the checks run on titles, hooks and descriptions |
| `finder.py` | Autopilot's video finder. Ranks channel uploads and search results by views over their own channel's median (yt-viral). |
| `requirements.txt` | Python dependencies. FFmpeg is required separately. |

## Setup

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

The desktop app uses `.venv` (or `venv`) in this folder when it exists.

## Usage

```bash
python autoclipper.py --list-clis                    # JSON: supported CLIs and whether each is installed
python autoclipper.py --test-cli claude              # check that a CLI responds
python autoclipper.py SOURCE --provider claude \
    [--seo-provider codex] [--source-language hi|en|auto] [--clips auto|1-10] [--output-dir PATH]
```

`SOURCE` is a YouTube video URL or a path to a local video. `--output-dir` defaults to `./output`.

`--provider` selects the CLI for highlights and subtitles. `--seo-provider` selects the CLI for the title, description, tags and X post and defaults to `--provider`.

`--clips auto` selects strong, non-overlapping highlights across the source. It can return zero clips if none qualify or more than ten for a longer source. A number sets the maximum for that run. The command-line default is five.

Pass `--length 30-60` to choose a preset. Pass `--options '{"duration":[30000,30000]}'` for an exact 30-second automatic clip. For manual cuts, pass `--options '{"mode":"manual","ranges":[[20000,50000]],"layout":"fit","subtitles":"box"}'`. The numbers in the options object are milliseconds.

## Output

Finished clips go to `<output-dir>/clips/ready/`. Each clip has two files:

- `clip_<job>_<NN>.mp4`: 720 × 1280 H.264/AAC with burned-in captions
- `clip_<job>_<NN>_meta.json`: title, description, tags, hook, creator, duration, source position (`sourceStartSec`, `sourceEndSec`), source identity (`sourceKey`, `sourceKind`, `sourceId`, `sourceUrl`, `sourceTitle`, `sourceFile`), generation CLI (`aiProvider`), SEO CLI (`seoProvider`), `jobId` and `createdAt`

The metadata file is installed before the video, so a clip that appears in the library is always complete. The desktop app moves published clips to `clips/completed/`.

## License

This engine started from [AI-Youtube-Shorts-Generator](https://github.com/Anil-matcha/AI-Youtube-Shorts-Generator) by Anil Chandra Naidu Matcha, which is MIT licensed. See [LICENSE](LICENSE).
