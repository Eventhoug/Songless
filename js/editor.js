import { CLIP_STEPS, formatClip, formatSeconds, parseSeconds, slugify } from './game.js';
import {
  clearBroken, deleteCustomSong, getCustomSongs, loadSongList, mergeSongs, saveCustomSong, songsTxtLine,
  songsUrlFromParams,
} from './songs.js';
import { MockClipPlayer, YouTubeClipPlayer } from './player.js';

const params = new URLSearchParams(window.location.search);
const MOCK = params.has('mock');
const SONGS_URL = songsUrlFromParams(params);

const $ = (id) => document.getElementById(id);
const els = {
  existing: $('existing'),
  yt: $('yt'),
  loadVideo: $('load-video'),
  frame: $('video-frame'),
  artist: $('artist'),
  title: $('title'),
  genres: $('genres'),
  start: $('start'),
  hook: $('hook'),
  setStart: $('set-start'),
  setHook: $('set-hook'),
  testButtons: $('test-buttons'),
  line: $('line'),
  copyLine: $('copy-line'),
  save: $('save'),
  status: $('status'),
  saved: $('saved'),
  allLines: $('all-lines'),
  copyAll: $('copy-all'),
  clearBroken: $('clear-broken'),
  toast: $('toast'),
};

let baseSongs = [];
let player = null;
let loadedVideo = null;

export function extractYouTubeId(value) {
  const text = String(value || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(text)) return text;
  const match = text.match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/|\/v\/)([A-Za-z0-9_-]{11})/);
  return match ? match[1] : null;
}

let toastTimer = null;
function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
}

function selectedGenres() {
  return [...els.genres.querySelectorAll('input:checked')].map((input) => input.value);
}

function setGenres(genres) {
  for (const input of els.genres.querySelectorAll('input')) input.checked = genres.includes(input.value);
}

// Returns { song } or { error }.
function readForm() {
  const yt = extractYouTubeId(els.yt.value);
  const artist = els.artist.value.trim().replace(/\|/g, '/');
  const title = els.title.value.trim().replace(/\|/g, '/');
  const start = parseSeconds(els.start.value);
  const hook = parseSeconds(els.hook.value);
  if (!yt) return { error: 'Paste a YouTube link or video id.' };
  if (!artist || !title) return { error: 'Fill in artist and title.' };
  if (artist.includes(' - ')) return { error: 'The artist name cannot contain " - ".' };
  if (start === null) return { error: 'Start must be a time like 0:00 or 0:02.5' };
  if (hook === null) return { error: 'Hook must be a time like 1:05 or 65' };
  const genres = selectedGenres();
  return {
    song: {
      id: slugify(artist, title),
      artist,
      title,
      genres: genres.length ? genres : ['other'],
      yt,
      start,
      hook,
      hookSource: 'manual',
      source: 'browser',
    },
  };
}

function updateLine() {
  const { song, error } = readForm();
  els.line.value = song ? songsTxtLine(song) : '';
  els.status.textContent = error || '';
}

async function ensurePlayer() {
  if (player) return player;
  els.frame.hidden = false;
  const PlayerClass = MOCK ? MockClipPlayer : YouTubeClipPlayer;
  player = new PlayerClass($('player'), {
    controls: true,
    onError: (code) => toast(`YouTube error ${code}: this video cannot be embedded. Try another upload of the song.`),
  });
  try {
    await player.init();
  } catch (error) {
    player = null;
    toast(String(error.message || error));
    throw error;
  }
  return player;
}

async function loadVideo() {
  const id = extractYouTubeId(els.yt.value);
  if (!id) {
    toast('That does not look like a YouTube link.');
    return;
  }
  const p = await ensurePlayer();
  loadedVideo = id;
  await p.load(id, parseSeconds(els.hook.value) || 0);
  updateLine();
}

async function useCurrentTime(input) {
  if (!player || !loadedVideo) {
    toast('Load the video first.');
    return;
  }
  input.value = formatSeconds(Math.round(player.getCurrentTime() * 10) / 10);
  updateLine();
}

