import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from autoclipper import load_source, render, run_tool
from generation_options import parse_options
from subtitle_render import PRESETS, timed_words, write_caption_filter


class CaptionTimingTests(unittest.TestCase):
    def test_matching_words_use_whisper_boundaries_and_rewrites_use_segment(self):
        spoken = [(2.10, 2.18, "Yeh,"), (2.25, 2.60, " toh"), (2.90, 3.14, " achha!")]
        matched = timed_words(["Yeh", "toh", "achha."], 2, 3, spoken)
        self.assertEqual(matched, [(2.10, 2.18, "Yeh"), (2.25, 2.60, "toh"), (2.90, 3, "achha.")])
        rewritten = timed_words(["Bahut", "badhiya!"], 2, 3, spoken)
        self.assertEqual(rewritten[0][0], 2)
        self.assertEqual(rewritten[0][1], rewritten[1][0])
        self.assertEqual(rewritten[1][1], 3)

    def test_motion_is_rebased_at_clip_boundaries_and_preserves_literal_text(self):
        with TemporaryDirectory() as directory:
            workdir = Path(directory)
            group = [(1, 5, r"Yeh {\pos(0,0)} toh achha hai.")]
            overlay = write_caption_filter(workdir, group, (2, 4), "split", "karaoke")
            script = (workdir / "captions.ass").read_text(encoding="utf-8")
        self.assertTrue(overlay.startswith("ass="))
        self.assertIn(",2,46,46,115,1", script)
        self.assertIn("｛＼pos(0,0)｝", script)
        self.assertNotIn(r"{\pos(0,0)}", script)
        timings = re.findall(r"^Dialogue: 0,(.*?),(.*?),Caption", script, re.MULTILINE)
        self.assertEqual(timings[0][0], "0:00:00.00")
        self.assertEqual(timings[-1][1], "0:00:02.00")
        self.assertTrue(all(start < end for start, end in timings))


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg and FFprobe are required")
class CaptionExportTests(unittest.TestCase):
    def test_all_styles_burn_expected_colors_and_off_keeps_credit(self):
        with TemporaryDirectory() as directory:
            workdir = Path(directory)
            media = workdir / "source.mp4"
            run_tool([
                "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=#202020:s=180x320:r=25",
                "-f", "lavfi", "-i", "sine=frequency=440", "-t", "1.2",
                "-c:v", "libx264", "-c:a", "aac", "-metadata", "artist=Fixture", str(media),
            ])
            source = load_source(str(media), workdir)
            group = [(0, 1, "Alag baat hai.")]
            words = {(0, 1): [(0, .28, "Alag"), (.36, .68, "baat"), (.72, 1, "hai.")]}
            match_colors = {
                "classic": (255, 255, 0), "clean": (255, 255, 255), "box": (255, 255, 255),
                "karaoke": (118, 255, 173), "punch": (255, 223, 103), "spotlight": (88, 69, 205),
            }
            for preset in PRESETS["subtitles"]:
                style = preset["id"]
                with self.subTest(style=style):
                    self.assertEqual(parse_options({"subtitles": style}, "auto")[5], style)
                    video, metadata = render(
                        source, group, {"description": ""}, style, workdir, "test", "codex", "codex",
                        (0, 1.12), "fill", 0.5, None, style, word_times=words)
                    self.assertEqual(json.loads(metadata.read_text())["subtitleStyle"], style)
                    pixels = self.frame(video, "0.40", "crop=720:110:0:930")
                    if style == "off":
                        self.assertFalse(any(max(rgb) > 50 for rgb in pixels))
                        credit = self.frame(video, "0.40", "crop=720:75:0:0")
                        self.assertTrue(any(min(rgb) > 210 for rgb in credit))
                    else:
                        self.assertGreater(len(self.color_pixels(pixels, match_colors[style])), 40)
                    if style == "karaoke":
                        previous = self.frame(video, "0.16", "crop=720:110:0:930")
                        previous_x = min(self.color_pixels(previous, match_colors[style])) % 720
                        current_x = min(self.color_pixels(pixels, match_colors[style])) % 720
                        self.assertGreater(current_x, previous_x + 30)
                    if style == "punch":
                        first = self.frame(video, "0", "crop=720:110:0:930")
                        pop = self.frame(video, "0.08", "crop=720:110:0:930")
                        self.assertGreater(len(self.color_pixels(pop, match_colors[style])),
                                           len(self.color_pixels(first, match_colors[style])) * 1.3)

    @staticmethod
    def frame(video, time, crop):
        raw = subprocess.check_output([
            "ffmpeg", "-v", "error", "-ss", time, "-i", str(video), "-frames:v", "1",
            "-vf", crop, "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
        ])
        return list(zip(raw[0::3], raw[1::3], raw[2::3]))

    @staticmethod
    def color_pixels(pixels, color):
        return [index for index, rgb in enumerate(pixels)
                if all(abs(a - b) <= 25 for a, b in zip(rgb, color))]


if __name__ == "__main__":
    unittest.main()
