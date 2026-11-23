"""Render captioned vertical clips from a YouTube URL or a local video into the studio library."""

import argparse
import base64
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

from clip_ai import (AUTO_CLIPS, LENGTHS, MAX_CLIPS, PROVIDERS, assert_source_can_fit, available_clis,
                     cli_path, command_for, highlights, test_cli, write_captions, write_clip, write_seo)
from generation_options import (auto_clips, content_options, manual_intervals, parse_options,
                                resolve_layout, spoken_groups, video_filter)
from subtitle_render import MOTION_STYLES, write_caption_filter


DEFAULT_OUTPUT = Path(__file__).resolve().parent / "output"


def run_tool(args, cwd=None):
    try:
        result = subprocess.run(
            args, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace"
        )
    except FileNotFoundError as error:
        raise RuntimeError(f"{args[0]} is required. Install FFmpeg and add it to PATH.") from error
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or f"{args[0]} exited with code {result.returncode}.")
    return result.stdout


def probe(path):
    info = json.loads(run_tool([
        "ffprobe", "-v", "error", "-show_entries",
        "format=duration:format_tags=title,artist,author:stream=codec_type,width,height,duration"
        ":stream_disposition=attached_pic:stream_side_data=rotation",
        "-of", "json", str(path),
    ]))
    streams = info.get("streams", [])
    video = next((stream for stream in streams if stream.get("codec_type") == "video"
                  and not stream.get("disposition", {}).get("attached_pic")), None)
    if video is None:
        raise ValueError("This file has no video track.")
    if not any(stream.get("codec_type") == "audio" for stream in streams):
        raise ValueError("This video has no audio track to transcribe.")
    duration = float(info.get("format", {}).get("duration") or 0)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("Could not read the video duration.")
    width, height = video.get("width", 0), video.get("height", 0)
    rotation = next((data["rotation"] for data in video.get("side_data_list", []) if "rotation" in data), 0)
    if abs(rotation) % 180 == 90:
        width, height = height, width
    tags = info["format"].get("tags", {})
    return {
        "duration": duration, "video_duration": float(video["duration"]) if video.get("duration") not in (None, "N/A") else duration,
        "width": width, "height": height, "tags": {key.lower(): value for key, value in tags.items()},
    }


def youtube_id(source):
    url = urlparse(source)
    if url.scheme.lower() not in ("http", "https"):
        return ""
    host = (url.hostname or "").lower()
    parts = url.path.strip("/").split("/")
    video_id = ""
    if host == "youtu.be" and len(parts) == 1:
        video_id = parts[0]
    elif host in ("youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"):
        if parts == ["watch"]:
            video_id = parse_qs(url.query).get("v", [""])[0]
        elif len(parts) == 2 and parts[0] in ("shorts", "embed", "live"):
            video_id = parts[1]
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        raise ValueError("Choose a link to a single YouTube video or a local video file.")
    return video_id


def active_stream(info):
    return info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming")


def youtube_source(video_id, workdir=None, preview=False):
    from yt_dlp import YoutubeDL
    from yt_dlp.utils import DownloadError

    source = f"https://www.youtube.com/watch?v={video_id}"
    max_preview_bytes = 32 * 1024 * 1024

    def limit_preview(progress):
        if (progress.get("downloaded_bytes") or 0) > max_preview_bytes:
            raise DownloadError("The preview exceeds the download limit.")

    last_update = 0

    def download_progress(progress):
        nonlocal last_update
        current = time.monotonic()
        total = progress.get("total_bytes") or progress.get("total_bytes_estimate")
        downloaded = progress.get("downloaded_bytes")
        if progress["status"] == "downloading" and total and downloaded and current - last_update >= 5:
            percent = min(100, int(100 * downloaded / total))
            print(f"Download progress: {percent}%", flush=True)
            last_update = current

    options = {
        "format": "bv[height<=360]/b[height<=360]" if preview else
                  "bv[height<=1080]+ba/b[height<=1080]/b",
        "quiet": True, "noprogress": True, "noplaylist": True,
        "socket_timeout": 10, "extractor_retries": 1,
        "js_runtimes": {"deno": {}, "node": {}},
    }
    if preview:
        options.update({"max_filesize": max_preview_bytes, "progress_hooks": [limit_preview]})
    if workdir is None:
        options["ignore_no_formats_error"] = True
    if workdir is not None:
        options.update({
            "outtmpl": str(workdir / "source.%(ext)s"), "merge_output_format": "mkv",
            "progress_hooks": [download_progress],
            "match_filter": lambda info, *, incomplete: (
                "Live streams can be processed after the stream ends." if active_stream(info) else None
            ),
        })
    try:
        with YoutubeDL(options) as downloader:
            info = downloader.extract_info(source, download=workdir is not None)
    except DownloadError as error:
        raise RuntimeError(str(error)) from error
    if not info or info.get("_type") == "playlist":
        raise ValueError("Choose one recorded YouTube video.")
    return source, info