async function testClip(seconds) {
  const id = extractYouTubeId(els.yt.value);
  if (!id) {
    toast('Load a video first.');
    return;
  }
  const from = document.querySelector('input[name="test-from"]:checked').value;
  const at = parseSeconds(from === 'hook' ? els.hook.value : els.start.value);
  if (at === null) {
    toast('Fix the time first.');
    return;
  }
  const p = await ensurePlayer();
  if (loadedVideo !== id) {
    loadedVideo = id;
    await p.load(id, at);
  }
  p.playClip(at, seconds);
}

function fillExisting(songs) {
  const sorted = [...songs].sort((a, b) => {
    const guessA = a.hookSource === 'estimate' ? 0 : 1;
    const guessB = b.hookSource === 'estimate' ? 0 : 1;
    return guessA - guessB || a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title);
  });
  for (const song of sorted) {
    if (!song.yt) continue;
    const option = document.createElement('option');
    option.value = song.id;
    option.textContent = `${song.artist} - ${song.title}${song.hookSource === 'estimate' ? '  (hook guessed)' : ''}`;
    els.existing.append(option);
  }
}

function pickExisting() {
  const all = mergeSongs(baseSongs, getCustomSongs());
  const song = all.find((s) => s.id === els.existing.value);
  if (!song) return;
  els.yt.value = song.yt || '';
  els.artist.value = song.artist;
  els.title.value = song.title;
  setGenres(song.genres);
  els.start.value = formatSeconds(song.start || 0);
  els.hook.value = formatSeconds(song.hook || 0);
  updateLine();
  if (song.yt) loadVideo().catch(() => {});
}

function renderSaved() {
  const custom = getCustomSongs();
  els.saved.replaceChildren();
  if (!custom.length) {
    const li = document.createElement('li');
    li.textContent = 'Nothing saved yet.';
    els.saved.append(li);
  }
  for (const song of custom) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${song.artist} - ${song.title} (hook ${formatSeconds(song.hook)})`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'small-btn';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      deleteCustomSong(song.id);
      renderSaved();
    });
    li.append(label, remove);
    els.saved.append(li);
  }
  els.allLines.value = custom.map((s) => songsTxtLine(s)).join('\n');
}

async function copy(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied.');
  } catch {
    toast('Could not copy. Select the text and copy it by hand.');
  }
}

function bind() {
  for (const seconds of CLIP_STEPS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'small-btn';
    btn.textContent = formatClip(seconds);
    btn.addEventListener('click', () => testClip(seconds));
    els.testButtons.append(btn);
  }
  els.loadVideo.addEventListener('click', () => loadVideo().catch(() => {}));
  els.setStart.addEventListener('click', () => useCurrentTime(els.start));
  els.setHook.addEventListener('click', () => useCurrentTime(els.hook));
  els.existing.addEventListener('change', pickExisting);
  for (const input of [els.yt, els.artist, els.title, els.start, els.hook]) {
    input.addEventListener('input', updateLine);
  }
  els.genres.addEventListener('change', updateLine);
  els.copyLine.addEventListener('click', () => copy(els.line.value));
  els.copyAll.addEventListener('click', () => copy(els.allLines.value));
  els.save.addEventListener('click', () => {
    const { song, error } = readForm();
    if (error) {
      toast(error);
      return;
    }
    if (saveCustomSong(song)) {
      toast('Saved. The song is now in the game on this device.');
      renderSaved();
    } else {
      toast('Could not save: this browser blocks local storage.');
    }
  });
  els.clearBroken.addEventListener('click', () => {
    clearBroken();
    toast('Videos that failed before will be tried again.');
  });
}

async function start() {
  bind();
  renderSaved();
  updateLine();
  els.status.textContent = '';
  try {
    baseSongs = await loadSongList(SONGS_URL);
    fillExisting(mergeSongs(baseSongs, getCustomSongs()));
  } catch {
    // The editor still works for new songs without the song list.
  }
}

start();
