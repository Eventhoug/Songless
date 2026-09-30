"""Tests for the Python song tools. Run:  python -m unittest discover tests"""

import csv
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

import build_songs  # noqa: E402
import import_spotify  # noqa: E402
import songlib  # noqa: E402


def heatmap(duration, peak_at, peak_width=4, points=100, base=0.2):
    step = duration / points
    data = []
    for i in range(points):
        start = i * step
        value = 1.0 if peak_at <= start < peak_at + peak_width else base
        data.append({"start_time": start, "end_time": start + step, "value": value})
    return data


class ParseTests(unittest.TestCase):
    def test_basic_line(self):
        entry = songlib.parse_line("Radiohead - Creep | rock")
        self.assertEqual((entry.artist, entry.title, entry.genres), ("Radiohead", "Creep", ["rock"]))
        self.assertIsNone(entry.hook)

    def test_overrides(self):
        entry = songlib.parse_line(
            "Dire Straits - Sultans of Swing | rock | hook=1:05.5 | start=0:02 | "
            "yt=https://www.youtube.com/watch?v=abcdefghijk&t=3")
        self.assertEqual(entry.hook, 65.5)
        self.assertEqual(entry.start, 2)
        self.assertEqual(entry.yt, "abcdefghijk")

    def test_multiple_genres_and_aliases(self):
        entry = songlib.parse_line("Post Malone - Circles | pop, hip-hop")
        self.assertEqual(entry.genres, ["pop", "hiphop"])

    def test_title_with_dash_keeps_rest(self):
        entry = songlib.parse_line("blink-182 - What's My Age Again? | rock")
        self.assertEqual(entry.artist, "blink-182")
        self.assertEqual(entry.title, "What's My Age Again?")

    def test_missing_genre_is_other(self):
        self.assertEqual(songlib.parse_line("A - B").genres, ["other"])

    def test_bad_lines(self):
        with self.assertRaises(ValueError):
            songlib.parse_line("No dash here | rock")
        with self.assertRaises(ValueError):
            songlib.parse_line("A - B | yt=nope")

    def test_file_parsing_sections_and_duplicates(self):
        text = "\n".join([
            "# comment",
            "Radiohead - Creep | rock",
            "radiohead - creep | rock",
            "Band - Song | jazz",
            "# === Spotify liked songs (imported 2026-09-30) ===",
            "Travis Scott - 90210 | hiphop",
        ])
        entries, problems = songlib.parse_songs_text(text)
        self.assertEqual([e.title for e in entries], ["Creep", "Song", "90210"])
        self.assertEqual(entries[-1].source, "spotify")
        self.assertEqual(entries[0].source, "list")
        self.assertTrue(any("duplicate" in p for p in problems))
        self.assertTrue(any("unknown genre" in p for p in problems))

    def test_real_song_list_parses(self):
        entries, problems = songlib.read_songs_txt()
        self.assertEqual(problems, [])
        self.assertGreater(len(entries), 200)
        artists = {e.artist for e in entries}
        for band in ("Radiohead", "Dire Straits", "blink-182"):
            self.assertIn(band, artists)

    def test_times(self):
        self.assertEqual(songlib.parse_time("1:05"), 65)
        self.assertEqual(songlib.parse_time("65"), 65)
        self.assertEqual(songlib.format_time(65), "1:05")
        self.assertEqual(songlib.format_time(58.5), "0:58.5")


