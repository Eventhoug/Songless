"""Shared helpers for the Songless tools.

Everything that talks to YouTube goes through yt-dlp, which is imported lazily
so the parsing helpers (and the tests) work without it installed.
"""

from __future__ import annotations

import datetime as _dt
import json
import math
import random
import re
import time
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SONGS_TXT = DATA / "songs.txt"
SONGS_JSON = DATA / "songs.json"
CACHE_JSON = DATA / "yt_cache.json"
ARTIST_GENRES_TXT = DATA / "artist_genres.txt"
REPORT_TXT = DATA / "build_report.txt"

GENRES = ("rock", "pop", "hiphop", "other")
GENRE_ALIASES = {
    "hip-hop": "hiphop",
    "hip hop": "hiphop",
    "hiphop": "hiphop",
    "rap": "hiphop",
    "rock": "rock",
    "pop": "pop",
    "other": "other",
}

YT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


# --------------------------------------------------------------------------
# Text helpers
# --------------------------------------------------------------------------

def norm(text: str) -> str:
    """Lowercase, strip accents and punctuation, drop a leading 'the'."""
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.lower().replace("&", " and ").replace("ø", "o").replace("æ", "ae")
    text = re.sub(r"[’'`]", "", text)
    text = re.sub(r"[^a-z0-9]+", " ", text).strip()
    if text.startswith("the "):
        text = text[4:]
    return text


def song_key(artist: str, title: str) -> str:
    return f"{norm(artist)} - {norm(title)}"


def slug(artist: str, title: str) -> str:
    return re.sub(r"\s+", "-", f"{norm(artist)} {norm(title)}".strip()) or "song"


def parse_time(value: str) -> float:
    """'1:05' -> 65.0, '65' -> 65.0, '1:05.5' -> 65.5."""
    value = value.strip()
    if not value:
        raise ValueError("empty time")
    parts = value.split(":")
    if len(parts) > 3:
        raise ValueError(f"bad time: {value!r}")
    total = 0.0
    for part in parts:
        total = total * 60 + float(part)
    if total < 0:
        raise ValueError(f"negative time: {value!r}")
    return total


