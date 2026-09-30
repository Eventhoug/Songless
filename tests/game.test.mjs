// Tests for the game logic. Run:  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLIP_STEPS, MAX_ATTEMPTS, Round, ShuffleBag, applyResult, emptyStats, filterByGenre,
  formatSeconds, normalize, parseSeconds, sameSong, searchSongs, slugify,
} from '../js/game.js';
import {
  DEFAULT_SONGS_URL, cleanSong, mergeSongs, playableSongs, songsTxtLine, songsUrlFromParams,
} from '../js/songs.js';

const creep = { id: 'radiohead-creep', title: 'Creep', artist: 'Radiohead', genres: ['rock'], yt: 'aaaaaaaaaaa', start: 0, hook: 58.5 };
const karma = { id: 'radiohead-karma-police', title: 'Karma Police', artist: 'Radiohead', genres: ['rock'], yt: 'bbbbbbbbbbb', start: 1, hook: 70 };
const sultans = { id: 'dire-straits-sultans-of-swing', title: 'Sultans of Swing', artist: 'Dire Straits', genres: ['rock'], yt: 'ccccccccccc', start: 0, hook: 90 };
const hotline = { id: 'drake-hotline-bling', title: 'Hotline Bling', artist: 'Drake', genres: ['hiphop'], yt: 'ddddddddddd', start: 0, hook: 40 };
const circles = { id: 'post-malone-circles', title: 'Circles', artist: 'Post Malone', genres: ['pop', 'hiphop'], yt: 'eeeeeeeeeee', start: 0, hook: 50 };
const songs = [creep, karma, sultans, hotline, circles];

test('clip steps are 0.5, 1, 2, 4, 8, 16 seconds', () => {
  assert.deepEqual(CLIP_STEPS, [0.5, 1, 2, 4, 8, 16]);
  assert.equal(MAX_ATTEMPTS, 6);
});

test('wrong guesses and skips unlock longer clips from the same start', () => {
  const round = new Round(creep, 'hook');
  assert.equal(round.startTime, 58.5);
  assert.equal(round.clipLength, 0.5);
  assert.equal(round.guess(sultans), 'wrong');
  assert.equal(round.clipLength, 1);
  assert.equal(round.skip(), 'skip');
  assert.equal(round.clipLength, 2);
  assert.equal(round.guess(karma), 'artist');
  assert.equal(round.clipLength, 4);
  assert.equal(round.startTime, 58.5);
  assert.equal(round.guess(creep), 'correct');
  assert.ok(round.finished && round.won);
  assert.equal(round.points, 3);
});

test('start mode uses the start time', () => {
  assert.equal(new Round(karma, 'start').startTime, 1);
  assert.equal(new Round(karma, 'hook').startTime, 70);
});

test('six misses end the round', () => {
  const round = new Round(creep);
  for (let i = 0; i < 5; i += 1) round.skip();
  assert.equal(round.clipLength, 16);
  assert.equal(round.nextClipLength, null);
  assert.equal(round.finished, false);
  round.guess(hotline);
  assert.ok(round.finished);
  assert.equal(round.won, false);
  assert.equal(round.points, 0);
  assert.equal(round.guess(creep), null);
});

test('first try gives 6 points and streaks add up', () => {
  let stats = emptyStats();
  const r1 = new Round(creep);
  r1.guess(creep);
  stats = applyResult(stats, r1);
  const r2 = new Round(karma);
  r2.skip();
  r2.guess(karma);
  stats = applyResult(stats, r2);
  assert.deepEqual(stats, { score: 11, streak: 2, best: 2, played: 2, won: 2 });
  const r3 = new Round(sultans);
  r3.giveUp();
  stats = applyResult(stats, r3);
  assert.equal(stats.streak, 0);
  assert.equal(stats.best, 2);
  assert.equal(stats.score, 11);
});

