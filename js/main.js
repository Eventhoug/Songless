import {
  CLIP_STEPS, MAX_ATTEMPTS, GENRE_FILTERS, Round, ShuffleBag, applyResult, emptyStats,
  filterByGenre, formatClip, searchSongs, statsKey,
} from './game.js';
import {
  getBrokenVideos, getCustomSongs, loadSongList, markBroken, mergeSongs, playableSongs,
  songsUrlFromParams,
} from './songs.js';
import { MockClipPlayer, YouTubeClipPlayer } from './player.js';
import { load, save } from './storage.js';

const params = new URLSearchParams(window.location.search);
const MOCK = params.has('mock');
const SONGS_URL = songsUrlFromParams(params);
const TIMELINE_SECONDS = CLIP_STEPS[CLIP_STEPS.length - 1];

const $ = (id) => document.getElementById(id);
const els = {
  loading: $('loading'),
  empty: $('empty'),
  emptyTitle: $('empty-title'),
  emptyBody: $('empty-body'),
  game: $('game'),
  modeButtons: $('mode-buttons'),
  genreButtons: $('genre-buttons'),
  statScore: $('stat-score'),
  statStreak: $('stat-streak'),
  statBest: $('stat-best'),
  cover: $('cover'),
  coverTitle: $('cover-title'),
  coverSub: $('cover-sub'),
  eq: $('eq'),
  attempts: $('attempts'),
  timeline: $('timeline'),
  unlocked: $('unlocked'),
  progress: $('progress'),
  clipLabel: $('clip-label'),
  playBtn: $('play-btn'),
  guessArea: $('guess-area'),
  input: $('guess-input'),
  suggestions: $('suggestions'),
  skipBtn: $('skip-btn'),
  submitBtn: $('submit-btn'),
  giveUpBtn: $('giveup-btn'),
  reveal: $('reveal'),
  revealResult: $('reveal-result'),
  revealTitle: $('reveal-title'),
  revealArtist: $('reveal-artist'),
  revealPoints: $('reveal-points'),
  nextBtn: $('next-btn'),
  songCount: $('song-count'),
  volume: $('volume'),
  resetStats: $('reset-stats'),
  toast: $('toast'),
};

const settings = {
  mode: 'start',
  genre: 'all',
  volume: 80,
  ...load('settings.v1', {}),
};
let allStats = load('stats.v1', {});
if (!allStats || typeof allStats !== 'object') allStats = {};

const state = {
  catalog: [], // every playable song (used for guessing suggestions)
  pool: [], // songs in the current genre filter
  bag: null,
  round: null,
  roundNo: 0,
  player: null,
  loadPromise: Promise.resolve(),
  playing: false,
  playToken: 0,
  suggestions: [],
  highlighted: -1,
  selected: null,
};

// ---------------------------------------------------------------- helpers

function currentKey() {
  return statsKey(settings.mode, settings.genre);
}

function currentStats() {
  return { ...emptyStats(), ...(allStats[currentKey()] || {}) };
}

function saveSettings() {
  save('settings.v1', settings);
}

let toastTimer = null;
function toast(message, ms = 2600) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function genreLabel(id) {
  return (GENRE_FILTERS.find((g) => g.id === id) || GENRE_FILTERS[0]).label;
}

function modeLabel(mode) {
  return mode === 'hook' ? 'Main hook' : 'Start of song';
}

// ---------------------------------------------------------------- rendering

