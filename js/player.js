// Clip players. Both classes have the same interface:
//   init(), load(videoId, start), playClip(start, seconds, onProgress),
//   playFrom(start), stop(), setVolume(0-100), getCurrentTime(), isReady

const STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

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

// Plays exact clips from a hidden (covered) YouTube player.
//
// Clip length is measured with a local timer that only runs while YouTube
// reports PLAYING, so time spent buffering is not counted.
export class YouTubeClipPlayer {
  constructor(element, { controls = false, onError = () => {}, onState = () => {} } = {}) {
    this.element = element;
    this.controls = controls;
    this.onError = onError;
    this.onState = onState;
    this.player = null;
    this.isReady = false;
    this.videoId = null;
    this.clip = null;
    this.preparing = null;
    this.timer = null;
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
    this.isReady = true;
  }

  // Cue a video and buffer it (muted) so the first clip starts quickly.
  load(videoId, start = 0) {
    this.stop();
    this.videoId = videoId;
    this.player.cueVideoById({ videoId, startSeconds: start });
    return new Promise((resolve) => {
      this.preparing = { start, resolve, videoId };
      this.player.mute();
      this.player.playVideo();
      setTimeout(() => {
        if (this.preparing && this.preparing.videoId === videoId) this.finishPrepare();
      }, 6000);
    });
  }

  finishPrepare() {
    const prep = this.preparing;
    if (!prep) return;
    this.preparing = null;
    try {
      this.player.pauseVideo();
      this.player.seekTo(prep.start, true);
      this.player.unMute();
    } catch {
      // player may be gone
    }
    prep.resolve();
  }

  cancelPrepare() {
    const prep = this.preparing;
    if (!prep) return;
    this.preparing = null;
    this.player.unMute();
    prep.resolve();
  }

  playClip(start, seconds, onProgress = () => {}) {
    this.stop();
    this.cancelPrepare();
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
      this.player.unMute();
      this.player.seekTo(start, true);
      this.player.playVideo();
      this.timer = setInterval(() => this.tick(), 15);
    });
  }

  playFrom(start) {
    this.stop();
    this.cancelPrepare();
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
    try {
      this.player.pauseVideo();
      this.player.seekTo(clip.start, true);
    } catch {
      // ignore
    }
    clip.resolve(reason);
  }

  stop() {
    if (this.clip) {
      this.finishClip('stopped');
    } else if (this.player && this.isReady) {
      try {
        this.player.pauseVideo();
      } catch {
        // ignore
      }
    }
  }

  handleState(state) {
    this.state = state;
    const now = performance.now();
    if (this.preparing && state === STATE.PLAYING) {
      this.finishPrepare();
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
    if (this.preparing) {
      const prep = this.preparing;
      this.preparing = null;
      prep.resolve();
    }
    this.finishClip('error');
    this.onError(code, videoId);
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
