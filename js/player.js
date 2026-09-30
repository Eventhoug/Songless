// Clip players. YouTubeClipPlayer and MockClipPlayer have the same interface:
//   init(), load(videoId, start), seekIdle(start), playClip(start, seconds, onProgress),
//   playFrom(start), stop(), setActive(bool), setVolume(0-100), getCurrentTime(), isReady
// PlayerPool keeps several of them so the next songs are already loaded.

const STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
const PREPARE_TIMEOUT_MS = 8000;

let apiPromise = null;

export function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === 'function') previous();
      resolve(window.YT);
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => reject(new Error('Could not load the YouTube player. Check the internet connection or turn off the ad blocker for this page.'));
    document.head.appendChild(script);
    setTimeout(() => reject(new Error('The YouTube player took too long to load.')), 20000);
  });
  apiPromise.catch(() => { apiPromise = null; });
  return apiPromise;
}

// Plays exact clips from a hidden YouTube player.
//
// Clip length is measured with a local timer that only runs while YouTube
// reports PLAYING, so time spent buffering is not counted.
//
// No sound in the background: in the game (controls off) the player stays muted
// unless a clip or the answer is playing on purpose, and if the video starts
// playing by itself (for example a slow load that finishes after the timeout)
// it is paused straight away.
export class YouTubeClipPlayer {
  constructor(element, { controls = false, onError = () => {}, onState = () => {} } = {}) {
    this.element = element;
    this.controls = controls;
    this.silent = !controls; // the editor shows YouTube's own controls, so it needs sound
    this.onError = onError;
    this.onState = onState;
    this.player = null;
    this.isReady = false;
    this.videoId = null;
    this.clip = null;
    this.preparing = null;
    this.timer = null;
    this.wantsSound = false; // true while a clip or the answer plays on purpose
    this.state = STATE.UNSTARTED;
  }

  async init() {
    const YT = await loadYouTubeApi();
    await new Promise((resolve) => {
      this.player = new YT.Player(this.element, {
        width: '100%',
        height: '100%',
        playerVars: {
          controls: this.controls ? 1 : 0,
          disablekb: this.controls ? 0 : 1,
          fs: 0,
          rel: 0,
          iv_load_policy: 3,
          playsinline: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: () => resolve(),
          onStateChange: (event) => this.handleState(event.data),
          onError: (event) => this.handleError(event.data),
        },
      });
    });
    if (this.silent) this.player.mute();
    this.isReady = true;
  }

  // Cue a video and buffer it (muted) so the first clip starts quickly.
  load(videoId, start = 0) {
    this.stop();
    this.resolvePrepare();
    this.videoId = videoId;
    this.player.mute();
    this.player.cueVideoById({ videoId, startSeconds: start });
    return new Promise((resolve) => {
      this.preparing = { start, resolve, videoId };
      this.player.playVideo();
      setTimeout(() => {
        if (this.preparing && this.preparing.videoId === videoId) this.finishPrepare();
      }, PREPARE_TIMEOUT_MS);
    });
  }

  finishPrepare() {
    const prep = this.preparing;
    if (!prep) return;
    this.preparing = null;
    try {
      this.player.pauseVideo();
      this.player.seekTo(prep.start, true);
      if (!this.silent) this.player.unMute();
    } catch {
      // player may be gone
    }
    prep.resolve();
  }

  // End a pending load() promise without touching the sound.
  resolvePrepare() {
    const prep = this.preparing;
    if (!prep) return;
    this.preparing = null;
    prep.resolve();
  }

  // Move a loaded, paused video to another start point (e.g. after switching mode).
  seekIdle(start) {
    if (!this.isReady || this.clip || this.preparing) return;
    try {
      this.player.seekTo(start, true);
    } catch {
      // ignore
    }
  }

  playClip(start, seconds, onProgress = () => {}) {
    this.stop();
    this.resolvePrepare();
    return new Promise((resolve) => {
      this.clip = {
        start,
        limitMs: seconds * 1000,
        elapsed: 0,
        since: null,
        began: performance.now(),
        resolve,
        onProgress,
      };
      this.wantsSound = true;
      this.player.unMute();
      this.player.seekTo(start, true);
      this.player.playVideo();
      this.timer = setInterval(() => this.tick(), 15);
    });
  }