function renderControls() {
  for (const btn of els.modeButtons.querySelectorAll('button')) {
    const active = btn.dataset.mode === settings.mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
  for (const btn of els.genreButtons.querySelectorAll('button')) {
    const active = btn.dataset.genre === settings.genre;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
}

function renderStats() {
  const stats = currentStats();
  els.statScore.textContent = String(stats.score);
  els.statStreak.textContent = String(stats.streak);
  els.statBest.textContent = String(stats.best);
}

function renderAttempts() {
  const round = state.round;
  els.attempts.replaceChildren();
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    const attempt = round ? round.attempts[i] : null;
    const li = el('li', 'attempt');
    if (attempt) {
      li.classList.add(attempt.type);
      const labels = { wrong: 'Wrong', artist: 'Right artist', skip: 'Skipped', correct: 'Correct' };
      const text = attempt.guess ? `${attempt.guess.artist} - ${attempt.guess.title}` : 'Skipped';
      li.append(el('span', 'attempt-text', text), el('span', 'attempt-tag', labels[attempt.type]));
    } else {
      if (round && !round.finished && i === round.attempts.length) li.classList.add('current');
      li.append(el('span', 'attempt-text', ''), el('span', 'attempt-tag', formatClip(CLIP_STEPS[i])));
    }
    els.attempts.append(li);
  }
}

function renderTimeline() {
  const round = state.round;
  const unlockedSeconds = round ? (round.finished ? TIMELINE_SECONDS : round.clipLength) : CLIP_STEPS[0];
  els.unlocked.style.width = `${(unlockedSeconds / TIMELINE_SECONDS) * 100}%`;
  if (!els.timeline.querySelector('.marker')) {
    for (const step of CLIP_STEPS.slice(0, -1)) {
      const marker = el('span', 'marker');
      marker.style.left = `${(step / TIMELINE_SECONDS) * 100}%`;
      els.timeline.append(marker);
    }
  }
  els.clipLabel.textContent = round && round.finished ? 'Full song' : `${formatClip(unlockedSeconds)} unlocked`;
}

function setProgress(seconds) {
  els.progress.style.width = `${Math.min(seconds / TIMELINE_SECONDS, 1) * 100}%`;
}

function renderButtons() {
  const round = state.round;
  const next = round ? round.nextClipLength : null;
  els.skipBtn.textContent = next ? `Skip (+${formatClip(next - round.clipLength)})` : 'Skip (last try)';
  els.playBtn.classList.toggle('is-playing', state.playing);
  els.playBtn.setAttribute('aria-label', state.playing ? 'Stop' : `Play ${formatClip(round ? round.clipLength : CLIP_STEPS[0])}`);
  els.eq.classList.toggle('active', state.playing);
}

function renderRound() {
  renderAttempts();
  renderTimeline();
  renderButtons();
}

function showPanel(panel) {
  els.loading.hidden = panel !== 'loading';
  els.empty.hidden = panel !== 'empty';
  els.game.hidden = panel !== 'game';
}

function showEmpty(title, paragraphs) {
  els.emptyTitle.textContent = title;
  els.emptyBody.replaceChildren();
  for (const item of paragraphs) {
    if (Array.isArray(item)) {
      const pre = el('pre');
      pre.append(el('code', '', item.join('\n')));
      els.emptyBody.append(pre);
    } else {
      els.emptyBody.append(el('p', '', item));
    }
  }
  showPanel('empty');
}

// ---------------------------------------------------------------- suggestions

function updateSuggestions() {
  state.selected = null;
  state.suggestions = searchSongs(state.catalog, els.input.value, 8);
  state.highlighted = state.suggestions.length ? 0 : -1;
  renderSuggestions();
}

function renderSuggestions() {
  const list = els.suggestions;
  list.replaceChildren();
  const open = state.suggestions.length > 0 && document.activeElement === els.input;
  list.hidden = !open;
  els.input.setAttribute('aria-expanded', String(open));
  state.suggestions.forEach((song, index) => {
    const li = el('li', index === state.highlighted ? 'highlighted' : '');
    li.id = `suggestion-${index}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(index === state.highlighted));
    li.append(el('span', 's-title', song.title), el('span', 's-artist', song.artist));
    li.addEventListener('mousedown', (event) => {
      event.preventDefault();
      chooseSuggestion(index);
    });
    list.append(li);
  });
  if (state.highlighted >= 0) els.input.setAttribute('aria-activedescendant', `suggestion-${state.highlighted}`);
  else els.input.removeAttribute('aria-activedescendant');
}

function chooseSuggestion(index) {
  const song = state.suggestions[index];
  if (!song) return;
  state.selected = song;
  els.input.value = `${song.artist} - ${song.title}`;
  state.suggestions = [];
  renderSuggestions();
}

function closeSuggestions() {
  state.suggestions = [];
  renderSuggestions();
}

// ---------------------------------------------------------------- game flow

function rebuildPool() {
  state.pool = filterByGenre(state.catalog, settings.genre);
  state.bag = new ShuffleBag(state.pool);
  const label = genreLabel(settings.genre);
  els.songCount.textContent = settings.genre === 'all'
    ? `${state.pool.length} songs`
    : `${state.pool.length} ${label.toLowerCase()} songs`;
}

function recordAbandonedRound() {
  const round = state.round;
  if (round && !round.finished && round.attempts.length > 0) {
    round.giveUp();
    allStats[currentKey()] = applyResult(currentStats(), round);
    save('stats.v1', allStats);
  }
}

function stopPlayback() {
  state.playToken += 1;
  state.playing = false;
  state.player.stop();
  renderButtons();
}

function nextRound() {
  stopPlayback();
  closeSuggestions();
  if (!state.pool.length) {
    state.round = null;
    showEmpty(`No ${genreLabel(settings.genre).toLowerCase()} songs yet`, [
      'Pick another genre, or add songs with this genre to data/songs.txt and run tools/build_songs.py.',
    ]);
    return;
  }
  showPanel('game');
  const song = state.bag.next();
  state.round = new Round(song, settings.mode);
  state.roundNo += 1;

  els.cover.classList.remove('hidden');
  els.coverTitle.textContent = `Song ${state.roundNo}`;
  els.coverSub.textContent = `${modeLabel(settings.mode)} · ${genreLabel(settings.genre)}`;
  els.reveal.hidden = true;
  els.guessArea.hidden = false;
  els.playBtn.hidden = false;
  els.input.value = '';
  state.selected = null;
  setProgress(0);
  renderRound();
  renderStats();

  state.loadPromise = state.player.load(song.yt, state.round.startTime);
  if (window.matchMedia('(pointer: fine)').matches) els.input.focus({ preventScroll: true });
}

async function togglePlay() {
  const round = state.round;
  if (!round || round.finished) return;
  if (state.playing) {
    stopPlayback();
    return;
  }
  const token = ++state.playToken;
  state.playing = true;
  renderButtons();
  await state.loadPromise;
  if (token !== state.playToken || state.round !== round || round.finished) {
    if (token === state.playToken) {
      state.playing = false;
      renderButtons();
    }
    return;
  }
  const result = await state.player.playClip(round.startTime, round.clipLength, setProgress);
  if (token !== state.playToken || state.round !== round) return;
  state.playing = false;
  renderButtons();
  if (result === 'timeout') toast('The video did not start. Check your connection and press play again.');
  setTimeout(() => { if (!state.playing && state.round === round) setProgress(0); }, 600);
}

function submitGuess() {
  const round = state.round;
  if (!round || round.finished) return;
  let song = state.selected;
  if (!song && state.suggestions.length) {
    song = state.suggestions[Math.max(state.highlighted, 0)];
  }
  if (!song) {
    toast(els.input.value.trim() ? 'Pick a song from the list.' : 'Type a title or artist, then pick a song from the list.');
    return;
  }
  stopPlayback();
  const result = round.guess(song);
  els.input.value = '';
  state.selected = null;
  closeSuggestions();
  if (result === 'artist' && !round.finished) toast('Right artist, wrong song!');
  afterAttempt();
}

function skip() {
  const round = state.round;
  if (!round || round.finished) return;
  stopPlayback();
  round.skip();
  afterAttempt();
}

function giveUp() {
  const round = state.round;
  if (!round || round.finished) return;
  stopPlayback();
  round.giveUp();
  afterAttempt();
}

function afterAttempt() {
  if (state.round.finished) finishRound();
  else renderRound();
}

function finishRound() {
  const round = state.round;
  state.playing = false;
  allStats[currentKey()] = applyResult(currentStats(), round);
  save('stats.v1', allStats);
  renderStats();
  renderRound();

  const used = round.attempts.length;
  if (round.won) {
    els.revealResult.textContent = used === 1 ? 'First try!' : `Got it in ${used} tries`;
  } else if (round.gaveUp) {
    els.revealResult.textContent = 'You gave up';
  } else {
    els.revealResult.textContent = 'Out of tries';
  }
  els.revealResult.className = `reveal-result ${round.won ? 'won' : 'lost'}`;
  els.revealTitle.textContent = round.song.title;
  els.revealArtist.textContent = round.song.artist;
  const streak = currentStats().streak;
  els.revealPoints.textContent = round.won
    ? `+${round.points} points · streak ${streak}`
    : 'Streak reset';

  els.cover.classList.add('hidden');
  els.guessArea.hidden = true;
  els.playBtn.hidden = true;
  els.reveal.hidden = false;
  setProgress(0);
  state.loadPromise.then(() => {
    if (state.round === round) state.player.playFrom(round.startTime);
  });
  els.nextBtn.focus();
}

function setMode(mode) {
  if (mode === settings.mode) return;
  recordAbandonedRound();
  settings.mode = mode;
  saveSettings();
  renderControls();
  renderStats();
  nextRound();
}

function setGenre(genre) {
  if (genre === settings.genre) return;
  recordAbandonedRound();
  settings.genre = genre;
  saveSettings();
  renderControls();
  rebuildPool();
  renderStats();
  nextRound();
}

function handlePlayerError(code, videoId) {
  if (!videoId) return;
  console.warn(`Songless: YouTube error ${code} for video ${videoId}. Skipping it on this device.`);
  markBroken(videoId);
  const broken = (s) => s.yt === videoId;
  const brokenSong = state.catalog.find(broken);
  state.catalog = state.catalog.filter((s) => !broken(s));
  state.pool = state.pool.filter((s) => !broken(s));
  if (brokenSong && state.bag) state.bag.remove(brokenSong);
  if (state.round && state.round.song.yt === videoId && !state.round.finished) {
    toast('That video cannot be played here, so it was skipped.');
    state.roundNo -= 1;
    nextRound();
  }
}

// ---------------------------------------------------------------- events

function bindEvents() {
  els.modeButtons.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-mode]');
    if (btn) setMode(btn.dataset.mode);
  });
  els.genreButtons.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-genre]');
    if (btn) setGenre(btn.dataset.genre);
  });
  els.playBtn.addEventListener('click', togglePlay);
  els.submitBtn.addEventListener('click', submitGuess);
  els.skipBtn.addEventListener('click', skip);
  els.giveUpBtn.addEventListener('click', giveUp);
  els.nextBtn.addEventListener('click', nextRound);

  els.input.addEventListener('input', updateSuggestions);
  els.input.addEventListener('focus', renderSuggestions);
  els.input.addEventListener('blur', () => setTimeout(renderSuggestions, 0));
  els.input.addEventListener('keydown', (event) => {
    const count = state.suggestions.length;
    if (event.key === 'ArrowDown' && count) {
      event.preventDefault();
      state.highlighted = (state.highlighted + 1) % count;
      renderSuggestions();
    } else if (event.key === 'ArrowUp' && count) {
      event.preventDefault();
      state.highlighted = (state.highlighted - 1 + count) % count;
      renderSuggestions();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      submitGuess();
    } else if (event.key === 'Escape') {
      closeSuggestions();
    }
  });

  document.addEventListener('keydown', (event) => {
    const typing = event.target instanceof HTMLInputElement && event.target.type === 'text';
    if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === ' ' && state.round && !state.round.finished && !els.game.hidden) {
      if (event.target instanceof HTMLButtonElement) return; // let buttons handle Space
      event.preventDefault();
      togglePlay();
    } else if (event.key === 'Enter' && !els.reveal.hidden && event.target === document.body) {
      event.preventDefault();
      nextRound();
    }
  });

  els.volume.value = String(settings.volume);
  els.volume.addEventListener('input', () => {
    settings.volume = Number(els.volume.value);
    state.player?.setVolume(settings.volume);
    saveSettings();
  });

  els.resetStats.addEventListener('click', () => {
    if (!window.confirm('Reset score, streaks and best streaks for every mode and genre?')) return;
    allStats = {};
    save('stats.v1', allStats);
    renderStats();
    toast('Stats reset.');
  });
}

function buildGenreButtons() {
  for (const genre of GENRE_FILTERS) {
    const btn = el('button', 'chip', genre.label);
    btn.type = 'button';
    btn.dataset.genre = genre.id;
    els.genreButtons.append(btn);
  }
}

// ---------------------------------------------------------------- start

async function start() {
  if (!['start', 'hook'].includes(settings.mode)) settings.mode = 'start';
  if (!GENRE_FILTERS.some((g) => g.id === settings.genre)) settings.genre = 'all';
  buildGenreButtons();
  renderControls();
  renderStats();
  bindEvents();

  if (window.location.protocol === 'file:') {
    showEmpty('Open the game through a web server', [
      'Browsers do not let the game load its song list from a file. In the Songless folder run:',
      ['python -m http.server 8000'],
      'and open http://localhost:8000 . Or use the website link (Vercel).',
    ]);
    return;
  }

  let songs;
  try {
    songs = mergeSongs(await loadSongList(SONGS_URL), getCustomSongs());
  } catch (error) {
    showEmpty('Could not load the song list', [String(error.message || error)]);
    return;
  }
  const broken = getBrokenVideos();
  state.catalog = playableSongs(songs, broken);
  if (!state.catalog.length) {
    showEmpty('No playable songs yet', [
      `The song list has ${songs.length} songs, but none of them has a YouTube video yet.`,
      'On your computer, in the Songless folder, run:',
      ['pip install -r tools/requirements.txt', 'python tools/build_songs.py'],
      'Then commit and push data/songs.json and data/yt_cache.json. The website updates by itself after a push (on your own computer, just reload). See README.md for details. You can also add a single song in the editor (link at the bottom).',
    ]);
    return;
  }

  const PlayerClass = MOCK ? MockClipPlayer : YouTubeClipPlayer;
  const failIds = (params.get('mockFail') || '').split(',').filter(Boolean);
  state.player = new PlayerClass($('player'), { onError: handlePlayerError, failIds });
  try {
    await state.player.init();
  } catch (error) {
    showEmpty('Could not start the YouTube player', [String(error.message || error)]);
    return;
  }
  state.player.setVolume(settings.volume);
  rebuildPool();
  nextRound();
}

start();
