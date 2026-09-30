# Songless Infinite

A guess-the-song game for the class, inspired by Songless (lessgames.com/songless), with an endless mode.

- **Two modes.** *Start of song* plays from the beginning; *Main hook* plays from the chorus or riff.
- **Six tries.** You hear 0.5 s. Every wrong guess or skip unlocks a longer clip from the same spot: 0.5, 1, 2, 4, 8, then 16 s.
- **Genre filters.** All, Rock, Pop and Hip-hop.
- **Endless.** Songs never repeat until every song in the filter has been played.
- **Scoring.** 6 points for a first-try guess, 5 for the second try and so on. Score, streak and best streak are saved in your browser, separately for each mode and genre.
- **Right-artist hint.** A wrong guess by the right artist is shown in yellow.
- **Songs.** About 400 songs to start with: Radiohead, Dire Straits and blink-182 plus many other rock, pop and hip-hop artists and some Danish classics. Import your Spotify liked songs, or add songs one by one.

The game is plain HTML, CSS and JavaScript, with no build step. Music plays through a hidden YouTube player, which is the free option that can start anywhere in a song. The song tools are written in Python.

## 1. First-time setup (once, on your own computer)

The song list (`data/songs.txt`) only contains artist, title and genre. A script looks up a YouTube video for each song and finds the hook. It must run on a normal computer with internet access.

You need Python 3.10 or newer.

```bash
pip install -r tools/requirements.txt
python tools/build_songs.py
```

This writes `data/songs.json`, which is the file the game reads.

- **First run.** With about 400 songs the first run takes a while, roughly 30 to 60 minutes, because it pauses between requests so YouTube doesn't block it.
- **Stopping and resuming.** You can stop with Ctrl+C at any time. Everything found so far is cached in `data/yt_cache.json`, so running the command again continues where it stopped.
- **The report.** At the end you get `data/build_report.txt`, which lists songs it could not find and hooks it had to guess.

Then commit and push `data/songs.json` and `data/yt_cache.json`.

## 2. Import your Spotify liked songs

1. Go to https://exportify.net, log in with Spotify and export **Liked Songs** as CSV. Tick "Include artists data" if it is offered, so the CSV contains genres.
2. Save the file in `data/spotify/`, for example `data/spotify/Liked_Songs.csv`. CSV files in that folder are not committed.
3. Run:

   ```bash
   python tools/import_spotify.py data/spotify/Liked_Songs.csv
   ```

### Which songs are kept

- **Top 60%.** The script ranks all your liked songs by popularity and keeps the top 60%. Change this with `--keep 0.5`, `--keep 0.7` and so on.
- **No very niche songs.** It drops songs with fewer than 1,000,000 YouTube views. Change this with `--min-views 500000`.
- **How popularity is measured.** Since February/March 2026 Spotify no longer gives popularity numbers to apps like Exportify (ramsayleung, 2026; Headphonesty, 2026), so the script uses YouTube view counts. If your CSV still has numbers in the Popularity column, those are used instead.
- **Genres.** They come from the CSV. Otherwise the script uses `data/artist_genres.txt` or artists already in `songs.txt`. Anything else becomes `other`, which only shows under *All*. The script lists those songs so you can change them to rock, pop or hiphop in `songs.txt`.
- **After the import.** The new songs are added at the bottom of `data/songs.txt` and `songs.json` is rebuilt. Songs that were left out are listed in `data/spotify/skipped.txt`.

Try `--dry-run` first to see what would happen without changing anything.

## 3. Play

The game has to be opened through a web server, not by double-clicking `index.html`:

```bash
python -m http.server 8000
```

Then open http://localhost:8000.

### Controls

1. Press the big play button, or Space.
2. Type part of a title or artist and pick the song from the list with the mouse, or with the arrow keys and Enter.
3. **Skip** unlocks the next, longer clip.
4. After the answer is shown, press **Next song**, or Enter.

## 4. Share it with your classmates (GitHub Pages)

1. Merge this branch into `main` and push.
2. On GitHub go to **Settings, Pages**. Under "Build and deployment" choose **Deploy from a branch**, then branch `main` and folder `/ (root)`, and save.
3. After a minute the game is live at `https://<your-username>.github.io/<repo-name>/`. Send that link to the class.

