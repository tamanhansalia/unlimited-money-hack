import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import finder
from clip_ai import structured
from generation_options import content_options
from playbook import packaging_issues
from subtitle_render import write_caption_filter

GOOD = {"title": "Gaadi ka hisaab", "hookText": "Kitna kharcha hua", "searchQuery": "gaadi ka hisaab comedy",
        "description": "Gaadi ki baat mein twist hai.", "tags": ["gaadi"], "xPost": "Gaadi ka plan tha."}


class PackagingRuleTests(unittest.TestCase):
    def test_a_clean_pairing_passes(self):
        self.assertEqual(packaging_issues(GOOD), [])

    def test_each_yt_package_rule_reports_one_fix(self):
        cases = {
            "title": ("Is this the most insane and crazy joke ever told on any stage in India", ["Shorten", "vague"]),
            "hookText": ("", ["Add hookText"]),
            "searchQuery": ("", ["Add searchQuery"]),
        }
        for field, (value, expected) in cases.items():
            with self.subTest(field=field):
                issues = " ".join(packaging_issues({**GOOD, field: value}))
                for phrase in expected:
                    self.assertIn(phrase, issues)

    def test_hook_must_not_repeat_the_title(self):
        issues = packaging_issues({**GOOD, "hookText": "Gaadi ka hisaab dekho"})
        self.assertTrue(any("repeats the title on gaadi, hisaab" in issue for issue in issues))

    def test_search_query_words_must_appear_up_front(self):
        issues = packaging_issues({**GOOD, "searchQuery": "wedding roast"})
        self.assertTrue(any("searchQuery" in issue for issue in issues))

    def test_most_of_the_search_query_must_appear(self):
        # One shared word out of four is not enough; three of four is.
        issues = " ".join(packaging_issues({**GOOD, "searchQuery": "gaadi wedding roast standup"}))
        self.assertIn("missing roast, standup, wedding", issues)
        self.assertEqual(packaging_issues({**GOOD, "searchQuery": "gaadi hisaab twist standup"}), [])

    def test_hook_is_at_most_four_words(self):
        self.assertEqual(packaging_issues({**GOOD, "hookText": "Papa ne bol diya"}), [])
        issues = " ".join(packaging_issues({**GOOD, "hookText": "Papa ne aaj bol diya"}))
        self.assertIn("2 to 4 words; it has 5", issues)

    def test_shouting_and_filler_openings_are_flagged(self):
        issues = " ".join(packaging_issues({**GOOD, "title": "YEH TOH KYA HUA BHAI"}))
        self.assertIn("all-caps", issues)
        issues = " ".join(packaging_issues({**GOOD, "title": "Ye to ka gaadi"}))
        self.assertIn("first three words", issues)


class ReviewRetryTests(unittest.TestCase):
    def test_review_issues_earn_one_rewrite(self):
        prompts = []

        def answer(provider, prompt):
            prompts.append(prompt)
            return {"value": len(prompts)}

        with patch("clip_ai.ask", side_effect=answer):
            result = structured("codex", "Return a value.", {}, lambda reply: reply["value"],
                                review=lambda value: ["Make it better."] if value == 1 else [])
        self.assertEqual(result, 2)
        self.assertIn("Make it better.", prompts[1])

    def test_a_usable_answer_survives_a_broken_rewrite(self):
        replies = iter([{"value": 1}, {"broken": True}])
        with patch("clip_ai.ask", side_effect=lambda *_: next(replies)):
            result = structured("codex", "Return a value.", {}, lambda reply: reply["value"],
                                review=lambda value: ["Make it better."])
        self.assertEqual(result, 1)

    def test_a_usable_answer_survives_a_rewrite_timeout(self):
        with patch("clip_ai.ask", side_effect=[{"value": 1}, RuntimeError("CLI timed out.")]):
            result = structured("codex", "Return a value.", {}, lambda reply: reply["value"],
                                review=lambda value: ["Make it better."])
        self.assertEqual(result, 1)


class ContentOptionTests(unittest.TestCase):
    def test_niche_and_hook_are_optional_and_checked(self):
        self.assertEqual(content_options({}), ("", False))
        self.assertEqual(content_options({"niche": "  Hindi   stand-up ", "hook": True}), ("Hindi stand-up", True))
        with self.assertRaisesRegex(ValueError, "niche"):
            content_options({"niche": "x" * 81})
        with self.assertRaisesRegex(ValueError, "hook"):
            content_options({"hook": "yes"})


class HookOverlayTests(unittest.TestCase):
    def test_hook_shows_for_the_first_seconds_at_the_top(self):
        with tempfile.TemporaryDirectory() as temp:
            workdir = Path(temp)
            write_caption_filter(workdir, [(10, 14, "Pehli line")], (10, 30), "fill", "classic", hook="Kitna kharcha hua")
            ass = (workdir / "captions.ass").read_text(encoding="utf-8")
        self.assertIn("Style: Hook,", ass)
        self.assertIn(",150,1\n", ass.split("Style: Hook,", 1)[1].split("\n", 1)[0] + "\n")
        self.assertIn("Dialogue: 0,0:00:00.00,0:00:02.50,Hook,,0,0,0,,{\\fad(120,220)}Kitna kharcha hua", ass)

    def test_no_hook_event_without_text(self):
        with tempfile.TemporaryDirectory() as temp:
            workdir = Path(temp)
            write_caption_filter(workdir, [(0, 2, "Line")], (0, 2), "fill", "classic")
            self.assertNotIn(",Hook,", (workdir / "captions.ass").read_text(encoding="utf-8"))


