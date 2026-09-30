# Spotify export goes here

Put your Exportify CSV of "Liked Songs" in this folder, for example `Liked_Songs.csv`, and run:

```bash
python tools/import_spotify.py data/spotify/Liked_Songs.csv
```

CSV and TXT files in this folder are not committed to git (see `.gitignore`).
`skipped.txt` lists the liked songs that were left out and why.