def local_source(source):
    path = Path(source).expanduser().resolve()
    if not path.is_file():
        raise ValueError("The selected video file could not be found.")
    return path


def inspect_source(source, preview_at=None):
    video_id = youtube_id(source)
    if video_id:
        _, info = youtube_source(video_id)
        width, height = info.get("width"), info.get("height")
        formats = info.get("requested_formats") or []
        if (not width or not height) and formats:
            width, height = formats[0].get("width"), formats[0].get("height")
        metadata = {"title": info.get("title"), "duration": info.get("duration"), "width": width,
                    "height": height, "active": bool(active_stream(info))}
    else:
        location = local_source(source)
        info = probe(location)
        metadata = {key: info[key] for key in ("duration", "width", "height")}
        metadata["title"] = info["tags"].get("title") or location.name
    if preview_at is None or metadata.get("active"):
        return metadata
    if not math.isfinite(preview_at) or preview_at < 0 or preview_at >= (metadata["duration"] or 0):
        raise ValueError("Choose a preview time inside the video.")
    with TemporaryDirectory(prefix="2pixelhack-preview-") as temp:
        directory = Path(temp)
        image = directory / "frame.jpg"
        if video_id:
            _, info = youtube_source(video_id, directory, preview=True)
            files = list(directory.glob("source.*"))
            if len(files) != 1:
                raise ValueError("A preview frame is unavailable within the 32 MB download limit.")
            location = files[0]
        run_tool([
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-ss", str(preview_at), "-i", str(location), "-map", "0:V:0", "-frames:v", "1",
            "-vf", "scale=720:720:force_original_aspect_ratio=decrease", "-q:v", "3", str(image),
        ])
        metadata["frame"] = "data:image/jpeg;base64," + base64.b64encode(image.read_bytes()).decode("ascii")
    return metadata


def load_source(source, workdir):
    video_id = youtube_id(source)
    source_url = ""
    title = creator = ""
    if video_id:
        print("Downloading the YouTube video...", flush=True)
        source_url, info = youtube_source(video_id, workdir)
        files = list(workdir.glob("source.*"))
        if len(files) != 1:
            raise ValueError("Choose one recorded YouTube video.")
        path = files[0]
        title = info.get("title") or ""
        creator = info.get("uploader") or info.get("channel") or ""
        identity = {"key": f"yt:{video_id}", "kind": "youtube", "id": video_id, "file": ""}
    else:
        path = local_source(source)
        digest = hashlib.sha1(str(path).lower().encode("utf-8")).hexdigest()[:12]
        identity = {"key": f"file:{digest}", "kind": "file", "id": "", "file": path.name}
    media = probe(path)
    tags = media.pop("tags")
    return {
        **media, "path": path, "title": title or tags.get("title") or path.stem,
        "creator": creator or tags.get("artist") or tags.get("author") or "",
        "url": source_url, "source": identity,
    }


