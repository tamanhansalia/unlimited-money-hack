"""Find and rank source videos for Autopilot.

Ranking follows the yt-viral skill (MIT, https://github.com/jakeschincariol/youtube-agent-skill): raw view
counts rank channel size, not ideas, so every video is scored as a multiple of its own channel's median views.
A median needs at least four videos with view counts; a channel with fewer is reported, not ranked on noise.
Only outliers are returned: videos at MIN_MULTIPLE or more of their channel's median, swipe.py's default line.

Public listings only. Nothing here signs in or uses the viewer's account.
"""

import re
import statistics
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from itertools import zip_longest
from urllib.parse import unquote, urlparse

VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}")
HANDLE = re.compile(r"@[\w.\-]{3,100}")
CHANNEL_ID = re.compile(r"UC[\w-]{22}")
YOUTUBE_HOSTS = ("youtube.com", "www.youtube.com", "m.youtube.com")
MIN_MEDIAN_VIDEOS = 4
MIN_MULTIPLE = 1.5
MAX_RESULTS = 20
MAX_SEARCH_CHANNELS = 8
MAX_SEARCH_VIDEOS = 24
WORKERS = 4
BLOCKED_AVAILABILITY = {"subscriber_only", "premium_only", "needs_auth", "private"}
BLOCKED_LIVE = {"is_live", "is_upcoming", "post_live"}

BASE_OPTIONS = {
    "quiet": True, "noprogress": True, "skip_download": True, "noplaylist": True,
    "socket_timeout": 10, "extractor_retries": 1, "js_runtimes": {"deno": {}, "node": {}},
}
LISTING_OPTIONS = {
    **BASE_OPTIONS, "noplaylist": False, "extract_flat": "in_playlist",
    # Channel pages only show relative dates; this turns them into approximate timestamps.
    "extractor_args": {"youtubetab": {"approximate_date": [""]}},
}


def channel_page(value):
    """Normalise @handle, a channel link, /channel/UC…, /c/… or /user/… to the channel's base URL."""
    raw = str(value or "").strip()
    if HANDLE.fullmatch(raw):
        return f"https://www.youtube.com/{raw}"
    url = urlparse(raw if "://" in raw else "https://" + raw)
    parts = [unquote(part) for part in url.path.split("/") if part]
    if url.scheme in ("http", "https") and (url.hostname or "").lower() in YOUTUBE_HOSTS and parts:
        if HANDLE.fullmatch(parts[0]):
            return f"https://www.youtube.com/{parts[0]}"
        if len(parts) > 1 and parts[0] == "channel" and CHANNEL_ID.fullmatch(parts[1]):
            return f"https://www.youtube.com/channel/{parts[1]}"
        if len(parts) > 1 and parts[0] in ("c", "user") and re.fullmatch(r"[\w.\-]{1,100}", parts[1]):
            return f"https://www.youtube.com/{parts[0]}/{parts[1]}"
    raise ValueError(f"{raw[:80] or 'An empty line'} is not a YouTube channel. Use @handle or a channel link.")


def short_error(error):
    text = str(error).replace("\n", " ")
    text = re.sub(r"^(?:ERROR:\s*)?(?:\[[^\]]+\]\s*)?(?:[\w@.-]+:\s*)?", "", text).strip()
    return (text[:157] + "…") if len(text) > 160 else text or "YouTube did not answer."


def extract(url, options):
    from yt_dlp import YoutubeDL

    with YoutubeDL(options) as downloader:
        return downloader.extract_info(url, download=False, process="extract_flat" in options)


def count(value):
    return value if type(value) in (int, float) and value > 0 else None


def median_views(videos):
    views = [video["views"] for video in videos if video["views"]]
    return statistics.median(views) if len(views) >= MIN_MEDIAN_VIDEOS else None


def channel_uploads(page, recent):
    info = extract(page + "/videos", {**LISTING_OPTIONS, "playlistend": recent})
    videos = [{
        "id": entry["id"], "title": entry.get("title") or "", "views": count(entry.get("view_count")),
        "duration": count(entry.get("duration")), "timestamp": count(entry.get("timestamp")),
        "live": entry.get("live_status"), "availability": entry.get("availability"),
    } for entry in info.get("entries") or [] if entry and VIDEO_ID.fullmatch(str(entry.get("id", "")))]
    return {
        "name": info.get("channel") or info.get("uploader") or info.get("title") or page,
        "channelId": info.get("channel_id"),
        "url": page, "followers": count(info.get("channel_follower_count")), "videos": videos,
        "median": median_views(videos),
    }


