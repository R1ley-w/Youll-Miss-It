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
const MASTER_UNMUTE_TC = 0.3; // fade back in after an unmute (s)
const MASTER_MUTE_TC = 0.1; // fade out on mute (s)
const BED_BASE = 0.4; // ambient bed level when no song is audible (ducked by song)
const BED_FADE_IN_TC = 0.2; // bed coming up after unlock (s)
const ONE_SHOT_GAIN = 1; // one-shot level relative to the bed (they duck with it)
const SFX_GAIN = 0.8; // SFX level relative to music

const PROXIMITY_TC = 0.12; // how fast a song tracks Greg's distance (s)
const CROSSFADE_TC = 0.8; // how long a track swap crossfades (s)
const CROSSFADE_MS = CROSSFADE_TC * 1000;
const RELEASE_AFTER_MS = 3000; // how long a fading track is kept before release
const EVICT_TC = 0.05; // fast fade for a third track pushed out by a quick double swap (s)
const EVICT_RELEASE_MS = 300; // ...and how long it gets before release
const REWARD_DUCK_TC = 0.1; // bed cut at the start of the reward beat (s)
const REWARD_HOLD_DUCK_TC = 0.15; // bed held down while the reward beat runs (s)
const HYSTERESIS = 20; // px of slack before the "nearest chest" flips
const GAIN_EXPONENT = 1.5; // gain curve ≈ (1 − d/R)^1.5

const SCHEDULE_LEAD = 0.05; // every ramp starts this far ahead of ctx.currentTime (s)
const RESUME_TIMEOUT_MS = 3000; // how long to poll for `running` after resume()
const RESUME_POLL_MS = 50;

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

type AssetDir = 'ambient' | 'sfx';

const SFX_NAMES = ['chest_open', 'prize_collect', 'landing'] as const;
type SfxName = (typeof SFX_NAMES)[number];