def format_time(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    minutes = int(seconds // 60)
    rest = seconds - minutes * 60
    if abs(rest - round(rest)) < 1e-6:
        return f"{minutes}:{int(round(rest)):02d}"
    return f"{minutes}:{rest:04.1f}"


def round_half(seconds: float) -> float:
    """Round to the nearest 0.5 s (halves round up, unlike round())."""
    return math.floor(seconds * 2 + 0.5) / 2


_SUFFIX_WORDS = (
    r"remaster(?:ed)?|version|edit|mix|live|mono|stereo|from|bonus|deluxe|"
    r"recorded|acoustic|demo|anniversary|soundtrack|session|take|single|"
    r"re-?recorded|taylor'?s"
)
_DASH_SUFFIX_RE = re.compile(rf"\s+-\s+[^-]*\b(?:{_SUFFIX_WORDS})\b.*$", re.I)
_FEAT_RE = re.compile(r"\s*[\(\[](?:feat\.?|ft\.?|featuring|with)\s[^\)\]]*[\)\]]", re.I)
_PAREN_SUFFIX_RE = re.compile(
    r"\s*[\(\[][^\)\]]*\b(?:remaster(?:ed)?|radio edit|single version|album version|"
    r"mono|stereo|bonus track|deluxe|live|taylor'?s version)\b[^\)\]]*[\)\]]",
    re.I,
)


def clean_title(title: str) -> str:
    """Strip Spotify-style suffixes: ' - Remastered 2011', '(feat. X)', ..."""
    cleaned = title.strip()
    cleaned = _DASH_SUFFIX_RE.sub("", cleaned)
    cleaned = _FEAT_RE.sub("", cleaned)
    cleaned = _PAREN_SUFFIX_RE.sub("", cleaned)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip(" -")
    return cleaned or title.strip()


# Artists whose names contain a comma (Exportify joins multiple artists with ",").
_COMMA_ARTISTS = (
    "Tyler, The Creator",
    "Earth, Wind & Fire",
    "Crosby, Stills, Nash & Young",
    "Crosby, Stills & Nash",
    "Emerson, Lake & Palmer",
    "Peter, Paul and Mary",
)


def primary_artist(names: str, uris: str | None = None) -> str:
    names = (names or "").strip()
    if not names:
        return ""
    if ";" in names:
        return names.split(";")[0].strip()
    for special in _COMMA_ARTISTS:
        if names.lower().startswith(special.lower()):
            return names[: len(special)]
    if uris is not None:
        uri_count = len([u for u in re.split(r"[,;]", uris) if u.strip()])
        if uri_count <= 1:
            return names
    return names.split(",")[0].strip()


# --------------------------------------------------------------------------
# Genres
# --------------------------------------------------------------------------

_HIPHOP_RE = re.compile(
    r"\b(hip ?-?hop|rap|trap|drill|grime|g funk|boom bap|crunk|dirty south)\b")
_ROCK_RE = re.compile(
    r"\b(rock|punk|metal|grunge|emo|shoegaze|britpop|post-punk|hardcore|madchester)\b")
_POP_RE = re.compile(r"\b(pop|synthpop|electropop|europop|dance pop|teen pop)\b")


def classify_genres(genre_text: str) -> str | None:
    """Map Spotify-style artist genre tags to rock / pop / hiphop.

    Every tag votes for each category it matches; the most votes win, and a
    tie is broken hiphop > rock > pop ('pop rap' is hip-hop, 'pop punk' rock).
    Returns None when no tag matches anything.
    """
    tags = [t.strip().lower() for t in re.split(r"[,;|]", genre_text or "") if t.strip()]
    votes = {"hiphop": 0, "rock": 0, "pop": 0}
    for tag in tags:
        if _HIPHOP_RE.search(tag):
            votes["hiphop"] += 1
        if _ROCK_RE.search(tag):
            votes["rock"] += 1
        if _POP_RE.search(tag):
            votes["pop"] += 1
    best = max(votes.values())
    if best == 0:
        return None
    for genre in ("hiphop", "rock", "pop"):
        if votes[genre] == best:
            return genre
    return None


def normalize_genre(value: str) -> str | None:
    return GENRE_ALIASES.get(value.strip().lower())


def load_artist_genres(path: Path = ARTIST_GENRES_TXT) -> dict[str, str]:
    """'Artist | genre' per line -> {norm(artist): genre}."""
    mapping: dict[str, str] = {}
    if not path.exists():
        return mapping
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "|" not in line:
            continue
        artist, genre = (p.strip() for p in line.split("|", 1))
        genre = normalize_genre(genre)
        if artist and genre:
            mapping[norm(artist)] = genre
    return mapping


# --------------------------------------------------------------------------
# songs.txt
# --------------------------------------------------------------------------

@dataclass
class Entry:
    artist: str
    title: str
    genres: list[str]
    yt: str | None = None
    hook: float | None = None
    start: float | None = None
    source: str = "list"
    line_no: int = 0
    warnings: list[str] = field(default_factory=list)

    @property
    def key(self) -> str:
        return song_key(self.artist, self.title)


def parse_line(line: str, line_no: int = 0, source: str = "list") -> Entry:
    """Parse 'Artist - Title | genre [| hook=1:05] [| start=0:02] [| yt=ID]'."""
    parts = [p.strip() for p in line.split("|")]
    head = parts[0]
    if " - " not in head:
        raise ValueError(f"line {line_no}: expected 'Artist - Title', got {head!r}")
    artist, title = (s.strip() for s in head.split(" - ", 1))
    if not artist or not title:
        raise ValueError(f"line {line_no}: missing artist or title")

    entry = Entry(artist=artist, title=title, genres=[], source=source, line_no=line_no)
    for part in parts[1:]:
        if not part:
            continue
        if "=" in part:
            name, value = (s.strip() for s in part.split("=", 1))
            name = name.lower()
            if name == "hook":
                entry.hook = parse_time(value)
            elif name == "start":
                entry.start = parse_time(value)
            elif name in ("yt", "youtube"):
                video_id = extract_youtube_id(value)
                if not video_id:
                    raise ValueError(f"line {line_no}: bad YouTube id {value!r}")
                entry.yt = video_id
            else:
                entry.warnings.append(f"line {line_no}: unknown option {name!r}")
        else:
            for raw_genre in re.split(r"[,/]", part):
                genre = normalize_genre(raw_genre)
                if genre is None:
                    entry.warnings.append(f"line {line_no}: unknown genre {raw_genre.strip()!r}")
                elif genre not in entry.genres:
                    entry.genres.append(genre)
    if not entry.genres:
        entry.genres = ["other"]
    return entry


_SECTION_RE = re.compile(r"^#\s*===(.*)===\s*$")


def parse_songs_text(text: str) -> tuple[list[Entry], list[str]]:
    """Returns (entries, problems). Duplicate songs keep their first line."""
    entries: list[Entry] = []
    problems: list[str] = []
    seen: dict[str, int] = {}
    source = "list"
    for line_no, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            section = _SECTION_RE.match(line)
            if section:
                source = "spotify" if "spotify" in section.group(1).lower() else "list"
            continue
        try:
            entry = parse_line(line, line_no, source)
        except ValueError as err:
            problems.append(str(err))
            continue
        problems.extend(entry.warnings)
        if entry.key in seen:
            problems.append(
                f"line {line_no}: duplicate of line {seen[entry.key]} ({entry.artist} - {entry.title})")
            continue
        seen[entry.key] = line_no
        entries.append(entry)
    return entries, problems


def read_songs_txt(path: Path = SONGS_TXT) -> tuple[list[Entry], list[str]]:
    if not path.exists():
        return [], [f"{path} not found"]
    return parse_songs_text(path.read_text(encoding="utf-8"))


def extract_youtube_id(value: str) -> str | None:
    value = value.strip()
    if YT_ID_RE.match(value):
        return value
    match = re.search(
        r"(?:v=|youtu\.be/|/embed/|/shorts/|/live/|/v/)([A-Za-z0-9_-]{11})", value)
    return match.group(1) if match else None


# --------------------------------------------------------------------------
# Hooks
# --------------------------------------------------------------------------

def hook_from_heatmap(heatmap, duration: float | None) -> float | None:
    """Pick the hook from YouTube's 'Most replayed' data.

    Ignores the first and last 8% of the song, smooths the curve, takes the
    peak and backs off 1.5 s so the clip starts just before it. Returns None if
    there is no usable heatmap or the curve is too flat to trust.
    """
    points = []
    for item in heatmap or []:
        try:
            points.append((float(item["start_time"]), float(item["end_time"]), float(item["value"])))
        except (KeyError, TypeError, ValueError):
            continue
    if len(points) < 10:
        return None
    points.sort()
    total = float(duration) if duration else points[-1][1]
    if total <= 0:
        return None
    lo, hi = total * 0.08, total * 0.92
    values = [p[2] for p in points]
    smoothed = []
    for i in range(len(values)):
        # 1-2-1 kernel: evens out single spikes but keeps the true peak on top.
        weights = [(values[j], 2 if j == i else 1) for j in (i - 1, i, i + 1) if 0 <= j < len(values)]
        smoothed.append(sum(v * w for v, w in weights) / sum(w for _, w in weights))
    candidates = [i for i, p in enumerate(points) if p[0] >= lo and p[1] <= hi]
    if not candidates:
        return None
    # On a plateau take the earliest point, so the clip starts where the peak begins.
    best = max(candidates, key=lambda i: (round(smoothed[i], 6), -i))
    ordered = sorted(smoothed[i] for i in candidates)
    median = ordered[len(ordered) // 2]
    if smoothed[best] - median < 0.1:
        return None
    hook = max(0.0, points[best][0] - 1.5)
    if total > 40:
        hook = min(hook, total - 20)
    return round_half(hook)


def estimate_hook(duration: float | None) -> float:
    if not duration:
        return 45.0
    return round_half(min(duration * 0.3, max(duration - 20, 0)))


# --------------------------------------------------------------------------
# YouTube lookups (yt-dlp)
# --------------------------------------------------------------------------

_BAD_WORDS = (
    "live", "cover", "karaoke", "remix", "instrumental", "sped up", "slowed",
    "nightcore", "reaction", "lesson", "tutorial", "8d", "1 hour", "10 hours",
    "bass boosted", "reverb", "piano", "drum", "tribute", "concert", "full album",
    "extended", "acoustic", "unplugged", "loop", "mashup", "parody", "reacts",
)
_STOP_WORDS = {"a", "an", "and", "of", "the", "to", "in", "on", "feat", "ft"}


def score_candidate(entry: dict, artist: str, title: str, duration: float | None = None) -> float:
    """Heuristic score for a YouTube search result (higher is better)."""
    video_title = norm(entry.get("title") or "")
    channel_raw = entry.get("channel") or entry.get("uploader") or ""
    channel = norm(channel_raw)
    want_title = norm(title)
    want_artist = norm(artist)
    words = set(video_title.split())
    score = 0.0

    title_words = [w for w in want_title.split() if w not in _STOP_WORDS] or want_title.split()
    missing = [w for w in title_words if w not in words]
    if missing:
        score -= 4 * len(missing) / max(len(title_words), 1) + 2

    is_topic = channel_raw.strip().lower().endswith(" - topic")
    if is_topic and norm(channel_raw[: -len(" - topic")]) == want_artist:
        score += 5
    elif is_topic:
        score += 1
    if want_artist and (want_artist in video_title or want_artist in channel):
        score += 2
    elif want_artist.replace(" ", "") and want_artist.replace(" ", "") in channel.replace(" ", ""):
        score += 2

    if "official audio" in video_title:
        score += 2
    elif "official music video" in video_title or "official video" in video_title:
        score += 1
    elif " audio" in f" {video_title}":
        score += 0.5

    for bad in _BAD_WORDS:
        if re.search(rf"\b{re.escape(bad)}\b", video_title) and not re.search(
                rf"\b{re.escape(bad)}\b", want_title):
            score -= 6
            break

    length = entry.get("duration")
    if length:
        if duration:
            diff = abs(float(length) - float(duration))
            score -= min(diff, 120) / 15
            if diff > 60:
                score -= 3
        elif length > 900 or length < 60:
            score -= 5

    views = entry.get("view_count") or 0
    score += 0.3 * math.log10(views + 1)
    return score


def _ydl(extra: dict | None = None):
    try:
        import yt_dlp  # noqa: F401
    except ImportError as err:  # pragma: no cover - depends on the machine
        raise SystemExit(
            "yt-dlp is not installed. Run:  pip install -r tools/requirements.txt") from err
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "ignore_no_formats_error": True,
    }
    opts.update(extra or {})
    return yt_dlp.YoutubeDL(opts)


def youtube_search(query: str, count: int = 8) -> list[dict]:
    with _ydl({"extract_flat": "in_playlist"}) as ydl:
        info = ydl.extract_info(f"ytsearch{count}:{query}", download=False)
    return [e for e in (info or {}).get("entries") or [] if e and e.get("id")]


def youtube_details(video_id: str) -> dict:
    with _ydl() as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    return info or {}


def today() -> str:
    return _dt.date.today().isoformat()


class Resolver:
    """Finds a playable YouTube video for each song and caches the result.

    Cache record (data/yt_cache.json, keyed by song_key):
      yt, ytTitle, channel, duration, views, candidates[], detailed,
      embeddable, hook (from heatmap or None), checked (date)
    """

    def __init__(self, cache_path: Path = CACHE_JSON, offline: bool = False,
                 delay: float = 1.5, search=None, details=None, sleep=None):
        self.cache_path = cache_path
        self.offline = offline
        self.delay = delay
        self._search = search or youtube_search
        self._details = details or youtube_details
        self._sleep = sleep or time.sleep
        self._calls = 0
        self.cache: dict[str, dict] = {}
        if cache_path.exists():
            try:
                self.cache = json.loads(cache_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                print(f"warning: {cache_path} is not valid JSON, starting with an empty cache")

    def save(self) -> None:
        self.cache_path.write_text(
            json.dumps(self.cache, indent=1, ensure_ascii=False, sort_keys=True) + "\n",
            encoding="utf-8")

    def forget(self, key: str) -> None:
        self.cache.pop(key, None)

    def _pause(self) -> None:
        if self._calls and self.delay > 0:
            self._sleep(self.delay * random.uniform(0.7, 1.3))
        self._calls += 1

    def lookup(self, artist: str, title: str, duration: float | None = None,
               detail: bool = True, video_id: str | None = None) -> tuple[dict | None, str]:
        """Returns (record, status). status is 'cache', 'new', 'offline' or an error text."""
        key = song_key(artist, title)
        rec = self.cache.get(key)
        if rec and video_id and rec.get("yt") != video_id:
            rec = None  # a manual yt= override replaces whatever was cached
        if rec and (rec.get("detailed") or not detail):
            return rec, "cache"
        if self.offline:
            return rec, "offline"

        try:
            if rec is None:
                if video_id:
                    rec = {"candidates": [{"id": video_id}], "yt": video_id}
                else:
                    rec = self._search_record(artist, title, duration)
                    if rec is None:
                        return None, "no matching video found"
            if detail:
                ok = self._detail_record(rec)
                if not ok:
                    self.cache[key] = rec
                    self.save()
                    return None, "no embeddable video found"
        except Exception as err:  # yt-dlp raises many different errors
            return rec, f"lookup failed: {str(err).splitlines()[0][:160]}"

        rec["checked"] = today()
        self.cache[key] = rec
        self.save()
        return rec, "new"

    def _search_record(self, artist: str, title: str, duration: float | None) -> dict | None:
        results: dict[str, dict] = {}
        for query in (f"{artist} - {title} audio", f"{artist} {title}"):
            self._pause()
            for item in self._search(query):
                results.setdefault(item["id"], item)
            scored = sorted(results.values(),
                            key=lambda e: score_candidate(e, artist, title, duration),
                            reverse=True)
            if scored and score_candidate(scored[0], artist, title, duration) >= 2:
                break
        scored = sorted(results.values(),
                        key=lambda e: score_candidate(e, artist, title, duration), reverse=True)
        scored = [e for e in scored if score_candidate(e, artist, title, duration) > -2][:4]
        if not scored:
            return None
        best = scored[0]
        return {
            "yt": best["id"],
            "ytTitle": best.get("title"),
            "channel": best.get("channel") or best.get("uploader"),
            "duration": best.get("duration"),
            "views": best.get("view_count"),
            "candidates": [
                {
                    "id": e["id"],
                    "title": e.get("title"),
                    "channel": e.get("channel") or e.get("uploader"),
                    "duration": e.get("duration"),
                    "views": e.get("view_count"),
                    "score": round(score_candidate(e, artist, title, duration), 2),
                }
                for e in scored
            ],
            "detailed": False,
        }

    def _detail_record(self, rec: dict) -> bool:
        for cand in rec.get("candidates") or [{"id": rec.get("yt")}]:
            self._pause()
            try:
                info = self._details(cand["id"])
            except Exception as err:  # unavailable, private, region-locked, ...
                cand["error"] = str(err).splitlines()[0][:160]
                continue
            if info.get("playable_in_embed") is False:
                cand["error"] = "embedding disabled"
                continue
            if info.get("availability") not in (None, "public", "unlisted"):
                cand["error"] = f"availability: {info.get('availability')}"
                continue
            duration = info.get("duration") or cand.get("duration")
            rec.update({
                "yt": cand["id"],
                "ytTitle": info.get("title") or cand.get("title"),
                "channel": info.get("channel") or info.get("uploader") or cand.get("channel"),
                "duration": duration,
                "views": info.get("view_count") or cand.get("views"),
                "embeddable": info.get("playable_in_embed"),
                "hook": hook_from_heatmap(info.get("heatmap"), duration),
                "detailed": True,
            })
            return True
        rec["detailed"] = False
        return False