def search_results(query, limit):
    info = extract(f"ytsearch{limit}:{query}", {**LISTING_OPTIONS, "playlistend": limit})
    return [{"id": entry["id"], "duration": count(entry.get("duration")), "timestamp": count(entry.get("timestamp"))}
            for entry in info.get("entries") or [] if entry and VIDEO_ID.fullmatch(str(entry.get("id", "")))]


def video_details(video_id):
    info = extract(f"https://www.youtube.com/watch?v={video_id}", BASE_OPTIONS)
    uploaded = info.get("upload_date") or ""
    timestamp = count(info.get("timestamp"))
    if not timestamp and re.fullmatch(r"\d{8}", uploaded):
        timestamp = datetime.strptime(uploaded, "%Y%m%d").replace(tzinfo=timezone.utc).timestamp()
    channel_id = info.get("channel_id") or ""
    channel = (f"https://www.youtube.com/channel/{channel_id}" if CHANNEL_ID.fullmatch(channel_id)
               else info.get("channel_url") or "")
    return {
        "id": video_id, "title": info.get("title") or "", "views": count(info.get("view_count")),
        "duration": count(info.get("duration")), "timestamp": timestamp, "live": info.get("live_status"),
        "availability": info.get("availability"), "channel": info.get("channel") or info.get("uploader") or "",
        "channelPage": channel_page(channel) if channel else "",
    }


def integer(options, key, default, low, high):
    value = options.get(key, default)
    if value is None and default is None:
        return None
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f"{key} must be a whole number from {low} to {high}.")
    return value


def checked_options(options):
    if not isinstance(options, dict):
        raise ValueError("Invalid video search settings.")
    channels = options.get("channels", [])
    keywords = options.get("keywords", [])
    exclude = options.get("exclude", [])
    if not isinstance(channels, list) or len(channels) > 20:
        raise ValueError("List up to 20 channels.")
    if (not isinstance(keywords, list) or len(keywords) > 10
            or any(not isinstance(word, str) or not 1 <= len(word.strip()) <= 80 for word in keywords)):
        raise ValueError("List up to 10 searches of 1 to 80 characters.")
    if not isinstance(exclude, list) or len(exclude) > 20000 or any(
            not isinstance(item, str) or not VIDEO_ID.fullmatch(item) for item in exclude):
        raise ValueError("Invalid list of processed videos.")
    pages = list(dict.fromkeys(channel_page(channel) for channel in channels))
    searches = list(dict.fromkeys(" ".join(word.split()) for word in keywords))
    if not pages and not searches:
        raise ValueError("Add at least one channel or search.")
    settings = {
        "recent": integer(options, "recent", 30, 5, 60),
        "searchLimit": integer(options, "searchLimit", 12, 3, 25),
        "minDuration": integer(options, "minDuration", 180, 0, 36000),
        "maxDuration": integer(options, "maxDuration", 14400, 60, 43200),
        "maxAgeDays": integer(options, "maxAgeDays", None, 1, 3650),
    }
    if settings["minDuration"] >= settings["maxDuration"]:
        raise ValueError("The minimum video length must be shorter than the maximum.")
    settings["ranking"] = options.get("ranking", "outliers")
    if settings["ranking"] not in ("outliers", "eligible"):
        raise ValueError("Choose how to rank the videos.")
    return pages, searches, set(exclude), settings


def eligible(video, settings, exclude, now):
    if video["id"] in exclude or not video["views"] or not video["duration"]:
        return False
    if video.get("live") in BLOCKED_LIVE or video.get("availability") in BLOCKED_AVAILABILITY:
        return False
    if not settings["minDuration"] <= video["duration"] <= settings["maxDuration"]:
        return False
    return is_recent(video, settings, now)


def is_recent(video, settings, now):
    age = settings["maxAgeDays"]
    return not (age and video.get("timestamp") and now - video["timestamp"] > age * 86400)


def candidate(video, channel, source, query=""):
    median = channel["median"] if channel else None
    published = video.get("timestamp")
    return {
        "id": video["id"], "url": f"https://www.youtube.com/watch?v={video['id']}", "title": video["title"],
        "channel": (channel or {}).get("name") or video.get("channel") or "", "views": int(video["views"]),
        "median": int(median) if median else None,
        "multiple": round(video["views"] / median, 2) if median else None,
        "duration": int(video["duration"]), "source": source, "query": query,
        "publishedAt": datetime.fromtimestamp(published, timezone.utc).isoformat() if published else None,
    }


