import type { Layout } from '../layouts';
import { TILE } from '../constants';
import { ItemId } from './Inventory';
import { trackEvent } from './analytics';

/*
  One Web Audio graph, outside Phaser. The whole game (and Phaser's sound manager) is torn
  down and rebuilt when the viewport crosses the portrait/landscape threshold, so audio that
  lives inside Phaser dies with it. This singleton survives that rebuild: one AudioContext,
  one master gain, one mute.
*/

// ---------------------------------------------------------------------------
// Tuning constants. The ear decisions below (levels, radius) are deliberately
// shipped as named constants rather than argued into exact values — they are
// meant to be re-tuned by ear, not re-derived.
// ---------------------------------------------------------------------------

const MASTER_DEFAULT = 0.9; // master gain at full volume
const MASTER_FADE_TC = 0.45; // ~1.5s auto-start fade-in on the first gesture
const BED_BASE = 0.4; // ambient bed level when no song is audible (ducked by song)
const SFX_GAIN = 0.8; // one-shot level relative to music

const PROXIMITY_TC = 0.12; // how fast a song tracks Greg's distance (s)
const CROSSFADE_TC = 0.8; // how long a track swap crossfades (s)
const CROSSFADE_MS = CROSSFADE_TC * 1000;
const RELEASE_AFTER_MS = 3000; // how long a fading track is kept before release
const HYSTERESIS = 20; // px of slack before the "nearest chest" flips
const GAIN_EXPONENT = 1.5; // gain curve ≈ (1 − d/R)^1.5

const ONE_SHOT_MIN_MS = 4000;
const ONE_SHOT_MAX_MS = 12000;

const SONG_HEARD_MS = 10000; // fire song_heard_<chest> after 10s of audible playback

const MUTE_KEY = 'ymi-audio-v1';

const COMPLETION = 'completion';
type SongKey = ItemId | typeof COMPLETION;

interface OneShotEntry {
  name: string;
}

interface AudioManifest {
  ambient: { oneShots: OneShotEntry[] };
}

const SFX_NAMES = ['chest_open', 'prize_collect', 'landing'] as const;

// Fallback one-shot list if the manifest can't be fetched. The manifest is authoritative
// (the count is a property of the source recordings), but losing it must not silence the bed.
const FALLBACK_ONE_SHOTS = [
  'drip-1',
  'drip-2',
  'drip-3',
  'drip-4',
  'drip-5',
  'drip-6',
  'chain-1',
  'chain-2',
  'creak',
];

function isWebKit(): boolean {
  // Every browser on iOS/iPadOS is WebKit underneath, whatever its UA brands itself as —
  // Chrome (CriOS), Firefox (FxiOS), Edge (EdgiOS), and the in-app browsers (Instagram is the
  // main traffic source). They, and desktop Safari, all report Apple as the vendor.
  if (navigator.vendor === 'Apple Computer, Inc.') return true;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // iPadOS asks for desktop sites and identifies as a Mac; touch gives it away.
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
  return /WebKit/.test(ua) && !/(Chrome|Chromium|Edg|OPR|Opera|Firefox)/.test(ua);
}

