#!/usr/bin/env python3
"""Import the most popular part of your Spotify liked songs into data/songs.txt.

1. Export "Liked Songs" as CSV from https://exportify.net (tick "Include artists
   data" if it is offered, so genres are included) and save it in data/spotify/.
2. Run:
       python tools/import_spotify.py data/spotify/Liked_Songs.csv

The script keeps the most popular 60% (change with --keep) and drops songs with
fewer than --min-views YouTube views, so the very niche ones are left out.
Popularity is Spotify's Popularity column when the CSV has values in it,
otherwise the YouTube view count. Genres come from the CSV, then
data/artist_genres.txt, then songs already in songs.txt, else "other".

Afterwards it rebuilds data/songs.json. Lookups are cached, so you can stop
with Ctrl+C and run the same command again to continue.

A plain .txt file with one "Artist - Title" per line also works.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_songs  # noqa: E402
import songlib  # noqa: E402
from songlib import Resolver, song_key  # noqa: E402


@dataclass
class Track:
    artist: str
    title: str
    duration: float | None = None
    popularity: float | None = None
    genres_text: str = ""
    views: int | None = None
    found: bool | None = None
    genre: str = "other"

    @property
    def key(self) -> str:
        return song_key(self.artist, self.title)


def find_column(headers: list[str], *tests) -> str | None:
    lowered = {h: h.strip().lower() for h in headers}
    for test in tests:
        for header, low in lowered.items():
            if test(low):
                return header
    return None


def read_tracks(path: Path) -> list[Track]:
    if path.suffix.lower() == ".txt":
        return read_text_list(path)
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        headers = reader.fieldnames or []
        title_col = find_column(
            headers,
            lambda h: h == "track name",
            lambda h: "track name" in h,
            lambda h: h in ("name", "title", "song", "song name", "track"),
            lambda h: "title" in h and "album" not in h,
        )
        artist_col = find_column(
            headers,
            lambda h: h in ("artist name(s)", "artist name", "artist names", "artist(s)",
                            "artist", "artists"),
            lambda h: "artist" in h and "album" not in h and "uri" not in h
            and "genre" not in h and "id" not in h.split(),
        )
        uri_col = find_column(headers, lambda h: "artist uri" in h and "album" not in h)
        duration_col = find_column(headers, lambda h: "duration" in h)
        popularity_col = find_column(headers, lambda h: "popularity" in h)
        genre_col = find_column(headers, lambda h: "genre" in h)
        if not title_col or not artist_col:
            raise SystemExit(
                f"Could not find the track and artist columns in {path}.\n"
                f"Columns found: {', '.join(headers)}")

        tracks: list[Track] = []
        for row in reader:
            raw_title = (row.get(title_col) or "").strip()
            raw_artist = (row.get(artist_col) or "").strip()
            if not raw_title or not raw_artist:
                continue
            artist = songlib.primary_artist(raw_artist, row.get(uri_col) if uri_col else None)
            title = songlib.clean_title(raw_title)
            tracks.append(Track(
                artist=artist.replace("|", "/"),
                title=title.replace("|", "/"),
                duration=parse_duration(row.get(duration_col) if duration_col else None),
                popularity=parse_number(row.get(popularity_col) if popularity_col else None),
                genres_text=(row.get(genre_col) or "") if genre_col else "",
            ))
    return tracks


def read_text_list(path: Path) -> list[Track]:
    tracks = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or " - " not in line:
            continue
        artist, title = (s.strip() for s in line.split("|")[0].split(" - ", 1))
        if artist and title:
            tracks.append(Track(artist=artist, title=songlib.clean_title(title)))
    return tracks


def parse_number(value: str | None) -> float | None:
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


def parse_duration(value: str | None) -> float | None:
    number = parse_number(value)
    if number is None or number <= 0:
        return None
    return number / 1000 if number > 10000 else number  # Spotify gives milliseconds


def dedupe(tracks: list[Track]) -> list[Track]:
    seen: set[str] = set()
    unique = []
    for track in tracks:
        if track.key not in seen:
            seen.add(track.key)
            unique.append(track)
    return unique


def choose_genre(track: Track, artist_map: dict[str, str], known: dict[str, str]) -> str:
    return (songlib.classify_genres(track.genres_text)
            or artist_map.get(songlib.norm(track.artist))
            or known.get(songlib.norm(track.artist))
            or "other")


def select(tracks: list[Track], keep: float, use_popularity: bool,
           min_views: int, min_popularity: float) -> tuple[list[Track], list[tuple[Track, str]]]:
    """Returns (kept, skipped-with-reason). Ranking is over every liked song."""
    def metric(t: Track) -> float:
        value = t.popularity if use_popularity else t.views
        return -1 if value is None else value

    ranked = sorted(tracks, key=metric, reverse=True)
    cut = round(len(ranked) * keep)
    kept, skipped = [], []
    for position, track in enumerate(ranked):
        if track.found is False:
            skipped.append((track, "not found on YouTube"))
        elif position >= cut:
            skipped.append((track, f"below the top {keep:.0%}"))
        elif use_popularity and (track.popularity or 0) < min_popularity:
            skipped.append((track, f"Spotify popularity {track.popularity:g} < {min_popularity:g}"))
        elif not use_popularity and track.views is None:
            skipped.append((track, "not looked up yet"))
        elif track.views is not None and track.views < min_views:
            skipped.append((track, f"only {track.views:,} YouTube views"))
        else:
            kept.append(track)
    return kept, skipped


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("csv", help="Exportify CSV (or a .txt with 'Artist - Title' lines)")
    parser.add_argument("--keep", type=float, default=0.6,
                        help="share of liked songs to keep, 0-1 (default 0.6)")
    parser.add_argument("--min-views", type=int, default=1_000_000,
                        help="drop songs with fewer YouTube views (default 1000000)")
    parser.add_argument("--min-popularity", type=float, default=20,
                        help="drop songs below this Spotify popularity, if the CSV has it")
    parser.add_argument("--delay", type=float, default=1.5,
                        help="seconds between YouTube requests (default 1.5)")
    parser.add_argument("--offline", action="store_true", help="use only cached lookups")
    parser.add_argument("--dry-run", action="store_true", help="show the result, change nothing")
    parser.add_argument("--no-build", action="store_true", help="do not rebuild songs.json")
    parser.add_argument("--songs", default=str(songlib.SONGS_TXT), help=argparse.SUPPRESS)
    parser.add_argument("--cache", default=str(songlib.CACHE_JSON), help=argparse.SUPPRESS)
    parser.add_argument("--skipped", default=str(songlib.DATA / "spotify" / "skipped.txt"),
                        help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    if not 0 < args.keep <= 1:
        parser.error("--keep must be between 0 and 1, e.g. 0.6")
    csv_path = Path(args.csv)
    if not csv_path.exists():
        parser.error(f"{csv_path} does not exist")

    tracks = dedupe(read_tracks(csv_path))
    if not tracks:
        print("No tracks found in", csv_path)
        return 1
    print(f"{len(tracks)} liked songs in {csv_path.name}.")

    with_popularity = sum(1 for t in tracks if t.popularity and t.popularity > 0)
    use_popularity = with_popularity >= len(tracks) / 2
    resolver = Resolver(Path(args.cache), offline=args.offline, delay=args.delay)

    try:
        for index, track in enumerate([] if use_popularity else tracks, start=1):
            rec, status = resolver.lookup(track.artist, track.title, track.duration, detail=False)
            track.views = (rec or {}).get("views")
            if rec is None and status not in ("offline", "cache"):
                track.found = False
            elif rec is not None:
                track.found = True
            if status == "new":
                views = f"{track.views:,}" if track.views is not None else "?"
                print(f"[{index}/{len(tracks)}] {track.artist} - {track.title}: {views} views")
            elif status not in ("cache", "offline"):
                print(f"[{index}/{len(tracks)}] {track.artist} - {track.title}: {status}")
    except KeyboardInterrupt:
        print("\nStopped. Lookups so far are cached; run the same command again to continue.")
        return 130

    print("Ranking by", "Spotify popularity" if use_popularity else "YouTube views")
    kept, skipped = select(tracks, args.keep, use_popularity, args.min_views, args.min_popularity)

    songs_path = Path(args.songs)
    existing, _ = songlib.read_songs_txt(songs_path)
    existing_keys = {e.key for e in existing}
    known_genres = {songlib.norm(e.artist): e.genres[0] for e in existing if e.genres[0] != "other"}
    artist_map = songlib.load_artist_genres()

    new_tracks = []
    for track in kept:
        if track.key in existing_keys:
            continue
        track.genre = choose_genre(track, artist_map, known_genres)
        new_tracks.append(track)
    already = len(kept) - len(new_tracks)

    print()
    print(f"Kept {len(kept)} of {len(tracks)} songs. {len(new_tracks)} are new, "
          f"{already} were already in songs.txt.")
    by_genre: dict[str, int] = {}
    for track in new_tracks:
        by_genre[track.genre] = by_genre.get(track.genre, 0) + 1
    if by_genre:
        print("New songs per genre:", ", ".join(f"{g} {n}" for g, n in sorted(by_genre.items())))
    others = [t for t in new_tracks if t.genre == "other"]
    if others:
        print(f"{len(others)} new songs got genre 'other' (they only show under All). "
              "Change '| other' to rock, pop or hiphop in songs.txt if you want:")
        for track in others[:15]:
            print(f"   {track.artist} - {track.title}")
        if len(others) > 15:
            print(f"   ... and {len(others) - 15} more")

    if args.dry_run:
        print("\nDry run: nothing was written.")
        return 0

    skipped_path = Path(args.skipped)
    skipped_path.parent.mkdir(parents=True, exist_ok=True)
    skipped_path.write_text(
        "Songs from your liked songs that were NOT added, and why.\n"
        "Copy a line into data/songs.txt (as 'Artist - Title | genre') to add it anyway.\n\n"
        + "".join(f"{t.artist} - {t.title}    ({reason})\n" for t, reason in skipped),
        encoding="utf-8")
    print(f"{len(skipped)} skipped songs are listed in {skipped_path}.")

    if new_tracks:
        text = songs_path.read_text(encoding="utf-8") if songs_path.exists() else ""
        if text and not text.endswith("\n"):
            text += "\n"
        text += f"\n# === Spotify liked songs (imported {dt.date.today().isoformat()}) ===\n"
        text += "".join(f"{t.artist} - {t.title} | {t.genre}\n" for t in new_tracks)
        songs_path.write_text(text, encoding="utf-8")
        print(f"Added {len(new_tracks)} songs to {songs_path}.")

    if args.no_build:
        return 0
    print("\nBuilding songs.json ...")
    build_args = ["--songs", str(songs_path), "--cache", args.cache, "--delay", str(args.delay)]
    if args.offline:
        build_args.append("--offline")
    return build_songs.main(build_args)


if __name__ == "__main__":
    sys.exit(main())
