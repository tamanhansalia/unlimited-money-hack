"""Render captioned vertical clips from a YouTube URL or a local video into the studio library."""

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

from clip_ai import PROVIDERS, available_clis, command_for, highlights, write_clip


DEFAULT_OUTPUT = Path(__file__).resolve().parent / "output"
ASS_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1280
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Arial Black,32,&H0000FFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,2.8,1.2,2,40,40,330,1
Style: Credit,Arial,18,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,1.5,0.8,8,20,20,30,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


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
        "format=duration:format_tags=title,artist,author:stream=codec_type:stream_disposition=attached_pic",
        "-of", "json", str(path),
    ]))
    streams = info.get("streams", [])
    if not any(s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic") for s in streams):
        raise ValueError("This file has no video track.")
    if not any(s.get("codec_type") == "audio" for s in streams):
        raise ValueError("This video has no audio track to transcribe.")
    duration = float(info.get("format", {}).get("duration") or 0)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("Could not read the video duration.")
    tags = info["format"].get("tags", {})
    return duration, {key.lower(): value for key, value in tags.items()}


def load_source(source, workdir):
    url = urlparse(source)
    source_url = ""
    title = creator = video_id = ""
    if url.scheme.lower() in ("http", "https"):
        host = (url.hostname or "").lower()
        parts = url.path.strip("/").split("/")
        if host == "youtu.be":
            video_id = parts[0]
        elif host == "youtube.com" or host.endswith(".youtube.com"):
            if parts == ["watch"]:
                video_id = parse_qs(url.query).get("v", [""])[0]
            elif len(parts) == 2 and parts[0] in ("shorts", "embed", "live"):
                video_id = parts[1]
        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
            raise ValueError("Choose a link to a single YouTube video or a local video file.")
        source = f"https://www.youtube.com/watch?v={video_id}"
        from yt_dlp import YoutubeDL
        from yt_dlp.utils import DownloadError

        print("Downloading the YouTube video...", flush=True)
        options = {
            "outtmpl": str(workdir / "source.%(ext)s"),
            "format": "bv[height<=1080]+ba/b[height<=1080]/b",
            "merge_output_format": "mkv",
            "quiet": True,
            "noprogress": True,
            "noplaylist": True,
            "match_filter": lambda info, *, incomplete: (
                "Live streams can be processed after the stream ends."
                if info.get("is_live") or info.get("live_status") == "is_upcoming" else None
            ),
        }
        try:
            with YoutubeDL(options) as downloader:
                info = downloader.extract_info(source, download=True)
        except DownloadError as error:
            raise RuntimeError(str(error)) from error
        files = list(workdir.glob("source.*"))
        if len(files) != 1 or not info or info.get("_type") == "playlist":
            raise ValueError("Choose one recorded YouTube video.")
        path = files[0]
        source_url = info.get("webpage_url") or source
        title = info.get("title") or ""
        creator = info.get("uploader") or info.get("channel") or ""
    else:
        path = Path(source).expanduser().resolve()
        if not path.is_file():
            raise ValueError("The selected video file could not be found.")

    duration, tags = probe(path)
    if video_id:
        identity = {"key": f"yt:{video_id}", "kind": "youtube", "id": video_id, "file": ""}
    else:
        digest = hashlib.sha1(str(path).lower().encode("utf-8")).hexdigest()[:12]
        identity = {"key": f"file:{digest}", "kind": "file", "id": "", "file": path.name}
    return {
        "path": path, "duration": duration,
        "title": title or tags.get("title") or path.stem,
        "creator": creator or tags.get("artist") or tags.get("author") or "",
        "url": source_url,
        "video_id": video_id,
        "source": identity,
    }


def transcribe(source, language):
    from faster_whisper import WhisperModel

    print("Transcribing speech on this computer...", flush=True)
    model = WhisperModel("small", device="cpu", compute_type="int8")
    segments, _ = model.transcribe(str(source["path"]), task="transcribe",
                                   language=None if language == "auto" else language,
                                   vad_filter=True, condition_on_previous_text=False)
    transcript = []
    for segment in segments:
        start, end = max(0, segment.start), min(source["duration"], segment.end)
        if segment.text.strip() and end > start:
            transcript.append((start, end, segment.text.strip()))
    if not transcript:
        raise ValueError("No speech was detected. Choose a video with spoken audio.")
    return transcript


def ass_time(seconds):
    minutes, remainder = divmod(round(seconds * 100), 6000)
    hours, minutes = divmod(minutes, 60)
    secs, cents = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{secs:02d}.{cents:02d}"


def caption(start, end, style, text):
    # Keep metadata and transcripts literal even when they contain ASS control characters.
    text = " ".join(text.split()).translate(str.maketrans({"\\": "＼", "{": "｛", "}": "｝"}))
    return f"Dialogue: 0,{ass_time(start)},{ass_time(end)},{style},,0,0,0,,{text}\n"


def render(source, group, fields, clip_id, workdir, job_id, provider):
    start = max(0, group[0][0] - 0.25)
    end = min(source["duration"], group[-1][1] + 0.3)
    events = [caption(s - start, e - start, "Caption", t) for s, e, t in group]
    if source["creator"]:
        events.insert(0, caption(0, end - start, "Credit", f"Credit: {source['creator']}"))
    (workdir / "captions.ass").write_text(ASS_HEADER + "".join(events), encoding="utf-8")

    video = workdir / f"{clip_id}.mp4"
    run_tool([
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-n",
        "-ss", str(start), "-i", str(source["path"]), "-t", str(end - start),
        "-map", "0:V:0", "-map", "0:a:0",
        "-vf", "fps=25,scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1,ass=captions.ass",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "fast", "-crf", "20",
        "-c:a", "aac", "-ar", "48000", "-b:a", "160k", "-movflags", "+faststart", str(video),
    ], cwd=workdir)
    duration, _ = probe(video)
    if source["url"]:
        fields = {**fields, "description": fields["description"] + "\n\n" + source["url"]}
    meta = {
        "id": clip_id, "video": video.name, **fields, "creator": source["creator"],
        "durationSec": duration, "duration": f"{duration:.1f}s",
        "fileSize": f"{video.stat().st_size / (1024 * 1024):.2f} MB", "status": "ready",
        "hook": group[0][2], "captionLanguage": "hi-Latn", "aiProvider": provider,
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


def generate(source, count, output_dir, provider, language):
    if not command_for(provider):
        raise ValueError(f"Install {PROVIDERS[provider]} and sign in before generating.")
    output_dir = Path(output_dir).resolve()
    ready = output_dir / "clips" / "ready"
    ready.mkdir(parents=True, exist_ok=True)
    job_id = uuid4().hex
    with TemporaryDirectory(prefix=".render-", dir=ready) as job_dir:
        workdir = Path(job_dir)
        info = load_source(source, workdir)
        print(f"Source loaded: {info['title']}", flush=True)
        transcript = transcribe(info, language)
        print(f"Selecting highlights with {PROVIDERS[provider]}...", flush=True)
        groups = highlights(provider, transcript, count)
        print(f"Found {len(groups)} highlight(s).", flush=True)
        outputs = []
        for number, group in enumerate(groups, 1):
            print(f"Writing Hinglish subtitles and publishing details for clip {number}...", flush=True)
            translated, fields = write_clip(provider, group)
            print(f"Rendering clip {number} of {len(groups)}...", flush=True)
            outputs.append(render(info, translated, fields, f"clip_{job_id}_{number:02d}", workdir, job_id, provider))

        for video, metadata in outputs:
            # The studio discovers MP4 files. Install metadata first so a clip is always complete.
            sidecar = ready / metadata.name
            install_file(metadata, sidecar)
            try:
                install_file(video, ready / video.name)
            except OSError:
                sidecar.unlink()
                raise
    print(f"Saved {len(outputs)} of {count} requested clips to {ready}.", flush=True)


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list-clis", action="store_true")
    parser.add_argument("--provider", choices=PROVIDERS)
    parser.add_argument("--source-language", choices=["hi", "en", "auto"], default="hi")
    parser.add_argument("source", nargs="?", help="YouTube video URL or local video file")
    parser.add_argument("--clips", "--num-clips", type=int, choices=range(1, 11), default=5)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT, help="Studio output root")
    args = parser.parse_args()
    if args.list_clis:
        print(json.dumps(available_clis()))
        sys.exit(0)
    if not args.source or not args.provider:
        parser.error("Provide a source and select an AI CLI with --provider.")
    try:
        generate(args.source, args.clips, args.output_dir, args.provider, args.source_language)
    except (OSError, ValueError, RuntimeError, ImportError) as error:
        parser.exit(1, f"Clip generation failed: {error}\n")
