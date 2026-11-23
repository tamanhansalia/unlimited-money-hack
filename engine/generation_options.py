"""Validate generation options and resolve source intervals and FFmpeg layouts."""

import json
import math
import sys
from pathlib import Path
from statistics import median

from clip_ai import PRESETS, assert_source_can_fit, duration_range, length_spec, speech_bounds


FPS = 25
WIDTH, HEIGHT = 720, 1280


def parse_options(options, length):
    if not isinstance(options, dict):
        raise ValueError("Invalid generation settings.")
    mode = options.get("mode", "auto")
    orientation = options.get("orientation", "auto")
    layout = options.get("layout", "fill")
    subtitles = options.get("subtitles", "classic")
    if mode not in ("auto", "manual") or orientation not in PRESETS["orientations"] or layout not in PRESETS["layouts"]:
        raise ValueError("Choose a clip mode, source orientation and layout.")
    if subtitles not in [style["id"] for style in PRESETS["subtitles"]]:
        raise ValueError("Choose a subtitle style.")
    length = length_spec(length)
    duration = options.get("duration")
    if mode == "auto" and duration is not None:
        if (not isinstance(duration, list) or len(duration) != 2
                or any(type(value) is not int for value in duration)
                or not 40 <= duration[0] <= duration[1] <= 300_000
                or math.ceil(duration[0] / 40) > math.floor(duration[1] / 40)):
            raise ValueError("Choose a duration range between 0.04 and 300 seconds that fits whole video frames.")
        length = duration_range(*(value / 1000 for value in duration))
    ranges = options.get("ranges", [])
    if mode == "manual":
        if (not isinstance(ranges, list) or not 1 <= len(ranges) <= 10
                or any(not isinstance(pair, list) or len(pair) != 2
                       or any(type(value) is not int for value in pair)
                       or not 0 <= pair[0] < pair[1] for pair in ranges)):
            raise ValueError("Enter 1 to 10 valid start and end times.")
        ranges = sorted(ranges)
        if any(first[1] > second[0] for first, second in zip(ranges, ranges[1:])):
            raise ValueError("Manual clip ranges must not overlap.")
    position = options.get("position", 0.5)
    if not unit_number(position):
        raise ValueError("Choose a crop position between 0 and 100 percent.")
    regions = options.get("regions")
    if layout == "split":
        if not isinstance(regions, list) or len(regions) != 2:
            raise ValueError("Choose camera and screen regions in the source frame.")
        for region in regions:
            if not isinstance(region, list) or len(region) != 4 or not all(map(unit_number, region)):
                raise ValueError("Choose camera and screen regions in the source frame.")
            x, y, w, h = region
            if min(w, h) < 0.02 or x + w > 1.000001 or y + h > 1.000001:
                raise ValueError("Each region needs at least 2% of the frame and must fit inside it.")
    return mode, length, ranges, orientation, layout, subtitles, position, regions


def content_options(options):
    """The niche the AI writes for and whether the on-screen hook is burned in. Both are optional."""
    niche = options.get("niche", "")
    hook = options.get("hook", False)
    if not isinstance(niche, str) or len(niche) > 80 or any(not character.isprintable() for character in niche):
        raise ValueError("Describe the niche in 80 characters or fewer.")
    if type(hook) is not bool:
        raise ValueError("Choose whether to show the on-screen hook.")
    return " ".join(niche.split()), hook


def unit_number(value):
    return type(value) in (int, float) and 0 <= value <= 1


def manual_intervals(ranges, duration):
    intervals = []
    for start, end in ranges:
        if end / 1000 > duration:
            raise ValueError("A manual clip ends after the source video.")
        first = math.ceil(start * FPS / 1000)
        last = math.floor(end * FPS / 1000)
        if last <= first:
            raise ValueError("Every manual clip must contain at least one full video frame.")
        intervals.append((first / FPS, last / FPS))
    return intervals


def auto_interval(speech, duration, length, earliest=0, latest=None):
    latest = duration if latest is None else min(duration, latest)
    start, end = speech[0][0], speech[-1][1]
    if earliest > start + 1e-8 or latest < end - 1e-8:
        return None
    minimum = max(1, math.ceil(max(length.minimum, end - start) * FPS - 1e-8))
    maximum = min(math.floor((latest - earliest) * FPS + 1e-8), math.floor(length.maximum * FPS + 1e-8))
    if minimum > maximum:
        return None
    padded = round((end - start + 0.55) * FPS)
    frame_count = min(maximum, max(minimum, padded))
    clip_duration = frame_count / FPS
    lead = min(0.25, max(0, (clip_duration - (end - start)) / 2))
    start = max(earliest, end - clip_duration, min(start - lead, latest - clip_duration))
    return start, start + clip_duration


