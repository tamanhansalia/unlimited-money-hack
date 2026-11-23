import shutil
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from autoclipper import load_source, probe, render, run_tool
from clip_ai import length_spec
from generation_options import auto_clips, manual_intervals, parse_options


class CutTests(unittest.TestCase):
    def test_padding_respects_the_clip_cap_and_keeps_adjacent_clips_separate(self):
        groups = [[(1, 14, "First")], [(14, 27, "Second")]]
        cuts = list(auto_clips(groups, 30, length_spec("10-13")))
        self.assertEqual([end - start for _, (start, end) in cuts], [13, 13])
        self.assertLessEqual(cuts[0][1][1], cuts[1][1][0])

    def test_manual_boundaries_snap_inward_and_reject_marks_past_the_source(self):
        self.assertEqual(manual_intervals([[421, 1921]], 2), [(0.44, 1.92)])
        with self.assertRaisesRegex(ValueError, "after the source"):
            manual_intervals([[0, 2001]], 2)

    def test_custom_duration_must_fit_whole_frames(self):
        with self.assertRaisesRegex(ValueError, "whole video frames"):
            parse_options({"duration": [1501, 1501]}, "auto")

    def test_custom_fixed_length_pads_a_slightly_shorter_speech_span(self):
        _, length, *_ = parse_options({"duration": [30000, 30000]}, "auto")
        (_, (start, end)), = auto_clips([[(2, 31, "A complete story")]], 40, length)
        self.assertEqual(end - start, 30)
        self.assertLessEqual(start, 2)
        self.assertGreaterEqual(end, 31)

    def test_automatic_cut_keeps_the_whole_joke_and_uses_the_audience_pause(self):
        joke = (215.36, 244.36, "Setup and punchline")
        transcript = [(204.82, 208.82, "Previous joke"), joke, (252.66, 253.66, "Next joke")]
        (_, (start, end)), = auto_clips([[joke]], 438, length_spec("30-60"), transcript=transcript)
        self.assertEqual(end - start, 30)
        self.assertLessEqual(start, joke[0])
        self.assertGreaterEqual(end, joke[1])
        self.assertGreaterEqual(start, transcript[0][1])
        self.assertLessEqual(end, transcript[2][0])

    def test_automatic_cut_moves_the_padding_to_the_uninterrupted_side(self):
        joke = (2, 31.99, "A nearly 30-second joke")
        transcript = [joke, (31.99, 38, "Next joke")]
        (_, (start, end)), = auto_clips([[joke]], 40, length_spec("30-60"), transcript=transcript)
        self.assertGreaterEqual(end, joke[1])
        self.assertLessEqual(end, transcript[1][0])
        self.assertLessEqual(start, joke[0])


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg and FFprobe are required")
class ExportTests(unittest.TestCase):
    def test_real_export_respects_padding_limit_and_renders_both_split_panels(self):
        with TemporaryDirectory() as temp:
            workdir = Path(temp)
            media = workdir / "source.mp4"
            run_tool([
                "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=red:s=80x90:r=30",
                "-f", "lavfi", "-i", "color=blue:s=80x90:r=30", "-f", "lavfi", "-i", "sine=frequency=440",
                "-filter_complex", "[0:v][1:v]hstack[v]", "-map", "[v]", "-map", "2:a",
                "-t", "15", "-c:v", "libx264", "-c:a", "aac", str(media),
            ])
            source = load_source(str(media), workdir)
            group, interval = next(auto_clips([[(1, 14, "Ek test line.")]], source["duration"], length_spec("10-13")))
            output, _ = render(source, group, {"description": ""}, "clip-test", workdir, "test", "codex", "codex",
                               interval, "split", 0.5, [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]], "box")
            info = probe(output)
            self.assertEqual(info["video_duration"], 13)
            self.assertEqual((info["width"], info["height"]), (720, 1280))
            frame = workdir / "frame.rgb"
            run_tool(["ffmpeg", "-v", "error", "-i", str(output), "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", str(frame)])
            pixels = frame.read_bytes()
            top = (320 * 720 + 360) * 3
            bottom = (960 * 720 + 360) * 3
            self.assertGreater(pixels[top], 220)
            self.assertGreater(pixels[bottom + 2], 220)

            moving, _ = render(source, group, {"description": ""}, "moving-test", workdir, "test", "codex", "codex",
                               (1, 3), "fill", [(0.1, 0), (1.9, 1)], None, "off")
            colors = []
            for time in (0, 1.96):
                frame.unlink()
                run_tool(["ffmpeg", "-v", "error", "-ss", str(time), "-i", str(moving), "-frames:v", "1",
                          "-pix_fmt", "rgb24", "-f", "rawvideo", str(frame)])
                colors.append(frame.read_bytes()[top:top + 3])
            self.assertGreater(colors[0][0], 220)
            self.assertGreater(colors[1][2], 220)