class TextTests(unittest.TestCase):
    def test_norm(self):
        self.assertEqual(songlib.norm("The Killers"), "killers")
        self.assertEqual(songlib.norm("Beyoncé"), "beyonce")
        self.assertEqual(songlib.norm("MØ"), "mo")
        self.assertEqual(songlib.norm("Guns N' Roses"), "guns n roses")
        self.assertEqual(songlib.norm("AC/DC"), "ac dc")

    def test_clean_title(self):
        cases = {
            "Sultans of Swing - Remastered 1996": "Sultans of Swing",
            "Under Pressure - Remastered 2011": "Under Pressure",
            "Money for Nothing - 2022 Remaster": "Money for Nothing",
            "90210 (feat. Kacy Hill)": "90210",
            "Love Story (Taylor's Version)": "Love Story",
            "Take Me Out - Radio Edit": "Take Me Out",
            "Street Spirit (Fade Out)": "Street Spirit (Fade Out)",
            "Live Forever - Remastered": "Live Forever",
            "Hold On - Live at Wembley": "Hold On",
        }
        for raw, expected in cases.items():
            self.assertEqual(songlib.clean_title(raw), expected, raw)

    def test_primary_artist(self):
        self.assertEqual(songlib.primary_artist("Travis Scott, Kacy Hill", "a,b"), "Travis Scott")
        self.assertEqual(songlib.primary_artist("Tyler, The Creator", "spotify:artist:x"),
                         "Tyler, The Creator")
        self.assertEqual(songlib.primary_artist("Tyler, The Creator, Frank Ocean"), "Tyler, The Creator")
        self.assertEqual(songlib.primary_artist("Earth, Wind & Fire"), "Earth, Wind & Fire")
        self.assertEqual(songlib.primary_artist("A;B"), "A")

    def test_youtube_id(self):
        self.assertEqual(songlib.extract_youtube_id("https://youtu.be/abcdefghijk"), "abcdefghijk")
        self.assertEqual(songlib.extract_youtube_id("abcdefghijk"), "abcdefghijk")
        self.assertIsNone(songlib.extract_youtube_id("https://example.com"))


class GenreTests(unittest.TestCase):
    def test_classify(self):
        cases = {
            "pop punk, punk, socal pop punk, rock": "rock",
            "canadian hip hop, hip hop, rap, pop rap, toronto rap": "hiphop",
            "dance pop, pop, uk pop": "pop",
            "pop rap": "hiphop",
            "pop punk": "rock",
            "alternative metal, nu metal, post-grunge, rap metal": "rock",
            "beatlesque, britpop, madchester, permanent wave, rock": "rock",
            "canadian contemporary r&b, canadian pop, pop": "pop",
            "k-pop": "pop",
        }
        for tags, expected in cases.items():
            self.assertEqual(songlib.classify_genres(tags), expected, tags)
        self.assertIsNone(songlib.classify_genres(""))
        self.assertIsNone(songlib.classify_genres("jazz, bossa nova"))

    def test_artist_map_file(self):
        mapping = songlib.load_artist_genres()
        self.assertEqual(mapping.get(songlib.norm("Playboi Carti")), "hiphop")


class HookTests(unittest.TestCase):
    def test_peak_becomes_hook(self):
        self.assertEqual(songlib.hook_from_heatmap(heatmap(200, 60), 200), 58.5)

    def test_intro_peak_is_ignored(self):
        data = heatmap(200, 4)
        for point in data:
            if 100 <= point["start_time"] < 104:
                point["value"] = 0.8
        self.assertEqual(songlib.hook_from_heatmap(data, 200), 98.5)

    def test_flat_or_missing(self):
        self.assertIsNone(songlib.hook_from_heatmap(heatmap(200, 60, base=0.95), 200))
        self.assertIsNone(songlib.hook_from_heatmap(None, 200))
        self.assertIsNone(songlib.hook_from_heatmap([], 200))

    def test_estimate(self):
        self.assertEqual(songlib.estimate_hook(200), 60.0)
        self.assertEqual(songlib.estimate_hook(None), 45.0)


def candidate(video_id, title, channel, duration=240, views=1_000_000):
    return {"id": video_id, "title": title, "channel": channel, "duration": duration,
            "view_count": views}


