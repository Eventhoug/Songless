// Loading the song list: data/songs.json plus songs saved in this browser
// from the editor (those win when they have the same id).

import { load, save } from './storage.js';
import { formatSeconds, slugify } from './game.js';

const CUSTOM_KEY = 'customSongs.v1';
const BROKEN_KEY = 'brokenVideos.v1';

export async function loadSongList(url = 'data/songs.json') {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  const data = await response.json();
  const songs = Array.isArray(data) ? data : data.songs || [];
  return songs.map(cleanSong).filter(Boolean);
}

export function cleanSong(raw) {
  if (!raw || !raw.title || !raw.artist) return null;
  const genres = Array.isArray(raw.genres) && raw.genres.length ? raw.genres : ['other'];
  return {
    id: raw.id || slugify(raw.artist, raw.title),
    title: String(raw.title),
    artist: String(raw.artist),
    genres,
    yt: raw.yt || null,
    duration: raw.duration || null,
    start: Number(raw.start) || 0,
    hook: raw.hook === null || raw.hook === undefined ? 45 : Number(raw.hook),
    hookSource: raw.hookSource || 'estimate',
    source: raw.source || 'list',
  };
}

export function getCustomSongs() {
  const list = load(CUSTOM_KEY, []);
  return Array.isArray(list) ? list.map(cleanSong).filter(Boolean) : [];
}

export function saveCustomSong(song) {
  const list = getCustomSongs().filter((s) => s.id !== song.id);
  list.push(cleanSong({ ...song, source: 'browser' }));
  return save(CUSTOM_KEY, list);
}

export function deleteCustomSong(id) {
  return save(CUSTOM_KEY, getCustomSongs().filter((s) => s.id !== id));
}

export function mergeSongs(base, custom) {
  const byId = new Map(base.map((s) => [s.id, s]));
  for (const song of custom) byId.set(song.id, song);
  return [...byId.values()];
}

export function getBrokenVideos() {
  const list = load(BROKEN_KEY, []);
  return new Set(Array.isArray(list) ? list : []);
}

export function markBroken(videoId) {
  const set = getBrokenVideos();
  set.add(videoId);
  save(BROKEN_KEY, [...set]);
}

export function clearBroken() {
  save(BROKEN_KEY, []);
}

export function playableSongs(songs, broken = new Set()) {
  return songs.filter((s) => s.yt && !broken.has(s.yt));
}

// The songs.txt line for a song, with the overrides needed to reproduce it.
export function songsTxtLine(song, { includeHook = true, includeStart = true } = {}) {
  const parts = [`${song.artist} - ${song.title}`, song.genres.join(',')];
  if (song.yt) parts.push(`yt=${song.yt}`);
  if (includeHook && song.hook !== null && song.hook !== undefined) parts.push(`hook=${formatSeconds(song.hook)}`);
  if (includeStart && song.start) parts.push(`start=${formatSeconds(song.start)}`);
  return parts.join(' | ');
}
