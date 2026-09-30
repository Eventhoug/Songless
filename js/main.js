import {
  CLIP_STEPS, MAX_ATTEMPTS, GENRE_FILTERS, Round, ShuffleBag, applyResult, emptyStats,
  filterByGenre, searchSongs, statsKey,
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
  menuBtn: $('menu-btn'),
  menu: $('menu'),
  statScore: $('stat-score'),
  statStreak: $('stat-streak'),
  statBest: $('stat-best'),
  statBest2: $('stat-best-2'),
  statPlayed: $('stat-played'),
  statWinrate: $('stat-winrate'),
  statsScope: $('stats-scope'),
  attempts: $('attempts'),
  timeline: $('timeline'),
  marker: $('marker'),
  clipLabel: $('clip-label'),
  playBtn: $('play-btn'),
  guessArea: $('guess-area'),
  input: $('guess-input'),
  suggestions: $('suggestions'),
  skipBtn: $('skip-btn'),
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
  segments: [], // timeline segments: { start, length, fill }
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

function svgIcon(kind) {
  const paths = {
    wrong: '<path d="M6 6l12 12M18 6 6 18"/>',
    artist: '<path d="M6 6l12 12M18 6 6 18"/>',
    skip: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
    correct: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  };
  const span = el('span', 'attempt-icon');
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[kind]}</svg>`;
  return span;
}

function genreLabel(id) {
  return (GENRE_FILTERS.find((g) => g.id === id) || GENRE_FILTERS[0]).label;
}

function modeLabel(mode) {
  return mode === 'hook' ? 'Main hook' : 'Start of song';
}

function secondsText(seconds) {
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
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
  els.statBest2.textContent = String(stats.best);
  els.statPlayed.textContent = String(stats.played);
  els.statWinrate.textContent = stats.played ? `${Math.round((stats.won / stats.played) * 100)}%` : '0%';
  els.statsScope.textContent = `${modeLabel(settings.mode)} · ${genreLabel(settings.genre)}`;
}

function renderAttempts() {
  const round = state.round;
  els.attempts.replaceChildren();
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    const attempt = round ? round.attempts[i] : null;
    const li = el('li', 'attempt');
    if (attempt) {
      li.classList.add(attempt.type);
      const text = attempt.guess ? `${attempt.guess.artist} - ${attempt.guess.title}` : 'Skipped';
      li.append(svgIcon(attempt.type), el('span', 'attempt-text', text));
      if (attempt.type === 'artist') li.append(el('span', 'attempt-tag', 'Right artist'));
    } else if (round && !round.finished && i === round.attempts.length) {
      li.classList.add('current');
    }
    els.attempts.append(li);
  }
}

function buildTimeline() {
  els.timeline.replaceChildren();
  state.segments = [];
  let previous = 0;
  for (const step of CLIP_STEPS) {
    const seg = el('span', 'segment');
    const fill = el('span', 'segment-fill');
    seg.style.flexGrow = String(step - previous);
    seg.append(fill);
    els.timeline.append(seg);
    state.segments.push({ start: previous, length: step - previous, seg, fill });
    previous = step;
  }
}

function renderTimeline() {
  const round = state.round;
  const unlocked = round ? (round.finished ? TIMELINE_SECONDS : round.clipLength) : CLIP_STEPS[0];
  for (const segment of state.segments) {
    segment.seg.classList.toggle('unlocked', segment.start < unlocked);
  }
  const position = (unlocked / TIMELINE_SECONDS) * 100;
  els.marker.style.left = `${position}%`;
  els.clipLabel.style.left = `${position}%`;
  // Slide the label from left-aligned (start of the bar) to right-aligned (end).
  els.clipLabel.style.transform = `translateX(-${position}%)`;
  els.clipLabel.textContent = secondsText(unlocked);
}

function setProgress(seconds) {
  for (const segment of state.segments) {
    const part = Math.min(Math.max((seconds - segment.start) / segment.length, 0), 1);
    segment.fill.style.width = `${part * 100}%`;
  }
}

function renderButtons() {
  const round = state.round;
  const next = round ? round.nextClipLength : null;
  els.skipBtn.setAttribute('aria-label', next ? `Skip (+${next - round.clipLength} s)` : 'Skip');
  els.playBtn.classList.toggle('is-playing', state.playing);
  els.playBtn.setAttribute('aria-label', state.playing ? 'Stop' : `Play ${secondsText(round ? round.clipLength : CLIP_STEPS[0])}`);
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

function setRevealVisible(visible) {
  els.reveal.classList.toggle('offscreen', !visible);
  els.reveal.setAttribute('aria-hidden', String(!visible));
  els.reveal.inert = !visible;
  els.guessArea.hidden = visible;
  els.playBtn.parentElement.hidden = visible;
}

function renderFooter() {
  const count = state.pool.length;
  const genre = settings.genre === 'all' ? '' : ` ${genreLabel(settings.genre).toLowerCase()}`;
  els.songCount.textContent = `${count}${genre} songs`;
}

// ---------------------------------------------------------------- suggestions

function updateSuggestions() {
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
      guess(song);
    });
    list.append(li);
  });
  if (state.highlighted >= 0) els.input.setAttribute('aria-activedescendant', `suggestion-${state.highlighted}`);
  else els.input.removeAttribute('aria-activedescendant');
}

function closeSuggestions() {
  state.suggestions = [];
  renderSuggestions();
}

// ---------------------------------------------------------------- game flow

function rebuildPool() {
  state.pool = filterByGenre(state.catalog, settings.genre);
  state.bag = new ShuffleBag(state.pool);
  renderFooter();
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

  setRevealVisible(false);
  els.input.value = '';
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

// Picking a song from the list is the guess, like in the original Songless.
function guess(song) {
  const round = state.round;
  if (!round || round.finished || !song) return;
  stopPlayback();
  const result = round.guess(song);
  els.input.value = '';
  closeSuggestions();
  if (result === 'artist' && !round.finished) toast('Right artist, wrong song!');
  afterAttempt();
}

function guessHighlighted() {
  if (state.suggestions.length) {
    guess(state.suggestions[Math.max(state.highlighted, 0)]);
  } else {
    toast(els.input.value.trim() ? 'No song matches that. Try another word.' : 'Type a title or artist, then pick a song from the list.');
  }
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

  setRevealVisible(true);
  setProgress(0);
  state.loadPromise.then(() => {
    if (state.round === round) state.player.playFrom(round.startTime);
  });
  els.nextBtn.focus({ preventScroll: true });
  els.reveal.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
  renderFooter();
  if (state.round && state.round.song.yt === videoId && !state.round.finished) {
    toast('That video cannot be played here, so it was skipped.');
    state.roundNo -= 1;
    nextRound();
  }
}

// ---------------------------------------------------------------- menu and dialogs

function setMenu(open) {
  els.menu.hidden = !open;
  els.menuBtn.setAttribute('aria-expanded', String(open));
}

function openDialog(id) {
  const dialog = $(id);
  if (!dialog) return;
  setMenu(false);
  if (id === 'stats-dialog') renderStats();
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
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
  els.skipBtn.addEventListener('click', skip);
  els.giveUpBtn.addEventListener('click', giveUp);
  els.nextBtn.addEventListener('click', nextRound);

  els.menuBtn.addEventListener('click', () => setMenu(els.menu.hidden));
  document.addEventListener('click', (event) => {
    if (!els.menu.hidden && !event.target.closest('#menu, #menu-btn')) setMenu(false);
    const opener = event.target.closest('[data-open]');
    if (opener) openDialog(opener.dataset.open);
  });
  for (const dialog of document.querySelectorAll('dialog')) {
    // Click on the dark backdrop closes the dialog.
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

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
      guessHighlighted();
    } else if (event.key === 'Escape') {
      closeSuggestions();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setMenu(false);
    const typing = event.target instanceof HTMLInputElement && event.target.type === 'text';
    if (typing || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]')) return;
    const revealed = !els.reveal.classList.contains('offscreen');
    if (event.key === ' ' && state.round && !state.round.finished && !els.game.hidden) {
      if (event.target instanceof HTMLButtonElement) return; // let buttons handle Space
      event.preventDefault();
      togglePlay();
    } else if (event.key === 'Enter' && revealed && event.target === document.body) {
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
    const btn = el('button', '', genre.label);
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
  buildTimeline();
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
      'Then commit and push data/songs.json and data/yt_cache.json. The website updates by itself after a push (on your own computer, just reload). See README.md for details. You can also add a single song in the editor (menu at the top left).',
    ]);
    return;
  }

  // The player must be in a rendered (not display:none) part of the page when it starts.
  showPanel('game');
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