  playFrom(start) {
    this.stop();
    this.resolvePrepare();
    this.wantsSound = true;
    this.player.unMute();
    this.player.seekTo(start, true);
    this.player.playVideo();
  }

  tick() {
    const clip = this.clip;
    if (!clip) return;
    const now = performance.now();
    const played = clip.elapsed + (clip.since === null ? 0 : now - clip.since);
    clip.onProgress(Math.min(played, clip.limitMs) / 1000);
    if (played >= clip.limitMs) {
      this.finishClip('done');
    } else if (played === 0 && now - clip.began > 15000) {
      this.finishClip('timeout');
    }
  }

  finishClip(reason) {
    const clip = this.clip;
    if (!clip) return;
    this.clip = null;
    clearInterval(this.timer);
    this.timer = null;
    this.quiet();
    try {
      this.player.seekTo(clip.start, true);
    } catch {
      // ignore
    }
    clip.resolve(reason);
  }

  // Pause, and mute again in the game.
  quiet() {
    this.wantsSound = false;
    try {
      this.player.pauseVideo();
      if (this.silent) this.player.mute();
    } catch {
      // ignore
    }
  }

  stop() {
    if (this.clip) {
      this.finishClip('stopped');
    } else if (this.player && this.isReady) {
      this.quiet();
    }
  }

  handleState(state) {
    this.state = state;
    const now = performance.now();
    if (this.preparing && state === STATE.PLAYING) {
      this.finishPrepare();
      return;
    }
    if (state === STATE.PLAYING && this.silent && !this.wantsSound) {
      // Started without being asked (e.g. a slow load finished late): stop it.
      this.quiet();
      return;
    }
    const clip = this.clip;
    if (clip) {
      if (state === STATE.PLAYING) {
        if (clip.since === null) clip.since = now;
      } else if (clip.since !== null) {
        clip.elapsed += now - clip.since;
        clip.since = null;
      }
      if (state === STATE.ENDED) this.finishClip('done');
    }
    this.onState(state);
  }

  handleError(code) {
    const videoId = this.videoId;
    this.resolvePrepare();
    this.finishClip('error');
    this.onError(code, videoId);
  }

  setActive() {
    // Showing and hiding is done by PlayerPool.
  }

  setVolume(volume) {
    if (this.player && this.isReady) this.player.setVolume(volume);
  }

  getCurrentTime() {
    return this.player && this.isReady ? this.player.getCurrentTime() : 0;
  }

  getDuration() {
    return this.player && this.isReady ? this.player.getDuration() : 0;
  }
}

// Several players stacked in one frame: the current song plus the next ones,
// which load (muted) in the background so pressing play starts right away.
export class PlayerPool {
  constructor(frame, { size = 3, createPlayer, onError = () => {} }) {
    this.frame = frame;
    this.size = size;
    this.createPlayer = createPlayer;
    this.onError = onError;
    this.entries = [];
    this.active = null;
    this.keepIds = new Set();
    this.clock = 0;
    this.isReady = false;
  }

  async init() {
    for (let i = 0; i < this.size; i += 1) {
      const slot = document.createElement('div');
      slot.className = 'pool-slot';
      const target = document.createElement('div');
      slot.append(target);
      this.frame.append(slot);
      const entry = { slot, player: null, videoId: null, start: 0, ready: Promise.resolve(), used: 0 };
      entry.player = this.createPlayer(target, (code, videoId) => this.handleError(entry, code, videoId));
      this.entries.push(entry);
    }
    await Promise.all(this.entries.map((entry) => entry.player.init()));
    this.isReady = true;
  }

  find(videoId) {
    return this.entries.find((entry) => entry.videoId === videoId) || null;
  }

  // Songs that must stay loaded (the current one and the next ones).
  keep(videoIds) {
    this.keepIds = new Set(videoIds.filter(Boolean));
  }

  freeEntry() {
    const free = this.entries.filter((e) => e !== this.active && !this.keepIds.has(e.videoId));
    if (!free.length) return null;
    return free.find((e) => !e.videoId) || free.reduce((a, b) => (a.used <= b.used ? a : b));
  }

  // Load a song in the background (muted). Returns a promise for when it is ready.
  prepare(videoId, start = 0) {
    if (!videoId) return Promise.resolve();
    const found = this.find(videoId);
    if (found) {
      if (found.start !== start) {
        found.start = start;
        found.ready = found.ready.then(() => found.player.seekIdle(start));
      }
      return found.ready;
    }
    const entry = this.freeEntry();
    if (!entry) return Promise.resolve();
    entry.videoId = videoId;
    entry.start = start;
    entry.used = ++this.clock;
    entry.ready = entry.player.load(videoId, start);
    return entry.ready;
  }