/*
  WebKit plays Opus-in-WebM through an <audio> element but routes literally zero signal into a
  MediaElementAudioSourceNode — the song plays at full volume ignoring proximity. So serve AAC
  to WebKit, and the smaller Opus to everyone else. Fall back to AAC if Opus is unsupported.
*/
function pickExt(): 'm4a' | 'webm' {
  if (isWebKit()) return 'm4a';
  const probe = document.createElement('audio');
  return probe.canPlayType('audio/webm; codecs=opus') ? 'webm' : 'm4a';
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bedGain: GainNode | null = null;
  private bedSource: AudioBufferSourceNode | null = null;

  private buffers = new Map<string, AudioBuffer>();
  private oneShotNames: string[] = [];

  private songs = new Map<SongKey, HTMLAudioElement>();
  private songSources = new Map<SongKey, MediaElementAudioSourceNode>();
  private songGains = new Map<SongKey, GainNode>();

  private manifest: AudioManifest | null = null;
  private unlocked = false;
  private muted = false;

  private masterTarget = 0;
  private masterTc = MASTER_FADE_TC;

  private radius = 210;
  private chestCenters = new Map<ItemId, { x: number; y: number }>();

  private activeChest: ItemId | null = null;
  private fading: SongKey | null = null;
  private fadeTimer: number | null = null;
  private swapUntil = 0;

  private rewardActive = false;
  private completionActive = false;

  private oneShotTimer: number | null = null;
  private lastUpdateTime = 0;
  private heardMs = new Map<string, number>();
  private heardFired = new Set<string>();

  /**
   * Called once at startup: wires the mute button, the first-gesture unlock and the
   * visibility handler. Safe to call after the AudioContext machinery exists or before.
   */
  init() {
    this.muted = this.loadMuted();
    this.updateMuteButton();

    const button = document.getElementById('mute-button');
    button?.addEventListener('click', () => this.toggleMute());

    // Unlock is retried on every gesture rather than once: Chrome can reject the first
    // resume() when it doesn't count that event as a user activation, so the listeners stay
    // alive until the context is genuinely running. unlock() is idempotent.
    const gesture = () => void this.unlock();
    window.addEventListener('pointerdown', gesture);
    window.addEventListener('mousedown', gesture);
    window.addEventListener('touchstart', gesture);
    window.addEventListener('keydown', gesture);
    window.addEventListener('click', gesture);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.stopOneShotScheduler();
        this.ctx?.suspend().catch(() => {});
      } else {
        void this.resumeContext().then((running) => {
          if (running) this.scheduleOneShots();
        });
      }
    });
  }

  /** The scene is a dumb position feed: hand it the current layout, then call update(). */
  setLayout(layout: Layout) {
    this.radius = layout.audioRadius;
    this.chestCenters = new Map(
      layout.ledges.map((l) => [l.key, { x: l.chestX + TILE / 2, y: l.chestY + TILE / 2 }])
    );

    // On a layout swap (rotate) Greg respawns outside every field, so the generic rules fade
    // the current song out and bring the bed back up — no special-casing here.
    if (this.activeChest) {
      this.fadeOut(this.activeChest);
      this.activeChest = null;
    }
  }

  update(x: number, y: number) {
    if (!this.ctx || this.ctx.state !== 'running') {
      this.lastUpdateTime = 0;
      return;
    }
    const now = performance.now();
    const dt = this.lastUpdateTime ? (now - this.lastUpdateTime) / 1000 : 0;
    this.lastUpdateTime = now;

    // The master is synced every frame rather than set once, because the single fade-in in
    // unlock() can fire while WebKit's clock is still frozen and be silently dropped. This
    // way the mix comes up the instant the context is genuinely running, no matter how late.
    this.setGain(this.master!, this.masterTarget, this.masterTc);

    if (this.completionActive) return;

    if (this.rewardActive) {
      if (this.activeChest) this.setGain(this.songGains.get(this.activeChest)!, 1, CROSSFADE_TC);
      this.setGain(this.bedGain!, 0, 0.15);
      return;
    }

    const desired = this.pickChest(x, y);
    if (desired !== this.activeChest) {
      if (this.activeChest) this.fadeOut(this.activeChest);
      this.activeChest = desired;
      if (desired) {
        this.startSong(desired);
        this.swapUntil = now + CROSSFADE_MS;
      }
    }

    const level = this.activeChest ? this.gainCurve(this.distTo(this.activeChest, x, y)) : 0;
    const tc = now < this.swapUntil ? CROSSFADE_TC : PROXIMITY_TC;

    if (this.activeChest) this.setGain(this.songGains.get(this.activeChest)!, level, tc);
    this.setGain(this.bedGain!, BED_BASE * (1 - level), tc);

    if (this.activeChest && level > 0.05) this.accumulateHeard(this.activeChest, dt);
  }

  /** Reward beat, part one: bed ducks, chest creaks, the song seeks to its hook and swells. */
  beginReward(id: ItemId) {
    if (!this.ctx) return;
    void this.resumeContext().then((running) => {
      if (!running) return;
      this.rewardActive = true;

      if (this.activeChest !== id) {
        if (this.activeChest) this.fadeOut(this.activeChest);
        this.activeChest = id;
        this.startSong(id);
      } else {
        const el = this.songs.get(id);
        if (el) {
          el.currentTime = 0; // the shipped file already begins at the hook
          this.playElement(el, id);
        }
      }

      this.setGain(this.songGains.get(id)!, 1, CROSSFADE_TC);
      this.setGain(this.bedGain!, 0, 0.1);
      this.playSfx('chest_open');
    });
  }

  /** Reward beat, part two: the prize lands and proximity takes back over. */
  completeReward() {
    this.playSfx('prize_collect');
    this.rewardActive = false;
  }

  landing() {
    this.playSfx('landing');
  }

  /** Lazy-load the completion track once the fourth item is collected. */
  preloadCompletion() {
    if (!this.ctx) return;
    this.ensureSong(COMPLETION);
  }

  /**
   * The sixth track takes over at full volume, bed silent, proximity suspended. It plays to
   * its end even after "Back to Game" closes the overlay; only then does proximity resume.
   */
  playCompletion() {
    if (!this.ctx) return;
    this.completionActive = true;
    this.rewardActive = false;

    if (this.activeChest) {
      this.fadeOut(this.activeChest);
      this.activeChest = null;
    }

    this.ensureSong(COMPLETION);
    const el = this.songs.get(COMPLETION)!;
    el.loop = false;
    el.currentTime = 0;
    el.onended = () => {
      this.completionActive = false;
      this.releaseSong(COMPLETION);
      this.lastUpdateTime = 0;
    };

    void this.resumeContext().then((running) => {
      if (!running) return;
      this.setGain(this.bedGain!, 0, PROXIMITY_TC);
      this.playElement(el, COMPLETION);
      this.setGain(this.songGains.get(COMPLETION)!, 1, CROSSFADE_TC);
    });
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    try {
      localStorage.setItem(MUTE_KEY, JSON.stringify(this.muted));
    } catch {
      // private browsing — the choice just won't persist
    }
    this.updateMuteButton();

    this.masterTarget = this.muted ? 0 : MASTER_DEFAULT;
    this.masterTc = this.muted ? 0.1 : 0.3;
    if (this.muted) {
      trackEvent('audio_muted');
    } else if (this.ctx) {
      void this.resumeContext();
    }
    return this.muted;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async unlock() {
    if (!this.ctx) {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 0;
      this.master.connect(ctx.destination);

      this.bedGain = ctx.createGain();
      this.bedGain.gain.value = 0;
      this.bedGain.connect(this.master);
    }

    if (this.ctx.state !== 'running') {
      await this.resumeContext();
    }
    // Chrome can reject the resume without a recognised gesture; bail and let the next
    // gesture retry rather than loading the bed against a still-frozen clock.
    if (this.ctx.state !== 'running') return;

    if (this.unlocked) return;
    this.unlocked = true;

    await this.loadBuffers();
    this.startBed();
    this.setGain(this.bedGain!, BED_BASE, 0.2);
    this.scheduleOneShots();

    this.masterTarget = this.muted ? 0 : MASTER_DEFAULT;
    this.masterTc = this.muted ? 0.1 : MASTER_FADE_TC;
    console.info('[audio] unlocked', {
      state: this.ctx.state,
      muted: this.muted,
      buffers: this.buffers.size,
    });
  }

  /**
   * The platform constraint that cost an hour: resume() is async and WebKit reports
   * `suspended` for a beat after the gesture. Until the clock is genuinely running, any ramp
   * scheduled against ctx.currentTime lands in the past. Await resume *and* poll for `running`.
   */
  private async resumeContext(): Promise<boolean> {
    const ctx = this.ctx;
    if (!ctx) return false;
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {
        return false;
      }
    }
    const deadline = performance.now() + 3000;
    while (ctx.state !== 'running') {
      if (performance.now() > deadline) {
        console.warn('[audio] context did not reach "running" in time', ctx.state);
        return false;
      }
      await sleep(50);
    }
    return true;
  }

  private async loadBuffers() {
    const primary = pickExt();
    const exts = primary === 'm4a' ? ['m4a', 'webm'] : ['webm', 'm4a'];

    try {
      const manifest = (await fetch('/assets/audio/manifest.json').then((r) =>
        r.json()
      )) as AudioManifest;
      this.manifest = manifest;
      this.oneShotNames = manifest.ambient.oneShots.map((o) => o.name);
    } catch (err) {
      console.error('[audio] manifest load failed, using fallback one-shots', err);
      this.oneShotNames = FALLBACK_ONE_SHOTS;
    }

    const targets = [
      { name: 'bed', dir: 'ambient' },
      ...this.oneShotNames.map((name) => ({ name, dir: 'ambient' })),
      ...SFX_NAMES.map((name) => ({ name, dir: 'sfx' })),
    ];
    await Promise.all(targets.map(({ name, dir }) => this.loadBuffer(name, dir, exts)));
  }

  /**
   * decodeAudioData support for a given container is not guaranteed on WebKit — the Opus bug
   * is about media elements, but decoding is its own gamble. Try the preferred format, then
   * fall back to the other, so a codec gap can't take the bed down with it.
   */
  private async loadBuffer(name: string, dir: string, exts: string[]): Promise<void> {
    for (const ext of exts) {
      try {
        const res = await fetch(`/assets/audio/${dir}/${name}.${ext}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = await this.ctx!.decodeAudioData(await res.arrayBuffer());
        this.buffers.set(name, buffer);
        return;
      } catch (err) {
        console.warn(`[audio] failed to load ${dir}/${name}.${ext}`, err);
      }
    }
    console.error(`[audio] could not load ${dir}/${name} in any format`);
  }

  private startBed() {
    const buf = this.buffers.get('bed');
    if (!buf || !this.ctx) return;
    this.bedSource = this.ctx.createBufferSource();
    this.bedSource.buffer = buf;
    this.bedSource.loop = true;
    this.bedSource.connect(this.bedGain!);
    this.bedSource.start();
  }

  private scheduleOneShots() {
    this.stopOneShotScheduler();
    const delay = ONE_SHOT_MIN_MS + Math.random() * (ONE_SHOT_MAX_MS - ONE_SHOT_MIN_MS);
    this.oneShotTimer = window.setTimeout(() => {
      this.playRandomOneShot();
      this.scheduleOneShots();
    }, delay);
  }

  private stopOneShotScheduler() {
    if (this.oneShotTimer !== null) {
      window.clearTimeout(this.oneShotTimer);
      this.oneShotTimer = null;
    }
  }

  private playRandomOneShot() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    if (this.oneShotNames.length === 0) return;
    const name = this.oneShotNames[Math.floor(Math.random() * this.oneShotNames.length)];
    this.playSfx(name);
  }

  private playSfx(name: string) {
    const buf = this.buffers.get(name);
    if (!buf || !this.ctx || this.ctx.state !== 'running') return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const gain = this.ctx.createGain();
    gain.gain.value = SFX_GAIN;
    src.connect(gain).connect(this.master!);
    src.start();
  }

  private playElement(el: HTMLAudioElement, label: string) {
    el.play().catch((err) => {
      console.warn(`[audio] play() rejected for ${label}`, err);
    });
  }

  private ensureSong(key: SongKey) {
    if (this.songs.has(key) || !this.ctx) return;
    const el = new Audio();
    el.preload = 'auto';
    el.src = `/assets/audio/tracks/${key}.${pickExt()}`;
    el.loop = true;

    // Media elements are created only after the AudioContext exists, and their src is set
    // directly rather than via <source> children — both part of avoiding the WebKit bug.
    const source = this.ctx.createMediaElementSource(el);
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain).connect(this.master!);

    this.songs.set(key, el);
    this.songSources.set(key, source);
    this.songGains.set(key, gain);
  }

  private startSong(key: SongKey) {
    if (this.fading === key) {
      if (this.fadeTimer !== null) window.clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
      this.fading = null;
    }
    this.ensureSong(key);
    const el = this.songs.get(key)!;
    el.currentTime = 0; // re-entering a field restarts the track at its hook, every time
    this.playElement(el, key);
  }

  private fadeOut(key: SongKey) {
    if (this.fading && this.fading !== key) this.releaseSong(this.fading);
    this.fading = key;
    const gain = this.songGains.get(key);
    if (gain) this.setGain(gain, 0, CROSSFADE_TC);

    if (this.fadeTimer !== null) window.clearTimeout(this.fadeTimer);
    this.fadeTimer = window.setTimeout(() => {
      if (this.fading === key) {
        this.fading = null;
        this.releaseSong(key);
      }
    }, RELEASE_AFTER_MS);
  }

  private releaseSong(key: SongKey) {
    const el = this.songs.get(key);
    if (!el) return;
    el.pause();
    el.removeAttribute('src');
    el.load();
    this.songSources.get(key)?.disconnect();
    this.songGains.get(key)?.disconnect();
    this.songs.delete(key);
    this.songSources.delete(key);
    this.songGains.delete(key);
  }

  private pickChest(x: number, y: number): ItemId | null {
    let nearest: ItemId | null = null;
    let nearestDist = Infinity;
    for (const [key, c] of this.chestCenters) {
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < this.radius && d < nearestDist) {
        nearest = key;
        nearestDist = d;
      }
    }

    const cur = this.activeChest;
    if (cur && this.chestCenters.has(cur)) {
      const curDist = this.distTo(cur, x, y);
      const stillInField = curDist <= this.radius + HYSTERESIS;
      const candidateClearlyCloser = nearest !== null && nearestDist < curDist - HYSTERESIS;
      if (stillInField && !candidateClearlyCloser) return cur;
    }
    return nearest;
  }

  private distTo(key: ItemId, x: number, y: number): number {
    const c = this.chestCenters.get(key)!;
    return Math.hypot(c.x - x, c.y - y);
  }

  private gainCurve(d: number): number {
    return Math.pow(Math.max(0, 1 - d / this.radius), GAIN_EXPONENT);
  }

  private accumulateHeard(key: ItemId, dt: number) {
    if (this.heardFired.has(key)) return;
    const total = (this.heardMs.get(key) ?? 0) + dt * 1000;
    this.heardMs.set(key, total);
    if (total >= SONG_HEARD_MS) {
      this.heardFired.add(key);
      trackEvent(`song_heard_${key}`);
    }
  }

  /** All gain changes go through setTargetAtTime — never gain.value per frame. */
  private setGain(gain: GainNode, value: number, timeConstant: number) {
    if (!this.ctx || this.ctx.state !== 'running' || !gain) return;
    gain.gain.setTargetAtTime(value, this.ctx.currentTime + 0.05, timeConstant);
  }

  private loadMuted(): boolean {
    try {
      const raw = localStorage.getItem(MUTE_KEY);
      return raw ? JSON.parse(raw) === true : false;
    } catch {
      return false;
    }
  }

  private updateMuteButton() {
    const button = document.getElementById('mute-button');
    if (!button) return;
    button.classList.toggle('muted', this.muted);
    button.setAttribute('aria-pressed', String(this.muted));
    button.setAttribute('aria-label', this.muted ? 'Unmute audio' : 'Mute audio');
    button.title = this.muted ? 'Unmute' : 'Mute';
  }

  /** Dev-only snapshot of internal state, for headless/inspector diagnosis of silent failures. */
  debug() {
    return {
      unlocked: this.unlocked,
      muted: this.muted,
      ctxState: this.ctx?.state ?? null,
      masterGain: this.master?.gain.value ?? null,
      bedGain: this.bedGain?.gain.value ?? null,
      manifestLoaded: this.manifest !== null,
      oneShotNames: this.oneShotNames,
      buffersLoaded: [...this.buffers.keys()],
      activeChest: this.activeChest,
      songsLoaded: [...this.songs.keys()],
    };
  }
}

export const audio = new AudioEngine();