class ScoreTests(unittest.TestCase):
    def test_topic_beats_live_and_cover(self):
        topic = candidate("topic000001", "Creep", "Radiohead - Topic", 239, 50_000_000)
        live = candidate("live0000001", "Radiohead - Creep (Live at Glastonbury)", "Radiohead",
                         250, 90_000_000)
        cover = candidate("cover000001", "Creep - Radiohead cover", "Some Singer", 238, 5_000_000)
        scores = {c["id"]: songlib.score_candidate(c, "Radiohead", "Creep", 238)
                  for c in (topic, live, cover)}
        self.assertEqual(max(scores, key=scores.get), "topic000001")

    def test_live_in_real_title_is_fine(self):
        ok = candidate("oasis000001", "Live Forever (Remastered)", "Oasis - Topic", 276)
        self.assertGreater(songlib.score_candidate(ok, "Oasis", "Live Forever", 276), 2)

    def test_other_artist_version_is_penalised(self):
        dolly = {"title": "Dolly Parton - Wrecking Ball (feat. Miley Cyrus) (Official Audio) ft. Miley Cyrus",
                 "channel": "Dolly Parton", "view_count": 1_228_194}
        miley = {"title": "Miley Cyrus - Wrecking Ball (Audio)", "channel": "MILEY", "view_count": 27_546_677}
        self.assertGreater(songlib.score_candidate(miley, "Miley Cyrus", "Wrecking Ball"),
                           songlib.score_candidate(dolly, "Miley Cyrus", "Wrecking Ball") + 2)

    def test_other_recording_is_penalised(self):
        remake = {"title": "Sunday Bloody Sunday (Stories Of Surrender Version) (Official Audio)",
                  "channel": "U2", "view_count": 65_973}
        original = {"title": "Sunday Bloody Sunday", "channel": "U2", "view_count": 463_949}
        self.assertGreater(songlib.score_candidate(original, "U2", "Sunday Bloody Sunday"),
                           songlib.score_candidate(remake, "U2", "Sunday Bloody Sunday") + 2)

    def test_original_version_is_fine(self):
        original = {"title": "California Love (Original Version)", "channel": "2Pac", "view_count": 88_367_624}
        full = {"title": "2Pac ft. Dr. Dre - California Love (Official Video) [Full Length Version]",
                "channel": "UPROXX", "view_count": 118_238_540}
        self.assertGreater(songlib.score_candidate(original, "2Pac", "California Love"),
                           songlib.score_candidate(full, "2Pac", "California Love"))

    def test_wrong_duration_is_penalised(self):
        right = candidate("right000001", "Dreams", "Fleetwood Mac - Topic", 257)
        long = candidate("long0000001", "Dreams", "Fleetwood Mac - Topic", 3600)
        self.assertGreater(songlib.score_candidate(right, "Fleetwood Mac", "Dreams", 257),
                           songlib.score_candidate(long, "Fleetwood Mac", "Dreams", 257))


class FakeYouTube:
    """Stands in for yt-dlp. `results` (and `music`) map a title word to search results."""

    def __init__(self, results, details, music=None):
        self.results = results
        self.music_results = music or {}
        self.details_by_id = details
        self.searches = []
        self.music_searches = []
        self.detail_calls = []

    def music(self, query):
        self.music_searches.append(query)
        for word, items in self.music_results.items():
            if word.lower() in query.lower():
                return items
        return []

    def search(self, query):
        self.searches.append(query)
        for word, items in self.results.items():
            if word.lower() in query.lower():
                return items
        return []

    def details(self, video_id):
        self.detail_calls.append(video_id)
        info = self.details_by_id.get(video_id)
        if info is None:
            raise RuntimeError("Video unavailable")
        return info


class ResolverTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = Path(self.tmp.name) / "cache.json"
        self.fake = FakeYouTube(
            {"Creep": [candidate("noembed0001", "Creep", "Radiohead - Topic", 239, 9_000_000),
                       candidate("creep000002", "Radiohead - Creep (Official Audio)", "Radiohead",
                                 239, 8_000_000)]},
            {"noembed0001": {"playable_in_embed": False, "duration": 239},
             "creep000002": {"playable_in_embed": True, "duration": 239, "view_count": 8_100_000,
                             "availability": "public", "heatmap": heatmap(239, 58)}},
        )

    def tearDown(self):
        self.tmp.cleanup()

    def resolver(self, offline=False):
        return songlib.Resolver(self.cache, offline=offline, delay=0, search=self.fake.search,
                                details=self.fake.details, music_search=self.fake.music)

    def test_skips_non_embeddable_and_caches(self):
        rec, status = self.resolver().lookup("Radiohead", "Creep", 239)
        self.assertEqual(status, "new")
        self.assertEqual(rec["yt"], "creep000002")
        self.assertEqual(rec["hook"], 58.5)
        self.assertEqual(rec["views"], 8_100_000)
        cached = json.loads(self.cache.read_text())
        self.assertIn("radiohead - creep", cached)

        searches = len(self.fake.searches)
        rec2, status2 = self.resolver().lookup("Radiohead", "Creep", 239)
        self.assertEqual((status2, rec2["yt"]), ("cache", "creep000002"))
        self.assertEqual(len(self.fake.searches), searches)

    def test_search_only(self):
        rec, status = self.resolver().lookup("Radiohead", "Creep", 239, detail=False)
        self.assertEqual(status, "new")
        self.assertFalse(rec["detailed"])
        self.assertEqual(self.fake.detail_calls, [])

    def test_not_found_and_offline(self):
        rec, status = self.resolver().lookup("Nobody", "Nothing")
        self.assertIsNone(rec)
        self.assertIn("no matching", status)
        rec, status = self.resolver(offline=True).lookup("Radiohead", "Creep")
        self.assertEqual((rec, status), (None, "offline"))
        self.assertEqual(self.fake.searches[-1:], ["Nobody Nothing"])