/** A song's media element and the two nodes that route it into the graph — always together. */
interface Track {
  el: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
}

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

  private tracks = new Map<SongKey, Track>();
  // Songs fading out, each with its pending release. Usually one; briefly two during an eviction.
  private releaseTimers = new Map<SongKey, number>();
  // Songs that were playing when the tab hid, to pick back up mid-song on return.
  private pausedForHide = new Set<SongKey>();

  private manifestLoaded = false;
  private unlocked = false;
  private muted = false;

  private masterTarget = 0;
  private masterTimeConstant = MASTER_FADE_TC;

  private radius = 210;
  private chestCenters = new Map<ItemId, { x: number; y: number }>();

  private activeChest: ItemId | null = null;
  private swapUntil = 0;

  private rewardActive = false;
  private rewardBeat = 0;
  private completionActive = false;

  private oneShotTimer: number | null = null;
  private lastUpdateTime = 0;
  private heardMs = new Map<ItemId, number>();
  private heardFired = new Set<ItemId>();

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
    // resume() when it doesn't count that event as a user activation. The listeners stay for
    // the whole session — after unlocking they're a cheap no-op, and they still let a gesture
    // revive a context the OS interrupted (an iOS phone call). unlock() is idempotent.
    const gesture = () => void this.unlock();
    window.addEventListener('pointerdown', gesture);
    window.addEventListener('mousedown', gesture);
    window.addEventListener('touchstart', gesture);
    window.addEventListener('keydown', gesture);
    window.addEventListener('click', gesture);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.onHide();
      else this.onShow();
    });
  }

  /** The scene is a dumb position feed: hand it the current layout, then call update(). */
  setLayout(layout: Layout) {
    this.radius = layout.audioRadius;
    this.chestCenters = new Map(
      layout.ledges.map((l) => [l.key, { x: l.chestX + TILE / 2, y: l.chestY + TILE / 2 }])
    );

    // On a layout swap (rotate) Greg respawns outside every field, so the generic rules fade
    // the current song out and bring the bed back up — no special-casing here. The rebuild
    // also destroys the scene's reward timer, so completeReward() is never coming: end it here.
    this.rewardActive = false;
    this.setActive(null);
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
    this.setGain(this.master!, this.masterTarget, this.masterTimeConstant);

    if (this.completionActive) return;

    if (this.rewardActive) {
      const track = this.activeChest && this.tracks.get(this.activeChest);
      if (track) this.setGain(track.gain, 1, CROSSFADE_TC);
      this.setGain(this.bedGain!, 0, REWARD_HOLD_DUCK_TC);
      return;
    }

    const desired = this.pickChest(x, y);
    if (desired !== this.activeChest) {
      this.setActive(desired);
      if (desired) {
        this.startSong(desired);
        this.swapUntil = now + CROSSFADE_MS;
      }
    }

    const level = this.activeChest ? this.gainCurve(this.distTo(this.activeChest, x, y)) : 0;
    const timeConstant = now < this.swapUntil ? CROSSFADE_TC : PROXIMITY_TC;

    const track = this.activeChest && this.tracks.get(this.activeChest);
    if (track) this.setGain(track.gain, level, timeConstant);
    this.setGain(this.bedGain!, BED_BASE * (1 - level), timeConstant);

    if (this.activeChest && level > 0.05 && !this.muted) this.accumulateHeard(this.activeChest, dt);
  }

  /** Reward beat, part one: bed ducks, chest creaks, the song seeks to its hook and swells. */
  beginReward(id: ItemId) {
    if (!this.ctx) return;
    // Open the beat synchronously. completeReward() closes it on the scene's clock, and a
    // resume that only settles after that (WebKit, straight after the tab comes back) must
    // not re-open it — proximity would stay frozen and the bed ducked for good.
    this.rewardActive = true;
    const beat = ++this.rewardBeat;

    void this.resumeContext().then((running) => {
      if (!running || !this.rewardActive || beat !== this.rewardBeat) return;

      if (this.activeChest !== id) {
        this.setActive(id);
        this.startSong(id);
      } else {
        const track = this.tracks.get(id);
        if (track) {
          track.el.currentTime = 0; // the shipped file already begins at the hook
          void this.playElement(track.el, id);
        }
      }

      this.setGain(this.tracks.get(id)!.gain, 1, CROSSFADE_TC);
      this.setGain(this.bedGain!, 0, REWARD_DUCK_TC);
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

  /** Lazy-load the completion track once the fourth item is collected. Idempotent. */
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
    this.setActive(null);

    const track = this.ensureSong(COMPLETION);
    track.el.loop = false;
    track.el.currentTime = 0;
    track.el.onended = () => this.endCompletion();

    void this.resumeContext().then(async (running) => {
      // If the track can't start, onended never fires — give proximity back instead of
      // leaving the mix suspended for the rest of the session.
      if (!running) return this.endCompletion();
      this.setGain(this.bedGain!, 0, PROXIMITY_TC);
      this.setGain(track.gain, 1, CROSSFADE_TC);
      if (!(await this.playElement(track.el, COMPLETION))) this.endCompletion();
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

    this.setMasterTarget(MASTER_UNMUTE_TC);
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

    if (this.unlocked) {
      // A resume that failed on tab return left the one-shots unscheduled; a gesture that
      // finally gets the context running picks them back up.
      if (this.oneShotTimer === null && document.visibilityState === 'visible') {
        this.scheduleOneShots();
      }
      return;
    }
    this.unlocked = true;

    await this.loadBuffers();
    this.startBed();
    this.setGain(this.bedGain!, BED_BASE, BED_FADE_IN_TC);
    this.scheduleOneShots();

    this.setMasterTarget(MASTER_FADE_TC);
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
    const deadline = performance.now() + RESUME_TIMEOUT_MS;
    while (ctx.state !== 'running') {
      if (performance.now() > deadline) {
        console.warn('[audio] context did not reach "running" in time', ctx.state);
        return false;
      }
      await sleep(RESUME_POLL_MS);
    }
    return true;
  }

  /**
   * Suspending the context silences the graph but not the media elements behind it — their
   * clocks keep running, so a song would come back further along (and the non-looping
   * completion track could end unheard). Pause them too.
   */
  private onHide() {
    this.stopOneShotScheduler();
    for (const [key, track] of this.tracks) {
      if (track.el.paused) continue;
      track.el.pause();
      this.pausedForHide.add(key);
    }
    this.ctx?.suspend().catch(() => {});
  }

  private onShow() {
    void this.resumeContext().then((running) => {
      if (!running) return;
      for (const key of this.pausedForHide) {
        const track = this.tracks.get(key);
        if (track) void this.playElement(track.el, key);
      }
      this.pausedForHide.clear();
      if (this.unlocked) this.scheduleOneShots();
    });
  }

  private async loadBuffers() {
    const primary = pickExt();
    const exts = primary === 'm4a' ? ['m4a', 'webm'] : ['webm', 'm4a'];

    try {
      const manifest = (await fetch('/assets/audio/manifest.json').then((r) =>
        r.json()
      )) as AudioManifest;
      this.manifestLoaded = true;
      this.oneShotNames = manifest.ambient.oneShots.map((o) => o.name);
    } catch (err) {
      console.error('[audio] manifest load failed, using fallback one-shots', err);
      this.oneShotNames = FALLBACK_ONE_SHOTS;
    }

    const targets: { name: string; dir: AssetDir }[] = [
      { name: 'bed', dir: 'ambient' },
      ...this.oneShotNames.map((name) => ({ name, dir: 'ambient' as const })),
      ...SFX_NAMES.map((name) => ({ name, dir: 'sfx' as const })),
    ];
    await Promise.all(targets.map(({ name, dir }) => this.loadBuffer(name, dir, exts)));
  }

  /**
   * decodeAudioData support for a given container is not guaranteed on WebKit — the Opus bug
   * is about media elements, but decoding is its own gamble. Try the preferred format, then
   * fall back to the other, so a codec gap can't take the bed down with it.
   */
  private async loadBuffer(name: string, dir: AssetDir, exts: string[]): Promise<void> {
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
    if (this.oneShotNames.length === 0) return;
    const name = this.oneShotNames[Math.floor(Math.random() * this.oneShotNames.length)];
    // One-shots are part of the bed, so they go through its gain and duck with it.
    this.playBuffer(name, this.bedGain!, ONE_SHOT_GAIN);
  }

  private playSfx(name: SfxName) {
    this.playBuffer(name, this.master!, SFX_GAIN);
  }

  private playBuffer(name: string, destination: AudioNode, level: number) {
    const buf = this.buffers.get(name);
    if (!buf || !this.ctx || this.ctx.state !== 'running') return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const gain = this.ctx.createGain();
    gain.gain.value = level;
    src.connect(gain).connect(destination);
    src.start();
  }

  /** Resolves false when the browser refuses playback, so callers can back out. */
  private playElement(el: HTMLAudioElement, label: string): Promise<boolean> {
    return el.play().then(
      () => true,
      (err) => {
        console.warn(`[audio] play() rejected for ${label}`, err);
        return false;
      }
    );
  }

  private ensureSong(key: SongKey): Track {
    const existing = this.tracks.get(key);
    if (existing) return existing;
    const ctx = this.ctx!;
    const el = new Audio();
    el.preload = 'auto';
    el.src = `/assets/audio/tracks/${key}.${pickExt()}`;
    el.loop = true;

    // Media elements are created only after the AudioContext exists, and their src is set
    // directly rather than via <source> children — both part of avoiding the WebKit bug.
    const source = ctx.createMediaElementSource(el);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain).connect(this.master!);

    const track = { el, source, gain };
    this.tracks.set(key, track);
    return track;
  }

  private startSong(key: SongKey) {
    this.cancelRelease(key);
    const track = this.ensureSong(key);
    track.el.currentTime = 0; // re-entering a field restarts the track at its hook, every time
    void this.playElement(track.el, key);
  }

  /** Hand the active slot to `next`, fading out whatever held it. */
  private setActive(next: ItemId | null) {
    if (this.activeChest && this.activeChest !== next) this.fadeOut(this.activeChest);
    this.activeChest = next;
  }

  private fadeOut(key: SongKey) {
    // Max two songs loaded: anything still fading from an earlier swap is hurried off with a
    // short fade rather than cut dead, so a fast traversal never pops an audible track.
    for (const other of [...this.releaseTimers.keys()]) {
      if (other !== key) this.scheduleRelease(other, EVICT_TC, EVICT_RELEASE_MS);
    }
    this.scheduleRelease(key, CROSSFADE_TC, RELEASE_AFTER_MS);
  }

  private scheduleRelease(key: SongKey, timeConstant: number, afterMs: number) {
    const track = this.tracks.get(key);
    if (!track) return;
    this.setGain(track.gain, 0, timeConstant);
    this.cancelRelease(key);
    this.releaseTimers.set(
      key,
      window.setTimeout(() => {
        this.releaseTimers.delete(key);
        this.releaseSong(key);
      }, afterMs)
    );
  }

  private cancelRelease(key: SongKey) {
    const timer = this.releaseTimers.get(key);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    this.releaseTimers.delete(key);
  }

  private releaseSong(key: SongKey) {
    this.cancelRelease(key);
    this.pausedForHide.delete(key);
    const track = this.tracks.get(key);
    if (!track) return;
    track.el.pause();
    track.el.removeAttribute('src');
    track.el.load();
    track.source.disconnect();
    track.gain.disconnect();
    this.tracks.delete(key);
  }

  private endCompletion() {
    this.completionActive = false;
    this.releaseSong(COMPLETION);
    this.lastUpdateTime = 0;
  }

  private setMasterTarget(unmutedTimeConstant: number) {
    this.masterTarget = this.muted ? 0 : MASTER_DEFAULT;
    this.masterTimeConstant = this.muted ? MASTER_MUTE_TC : unmutedTimeConstant;
  }

  private pickChest(x: number, y: number): ItemId | null {
    let nearest: ItemId | null = null;
    let nearestDist = Infinity;
    for (const key of this.chestCenters.keys()) {
      const d = this.distTo(key, x, y);
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
    gain.gain.setTargetAtTime(value, this.ctx.currentTime + SCHEDULE_LEAD, timeConstant);
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
      manifestLoaded: this.manifestLoaded,
      oneShotNames: this.oneShotNames,
      buffersLoaded: [...this.buffers.keys()],
      activeChest: this.activeChest,
      songsLoaded: [...this.tracks.keys()],
      rewardActive: this.rewardActive,
      completionActive: this.completionActive,
    };
  }
}

export const audio = new AudioEngine();