def transcribe(source, language, intervals=None, workdir=None, *, word_times=None, fast=False):
    from faster_whisper import WhisperModel

    print("Transcribing speech on this computer...", flush=True)
    model = WhisperModel("small", device="cpu", compute_type="int8")
    transcript = []
    last_progress = 0
    ranges = intervals or [(0, source["duration"])]
    total = sum(end - start for start, end in ranges)
    elapsed = 0
    # Stand-up can trigger several slow decode passes through laughter and applause.
    # Autopilot uses one pass, keeping the multilingual model and word timestamps.
    decoder = {"beam_size": 1, "best_of": 1, "temperature": 0.0} if fast else {}
    for index, (start, end) in enumerate(ranges):
        media = source["path"]
        if intervals:
            media = workdir / f"speech-{index}.wav"
            run_tool(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-ss", str(start), "-i", str(source["path"]),
                      "-t", f"{end - start:.6f}", "-map", "0:a:0", "-ac", "1", "-ar", "16000", str(media)])
        segments, _ = model.transcribe(str(media), task="transcribe",
                                       language=None if language == "auto" else language,
                                       vad_filter=True, condition_on_previous_text=False,
                                       word_timestamps=word_times is not None, **decoder)
        for segment in segments:
            now = time.monotonic()
            if now - last_progress >= 5:
                percent = min(99, int(100 * (elapsed + min(end - start, segment.end)) / total))
                print(f"Transcription progress: {percent}%", flush=True)
                last_progress = now
            first, last = start + max(0, segment.start), min(end, start + segment.end)
            if segment.text.strip() and last > first:
                transcript.append((first, last, segment.text.strip()))
                if word_times is not None and segment.words:
                    word_times[(first, last)] = [(start + word.start, start + word.end, word.word)
                                                 for word in segment.words]
        elapsed += end - start
    if not transcript:
        raise ValueError("No speech was detected. Choose a video with spoken audio.")
    return transcript


def detect_face_track(path, start, end):
    try:
        result = subprocess.run([
            sys.executable, str(Path(__file__).resolve().with_name("generation_options.py")),
            str(path), str(start), str(end),
        ], capture_output=True, encoding="utf-8", timeout=15, check=True)
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def render(source, group, fields, clip_id, workdir, job_id, provider, seo_provider,
           interval, layout, position, regions, subtitles, *, word_times=None, show_hook=False):
    start, end = interval
    target = end - start
    existing_layout = layout
    if layout == "reframe":
        track = detect_face_track(source["path"], start, end) if source["width"] > source["height"] else None
        layout = "fit"
        if track:
            crop_fraction = source["height"] * 9 / (source["width"] * 16)
            position = [(time, max(0, min(1, (center - crop_fraction / 2) / (1 - crop_fraction)))) for time, center in track]
            layout = "fill"
    caption_filter = write_caption_filter(workdir, group, interval, layout, subtitles,
                                          creator=source["creator"], word_times=word_times,
                                          hook=fields.get("hookText", "") if show_hook else "")
    overlay = f",{caption_filter}" if caption_filter else ""

    video = workdir / f"{clip_id}.mp4"
    run_tool([
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-n",
        "-ss", f"{start:.6f}", "-i", str(source["path"]), "-t", f"{target:.6f}",
        "-filter_complex", video_filter(layout, position, regions, overlay), "-map", "[out]", "-map", "0:a:0",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "fast", "-crf", "20",
        "-c:a", "aac", "-ar", "48000", "-b:a", "160k", "-movflags", "+faststart", str(video),
    ], cwd=workdir)
    measured = probe(video)
    duration = measured["video_duration"]
    if abs(duration - target) > 0.002:
        raise ValueError(f"Exported video is {duration:g}s, but the selected interval requires {target:.2f}s.")
    if source["url"]:
        fields = {**fields, "description": fields["description"] + "\n\n" + source["url"]}
    meta = {
        "id": clip_id, "video": video.name, **fields, "creator": source["creator"],
        "durationSec": duration, "duration": f"{duration:.1f}s",
        "fileSize": f"{video.stat().st_size / (1024 * 1024):.2f} MB", "status": "ready",
        "hook": group[0][2], "hookShown": bool(show_hook and fields.get("hookText")),
        "captionLanguage": "" if subtitles == "off" else "hi-Latn",
        "aiProvider": provider, "seoProvider": seo_provider,
        "subtitleStyle": subtitles, "layout": layout, "requestedLayout": existing_layout,
        "sourceTitle": source["title"], "sourceUrl": source["url"],
        "sourceStartSec": start, "sourceEndSec": end,
        "sourceKey": source["source"]["key"], "sourceKind": source["source"]["kind"],
        "sourceId": source["source"]["id"], "sourceFile": source["source"]["file"],
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "jobId": job_id,
    }
    metadata = workdir / f"{clip_id}_meta.json"
    metadata.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return video, metadata


