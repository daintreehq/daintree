import type { TourChapterTiming, TourPlayerState } from "./tourTypes.js";

type TourAudioEvent = "canplaythrough" | "playing" | "waiting" | "error" | "ended";

/** The slice of HTMLAudioElement the player drives — narrow so tests can fake it. */
export interface TourAudio {
  src: string;
  preload: string;
  currentTime: number;
  muted: boolean;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: TourAudioEvent, listener: () => void): void;
  removeEventListener(type: TourAudioEvent, listener: () => void): void;
}

export interface TourPlayerDeps {
  createAudio: (url: string) => TourAudio;
  now: () => number;
  requestFrame: (cb: () => void) => number;
  cancelFrame: (id: number) => void;
}

/**
 * How long the timeline holds still waiting for narration — at the start of a
 * chapter, or when playback stalls to buffer — before it carries on silently
 * on the wall clock. The voice rejoins at the scene's position when it can.
 */
export const AUDIO_WAIT_MS = 1500;

/** Drift between voice and timeline tolerated before the voice is re-seeked. */
const RESYNC_TOLERANCE_S = 0.3;

interface AudioSlot {
  audio: TourAudio;
  ready: boolean;
  /** The file itself is unusable (network, decode). Permanent for this opening. */
  loadFailed: boolean;
  /** `play()` was refused (autoplay policy). Retried on the next explicit play. */
  playRefused: boolean;
  /** Actually producing sound right now — the only state in which it owns the clock. */
  flowing: boolean;
  /** Reached its natural end; the timeline runs its silent tail on the wall clock. */
  ended: boolean;
  /** Bumped by every play/pause so a stale `play()` settlement is recognisable. */
  attempt: number;
  dispose: () => void;
}

type Listener = () => void;

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Drives the tour timeline. Narration audio is the clock while it is flowing;
 * otherwise (loading, buffering past the hold, refused, failed, offline) a wall
 * clock runs the same timeline silently, so scenes never depend on the
 * network. `silent` in the state says which, so the UI can show captions
 * exactly when the voice isn't carrying the chapter. Mute only touches the
 * audio element — the timeline is identical either way.
 */
export class TourPlayer {
  private state: TourPlayerState;
  private time = 0;
  private readonly timings: TourChapterTiming[];
  private readonly deps: TourPlayerDeps;
  private readonly slots = new Map<number, AudioSlot>();
  private readonly listeners = new Set<Listener>();
  private readonly timeListeners = new Set<Listener>();
  private frame: number | null = null;
  private clockBase = { time: 0, at: 0 };
  private holdStartedAt: number | null = null;
  private disposed = false;

  constructor(
    timings: TourChapterTiming[],
    deps: TourPlayerDeps,
    options: { muted?: boolean } = {}
  ) {
    if (timings.length === 0) throw new Error("TourPlayer needs at least one chapter");
    this.timings = timings;
    this.deps = deps;
    this.state = {
      chapterIndex: 0,
      status: "idle",
      muted: options.muted ?? false,
      audioStatus: "none",
      silent: timings[0]!.audioUrl === null,
    };
  }

