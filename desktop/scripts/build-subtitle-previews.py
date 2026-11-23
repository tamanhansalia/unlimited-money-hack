"""Regenerate the transparent samples used by the Generate subtitle picker."""

import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from generation_options import FPS, HEIGHT, WIDTH
from subtitle_render import MOTION_STYLES, PRESETS, write_caption_filter


DESTINATION = ROOT / "desktop" / "src" / "renderer" / "assets" / "subtitle-previews"
DEMO = [(0, 2.40, "Yeh toh alag baat hai."), (2.60, 3.80, "Phir kya hua?")]
WORD_TIMES = {
    (0, 2.40): [(0, .32, "Yeh"), (.36, .64, "toh"), (.68, 1.16, "alag"),
                (1.28, 1.84, "baat"), (1.88, 2.40, "hai.")],
    (2.60, 3.80): [(2.60, 2.92, "Phir"), (3.00, 3.32, "kya"), (3.36, 3.80, "hua?")],
}
INTERVAL = (0, 3.92)
POSTER_TIME = 0.80
STRIP_HEIGHT = 160


def build_previews():
    DESTINATION.mkdir(parents=True, exist_ok=True)
    margins = PRESETS["subtitleMargins"]
    strip_top = HEIGHT - margins["standard"] + margins["previewInset"] - STRIP_HEIGHT
    with TemporaryDirectory(prefix="2pixelhack-subtitle-previews-") as directory:
        workdir = Path(directory)
        for preset in PRESETS["subtitles"]:
            style = preset["id"]
            overlay = write_caption_filter(workdir, DEMO, INTERVAL, "fit", style, word_times=WORD_TIMES)
            if not overlay:
                continue
            command = [
                "ffmpeg", "-v", "error", "-y", "-nostdin",
                "-f", "lavfi", "-i", f"color=black@0:s={WIDTH}x{HEIGHT}:r={FPS},format=rgba",
                "-vf", f"{overlay}:alpha=1,crop={WIDTH}:{STRIP_HEIGHT}:0:{strip_top}",
            ]
            subprocess.run(command + [
                "-ss", str(POSTER_TIME), "-frames:v", "1", "-update", "1", str(DESTINATION / f"{style}.png"),
            ], cwd=workdir, check=True)
            if style in MOTION_STYLES:
                subprocess.run(command + [
                    "-t", str(INTERVAL[1]), "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
                    "-lossless", "1", "-b:v", "0", str(DESTINATION / f"{style}.webm"),
                ], cwd=workdir, check=True)


if __name__ == "__main__":
    build_previews()
