"""Build the ASS overlay used by clip exports and subtitle samples."""

import shutil
import unicodedata
from pathlib import Path

from clip_ai import PRESETS
from generation_options import HEIGHT, WIDTH


ASS_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
{caption_style}
Style: Credit,Geist,18,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,1.5,0.8,8,20,20,30,1
Style: Hook,Geist,50,&H00FFFFFF,&H000000FF,&H14111111,&H14111111,1,0,0,0,100,100,0,0,3,13,0,8,70,70,{hook_margin},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

CAPTION_STYLES = {
    "classic": "Geist,39,&H0000FFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,1",
    "clean": "Geist,39,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,0",
    "box": "Geist,42,&H00FFFFFF,&H000000FF,&H1A111111,&H1A111111,1,0,0,0,100,100,0,0,3,8,0",
    "karaoke": "Geist,48,&H00FFFFFF,&H000000FF,&H0014100D,&H70000000,1,0,0,0,100,100,0,0,1,4,1",
    "punch": "Geist,56,&H0067DFFF,&H000000FF,&H00140D18,&H50000000,1,0,0,0,100,100,0,0,1,5,2",
    "spotlight": "Geist,50,&H00FFFFFF,&H000000FF,&H00CD4558,&H00CD4558,1,0,0,0,100,100,0,0,3,10,0",
}
MOTION_STYLES = {preset["id"] for preset in PRESETS["subtitles"] if preset.get("motion")}
ASS_LITERALS = str.maketrans({"\\": "＼", "{": "｛", "}": "｝"})
MINT = r"{\1c&HADFF76&}"
WHITE = r"{\1c&HFFFFFF&}"
# yt-shorts: on-screen text for the first two seconds, in different words from the spoken line.
HOOK_SECONDS = 2.5
HOOK_FADE = r"{\fad(120,220)}"


def ass_time(centiseconds):
    minutes, remainder = divmod(centiseconds, 6000)
    hours, minutes = divmod(minutes, 60)
    secs, cents = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{secs:02d}.{cents:02d}"


def dialogue(start, end, text, style="Caption"):
    return f"Dialogue: 0,{ass_time(start)},{ass_time(end)},{style},,0,0,0,,{text}\n"


def caption_text(text):
    return " ".join(text.split()).translate(ASS_LITERALS)


def spoken_key(text):
    normalized = unicodedata.normalize("NFKD", text).casefold()
    return "".join(character for character in normalized if character.isalnum())


def timed_words(words, start, end, spoken):
    keys = [spoken_key(word) for word in words]
    source = [(a, b, key) for a, b, text in spoken if (key := spoken_key(text))]
    if all(keys) and keys == [key for _, _, key in source]:
        offsets = [(max(start, min(a, end)), max(start, min(b, end))) for a, b, _ in source]
        boundaries = [a for a, _ in offsets[1:]] + [end]
        matched = [(a, min(b, boundary), word) for (a, b), boundary, word in zip(offsets, boundaries, words)]
        if all(a < b for a, b, _ in matched):
            return matched

    # A translation may change word order or count. Keep the original segment's
    # timing and pace its written words by length.
    weights = [max(2, len(key)) for key in keys]
    total = sum(weights)
    elapsed = 0
    timings = []
    for word, weight in zip(words, weights):
        timings.append((start + (end - start) * elapsed / total,
                        start + (end - start) * (elapsed + weight) / total, word))
        elapsed += weight
    return timings


def phrases(words, word_limit, char_limit):
    phrase = []
    size = 0
    for word in words:
        length = len(word[2])
        if phrase and (len(phrase) == word_limit or size + 1 + length > char_limit):
            yield phrase
            phrase, size = [], 0
        size += length + bool(phrase)
        phrase.append(word)
    if phrase:
        yield phrase


def scale_for(words, limit):
    # ASS can wrap at spaces. Fit a long unbroken token within the same safe area.
    length = max(len(word) for word in words)
    return min(100, limit * 100 // length)


def motion_events(style, timings, emit):
    if style == "spotlight":
        for start, end, word in timings:
            word = word.upper()
            emit(start, end, rf"{{\fscx{scale_for([word], 12)}}}" + caption_text(word))
    elif style == "punch":
        for phrase in phrases(timings, 3, 19):
            start, end = phrase[0][0], phrase[-1][1]
            words = [word.upper() for _, _, word in phrase]
            scale = scale_for(words, 10)
            rise = min(80, round((end - start) * 500))
            settle = rise * 2
            pop = rf"{{\fscx{round(scale * .78)}\fscy78\t(0,{rise},\fscx{round(scale * 1.06)}\fscy106)\t({rise},{settle},\fscx{scale}\fscy100)}}"
            emit(start, end, pop + caption_text(" ".join(words)))
    elif style == "karaoke":
        for phrase in phrases(timings, 4, 26):
            words = [caption_text(word) for _, _, word in phrase]
            scale = rf"{{\fscx{scale_for(words, 13)}}}"
            plain = scale + " ".join(words)
            for index, (start, end, _) in enumerate(phrase):
                highlighted = words[:]
                highlighted[index] = MINT + highlighted[index] + WHITE
                emit(start, end, scale + " ".join(highlighted))
                if index + 1 < len(phrase):
                    emit(end, phrase[index + 1][0], plain)


def write_caption_filter(workdir, group, interval, layout, style, *, creator="", word_times=None, hook=""):
    clip_start, clip_end = interval
    events = []

    def emit(start, end, text):
        first = round((max(clip_start, start) - clip_start) * 100)
        last = round((min(clip_end, end) - clip_start) * 100)
        if first < last:
            events.append(dialogue(first, last, text))

    if creator:
        events.append(dialogue(0, round((clip_end - clip_start) * 100), caption_text(f"Credit: {creator}"), "Credit"))
    hook = " ".join(str(hook or "").split())
    if hook:
        last = round(min(HOOK_SECONDS, clip_end - clip_start) * 100)
        events.append(dialogue(0, last, HOOK_FADE + caption_text(hook), "Hook"))
    if style != "off":
        for start, end, text in group:
            if start >= clip_end or end <= clip_start:
                continue
            if style in MOTION_STYLES:
                spoken = () if word_times is None else word_times.get((start, end), ())
                timings = timed_words(text.split(), start, end, spoken)
                motion_events(style, timings, emit)
            else:
                emit(start, end, caption_text(text))
    if not events:
        return ""

    margin = PRESETS["subtitleMargins"]["split" if layout == "split" else "standard"]
    face = CAPTION_STYLES["classic" if style == "off" else style]
    line = f"Style: Caption,{face},2,46,46,{margin},1"
    # In the camera + screen layout the top panel is the camera, so the hook sits lower over the seam.
    hook_margin = 560 if layout == "split" else 150
    (workdir / "captions.ass").write_text(
        ASS_HEADER.format(width=WIDTH, height=HEIGHT, caption_style=line, hook_margin=hook_margin)
        + "".join(events), encoding="utf-8")
    fonts = workdir / "fonts"
    source = Path(__file__).with_name("fonts")
    if source.is_dir() and not fonts.exists():
        shutil.copytree(source, fonts)
    return "ass=captions.ass" + (":fontsdir=fonts" if fonts.is_dir() else "")