test('shuffle bag plays every song before repeating', () => {
  let seed = 1;
  const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const bag = new ShuffleBag(songs, random);
  for (let pass = 0; pass < 5; pass += 1) {
    const seen = new Set();
    let previous = bag.last;
    for (let i = 0; i < songs.length; i += 1) {
      const song = bag.next();
      assert.notEqual(song, previous);
      previous = song;
      seen.add(song.id);
    }
    assert.equal(seen.size, songs.length);
  }
  bag.remove(creep);
  for (let i = 0; i < 20; i += 1) assert.notEqual(bag.next(), creep);
  assert.equal(new ShuffleBag([]).next(), null);
});

test('genre filters', () => {
  assert.equal(filterByGenre(songs, 'all').length, 5);
  assert.deepEqual(filterByGenre(songs, 'rock').map((s) => s.id), [creep.id, karma.id, sultans.id]);
  assert.deepEqual(filterByGenre(songs, 'hiphop').map((s) => s.id), [hotline.id, circles.id]);
  assert.deepEqual(filterByGenre(songs, 'pop').map((s) => s.id), [circles.id]);
});

test('search matches word starts in title and artist', () => {
  assert.deepEqual(searchSongs(songs, 'radio').map((s) => s.title), ['Creep', 'Karma Police']);
  assert.deepEqual(searchSongs(songs, 'police').map((s) => s.title), ['Karma Police']);
  assert.deepEqual(searchSongs(songs, 'dire swing').map((s) => s.title), ['Sultans of Swing']);
  assert.deepEqual(searchSongs(songs, 'creep')[0], creep);
  assert.deepEqual(searchSongs(songs, ''), []);
  assert.deepEqual(searchSongs(songs, 'adiohead'), []);
});

test('normalize and same song', () => {
  assert.equal(normalize('The Killers'), 'killers');
  assert.equal(normalize('Beyoncé'), 'beyonce');
  assert.equal(normalize('MØ'), 'mo');
  assert.equal(normalize("Guns N' Roses"), 'guns n roses');
  assert.ok(sameSong(creep, { ...creep, id: 'other-id', artist: 'radiohead' }));
  assert.equal(slugify('Radiohead', 'Creep'), 'radiohead-creep');
});

test('times', () => {
  assert.equal(formatSeconds(65), '1:05');
  assert.equal(formatSeconds(58.5), '0:58.5');
  assert.equal(formatSeconds(59.96), '1:00');
  assert.equal(parseSeconds('1:05'), 65);
  assert.equal(parseSeconds('65.5'), 65.5);
  assert.equal(parseSeconds('abc'), null);
  assert.equal(parseSeconds(''), null);
});

test('songs.txt line and song list helpers', () => {
  const song = cleanSong({ ...karma, genres: ['rock', 'pop'] });
  assert.equal(songsTxtLine(song), 'Radiohead - Karma Police | rock,pop | yt=bbbbbbbbbbb | hook=1:10 | start=0:01');
  assert.equal(cleanSong({ title: 'x' }), null);
  const merged = mergeSongs(songs, [{ ...creep, hook: 10 }]);
  assert.equal(merged.length, 5);
  assert.equal(merged.find((s) => s.id === creep.id).hook, 10);
  assert.equal(playableSongs([...songs, { ...creep, id: 'x', yt: null }], new Set(['aaaaaaaaaaa'])).length, 4);
});

test('?songs= only accepts a .json file on the same site', () => {
  const url = (value) => songsUrlFromParams(new URLSearchParams(value === null ? '' : `songs=${encodeURIComponent(value)}`));
  assert.equal(url(null), DEFAULT_SONGS_URL);
  assert.equal(url('tests/fixtures/songs.json'), 'tests/fixtures/songs.json');
  for (const bad of ['https://evil.example/x.json', '//evil.example/x.json', '/etc/x.json', '../x.json',
    'data/../../x.json', 'data/songs.txt', 'javascript:alert(1)//.json', '']) {
    assert.equal(url(bad), DEFAULT_SONGS_URL, bad);
  }
});