def auto_clips(groups, duration, length, *, transcript=None):
    assert_source_can_fit(duration, length)
    positions = {segment: index for index, segment in enumerate(transcript or [])}
    start = 0
    for index, group in enumerate(groups):
        boundary = duration
        if index + 1 < len(groups):
            boundary = (group[-1][1] + groups[index + 1][0][0]) / 2
        earliest, latest = (speech_bounds(transcript, positions[group[0]], positions[group[-1]], duration)
                            if transcript is not None else (0, duration))
        interval = auto_interval(group, duration, length, max(start, earliest), min(boundary, latest))
        if interval:
            yield group, interval
            start = interval[1]


def spoken_groups(transcript, intervals):
    groups = []
    for start, end in intervals:
        group = [(max(start, a), min(end, b), text) for a, b, text in transcript if a < end and b > start]
        if not group:
            raise ValueError(f"No speech was detected in the manual clip from {start:g}s to {end:g}s.")
        groups.append(group)
    return groups


def resolve_layout(source, orientation, layout):
    if layout != "auto":
        return layout
    if orientation == "vertical" or (orientation == "auto" and source["height"] > source["width"]):
        return "fill"
    return "fit"


def face_track(path, start, end):
    """Sample the horizontal position of a single, consistently visible face."""
    try:
        import cv2
    except ImportError:
        return None
    detector = cv2.CascadeClassifier(str(Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"))
    if detector.empty():
        return None
    video = cv2.VideoCapture(str(path))
    samples = []
    try:
        for fraction in (0.15, 0.32, 0.5, 0.68, 0.85):
            seconds = (end - start) * fraction
            video.set(cv2.CAP_PROP_POS_MSEC, 1000 * (start + seconds))
            ok, image = video.read()
            if not ok:
                continue
            height, width = image.shape[:2]
            image = cv2.resize(image, (480, max(1, round(height * 480 / width))))
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            faces = detector.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=6, minSize=(28, 28))
            if len(faces) == 1:
                x, _, w, _ = faces[0]
                if w / 480 >= 0.06:
                    samples.append((seconds, (x + w / 2) / 480))
    finally:
        video.release()
    if len(samples) >= 3 and all(abs(a[1] - b[1]) <= 0.22 for a, b in zip(samples, samples[1:])):
        centers = [center for _, center in samples]
        return [(seconds, median(centers[max(0, i - 1):i + 2])) for i, (seconds, _) in enumerate(samples)]
    return None


def crop_expression(position):
    if isinstance(position, (int, float)):
        return f"{position:.6f}"
    expression = f"{position[-1][1]:.6f}"
    for (start, x), (end, next_x) in reversed(list(zip(position, position[1:]))):
        slope = (next_x - x) / (end - start)
        expression = f"if(lt(t,{end:.6f}),{x:.6f}+({slope:.6f})*max(0,t-{start:.6f}),{expression})"
    return expression


def video_filter(layout, position, regions=None, overlay=""):
    cadence = f"fps={FPS}:start_time=0,tpad=stop_mode=clone:stop_duration=0.08"
    def fit(width, height):
        return (f"scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1")

    if layout == "split":
        panels = []
        for index, (x, y, w, h) in enumerate(regions):
            panel = f"crop=trunc(iw*{w:.6f}/2)*2:trunc(ih*{h:.6f}/2)*2:iw*{x:.6f}:ih*{y:.6f}"
            panels.append(f"[in{index}]{panel},{fit(WIDTH, HEIGHT // 2)}[panel{index}]")
        return (f"[0:V:0]{cadence},split[in0][in1];" + ";".join(panels)
                + f";[panel0][panel1]vstack{overlay}[out]")
    output = fit(WIDTH, HEIGHT)
    if layout == "fill":
        vertical = position if isinstance(position, (int, float)) else 0.5
        output = (f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase:force_divisible_by=2,"
                  f"crop={WIDTH}:{HEIGHT}:x='(iw-ow)*({crop_expression(position)})':y=(ih-oh)*{vertical:.6f},setsar=1")
    return f"[0:V:0]{cadence},{output}{overlay}[out]"


if __name__ == "__main__":
    # Face detection runs in its own process so OpenCV and Whisper can use their own FFmpeg libraries.
    source, start, end = sys.argv[1:]
    print(json.dumps(face_track(source, float(start), float(end))))