  // Make this song the one that plays; uses the preloaded player when there is one.
  activate(videoId, start = 0) {
    if (this.active) this.active.player.stop();
    if (!this.find(videoId)) {
      this.keepIds.add(videoId);
      const previous = this.active;
      this.active = null; // the old song's player may be reused
      this.prepare(videoId, start);
      if (!this.find(videoId)) this.active = previous;
    } else {
      this.prepare(videoId, start); // moves it to the right start if needed
    }
    const entry = this.find(videoId);
    if (!entry) return Promise.resolve();
    this.active = entry;
    entry.used = ++this.clock;
    for (const e of this.entries) {
      e.slot.classList.toggle('active', e === entry);
      e.player.setActive(e === entry);
    }
    return entry.ready;
  }

  handleError(entry, code, videoId) {
    if (entry.videoId === videoId && entry !== this.active) entry.videoId = null;
    this.onError(code, videoId);
  }

  get player() {
    return this.active ? this.active.player : null;
  }

  playClip(start, seconds, onProgress) {
    return this.player ? this.player.playClip(start, seconds, onProgress) : Promise.resolve('stopped');
  }

  playFrom(start) {
    if (this.player) this.player.playFrom(start);
  }

  stop() {
    if (this.player) this.player.stop();
  }

  setVolume(volume) {
    for (const entry of this.entries) entry.player.setVolume(volume);
  }

  getCurrentTime() {
    return this.player ? this.player.getCurrentTime() : 0;
  }
}

// Stand-in used by the tests (?mock=1): plays a short beep instead of YouTube
// and records every call in window.__songlessMock.
export class MockClipPlayer {
  constructor(element, { onError = () => {}, failIds = [] } = {}) {
    this.element = element;
    this.onError = onError;
    this.failIds = new Set(failIds);
    this.isReady = false;
    this.videoId = null;
    this.position = 0;
    this.clip = null;
    this.timer = null;
    this.volume = 80;
    window.__songlessMock = window.__songlessMock || [];
    this.log = window.__songlessMock;
  }

  async init() {
    this.element.classList.add('mock-player');
    this.element.textContent = 'Test player';
    this.isReady = true;
  }

  async load(videoId, start = 0) {
    this.stop();
    this.videoId = videoId;
    this.position = start;
    this.element.textContent = `Test player: ${videoId}`;
    this.log.push({ type: 'load', videoId, start });
    if (this.failIds.has(videoId)) {
      setTimeout(() => this.onError(150, videoId), 50);
    }
  }

  seekIdle(start) {
    this.position = start;
    this.log.push({ type: 'seek', videoId: this.videoId, start });
  }

  setActive(active) {
    if (active) this.log.push({ type: 'activate', videoId: this.videoId });
  }

  playClip(start, seconds, onProgress = () => {}) {
    this.stop();
    this.log.push({ type: 'clip', videoId: this.videoId, start, seconds });
    this.beep(seconds);
    return new Promise((resolve) => {
      const began = performance.now();
      this.clip = { resolve, start };
      this.timer = setInterval(() => {
        const played = (performance.now() - began) / 1000;
        this.position = start + Math.min(played, seconds);
        onProgress(Math.min(played, seconds));
        if (played >= seconds) this.finish('done');
      }, 15);
    });
  }

  playFrom(start) {
    this.stop();
    this.position = start;
    this.log.push({ type: 'playFrom', videoId: this.videoId, start });
  }

  finish(reason) {
    clearInterval(this.timer);
    this.timer = null;
    const clip = this.clip;
    this.clip = null;
    if (clip) clip.resolve(reason);
  }

  stop() {
    if (this.clip) this.finish('stopped');
  }

  beep(seconds) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = this.ctx || new Ctx();
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      gain.gain.value = 0.05 * (this.volume / 100);
      osc.frequency.value = 440;
      osc.connect(gain).connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + Math.min(seconds, 16));
    } catch {
      // no audio in this environment
    }
  }

  setVolume(volume) {
    this.volume = volume;
  }

  getCurrentTime() {
    return this.position;
  }

  getDuration() {
    return 240;
  }
}
