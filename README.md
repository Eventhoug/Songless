# Songless Infinite

A guess-the-song game for the class, inspired by Songless (lessgames.com/songless), with an endless mode.

- **Two modes.** *Start of song* plays from the beginning; *Main hook* plays from the chorus or riff.
- **Six tries.** You hear 0.5 s. Every wrong guess or skip unlocks a longer clip from the same spot: 0.5, 1, 2, 4, 8, then 16 s.
- **Genre filters.** All, Rock, Pop and Hip-hop.
- **Endless.** Songs never repeat until every song in the filter has been played.
- **Scoring.** 6 points for a first-try guess, 5 for the second try and so on. Score, streak and best streak are saved in your browser, separately for each mode and genre.
- **Right-artist hint.** A wrong guess by the right artist is shown in yellow.
- **Songs.** About 800 songs to start with: Radiohead, Dire Straits and blink-182 plus many other rock, pop and hip-hop artists, Danish songs and hits in other languages. Import your Spotify liked songs, or add songs one by one.

The game is plain HTML, CSS and JavaScript, with no build step. Music plays through a hidden YouTube player, which is the free option that can start anywhere in a song. The song tools are written in Python.

## 1. First-time setup (once, on your own computer)

The song list (`data/songs.txt`) only contains artist, title and genre. A script looks up a YouTube video for each song and finds the hook. It must run on a normal computer with internet access.

You need Python 3.10 or newer.

```bash
pip install -r tools/requirements.txt
python tools/build_songs.py
```

This writes `data/songs.json`, which is the file the game reads.

- **Which video is used.** For each song the script first looks for the official studio track in the "Songs" section of YouTube Music. That is the same recording as on Spotify, and it starts at 0:00, so *Start of song* mode starts with the music. It checks that the artist matches and skips live, remix, demo and cover versions. If no studio track can be embedded, it uses a normal YouTube search and picks the best official video or audio upload.
- **Older song lists.** If your `yt_cache.json` was made before this change, most songs use music videos. Run `python tools/build_songs.py --upgrade` once to swap them for studio tracks. Songs where nothing better is found keep their current video.

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

## 3. Put it online with Vercel (the link for your classmates)

Vercel hosts the game as a normal website for free (Hobby plan, for personal non-commercial projects). It works with public and private repositories in your personal GitHub account (Vercel, n.d. a). There is nothing to build: `vercel.json` tells Vercel to serve the files as they are.

1. **Fill the song list first** (section 1 and optionally section 2), then commit and push `data/songs.json` and `data/yt_cache.json`.
2. **Merge the pull request into `main`.** On GitHub, go to **Settings, General, Default branch** and switch it to `main`.
3. **Create the Vercel project:**
   1. Go to https://vercel.com and sign up with **Continue with GitHub**.
   2. Click **Add New, Project**, find `Songless` and click **Import**. If it is not listed, click "Adjust GitHub App Permissions" and give Vercel access to the repository.
   3. Leave the settings as they are. The framework preset is "Other", with no build command. Click **Deploy**.
4. **Share the link.** After about a minute you get a link like `https://songless-xxxx.vercel.app`, which you can send to the class. You can change the name under **Settings, Domains** in the Vercel project.

### After setup
- **Automatic updates.** Every push to `main` updates the website automatically, for example after adding songs and running `build_songs.py`.
- **Preview links.** Every pull request gets its own preview link, so you can try changes before merging.
- **Production branch.** Vercel uses `main` as the live branch when the repository has one (Vercel, n.d. b).

If you'd rather use GitHub Pages: **Settings, Pages**, then "Deploy from a branch", `main`, `/ (root)`. Pages is free for public repositories only.

## 4. Play

### Controls
1. **Choose what to play.** Pick a genre in the tabs under the logo (All, Rock, Pop, Hip Hop), and *Start of song* or *Main hook* in the small toggle below them.
2. **Listen.** Press the big green play button, or Space.
3. **Guess.** Search for a title or artist and pick the song from the list: clicking it, or pressing Enter on the highlighted one, is your guess.
4. **Skip** unlocks the next, longer clip. If a clip is playing, it keeps playing to the new length, and the bar only resets when the clip ends.
5. **Next song.** After the answer is shown, press **Next song**, or Enter.

The icons at the top right open *How to play*, *Stats* and *Settings* (volume, reset stats). The menu at the top left links to the song editor.

### Testing on your own computer
The game has to be opened through a web server, not by double-clicking `index.html`:

```bash
python -m http.server 8000
```

Then open http://localhost:8000.

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
- **Hooks after `--upgrade`.** A studio track often has no graph. If it is the same length (within 3 s) as the video used before, it is the same audio, so the earlier hook is kept.
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
fonts/                      Outfit font (SIL Open Font License)
data/songs.txt              the song list you edit
data/songs.json             generated; what the game plays
data/yt_cache.json          generated; YouTube lookups
data/artist_genres.txt      artist -> genre for the Spotify import
tools/                      build_songs.py, import_spotify.py, songlib.py
vercel.json                 Vercel hosting settings (static site, no build)
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
- Vercel (n.d. a) *Vercel Hobby Plan*. Available at: https://vercel.com/docs/plans/hobby (Accessed: 30 September 2026).
- Vercel (n.d. b) *How to use a non-default branch for production deployments on Vercel*. Available at: https://vercel.com/kb/guide/can-i-use-a-non-default-branch-for-production (Accessed: 30 September 2026).
- watsonbox (n.d.) *exportify: Export/Backup Spotify playlists using the Web API*. GitHub. Available at: https://github.com/watsonbox/exportify (Accessed: 30 September 2026).
- yt-dlp (2026) *yt-dlp, version 2026.8.19* [computer program]. Available at: https://github.com/yt-dlp/yt-dlp (Accessed: 30 September 2026).
