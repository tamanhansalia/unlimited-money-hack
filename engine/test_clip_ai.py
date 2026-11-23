import json
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from clip_ai import (AUTO_CLIPS, PROVIDERS, ask, assert_source_can_fit, highlights, test_cli as check_cli,
                     validate_seo, write_captions, write_clip, write_seo)


class CliAdapterTests(unittest.TestCase):
    def test_headless_transports_round_trip_unicode_json(self):
        prompt = 'DATA\n' + 'एक वाक्य "quoted" \\ text\n' * 1500
        reply = '{"ok":true}'
        agy_events = [
            {"event": "init"},
            {"event": "step_update", "step_update": {"text_delta": "partial"}},
            {"event": "result", "result": {"status": "SUCCESS", "response": reply}},
        ]
        outputs = {
            "gemini": json.dumps({"response": reply}),
            "antigravity": "\n".join(map(json.dumps, agy_events)),
            "cursor": json.dumps({"type": "result", "is_error": False, "result": reply}),
        }

        for provider in PROVIDERS:
            with self.subTest(provider=provider):
                def run(args, *, input, cwd, **kwargs):
                    self.assertNotIn(prompt, args)
                    self.assertNotIn("shell", kwargs)
                    if provider in {"grok", "muse"}:
                        prompt_file = Path(args[args.index("--prompt-file") + 1])
                        self.assertEqual(prompt_file.parent, Path(cwd))
                        self.assertEqual(prompt_file.read_text(encoding="utf-8"), prompt)
                    elif provider == "antigravity":
                        self.assertEqual(json.loads(input)["message"]["content"], prompt)
                        self.assertEqual(args[args.index("--effort") + 1], "low")
                    else:
                        self.assertEqual(input, prompt)
                    return subprocess.CompletedProcess(args, 0, outputs.get(provider, reply), "")

                with patch("clip_ai.command_for", return_value=["cli"]), patch("clip_ai.subprocess.run", side_effect=run):
                    self.assertEqual(ask(provider, prompt), {"ok": True})

    def test_report_missing_or_malformed_cli_in_connection_check(self):
        with patch("clip_ai.command_for", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "Cursor Agent was not found"):
                check_cli("cursor")
        bad_reply = subprocess.CompletedProcess(["agy"], 0, '{"event":"init"}', "")
        with patch("clip_ai.command_for", return_value=["agy"]), patch("clip_ai.subprocess.run", return_value=bad_reply):
            with self.assertRaisesRegex(RuntimeError, "Antigravity CLI responded without valid JSON"):
                check_cli("antigravity")