class SelectTests(unittest.TestCase):
    def test_min_views_and_unknown(self):
        tracks = [import_spotify.Track("A", f"T{i}", views=v, found=True)
                  for i, v in enumerate([5_000_000, 2_000_000, 900_000])]
        tracks.append(import_spotify.Track("A", "Missing", found=False))
        kept, skipped = import_spotify.select(tracks, 1.0, False, 1_000_000, 20)
        self.assertEqual([t.title for t in kept], ["T0", "T1"])
        reasons = {t.title: reason for t, reason in skipped}
        self.assertIn("900,000", reasons["T2"])
        self.assertEqual(reasons["Missing"], "not found on YouTube")


class MusicMatchTests(unittest.TestCase):
    def test_music_title(self):
        self.assertTrue(songlib.music_title_ok("Creep", "Creep"))
        self.assertTrue(songlib.music_title_ok("Let Down (Remastered)", "Let Down"))
        self.assertTrue(songlib.music_title_ok("Street Spirit (Fade Out)", "Street Spirit (Fade Out)"))
        self.assertFalse(songlib.music_title_ok("Creep (Live)", "Creep"))
        self.assertFalse(songlib.music_title_ok("Flowers (Demo)", "Flowers"))
        self.assertFalse(songlib.music_title_ok("Counting Stars (2023 Version)", "Counting Stars"))
        self.assertFalse(songlib.music_title_ok("Karma Police", "Creep"))
        self.assertFalse(songlib.music_title_ok("one dance (speed)", "One Dance"))
        self.assertTrue(songlib.music_title_ok("Speed of Sound", "Speed of Sound"))
        self.assertTrue(songlib.music_title_ok("Live Forever", "Live Forever"))

    def test_artist_matches(self):
        self.assertTrue(songlib.artist_matches({"artists": ["Radiohead"]}, "Radiohead"))
        self.assertTrue(songlib.artist_matches({"channel": "The Killers - Topic"}, "The Killers"))
        self.assertTrue(songlib.artist_matches({"artists": ["Macklemore", "Ryan Lewis"]},
                                               "Macklemore & Ryan Lewis"))
        self.assertTrue(songlib.artist_matches({"artists": ["MØ"]}, "MØ"))
        self.assertFalse(songlib.artist_matches({"title": "Moment of truth", "channel": "Momo"}, "MØ"))
        self.assertTrue(songlib.artist_matches({"channel": "U2"}, "U2"))
        self.assertFalse(songlib.artist_matches({"artists": ["Some Cover Band"], "channel": "Covers"},
                                                "Radiohead"))


class MusicResolverTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = Path(self.tmp.name) / "cache.json"

    def tearDown(self):
        self.tmp.cleanup()

    def resolver(self, fake):
        return songlib.Resolver(self.cache, delay=0, search=fake.search, details=fake.details,
                                music_search=fake.music)

    def test_studio_track_first(self):
        fake = FakeYouTube(
            {"Creep": [candidate("video000001", "Radiohead - Creep", "Radiohead", 237)]},
            {"track000001": {"playable_in_embed": True, "duration": 238, "artists": ["Radiohead"],
                             "channel": "Radiohead", "track": "Creep", "view_count": 5_000_000,
                             "heatmap": heatmap(238, 58)}},
            music={"Creep": [{"id": "livetrack01", "title": "Creep (Live)"},
                             {"id": "track000001", "title": "Creep"}]},
        )
        rec, status = self.resolver(fake).lookup("Radiohead", "Creep")
        self.assertEqual((status, rec["yt"], rec["track"]), ("new", "track000001", True))
        self.assertEqual(rec["hook"], 58.0)  # peak point starts at 59.5 s, minus 1.5 s
        self.assertEqual(fake.searches, [])  # no normal YouTube search needed
        self.assertEqual(fake.detail_calls, ["track000001"])  # the live version was never tried

    def test_exact_title_is_tried_first(self):
        fake = FakeYouTube(
            {},
            {"remaster001": {"playable_in_embed": True, "duration": 174, "artists": ["Drake"]},
             "onedance001": {"playable_in_embed": True, "duration": 174, "artists": ["Drake"],
                             "track": "One Dance"}},
            music={"One Dance": [{"id": "speedup0001", "title": "one dance (speed)"},
                                 {"id": "remaster001", "title": "One Dance (Remastered)"},
                                 {"id": "onedance001", "title": "One Dance"}]},
        )
        rec, _ = self.resolver(fake).lookup("Drake", "One Dance")
        self.assertEqual(rec["yt"], "onedance001")
        self.assertEqual(fake.detail_calls, ["onedance001"])

    def test_wrong_artist_falls_back_to_video(self):
        fake = FakeYouTube(
            {"Creep": [candidate("video000001", "Radiohead - Creep (Official Audio)", "Radiohead", 237)]},
            {"cover000001": {"playable_in_embed": True, "duration": 230, "artists": ["Cover Band"],
                             "channel": "Cover Band - Topic", "track": "Creep"},
             "video000001": {"playable_in_embed": True, "duration": 237, "channel": "Radiohead"}},
            music={"Creep": [{"id": "cover000001", "title": "Creep"}]},
        )
        rec, status = self.resolver(fake).lookup("Radiohead", "Creep")
        self.assertEqual((status, rec["yt"], rec["track"]), ("new", "video000001", False))
        self.assertEqual(rec["candidates"][0]["error"], "different artist")

    def upgrade_cache(self):
        self.cache.write_text(json.dumps({"radiohead - creep": {
            "yt": "video000001", "channel": "Radiohead", "duration": 237, "hook": 60.0,
            "detailed": True, "candidates": [{"id": "video000001", "source": "web"}]}}))

    def test_upgrade_swaps_video_and_keeps_hook(self):
        self.upgrade_cache()
        fake = FakeYouTube({}, {"track000001": {"playable_in_embed": True, "duration": 238,
                                                "artists": ["Radiohead"], "track": "Creep"}},
                           music={"Creep": [{"id": "track000001", "title": "Creep"}]})
        resolver = self.resolver(fake)
        self.assertTrue(resolver.needs_upgrade("radiohead - creep"))
        rec, status = resolver.lookup("Radiohead", "Creep")  # without upgrade: cached video
        self.assertEqual((status, rec["yt"]), ("cache", "video000001"))
        rec, status = resolver.lookup("Radiohead", "Creep", upgrade=True)
        self.assertEqual((status, rec["yt"], rec["hook"], rec["hookFrom"]),
                         ("new", "track000001", 60.0, "video000001"))
        self.assertFalse(resolver.needs_upgrade("radiohead - creep"))

    def test_upgrade_keeps_old_video_when_nothing_better(self):
        self.upgrade_cache()
        fake = FakeYouTube({}, {}, music={})
        resolver = self.resolver(fake)
        rec, status = resolver.lookup("Radiohead", "Creep", upgrade=True)
        self.assertEqual((status, rec["yt"]), ("kept (no better video found)", "video000001"))
        self.assertEqual(rec["upgradeTried"], [])
        self.assertEqual(fake.searches, [])
        self.assertFalse(resolver.needs_upgrade("radiohead - creep"))
        rec, status = resolver.lookup("Radiohead", "Creep", upgrade=True)
        self.assertEqual(status, "cache")

    def test_upgrade_remembers_rejected_tracks(self):
        self.upgrade_cache()
        fake = FakeYouTube({}, {"cover000001": {"playable_in_embed": True, "artists": ["Cover Band"]}},
                           music={"Creep": [{"id": "cover000001", "title": "Creep"}]})
        rec, status = self.resolver(fake).lookup("Radiohead", "Creep", upgrade=True)
        self.assertEqual(status, "kept (no better video found)")
        self.assertEqual(rec["upgradeTried"],
                         [{"id": "cover000001", "title": "Creep", "error": "different artist"}])

    def test_upgrade_different_length_does_not_copy_hook(self):
        self.upgrade_cache()
        fake = FakeYouTube({}, {"track000001": {"playable_in_embed": True, "duration": 200,
                                                "artists": ["Radiohead"], "track": "Creep"}},
                           music={"Creep": [{"id": "track000001", "title": "Creep"}]})
        rec, _ = self.resolver(fake).lookup("Radiohead", "Creep", upgrade=True)
        self.assertIsNone(rec["hook"])