def listing(channel, videos, followers=1000):
    return {"channel": channel, "channel_follower_count": followers, "entries": [
        {"id": video_id, "title": title, "view_count": views, "duration": duration, "timestamp": stamp}
        for video_id, title, views, duration, stamp in videos]}


NOW = 1_800_000_000
DAY = 86400


class FinderTests(unittest.TestCase):
    def test_ranked_eligible_mode_can_use_a_small_channel_without_a_median(self):
        new = ("recentAAAAA", "New set", 20, 900, NOW - DAY)
        old = ("oldsetAAAAA", "Old set", 200, 900, NOW - 2 * DAY)
        long = ("longsetAAAA", "Long set", 1000, 3600, NOW)
        options = {"channels": ["@Small"], "minDuration": 300, "maxDuration": 1500}
        progress = []
        with patch("finder.extract", return_value=listing("Small", [old, new, long])):
            strict = finder.find_videos(options, now=NOW)
            relaxed = finder.find_videos({**options, "ranking": "eligible"}, now=NOW, progress=progress.append)
        self.assertEqual(strict["videos"], [])
        self.assertEqual([video["id"] for video in relaxed["videos"]], [new[0], old[0]])
        self.assertEqual(progress, ["Reading channel uploads · 0 of 1", "Reading channel uploads · 1 of 1"])

    def test_channel_links_are_normalised(self):
        self.assertEqual(finder.channel_page("@GauravKapoor"), "https://www.youtube.com/@GauravKapoor")
        self.assertEqual(finder.channel_page("youtube.com/@GauravKapoor/videos"), "https://www.youtube.com/@GauravKapoor")
        self.assertEqual(finder.channel_page("https://www.youtube.com/channel/UCkS7Vxu4PjM99w0Is6idjcg"),
                         "https://www.youtube.com/channel/UCkS7Vxu4PjM99w0Is6idjcg")
        with self.assertRaisesRegex(ValueError, "not a YouTube channel"):
            finder.channel_page("https://example.com/@someone")

    def test_videos_rank_by_multiple_of_their_own_channel_median(self):
        big = listing("Big", [
            ("bigAAAAAAAA", "Big normal", 1_000_000, 900, NOW - DAY),
            ("bigBBBBBBBB", "Big hit", 3_000_000, 900, NOW - 2 * DAY),
            ("bigCCCCCCCC", "Big other", 1_000_000, 900, NOW - 3 * DAY),
            ("bigDDDDDDDD", "Big short", 9_000_000, 50, NOW - 3 * DAY),
            ("bigEEEEEEEE", "Big old", 9_000_000, 900, NOW - 400 * DAY),
        ])
        small = listing("Small", [(f"small{i:06d}", f"Small {i}", 10_000, 900, NOW - DAY) for i in range(4)]
                        + [("smallHITXXX", "Small hit", 80_000, 900, NOW - DAY)])
        search = {"entries": [{"id": "searchAAAAA", "title": "Found", "duration": 1200},
                              {"id": "bigBBBBBBBB", "title": "Dup", "duration": 900}]}
        details = {"id": "searchAAAAA", "title": "Found", "view_count": 50_000, "duration": 1200,
                   "upload_date": "20270101", "channel": "Small", "channel_url": "https://www.youtube.com/@Small"}

        def extract(url, options):
            if url.startswith("ytsearch"):
                return search
            if "watch?v=" in url:
                return details
            if url == "https://www.youtube.com/@Big/videos":
                return big
            if url == "https://www.youtube.com/@Small/videos":
                return small
            raise RuntimeError("ERROR: [youtube:tab] @Broken: This channel does not exist.")

        with patch("finder.extract", side_effect=extract):
            result = finder.find_videos({"channels": ["@Big", "@Broken"], "keywords": ["comedy"],
                                         "maxAgeDays": 30, "minDuration": 180, "exclude": ["bigAAAAAAAA"]}, now=NOW)

        # Big hit (1.0×) and Big other (0.33×) are eligible but are not outliers, so they are not offered.
        ranked = [(video["id"], video["multiple"]) for video in result["videos"]]
        self.assertEqual(ranked, [("searchAAAAA", 5.0)])
        self.assertEqual((result["considered"], result["minMultiple"]), (3, 1.5))
        self.assertEqual(result["videos"][0]["source"], "search")
        self.assertEqual(result["videos"][0]["query"], "comedy")
        self.assertEqual(result["warnings"], ["Could not read @Broken: This channel does not exist."])
        self.assertEqual({channel["name"]: channel["median"] for channel in result["channels"]},
                         {"Big": 3_000_000, "Small": 10_000})

    def test_every_source_failing_is_an_error(self):
        with patch("finder.extract", side_effect=RuntimeError("Unable to download webpage")):
            with self.assertRaisesRegex(RuntimeError, "Unable to download webpage"):
                finder.find_videos({"channels": ["@Big"]}, now=NOW)

    def test_options_are_checked(self):
        for options, message in [({}, "at least one channel"), ({"keywords": ["x" * 81]}, "searches"),
                                 ({"channels": ["@Big"], "exclude": ["bad"]}, "processed"),
                                 ({"channels": ["@Big"], "minDuration": 9000, "maxDuration": 600}, "shorter")]:
            with self.subTest(options=options):
                with self.assertRaisesRegex(ValueError, message):
                    finder.find_videos(options)


if __name__ == "__main__":
    unittest.main()