class HighlightSelectionTests(unittest.TestCase):
    def test_autopilot_bounds_each_request_even_with_a_fixed_clip_count(self):
        segments = [(index * 40, index * 40 + 20, f"Speech {index}") for index in range(15)]
        windows = []

        def answer(_provider, prompt):
            rows = json.loads(prompt.split("\nDATA\n", 1)[1])
            windows.append([row["id"] for row in rows])
            first = rows[0]["id"]
            return {"clips": [{"first": first, "last": first, "score": 75 + first}]}

        with patch("clip_ai.ask", side_effect=answer):
            selected = highlights("codex", segments, 2, fast=True)
        self.assertEqual(windows, [list(range(6)), list(range(4, 10)), list(range(8, 14)), [12, 13, 14]])
        self.assertEqual(selected, [[segments[8]], [segments[12]]])

    def test_auto_uses_the_full_source_and_does_not_pad_with_weak_clips(self):
        segments = [(i * 40, i * 40 + 20, f"Speech {i}") for i in range(14)]
        windows = []

        def answer(provider, prompt):
            rows = json.loads(prompt.split("\nDATA\n", 1)[1])
            windows.append([row["id"] for row in rows])
            scores = {0: 74, 11: 93}
            return {"clips": [{"first": row["id"], "last": row["id"], "score": scores.get(row["id"], 78)}
                              for row in rows if row["id"] not in (9, 10)]}

        with patch("clip_ai.ask", side_effect=answer):
            selected = highlights("codex", segments, AUTO_CLIPS)

        self.assertEqual(windows, [list(range(12)), [10, 11, 12, 13]])
        self.assertEqual(selected, [[segments[i]] for i in [*range(1, 9), 11, 12, 13]])

    def test_auto_accepts_no_highlights(self):
        with patch("clip_ai.ask", return_value={"clips": []}):
            self.assertEqual(highlights("codex", [(0, 5, "An incomplete setup")], AUTO_CLIPS), [])

    def test_fixed_count_can_keep_a_lower_scoring_clip(self):
        segment = (0, 5, "A short story")
        with patch("clip_ai.ask", return_value={"clips": [{"first": 0, "last": 0, "score": 65}]}):
            self.assertEqual(highlights("codex", [segment], 1), [[segment]])

    def test_auto_prompt_keeps_the_existing_range(self):
        seen = []

        def answer(provider, prompt):
            seen.append(prompt)
            return {"clips": []}

        with patch("clip_ai.ask", side_effect=answer):
            highlights("codex", [(0, 20, "A complete joke")], AUTO_CLIPS)
        self.assertIn("Aim for 15-55 seconds, maximum 65 seconds", seen[0])

    def test_length_keeps_a_clip_inside_the_range(self):
        segment = (0, 12, "A tight joke")
        with patch("clip_ai.ask", return_value={"clips": [{"first": 0, "last": 0, "score": 88}]}):
            self.assertEqual(highlights("codex", [segment], 1, "10-13"), [[segment]])

    def test_about_thirty_seconds_can_end_on_a_sentence(self):
        segments = [(0, 14, "Setup"), (14, 31, "Payoff")]
        with patch("clip_ai.ask", return_value={"clips": [{"first": 0, "last": 1, "score": 86}]}):
            self.assertEqual(highlights("codex", segments, 1, "30"), [segments])

    def test_length_rejects_a_clip_outside_the_range(self):
        segments = [(0, 8, "Too short"), (10, 22, "Fits the range")]
        with patch("clip_ai.ask", return_value={"clips": [{"first": 0, "last": 0, "score": 90}]}):
            with self.assertRaisesRegex(RuntimeError, "at least 8.5"):
                highlights("codex", segments, 1, "10-13")

    def test_auto_uses_an_audience_pause_to_reach_the_minimum_duration(self):
        joke = (215.36, 244.36, "A complete setup and punchline.")
        preceding = (204.82, 208.82, "The previous joke.")
        later = (252.66, 253.66, "The next joke.")
        reply = {"clips": [{"first": 1, "last": 1, "score": 94}]}
        with patch("clip_ai.ask", return_value=reply) as ask:
            clips = highlights("antigravity", [preceding, joke, later], AUTO_CLIPS, "30-60", source_duration=438)
            self.assertEqual(clips, [[joke]])
            prompt = ask.call_args_list[0].args[1]
            rows = json.loads(prompt.split("\nDATA\n", 1)[1])
            self.assertEqual(rows[1]["allowedLast"], [1, 2])
            with self.assertRaisesRegex(RuntimeError, "adjacent pauses"):
                highlights("antigravity", [(204.82, 215.1, "Previous"), joke, (244.6, 253.66, "Next")],
                           AUTO_CLIPS, "30-60", source_duration=438)

    def test_automatic_boundary_review_keeps_the_closing_reply(self):
        segments = [(0, 13, "The setup."), (15, 34, "One character asks a question."),
                    (35, 38, "The final punchline is the answer."), (45, 48, "A new joke.")]
        replies = [{"clips": [{"first": 0, "last": 1, "score": 90}]},
                   {"clips": [{"first": 0, "last": 2, "score": 90}]}]
        with patch("clip_ai.ask", side_effect=replies) as ask:
            self.assertEqual(highlights("antigravity", segments, AUTO_CLIPS, "30-60", source_duration=48),
                             [segments[:3]])
        review = json.loads(ask.call_args.args[1].split("\nDATA\n", 1)[1])
        self.assertEqual(review["segments"][2]["text"], segments[2][2])

    def test_short_speech_rejects_a_long_range_before_the_model(self):
        with patch("clip_ai.ask") as ask:
            with self.assertRaisesRegex(ValueError, "at least 120"):
                highlights("codex", [(0, 20, "Too short")], 1, "120-300")
            ask.assert_not_called()

    def test_unknown_length_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "clip length"):
            highlights("codex", [(0, 30, "A story")], 1, "nope")

    def test_source_duration_must_fit_the_range(self):
        assert_source_can_fit(30, "10-13")
        assert_source_can_fit(400, "120-300")
        assert_source_can_fit(12, "auto")
        with self.assertRaisesRegex(ValueError, "at least 120"):
            assert_source_can_fit(90, "120-300")


class ClipCopyTests(unittest.TestCase):
    group = [(1, 4, "Mujhe laga it was easy.")]
    captions = {"captions": [{"id": 0, "text": "Mujhe laga it was easy."}]}
    metadata = {"title": "Gaadi ka hisaab", "description": "Gaadi ki baat mein twist hai.",
                "tags": ["gaadi"], "xPost": "Gaadi ka plan tha.",
                "hookText": "Kitna kharcha hua", "searchQuery": "Gaadi ka hisaab"}

    def test_separate_providers_get_separate_tasks(self):
        with patch("clip_ai.ask", side_effect=[self.captions, self.metadata]) as ask:
            self.assertEqual(write_captions("antigravity", self.group), self.group)
            source = {"title": "Driving stories", "channel": "Example creator"}
            self.assertEqual(write_seo("codex", self.group, source=source), self.metadata)

        (generation_cli, generation_prompt), (seo_cli, seo_prompt) = [call.args for call in ask.call_args_list]
        self.assertEqual((generation_cli, seo_cli), ("antigravity", "codex"))
        self.assertIn('"captions"', generation_prompt)
        self.assertNotIn('"title"', generation_prompt)
        self.assertIn('"title"', seo_prompt)
        self.assertNotIn('"captions"', seo_prompt)
        self.assertEqual(json.loads(seo_prompt.split("\nDATA\n", 1)[1])["source"], source)

    def test_one_provider_can_write_captions_and_seo_in_one_request(self):
        with patch("clip_ai.ask", return_value={**self.captions, **self.metadata}) as ask:
            self.assertEqual(write_clip("codex", self.group), (self.group, self.metadata))
        ask.assert_called_once()

    def test_youtube_tag_limit_includes_commas_and_quotes_around_multiword_tags(self):
        tags = [f"{number:02d} " + "x" * 37 for number in range(11)]
        at_limit = [*tags, "12 " + "x" * 22]
        self.assertEqual(validate_seo({**self.metadata, "tags": at_limit})["tags"], at_limit)
        with self.assertRaisesRegex(ValueError, "500-character limit"):
            validate_seo({**self.metadata, "tags": [*tags, at_limit[-1] + "x"]})


if __name__ == "__main__":
    unittest.main()