def install_file(source, destination):
    # Windows rename and POSIX hard links atomically fail if the name already exists.
    if os.name == "nt":
        source.rename(destination)
    else:
        os.link(source, destination)


def generate(source, count, output_dir, provider, language, job_id=None, *, seo_provider=None, length="auto", options=None):
    options = {} if options is None else options
    mode, length, ranges, orientation, layout, subtitles, position, regions = parse_options(options, length)
    niche, show_hook = content_options(options)
    fast = options.get("fastProcessing") is True
    seo_provider = seo_provider or provider
    label = PROVIDERS[provider].label
    seo_label = PROVIDERS[seo_provider].label
    for selected in dict.fromkeys((provider, seo_provider)):
        if not command_for(selected):
            raise ValueError(f"{PROVIDERS[selected].label} was not found. Install it, sign in, then rescan.")
    output_dir = Path(output_dir).resolve()
    ready = output_dir / "clips" / "ready"
    ready.mkdir(parents=True, exist_ok=True)
    job_id = job_id or uuid4().hex
    with TemporaryDirectory(prefix=f".render-{job_id}-", dir=ready) as job_dir:
        workdir = Path(job_dir)
        info = load_source(source, workdir)
        seo_source = {"spokenLanguage": {"hi": "Hindi or Hinglish", "en": "English"}.get(language, "Auto-detected")}
        if info["url"]:
            seo_source.update(title=info["title"], channel=info["creator"])
        print(f"Source loaded: {info['title']}", flush=True)
        intervals = None
        if mode == "auto":
            assert_source_can_fit(info["duration"], length)
        else:
            intervals = manual_intervals(ranges, info["duration"])
        word_times = {} if subtitles in MOTION_STYLES else None
        transcript = transcribe(info, language, intervals, workdir, word_times=word_times, fast=fast)
        layout = resolve_layout(info, orientation, layout)
        if mode == "auto":
            print(f"Selecting highlights with {label}...", flush=True)
            groups = highlights(provider, transcript, count, length, niche, source_duration=info["duration"], fast=fast,
                                progress=lambda part, total: print(f"Analyzing transcript window {part} of {total}", flush=True))
            cuts = list(auto_clips(groups, info["duration"], length, transcript=transcript))
            print(f"Found {len(cuts)} highlight(s).", flush=True)
        else:
            groups = spoken_groups(transcript, intervals)
            count = len(groups)
            cuts = list(zip(groups, intervals))
            print(f"Prepared {count} manual clip(s).", flush=True)
        outputs = []
        for number, (group, interval) in enumerate(cuts, 1):
            if subtitles == "off":
                print(f"Writing SEO for clip {number} with {seo_label}...", flush=True)
                translated, fields = group, write_seo(seo_provider, group, niche, source=seo_source)
            elif seo_provider == provider:
                print(f"Writing subtitles and SEO for clip {number} with {label}...", flush=True)
                translated, fields = write_clip(provider, group, niche, source=seo_source)
            else:
                print(f"Writing subtitles for clip {number} with {label}...", flush=True)
                translated = write_captions(provider, group)
                print(f"Writing SEO for clip {number} with {seo_label}...", flush=True)
                fields = write_seo(seo_provider, group, niche, source=seo_source)
            print(f"Rendering clip {number} of {len(cuts)}...", flush=True)
            outputs.append(render(info, translated, fields, f"clip_{job_id}_{number:02d}", workdir, job_id,
                                  provider, seo_provider, interval, layout, position, regions, subtitles,
                                  word_times=word_times, show_hook=show_hook))

        installed = []
        try:
            for video, metadata in outputs:
                # The studio discovers MP4 files. Install metadata first so a clip is always complete.
                for file in (metadata, video):
                    destination = ready / file.name
                    install_file(file, destination)
                    installed.append(destination)
        except OSError:
            for destination in reversed(installed):
                destination.unlink(missing_ok=True)
            raise
    if count == AUTO_CLIPS:
        print(f"Saved {len(outputs)} clips to {ready}.", flush=True)
    else:
        print(f"Saved {len(outputs)} of {count} requested clips to {ready}.", flush=True)