class BuildTests(unittest.TestCase):
    def test_build_writes_songs_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            songs_txt = tmp / "songs.txt"
            songs_txt.write_text(
                "Radiohead - Creep | rock\n"
                "Dire Straits - Sultans of Swing | rock | hook=1:30\n"
                "Queen - Bohemian Rhapsody | rock | yt=fJ9rUzIMcZQ\n"
                "Nobody - Nothing | pop\n", encoding="utf-8")
            fake = FakeYouTube(
                {"Creep": [candidate("creep000002", "Creep", "Radiohead - Topic", 239)],
                 "Sultans": [candidate("sultans0001", "Sultans of Swing", "Dire Straits - Topic", 348)]},
                {"creep000002": {"playable_in_embed": True, "duration": 239, "heatmap": heatmap(239, 58)},
                 "sultans0001": {"playable_in_embed": True, "duration": 348},
                 "fJ9rUzIMcZQ": {"playable_in_embed": True, "duration": 355}},
            )
            args = build_songs.parse_args([
                "--songs", str(songs_txt), "--out", str(tmp / "songs.json"),
                "--cache", str(tmp / "cache.json"), "--report", str(tmp / "report.txt"),
                "--delay", "0"])
            resolver = songlib.Resolver(tmp / "cache.json", delay=0,
                                        search=fake.search, details=fake.details,
                                        music_search=fake.music)
            with mock.patch("builtins.print"):
                self.assertEqual(build_songs.build(args, resolver), 0)
            data = json.loads((tmp / "songs.json").read_text())
            songs = {s["title"]: s for s in data["songs"]}
            self.assertEqual(data["count"], 4)
            self.assertEqual(data["playable"], 3)
            self.assertEqual((songs["Creep"]["yt"], songs["Creep"]["hookSource"]), ("creep000002", "heatmap"))
            self.assertEqual((songs["Sultans of Swing"]["hook"], songs["Sultans of Swing"]["hookSource"]),
                             (90, "manual"))
            self.assertEqual(songs["Bohemian Rhapsody"]["yt"], "fJ9rUzIMcZQ")
            self.assertEqual(songs["Bohemian Rhapsody"]["hookSource"], "estimate")
            self.assertIsNone(songs["Nothing"]["yt"])
            self.assertIn("Nobody - Nothing", (tmp / "report.txt").read_text())

    def test_limit_stops_new_lookups(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "songs.txt").write_text("A - One | rock\nA - Two | rock\nA - Three | rock\n",
                                           encoding="utf-8")
            fake = FakeYouTube(
                {word: [candidate(f"video{word:0>6}", word, "A - Topic", 200)]
                 for word in ("One", "Two", "Three")},
                {f"video{word:0>6}": {"playable_in_embed": True, "duration": 200}
                 for word in ("One", "Two", "Three")},
            )
            args = build_songs.parse_args([
                "--limit", "1", "--songs", str(tmp / "songs.txt"), "--out", str(tmp / "songs.json"),
                "--cache", str(tmp / "cache.json"), "--report", str(tmp / "report.txt")])
            resolver = songlib.Resolver(tmp / "cache.json", delay=0,
                                        search=fake.search, details=fake.details,
                                        music_search=fake.music)
            with mock.patch("builtins.print"):
                build_songs.build(args, resolver)
            data = json.loads((tmp / "songs.json").read_text())
            self.assertEqual(data["playable"], 1)
            self.assertIn("--limit reached", (tmp / "report.txt").read_text())

    def test_offline_build_keeps_manual_videos(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "songs.txt").write_text("A - B | pop | yt=abcdefghijk | hook=0:30\n", encoding="utf-8")
            args = build_songs.parse_args([
                "--offline", "--songs", str(tmp / "songs.txt"), "--out", str(tmp / "songs.json"),
                "--cache", str(tmp / "cache.json"), "--report", str(tmp / "report.txt")])
            with mock.patch("builtins.print"):
                build_songs.build(args)
            song = json.loads((tmp / "songs.json").read_text())["songs"][0]
            self.assertEqual((song["yt"], song["hook"], song["hookSource"]), ("abcdefghijk", 30, "manual"))