GitHub Pages is free for public repositories. A private repository needs a paid GitHub plan for Pages.

## 5. Add songs

### Many songs: edit `data/songs.txt`

One song per line:

```
Artist - Title | genre
Radiohead - Creep | rock
Post Malone - Circles | pop,hiphop
```

Optional extras, added after the genre:

| Extra | Meaning |
| --- | --- |
| `hook=1:05` | where *Main hook* mode starts (otherwise found automatically) |
| `start=0:02` | where *Start of song* mode starts (default 0:00; use it to skip silence) |
| `yt=VIDEO_ID` | use exactly this YouTube video (the id or a full link) |

Then run `python tools/build_songs.py` and commit `data/songs.txt`, `data/songs.json` and `data/yt_cache.json`.

### One song: use the editor (no Python needed)

Open **Add or fix a song** (`editor.html`) at the bottom of the game.

1. Paste a YouTube link and fill in artist, title and genre.
2. Play the video and press **Use current time** when the hook starts. Check it with the 0.5 s to 16 s test buttons.
3. **Save in this browser** puts the song in the game on your device straight away.
4. **Copy** gives you the line for `songs.txt`, with `yt=` and `hook=` filled in. Add it to the file and commit, so everyone gets the song.

## How the hook is found

- **Most replayed.** `build_songs.py` reads YouTube's "Most replayed" graph for the video. yt-dlp calls it `heatmap` (yt-dlp, 2026). It ignores the first and last 8% of the song, takes the most replayed moment and starts 1.5 s before it.
- **Estimated hooks.** Some videos have no graph. For those the hook is estimated at 30% of the song, and the build report and the editor mark it "(hook guessed)".
- **Fixing a hook.** Open the editor, pick the song, set the right time, and add `hook=m:ss` to its line in `songs.txt`.

## Troubleshooting

- **"That video cannot be played here."** Some videos don't allow embedding on other sites. The game skips them automatically. Fix it for good by adding `| yt=OTHER_VIDEO_ID` with another upload of the song.
- **The YouTube player does not load.** Ad blockers and some school networks block YouTube embeds. Try another network, or allow YouTube for the page.
- **iPhone plays nothing on the first press.** Press play once more. iOS sometimes needs an extra tap before sound starts.
- **`build_songs.py` says "Sign in to confirm you're not a bot".** YouTube is rate-limiting you. Wait a while, then continue with a slower pace, e.g. `python tools/build_songs.py --delay 4 --limit 100`.
- **Wrong video, e.g. a live version.** Add `| yt=THE_RIGHT_ID` to the line and rebuild.
- **Looking a song up again.** Use `python tools/build_songs.py --refresh "Artist - Title"`.

## Project layout

```
index.html, js/main.js      the game
editor.html, js/editor.js   add a song / fix a hook
js/game.js                  game rules (clip steps, scoring, shuffle, search)
js/player.js                YouTube clip player (+ a test player)
js/songs.js, js/storage.js  loading songs, saving in the browser
css/style.css               styling
data/songs.txt              the song list you edit
data/songs.json             generated; what the game plays
data/yt_cache.json          generated; YouTube lookups
data/artist_genres.txt      artist -> genre for the Spotify import
tools/                      build_songs.py, import_spotify.py, songlib.py
tests/                      Python and JavaScript tests
```

## Tests

```bash
python -m unittest discover tests     # song tools
node --test                           # game logic (Node 20+)
```

Add `?mock=1` to the game URL to play with a test beep instead of YouTube.

## References

- Headphonesty (2026) *Spotify Just Killed Thousands of Third-Party Music Apps*. Available at: https://www.headphonesty.com/2026/02/spotify-crackdown-thousands-third-party-music-apps/ (Accessed: 30 September 2026).
- ramsayleung (2026) *Spotify Web API changes (February 2026), Issue #550, rspotify*. GitHub. Available at: https://github.com/ramsayleung/rspotify/issues/550 (Accessed: 30 September 2026).
- watsonbox (n.d.) *exportify: Export/Backup Spotify playlists using the Web API*. GitHub. Available at: https://github.com/watsonbox/exportify (Accessed: 30 September 2026).
- yt-dlp (2026) *yt-dlp, version 2026.8.19* [computer program]. Available at: https://github.com/yt-dlp/yt-dlp (Accessed: 30 September 2026).