  getState = (): TourPlayerState => this.state;
  getTime = (): number => this.time;
  get chapterCount(): number {
    return this.timings.length;
  }
  get timing(): TourChapterTiming {
    return this.timings[this.state.chapterIndex]!;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Fires on every timeline tick while playing — keep listeners cheap. */
  subscribeTime = (listener: Listener): (() => void) => {
    this.timeListeners.add(listener);
    return () => this.timeListeners.delete(listener);
  };

  play(): void {
    if (this.disposed) return;
    if (this.state.status === "ended") this.seek(0);
    const slot = this.ensureSlot(this.state.chapterIndex);
    // An explicit play is a fresh chance for a voice the autoplay policy refused.
    if (slot?.playRefused) slot.playRefused = false;
    this.startClock();
    this.setState({ status: "playing" });
    if (slot && !slot.loadFailed && !slot.ended) {
      this.holdStartedAt = this.deps.now();
      if (slot.ready) this.startAudio(slot);
    }
    this.preloadAll();
    this.scheduleFrame();
  }

  pause(): void {
    if (this.state.status !== "playing") return;
    this.stopFrame();
    this.haltAudio(this.slots.get(this.state.chapterIndex));
    this.holdStartedAt = null;
    this.setState({ status: "paused" });
  }

  toggle(): void {
    if (this.state.status === "playing") this.pause();
    else this.play();
  }

  seek(seconds: number): void {
    const next = Math.min(Math.max(0, seconds), this.timing.duration);
    this.setTime(next);
    const slot = this.slots.get(this.state.chapterIndex);
    if (slot?.ready) {
      slot.audio.currentTime = next;
      if (slot.ended && next < this.timing.duration) {
        slot.ended = false;
        if (this.state.status === "playing" && !slot.loadFailed && !slot.playRefused) {
          this.startAudio(slot);
        }
      }
    }
    if (this.state.status === "ended" && next < this.timing.duration) {
      this.setState({ status: "paused" });
    }
    this.startClock();
  }

  goTo(index: number, options: { autoplay?: boolean } = {}): void {
    if (index < 0 || index >= this.timings.length || this.disposed) return;
    const wasPlaying = this.state.status === "playing";
    this.stopFrame();
    this.haltAudio(this.slots.get(this.state.chapterIndex));
    this.holdStartedAt = null;
    const slot = this.slots.get(index);
    if (slot) {
      slot.audio.currentTime = 0;
      slot.ended = false;
    }
    this.state = {
      ...this.state,
      chapterIndex: index,
      status: "idle",
      audioStatus: slot ? this.statusOf(slot) : "none",
      silent: this.timings[index]!.audioUrl === null || !!slot?.loadFailed,
    };
    this.setTime(0);
    this.startClock();
    this.emit();
    if (options.autoplay ?? wasPlaying) this.play();
  }

  next(): void {
    this.goTo(this.state.chapterIndex + 1, { autoplay: true });
  }

  previous(): void {
    this.goTo(this.state.chapterIndex - 1, { autoplay: true });
  }

  setMuted(muted: boolean): void {
    for (const slot of this.slots.values()) slot.audio.muted = muted;
    this.setState({ muted });
  }

  dispose(): void {
    this.disposed = true;
    this.stopFrame();
    for (const slot of this.slots.values()) {
      slot.attempt++;
      slot.dispose();
    }
    this.slots.clear();
    this.listeners.clear();
    this.timeListeners.clear();
  }

  private statusOf(slot: AudioSlot): TourPlayerState["audioStatus"] {
    if (slot.loadFailed || slot.playRefused) return "failed";
    return slot.ready ? "ready" : "loading";
  }

  private ensureSlot(index: number): AudioSlot | null {
    const existing = this.slots.get(index);
    if (existing) return existing;
    const url = this.timings[index]!.audioUrl;
    if (!url) return null;

    const audio = this.deps.createAudio(url);
    audio.preload = "auto";
    audio.muted = this.state.muted;
    const slot: AudioSlot = {
      audio,
      ready: false,
      loadFailed: false,
      playRefused: false,
      flowing: false,
      ended: false,
      attempt: 0,
      dispose: () => {},
    };
    const isCurrent = () => this.state.chapterIndex === index && !this.disposed;
    const isLive = () => isCurrent() && this.state.status === "playing";

    const onReady = () => {
      if (slot.ready) return;
      slot.ready = true;
      if (!isCurrent()) return;
      this.setState({ audioStatus: this.statusOf(slot) });
      // Late join: the silent clock may already be running, so the voice
      // picks up where the scene is rather than restarting it.
      if (isLive() && !slot.ended && !slot.loadFailed && !slot.playRefused) this.startAudio(slot);
    };
    const onPlaying = () => {
      if (!isLive()) return;
      slot.flowing = true;
      this.holdStartedAt = null;
      if (Math.abs(audio.currentTime - this.time) > RESYNC_TOLERANCE_S) {
        audio.currentTime = this.time;
      }
      this.startClock();
      this.setState({ silent: false });
    };
    const onWaiting = () => {
      slot.flowing = false;
      // A stall mid-chapter gets the same bounded hold as the first load.
      if (isLive() && !slot.ended) {
        this.startClock();
        this.holdStartedAt = this.deps.now();
      }
    };
    const onError = () => {
      slot.loadFailed = true;
      slot.flowing = false;
      if (!isCurrent()) return;
      this.holdStartedAt = null;
      this.startClock();
      this.setState({ audioStatus: "failed", silent: true });
    };
    const onEnded = () => {
      slot.flowing = false;
      slot.ended = true;
      // The timeline runs a little past the voice; finish that tail on the wall
      // clock, from wherever the voice actually stopped — frames may have been
      // throttled while it played, leaving the last sample behind.
      if (isLive()) {
        this.setTime(Math.min(Math.max(this.time, audio.currentTime), this.timing.duration));
        this.startClock();
      }
    };
    audio.addEventListener("canplaythrough", onReady);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("error", onError);
    audio.addEventListener("ended", onEnded);
    slot.dispose = () => {
      audio.removeEventListener("canplaythrough", onReady);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("error", onError);
      audio.removeEventListener("ended", onEnded);
      audio.pause();
      audio.src = "";
    };
    this.slots.set(index, slot);
    if (isCurrent()) this.setState({ audioStatus: "loading" });
    return slot;
  }

  /**
   * Starting the tour is the signal the user wants it, so every chapter's
   * narration downloads then — Next never waits on the network. Nothing loads
   * before the first play; the files are small and CDN-cached.
   */
  private preloadAll(): void {
    for (let i = 0; i < this.timings.length; i++) this.ensureSlot(i);
  }

  private startAudio(slot: AudioSlot): void {
    const attempt = ++slot.attempt;
    slot.audio.muted = this.state.muted;
    if (Math.abs(slot.audio.currentTime - this.time) > RESYNC_TOLERANCE_S) {
      slot.audio.currentTime = this.time;
    }
    Promise.resolve(slot.audio.play()).catch((error: unknown) => {
      // A pause or chapter change interrupts a pending play with AbortError;
      // that is us cancelling it, not the voice failing.
      if (attempt !== slot.attempt || isAbort(error)) return;
      slot.playRefused = true;
      slot.flowing = false;
      if (this.slots.get(this.state.chapterIndex) === slot && !this.disposed) {
        this.holdStartedAt = null;
        this.startClock();
        this.setState({ audioStatus: "failed", silent: true });
      }
    });
  }

  private haltAudio(slot: AudioSlot | undefined): void {
    if (!slot) return;
    slot.attempt++;
    slot.flowing = false;
    slot.audio.pause();
  }

  private startClock(): void {
    this.clockBase = { time: this.time, at: this.deps.now() };
  }

  private tick = (): void => {
    this.frame = null;
    if (this.state.status !== "playing" || this.disposed) return;
    const now = this.deps.now();

    if (this.holdStartedAt !== null) {
      if (now - this.holdStartedAt < AUDIO_WAIT_MS) {
        this.scheduleFrame();
        return;
      }
      this.holdStartedAt = null;
      this.startClock();
    }

    const slot = this.slots.get(this.state.chapterIndex);
    let next: number;
    if (slot?.flowing && !slot.ended) {
      next = slot.audio.currentTime;
      this.clockBase = { time: next, at: now };
    } else {
      next = this.clockBase.time + (now - this.clockBase.at) / 1000;
      // The tail after a voice that ended normally is intended silence.
      if (!slot?.ended && !this.state.silent) this.setState({ silent: true });
    }

    if (next >= this.timing.duration) {
      this.finish();
      return;
    }
    this.setTime(next);
    this.scheduleFrame();
  };

  private finish(): void {
    this.stopFrame();
    this.haltAudio(this.slots.get(this.state.chapterIndex));
    this.setTime(this.timing.duration);
    this.setState({ status: "ended" });
  }

  private scheduleFrame(): void {
    if (this.frame === null) this.frame = this.deps.requestFrame(this.tick);
  }

  private stopFrame(): void {
    if (this.frame !== null) this.deps.cancelFrame(this.frame);
    this.frame = null;
  }

  private setTime(time: number): void {
    if (time === this.time) return;
    this.time = time;
    for (const listener of this.timeListeners) listener();
  }

  private setState(patch: Partial<TourPlayerState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