class ImportTests(unittest.TestCase):
    HEADERS = ["Track URI", "Track Name", "Artist URI(s)", "Artist Name(s)", "Album Name",
               "Duration (ms)", "Popularity", "Genres"]

    def write_csv(self, path, rows):
        with path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(self.HEADERS)
            writer.writerows(rows)

    def test_import_keeps_most_viewed(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            rows = []
            results = {}
            details = {}
            # 10 songs with 10M, 20M, ... 100M views; song 1 has too few views.
            for i in range(1, 11):
                title = f"Song{i:02d}"
                vid = f"video{i:06d}"
                views = 500_000 if i == 10 else i * 10_000_000
                rows.append([f"spotify:track:{i}", f"{title} - Remastered 2011", "spotify:artist:1",
                             "Artist One", "Album", "200000", "", "pop punk, rock"])
                results[title] = [candidate(vid, title, "Artist One - Topic", 200, views)]
                details[vid] = {"playable_in_embed": True, "duration": 200, "view_count": views}
            rows.append(["spotify:track:x", "Unknown Song (feat. Someone)", "spotify:artist:2,spotify:artist:3",
                         "Mystery Artist, Someone", "Album", "180000", "", ""])
            results["Unknown Song"] = [candidate("unknown0001", "Unknown Song", "Mystery Artist - Topic",
                                                 180, 999_000_000)]
            details["unknown0001"] = {"playable_in_embed": True, "duration": 180}
            rows.append(["spotify:track:y", "Creep", "spotify:artist:4", "Radiohead", "Pablo Honey",
                         "238000", "", "alternative rock"])
            results["Creep"] = [candidate("creep000002", "Creep", "Radiohead - Topic", 238, 900_000_000)]
            details["creep000002"] = {"playable_in_embed": True, "duration": 238}
            csv_path = tmp / "liked.csv"
            self.write_csv(csv_path, rows)
            songs_txt = tmp / "songs.txt"
            songs_txt.write_text("Radiohead - Creep | rock\n", encoding="utf-8")

            fake = FakeYouTube(results, details)
            with mock.patch.object(songlib, "youtube_search", fake.search), \
                    mock.patch.object(songlib, "youtube_details", fake.details), \
                    mock.patch.object(songlib, "youtube_music_search", fake.music), \
                    mock.patch("builtins.print"):
                code = import_spotify.main([
                    str(csv_path), "--songs", str(songs_txt), "--cache", str(tmp / "cache.json"),
                    "--skipped", str(tmp / "skipped.txt"), "--delay", "0", "--no-build"])
            self.assertEqual(code, 0)

            text = songs_txt.read_text(encoding="utf-8")
            self.assertIn("# === Spotify liked songs (imported", text)
            added = [line for line in text.splitlines()[2:] if line and not line.startswith("#")]
            # 12 liked songs, keep 60% -> top 7 by views: Unknown, Creep, Song09..Song05.
            self.assertEqual(text.count("Radiohead - Creep"), 1)  # already there, not added twice
            self.assertIn("Mystery Artist - Unknown Song | other", added)
            for i in (9, 8, 7, 6, 5):
                self.assertIn(f"Artist One - Song{i:02d} | rock", added)
            self.assertEqual(len(added), 6)
            skipped = (tmp / "skipped.txt").read_text(encoding="utf-8")
            self.assertIn("Song01", skipped)
            self.assertIn("Song10", skipped)  # only 500k views
            entries, problems = songlib.parse_songs_text(text)
            self.assertEqual(problems, [])
            self.assertEqual(entries[-1].source, "spotify")

    def test_spotify_popularity_is_used_when_present(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            rows = [[f"spotify:track:{i}", f"Track {i}", "spotify:artist:1", "Band", "Album", "200000",
                     str(i * 10), ""] for i in range(1, 6)]
            csv_path = tmp / "liked.csv"
            self.write_csv(csv_path, rows)
            songs_txt = tmp / "songs.txt"
            with mock.patch.object(songlib, "youtube_search", side_effect=AssertionError("no lookups")), \
                    mock.patch("builtins.print"):
                import_spotify.main([str(csv_path), "--songs", str(songs_txt), "--cache",
                                     str(tmp / "cache.json"), "--skipped", str(tmp / "skipped.txt"),
                                     "--no-build", "--keep", "0.6"])
            lines = [l for l in songs_txt.read_text().splitlines() if l and not l.startswith("#")]
            self.assertEqual(lines, ["Band - Track 5 | other", "Band - Track 4 | other",
                                     "Band - Track 3 | other"])


if __name__ == "__main__":
    unittest.main()
