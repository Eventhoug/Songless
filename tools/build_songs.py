#!/usr/bin/env python3
"""Build data/songs.json (what the game plays) from data/songs.txt.

For every song it finds a YouTube video that may be embedded, its length and
view count, and the hook (from YouTube's "Most replayed" graph). Results are
cached in data/yt_cache.json, so only new songs are looked up next time.

    python tools/build_songs.py                  # look up new songs, write songs.json
    python tools/build_songs.py --offline        # no internet: only cache + overrides
    python tools/build_songs.py --refresh "Radiohead - Creep"
    python tools/build_songs.py --limit 50       # look up at most 50 new songs this run
    python tools/build_songs.py --upgrade        # swap music videos for studio tracks

Each song first gets the official studio track from YouTube Music (it starts at
0:00 like on Spotify); if there is none that can be embedded, a normal YouTube
search picks the best official video or audio upload.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import songlib  # noqa: E402
from songlib import Entry, Resolver, estimate_hook, format_time  # noqa: E402


def build_song(entry: Entry, rec: dict | None) -> dict:
    duration = (rec or {}).get("duration")
    if entry.hook is not None:
        hook, hook_source = entry.hook, "manual"
    elif rec and rec.get("hook") is not None:
        hook, hook_source = rec["hook"], "heatmap"
    else:
        hook, hook_source = estimate_hook(duration), "estimate"
    video_id = entry.yt or ((rec or {}).get("yt") if (rec or {}).get("detailed") else None)
    return {
        "id": songlib.slug(entry.artist, entry.title),
        "title": entry.title,
        "artist": entry.artist,
        "genres": entry.genres,
        "yt": video_id,
        "duration": int(duration) if duration else None,
        "start": entry.start or 0,
        "hook": hook,
        "hookSource": hook_source,
        "views": (rec or {}).get("views"),
        "source": entry.source,
    }


def build(args: argparse.Namespace, resolver: Resolver | None = None) -> int:
    entries, problems = songlib.read_songs_txt(Path(args.songs))
    if not entries:
        print("No songs found in", args.songs)
        for problem in problems:
            print("  ", problem)
        return 1

    resolver = resolver or Resolver(Path(args.cache), offline=args.offline, delay=args.delay)
    for name in args.refresh or []:
        if " - " not in name:
            print(f"--refresh expects 'Artist - Title', got {name!r}")
            return 2
        artist, title = name.split(" - ", 1)
        resolver.forget(songlib.song_key(artist, title))
    if args.refresh_all:
        resolver.cache.clear()

    songs: list[dict] = []
    failures: list[str] = []
    estimates: list[str] = []
    new_lookups = 0
    limited = 0
    interrupted = False
    total = len(entries)

    for index, entry in enumerate(entries, start=1):
        label = f"{entry.artist} - {entry.title}"
        cached = resolver.cache.get(entry.key)
        needs_network = not (cached and cached.get("detailed")
                             and (not entry.yt or cached.get("yt") == entry.yt))
        if args.upgrade and not entry.yt and resolver.needs_upgrade(entry.key):
            needs_network = True
        if needs_network and not args.offline and args.limit is not None and new_lookups >= args.limit:
            rec, status = cached, "not looked up yet (--limit reached)"
            limited += 1
        else:
            try:
                rec, status = resolver.lookup(entry.artist, entry.title, video_id=entry.yt,
                                              upgrade=args.upgrade)
            except KeyboardInterrupt:
                interrupted = True
                print("\nStopped. Writing what we have so far (the cache is saved).")
                break
            if status == "new" or status.startswith("kept"):
                new_lookups += 1
        song = build_song(entry, rec)
        songs.append(song)

        if status == "new":
            hook_text = f"hook {format_time(song['hook'])} ({song['hookSource']})"
            kind = "studio track" if songlib.is_track(rec) else "video"
            print(f"[{index}/{total}] {label}: {song['yt']} {kind}, {hook_text}")
        elif status not in ("cache", "offline") and not status.startswith("not looked up"):
            print(f"[{index}/{total}] {label}: {status}")
        if not song["yt"]:
            reason = {"cache": "no video", "offline": "not looked up yet"}.get(status, status)
            failures.append(f"{label}: {reason}")
        elif song["hookSource"] == "estimate":
            estimates.append(f"{label}: hook guessed at {format_time(song['hook'])}")

    playable = sum(1 for s in songs if s["yt"])
    payload = {
        "version": 1,
        "generated": dt.datetime.now().isoformat(timespec="seconds"),
        "count": len(songs),
        "playable": playable,
        "songs": songs,
    }
    Path(args.out).write_text(dump_songs_json(payload), encoding="utf-8")
    write_report(Path(args.report), problems, failures, estimates)

    tracks = sum(1 for e in entries[:len(songs)] if songlib.is_track(resolver.cache.get(e.key)))
    print()
    print(f"Wrote {args.out}: {len(songs)} songs, {playable} playable, {tracks} studio tracks.")
    if not args.upgrade and playable - tracks > 0 and not args.offline:
        print(f"{playable - tracks} songs use a music video. "
              "Run with --upgrade to look for studio tracks instead.")
    if args.offline and playable < len(songs):
        print(f"{len(songs) - playable} songs have no YouTube video yet. "
              "Run without --offline to look them up.")
    if limited:
        print(f"--limit reached: {limited} songs are left for the next run.")
    not_found = len(failures) - limited
    if not_found > 0 and not args.offline:
        print(f"{not_found} songs could not be found. See {args.report}.")
    if estimates:
        print(f"{len(estimates)} hooks are estimates. Fix them in editor.html if they sound wrong.")
    if problems:
        print(f"{len(problems)} problems in songs.txt. See {args.report}.")
    return 130 if interrupted else 0


def dump_songs_json(payload: dict) -> str:
    """JSON with one song per line, so git diffs stay readable."""
    head = {k: v for k, v in payload.items() if k != "songs"}
    lines = [json.dumps(song, ensure_ascii=False) for song in payload["songs"]]
    body = ",\n  ".join(lines)
    head_text = json.dumps(head, ensure_ascii=False)[:-1]
    return f'{head_text}, "songs": [\n  {body}\n]}}\n'


def write_report(path: Path, problems: list[str], failures: list[str], estimates: list[str]) -> None:
    lines = [f"Build report {dt.datetime.now():%Y-%m-%d %H:%M}", ""]
    sections = (
        ("Problems in songs.txt", problems),
        ("Songs without a YouTube video (add '| yt=VIDEO_ID' to the line to fix)", failures),
        ("Hooks that are estimates (fix in editor.html, then add '| hook=m:ss')", estimates),
    )
    for heading, items in sections:
        lines.append(f"{heading}: {len(items)}")
        lines.extend(f"  {item}" for item in items)
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--offline", action="store_true",
                        help="do not use the internet; only the cache and overrides")
    parser.add_argument("--refresh", action="append", metavar="'ARTIST - TITLE'",
                        help="look this song up again (can be repeated)")
    parser.add_argument("--refresh-all", action="store_true", help="look every song up again")
    parser.add_argument("--upgrade", action="store_true",
                        help="look again for songs that use a music video instead of a studio "
                             "track; keeps the old video if nothing better is found")
    parser.add_argument("--limit", type=int, default=None,
                        help="look up at most this many new songs in this run")
    parser.add_argument("--delay", type=float, default=1.5,
                        help="seconds to wait between YouTube requests (default 1.5)")
    parser.add_argument("--songs", default=str(songlib.SONGS_TXT), help=argparse.SUPPRESS)
    parser.add_argument("--out", default=str(songlib.SONGS_JSON), help=argparse.SUPPRESS)
    parser.add_argument("--cache", default=str(songlib.CACHE_JSON), help=argparse.SUPPRESS)
    parser.add_argument("--report", default=str(songlib.REPORT_TXT), help=argparse.SUPPRESS)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    return build(parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