def summary(channel):
    return {"name": channel["name"], "url": channel["url"], "followers": channel["followers"],
            "scanned": len(channel["videos"]),
            "median": int(channel["median"]) if channel["median"] else None}


def find_videos(options, now=None, progress=lambda message: None):
    pages, searches, exclude, settings = checked_options(options)
    now = time.time() if now is None else now
    warnings = []
    channels = {}
    found = {}
    aliases = {}

    def read_channel(page):
        try:
            return channel_uploads(page, settings["recent"])
        except Exception as error:  # yt-dlp raises many types; one bad channel must not stop the run.
            return f"Could not read {page.rsplit('/', 1)[-1]}: {short_error(error)}"

    def read_search(query):
        try:
            return search_results(query, settings["searchLimit"])
        except Exception as error:
            return f"Search “{query}” failed: {short_error(error)}"

    def read_video(video_id):
        try:
            return video_details(video_id)
        except Exception as error:
            return short_error(error)

    def collect(pool, inputs, reader, label):
        tasks = {pool.submit(reader, value): value for value in inputs}
        if tasks:
            progress(f"{label} · 0 of {len(tasks)}")
        results = {}
        for completed, task in enumerate(as_completed(tasks), 1):
            results[tasks[task]] = task.result()
            progress(f"{label} · {completed} of {len(tasks)}")
        return [results[value] for value in inputs]

    def remember_channel(channel):
        channels[channel["url"]] = channel
        if channel["channelId"]:
            aliases[f"https://www.youtube.com/channel/{channel['channelId']}"] = channel

    with ThreadPoolExecutor(WORKERS) as pool:
        for channel in collect(pool, pages, read_channel, "Reading channel uploads"):
            if isinstance(channel, str):
                warnings.append(channel)
                continue
            remember_channel(channel)
            for video in channel["videos"]:
                if eligible(video, settings, exclude, now):
                    found.setdefault(video["id"], candidate(video, channel, "channel"))

        results = collect(pool, searches, read_search, "Searching YouTube")
        groups = []
        for query, result in zip(searches, results):
            if isinstance(result, str):
                warnings.append(result)
            else:
                groups.append([(query, hit) for hit in result])
        hits = {}
        for row in zip_longest(*groups):
            for query, result in filter(None, row):
                duration = result["duration"]
                if (result["id"] not in exclude and result["id"] not in found
                        and (not duration or settings["minDuration"] <= duration <= settings["maxDuration"])
                        and is_recent(result, settings, now)):
                    hits.setdefault(result["id"], query)
        if len(hits) > MAX_SEARCH_VIDEOS:
            warnings.append(f"Checked the top {MAX_SEARCH_VIDEOS} of {len(hits)} search matches. Use fewer or more specific searches for deeper coverage.")

        lookups = collect(pool, list(hits)[:MAX_SEARCH_VIDEOS], read_video, "Checking matching videos")
        details = [video for video in lookups if isinstance(video, dict)]
        failed = [error for error in lookups if isinstance(error, str)]
        if failed:
            warnings.append(f"Could not read {len(failed)} search matches. {failed[0]}")
        details = [video for video in details if eligible(video, settings, exclude, now)]
        wanted = list(dict.fromkeys(video["channelPage"] for video in details
                                    if video["channelPage"] and video["channelPage"] not in channels
                                    and video["channelPage"] not in aliases))
        for channel in collect(pool, wanted[:MAX_SEARCH_CHANNELS], read_channel, "Comparing channel views"):
            if isinstance(channel, str):
                warnings.append(channel)
            else:
                remember_channel(channel)
    for video in details:
        page = video["channelPage"]
        found.setdefault(video["id"], candidate(video, channels.get(page) or aliases.get(page), "search", hits[video["id"]]))

    if not channels and not found and warnings and (not groups or (lookups and len(failed) == len(lookups))):
        raise RuntimeError(warnings[0])
    matching = found.values() if settings["ranking"] == "eligible" else [
        video for video in found.values() if (video["multiple"] or 0) >= MIN_MULTIPLE]
    # A video without a median can be used in eligible mode, in upload order after ranked videos.
    ranked = sorted(matching, key=lambda item: (item["multiple"] or 0,
                    item["views"] if item["multiple"] else 0, item["publishedAt"] or ""), reverse=True)
    return {"channels": [summary(channel) for channel in channels.values()],
            "videos": ranked[:MAX_RESULTS], "warnings": warnings,
            "considered": len(found), "minMultiple": MIN_MULTIPLE}
