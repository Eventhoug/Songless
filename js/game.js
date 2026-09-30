// Pure game logic: no DOM, no YouTube. Tested with `node --test tests/`.

// How long each clip is (seconds). A wrong guess or a skip unlocks the next one.
export const CLIP_STEPS = [0.5, 1, 2, 4, 8, 16];
export const MAX_ATTEMPTS = CLIP_STEPS.length;

export const MODES = ['start', 'hook'];
export const GENRE_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'rock', label: 'Rock' },
  { id: 'pop', label: 'Pop' },
  { id: 'hiphop', label: 'Hip Hop' },
];

export function normalize(text) {
  let s = String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/&/g, ' and ')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (s.startsWith('the ')) s = s.slice(4);
  return s;
}

export function songKey(song) {
  return `${normalize(song.artist)} - ${normalize(song.title)}`;
}

export function slugify(artist, title) {
  return `${normalize(artist)} ${normalize(title)}`.trim().replace(/\s+/g, '-') || 'song';
}

export function sameSong(a, b) {
  return !!a && !!b && (a.id === b.id || songKey(a) === songKey(b));
}

export function sameArtist(a, b) {
  return !!a && !!b && normalize(a.artist) === normalize(b.artist);
}

export function formatSeconds(seconds) {
  const s = Math.round(Math.max(0, Number(seconds) || 0) * 10) / 10;
  const minutes = Math.floor(s / 60);
  const rest = s - minutes * 60;
  const whole = Math.abs(rest - Math.round(rest)) < 1e-6;
  const secText = whole ? String(Math.round(rest)).padStart(2, '0') : rest.toFixed(1).padStart(4, '0');
  return `${minutes}:${secText}`;
}

export function parseSeconds(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  const parts = value.split(':');
  if (parts.length > 3 || parts.some((p) => p.trim() === '' || Number.isNaN(Number(p)))) return null;
  const total = parts.reduce((acc, p) => acc * 60 + Number(p), 0);
  return total >= 0 ? total : null;
}

export function formatClip(seconds) {
  return `${seconds < 1 ? seconds.toFixed(1) : String(seconds)} s`;
}

// Draws songs in random order without repeats until every song has been played.
export class ShuffleBag {
  constructor(items, random = Math.random) {
    this.items = [...items];
    this.random = random;
    this.bag = [];
    this.last = null;
  }

  get size() {
    return this.items.length;
  }

  refill() {
    this.bag = [...this.items];
    for (let i = this.bag.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.random() * (i + 1));
      [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
    }
    // Never play the same song twice in a row across a reshuffle.
    if (this.bag.length > 1 && this.bag[this.bag.length - 1] === this.last) {
      [this.bag[0], this.bag[this.bag.length - 1]] = [this.bag[this.bag.length - 1], this.bag[0]];
    }
  }

  next() {
    if (!this.items.length) return null;
    if (!this.bag.length) this.refill();
    this.last = this.bag.pop();
    return this.last;
  }

  remove(item) {
    this.items = this.items.filter((x) => x !== item);
    this.bag = this.bag.filter((x) => x !== item);
  }
}

// One song to guess.
export class Round {
  constructor(song, mode = 'start') {
    this.song = song;
    this.mode = mode;
    this.attempts = []; // { type: 'wrong' | 'artist' | 'skip' | 'correct', guess? }
    this.finished = false;
    this.won = false;
    this.gaveUp = false;
  }

  get startTime() {
    const t = this.mode === 'hook' ? this.song.hook : this.song.start;
    return Math.max(0, Number(t) || 0);
  }

  // Index of the clip that is unlocked now (0 = the 0.5 s clip).
  get step() {
    return Math.min(this.attempts.length, MAX_ATTEMPTS - 1);
  }

  get clipLength() {
    return CLIP_STEPS[this.step];
  }

  get nextClipLength() {
    return this.attempts.length + 1 < MAX_ATTEMPTS ? CLIP_STEPS[this.attempts.length + 1] : null;
  }

  get attemptsLeft() {
    return MAX_ATTEMPTS - this.attempts.length;
  }

  get points() {
    return this.won ? MAX_ATTEMPTS + 1 - this.attempts.length : 0;
  }

  guess(song) {
    if (this.finished) return null;
    let type = 'wrong';
    if (sameSong(song, this.song)) type = 'correct';
    else if (sameArtist(song, this.song)) type = 'artist';
    this.attempts.push({ type, guess: song });
    if (type === 'correct') {
      this.finished = true;
      this.won = true;
    } else if (this.attempts.length >= MAX_ATTEMPTS) {
      this.finished = true;
    }
    return type;
  }

  skip() {
    if (this.finished) return null;
    this.attempts.push({ type: 'skip' });
    if (this.attempts.length >= MAX_ATTEMPTS) this.finished = true;
    return 'skip';
  }

  giveUp() {
    if (this.finished) return;
    this.finished = true;
    this.gaveUp = true;
  }
}

// Stats are kept per mode + genre filter, e.g. "hook:rock".
export function statsKey(mode, genre) {
  return `${mode}:${genre}`;
}

export function emptyStats() {
  return { score: 0, streak: 0, best: 0, played: 0, won: 0 };
}

export function applyResult(stats, round) {
  const next = { ...emptyStats(), ...stats };
  next.played += 1;
  if (round.won) {
    next.won += 1;
    next.score += round.points;
    next.streak += 1;
    next.best = Math.max(next.best, next.streak);
  } else {
    next.streak = 0;
  }
  return next;
}

export function filterByGenre(songs, genre) {
  if (!genre || genre === 'all') return songs;
  return songs.filter((s) => Array.isArray(s.genres) && s.genres.includes(genre));
}

// Autocomplete: every word typed must appear in "artist title".
export function searchSongs(songs, query, limit = 8) {
  const q = normalize(query);
  if (!q) return [];
  const words = q.split(' ');
  const seen = new Set();
  const results = [];
  for (const song of songs) {
    const key = songKey(song);
    if (seen.has(key)) continue;
    const title = normalize(song.title);
    const artist = normalize(song.artist);
    const haystack = ` ${artist} ${title} `;
    if (!words.every((w) => haystack.includes(` ${w}`))) continue;
    seen.add(key);
    let rank = 3;
    if (title === q) rank = 0;
    else if (title.startsWith(q)) rank = 1;
    else if (artist.startsWith(q)) rank = 2;
    results.push({ song, rank });
  }
  results.sort((a, b) => a.rank - b.rank
    || a.song.title.localeCompare(b.song.title)
    || a.song.artist.localeCompare(b.song.artist));
  return results.slice(0, limit).map((r) => r.song);
}