def clip_count(value):
    if value == AUTO_CLIPS:
        return value
    try:
        count = int(value)
        if 1 <= count <= MAX_CLIPS:
            return count
    except ValueError:
        pass
    raise argparse.ArgumentTypeError(f"choose 'auto' or a whole number from 1 to {MAX_CLIPS}")


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    os.environ["PATH"] = cli_path()
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--list-clis", action="store_true")
    mode.add_argument("--inspect-source", action="store_true", help=argparse.SUPPRESS)
    mode.add_argument("--find-videos", action="store_true",
                      help="rank channel uploads and search results by views over their channel median (JSON in --options)")
    mode.add_argument("--test-cli", metavar="PROVIDER", choices=PROVIDERS)
    mode.add_argument("--provider", choices=PROVIDERS, help="AI CLI for highlights and subtitles")
    parser.add_argument("--seo-provider", choices=PROVIDERS,
                        help="AI CLI for titles, descriptions, tags and X posts (defaults to --provider)")
    parser.add_argument("--source-language", choices=["hi", "en", "auto"], default="hi")
    parser.add_argument("source", nargs="?", help="YouTube video URL or local video file")
    parser.add_argument("--clips", "--num-clips", type=clip_count, default=5, metavar="auto|1-10",
                        help="automatically select strong highlights, or set a maximum clip count (default: 5)")
    parser.add_argument("--length", choices=list(LENGTHS), default="auto",
                        help="clip length: auto (15-55s), 10-13, 15-30, 30 (about 30s), 30-60, 60-120, or 120-300")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT, help="Studio output root")
    parser.add_argument("--preview-at", type=float, help=argparse.SUPPRESS)
    parser.add_argument("--options", type=json.loads, default={}, help=argparse.SUPPRESS)
    parser.add_argument("--job-id", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.find_videos:
        from finder import find_videos
        try:
            print(json.dumps(find_videos(args.options, progress=lambda message:
                                         print(f"Finder progress: {message}", file=sys.stderr, flush=True)), ensure_ascii=False))
        except (OSError, ValueError, RuntimeError, ImportError) as error:
            parser.exit(1, f"{error}\n")
        sys.exit(0)
    if args.list_clis:
        print(json.dumps(available_clis()))
        sys.exit(0)
    if args.test_cli:
        try:
            test_cli(args.test_cli)
        except RuntimeError as error:
            parser.exit(1, f"{error}\n")
        sys.exit(0)
    if args.inspect_source and args.source:
        try:
            print(json.dumps(inspect_source(args.source, args.preview_at)))
        except (OSError, ValueError, RuntimeError, ImportError) as error:
            parser.exit(1, f"{error}\n")
        sys.exit(0)
    if not args.source or not args.provider:
        parser.error("Provide a source and select an AI CLI with --provider.")
    if args.job_id is not None and not re.fullmatch(r"[a-f0-9]{32}", args.job_id):
        parser.error("Invalid generation job ID.")
    try:
        generate(args.source, args.clips, args.output_dir, args.provider, args.source_language, args.job_id,
                 seo_provider=args.seo_provider, length=args.length, options=args.options)
    except (OSError, ValueError, RuntimeError, ImportError) as error:
        parser.exit(1, f"Clip generation failed: {error}\n")
