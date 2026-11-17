import path from "path";
import { existsSync, readdirSync } from "fs";
import { app, BrowserWindow } from "electron";
import { playSound, type SoundHandle } from "../utils/soundPlayer.js";
import { broadcastToRenderer, sendToOneVisibleRenderer } from "../ipc/utils.js";
import { CHANNELS } from "../ipc/channels.js";
import { store } from "../store.js";
import {
  CUSTOM_SOUND_MAX_SECONDS,
  isCustomSoundId,
} from "../../shared/types/ipc/notificationSounds.js";
import { isPlayableCustomSound, resolveCustomSoundPath } from "./customNotificationSounds.js";

export function getSoundsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "sounds")
    : path.join(app.getAppPath(), "electron", "resources", "sounds");
}

/**
 * Built-in sound identifiers.  Each key maps to the base WAV filename.
 * Variants (if they exist) are discovered automatically from siblings
 * in the sounds directory (e.g., chime.v1.wav, chime.v2.wav, ...).
 */
export const SOUND_FILES = {
  chime: "chime.wav",
  complete: "complete.wav",
  waiting: "waiting.wav",
  error: "error.wav",
  ping: "ping.wav",
  pulse: "pulse.wav",
  "all-clear": "all-clear.wav",
  "git-commit": "git-commit.wav",
  "git-push": "git-push.wav",
  "git-push-error": "git-push-error.wav",
  "worktree-create": "worktree-create.wav",
  "worktree-delete": "worktree-delete.wav",
  "agent-spawned": "agent-spawned.wav",
  "context-injected": "context-injected.wav",
  "dictation-start": "dictation-start.wav",
  "dictation-stop": "dictation-stop.wav",
  "dictation-error": "dictation-error.wav",
} as const;

export type SoundId = keyof typeof SOUND_FILES;

/** Set of all valid base sound filenames (for input validation). */
export const ALLOWED_SOUND_FILES = new Set<string>(Object.values(SOUND_FILES));

/**
 * Every sound a setting may name: the bundled files, plus imports registered on
 * this device whose file is still there. Live, so an import is playable at once.
 */
export const PLAYABLE_SOUND_FILES: { has(value: string): boolean } = {
  has: (value) => ALLOWED_SOUND_FILES.has(value) || isPlayableCustomSound(value),
};

/** The Notifications volume setting as linear gain; absent or malformed is full volume. */
function settingsVolume(): number {
  const volume: unknown = store.get("notificationSettings")?.soundVolume;
  if (typeof volume !== "number" || !Number.isFinite(volume)) return 1;
  return Math.max(0, Math.min(1, volume));
}

interface ActiveVoice {
  handle: SoundHandle;
  priority: number;
  startedAt: number;
  /** How long the OS player may still be sounding it; an import can run to the 3 s cap. */
  durationMs: number;
}

const DEBOUNCE_MS = 150;
const DECAY_WINDOW_MS = 2000;
const DECAY_FACTOR = 0.7;
const VOLUME_FLOOR = 0.1;
const MAX_VOICES = 3;
const MAX_SOUND_DURATION_MS = 600;
const MAX_CUSTOM_SOUND_DURATION_MS = CUSTOM_SOUND_MAX_SECONDS * 1000;
const CHORD_WINDOW_MS = 2000;

const PRIORITY_MAP: Record<string, number> = {
  error: 1,
  "dictation-error": 1,
  waiting: 2,
  chime: 3,
  complete: 3,
  ping: 4,
  pulse: 5,
};

/**
 * Central sound playback service.  Handles variant discovery, no-repeat
 * round-robin selection, dampening, and playback cancellation.
 *
 * Playback is routed to the renderer's Web Audio API via IPC when available,
 * falling back to OS process spawning (soundPlayer.ts) otherwise.
 */
const SOUND_THROTTLE_MS = 300;

class SoundService {
  private variantCache = new Map<string, string[]>();
  private lastVariant = new Map<string, number>();
  private lastPlayFileAt = 0;

  // Dampening state
  private lastPlayedAt = new Map<string, number>();
  private consecutiveCount = 0;
  private lastSoundAt = 0;
  private activeVoices: ActiveVoice[] = [];
  private completionBurstCount = 0;
  private completionBurstWindowStart = 0;

  play(id: SoundId, variant?: number): void {
    // Muted plays leave no trace in the chord, debounce or decay state, so the
    // first sound after unmuting plays as if the muted ones never happened.
    if (settingsVolume() <= 0) return;
    const now = Date.now();
    const isChordable = id === "complete" || id === "chime";

    if (isChordable && this.checkCompletionChord(id, now)) {
      const baseFile = SOUND_FILES[id];
      this.playDampened(baseFile, { volume: 1.0, priority: this.priorityFor(id) });
      return;
    }

    const baseFile = SOUND_FILES[id];
    const resolved =
      variant !== undefined ? this.getVariant(baseFile, variant) : this.pickVariant(baseFile);
    this.playDampened(resolved, { debounceKey: baseFile, priority: this.priorityFor(id) });
  }

  playFile(soundFile: string): void {
    // Checked before the throttle, so a muted or unplayable file can't swallow the
    // next audible one. Settings are validated on the way in, but a project's save
    // reaches here before its next decode.
    if (settingsVolume() <= 0 || !PLAYABLE_SOUND_FILES.has(soundFile)) return;
    const now = Date.now();
    if (now - this.lastPlayFileAt < SOUND_THROTTLE_MS) return;
    this.lastPlayFileAt = now;
    // An import has no variants, and its name isn't a bundled file to look for siblings of.
    const resolved = isCustomSoundId(soundFile) ? soundFile : this.pickVariant(soundFile);
    this.playDampened(resolved, {
      debounceKey: soundFile,
      priority: this.priorityForFile(soundFile),
    });
  }

  preview(id: SoundId): void {
    this.playBypassed(SOUND_FILES[id]);
  }

  previewFile(soundFile: string): void {
    if (!PLAYABLE_SOUND_FILES.has(soundFile)) return;
    this.playBypassed(soundFile);
  }

  cancel(): void {
    // Always cancel OS-fallback handles — they may have been started before
    // a renderer window existed and would otherwise play to completion.
    for (const voice of this.activeVoices) {
      voice.handle.cancel();
    }
    this.activeVoices = [];

    // Skip the renderer broadcast when no window is listening.
    // Intentionally GLOBAL; do not "make this consistent" with the single-target
    // triggers. The renderer that took a trigger can lose its turn to another
    // window or be cached afterwards, and caching neither unmounts the listener nor disposes its AudioContext, so
    // cancelSound() must reach it to fade a live voice and advance that view's
    // cancelGeneration (which is what aborts a pre-cache fetch/decode from
    // starting a stale sound). Idle receivers return before touching their
    // context, so this creates no audio; frozen receivers queue the message
    // until reactivation rather than thawing on it.
    if (BrowserWindow.getAllWindows().length > 0) {
      broadcastToRenderer(CHANNELS.EVENTS_PUSH, { name: "sound:cancel", payload: undefined });
    }
  }

  playPulse(soundFile: string, detuneCents?: number): void {
    if (!PLAYABLE_SOUND_FILES.has(soundFile)) return;
    this.playBypassed(soundFile, detuneCents);
  }

  cancelPulse(): void {
    this.cancel();
  }

  getVariants(soundFile: string): string[] {
    this.ensureCache(soundFile);
    return this.variantCache.get(soundFile)!;
  }

  getVariantCount(soundFile: string): number {
    return this.getVariants(soundFile).length;
  }

  // -- Private: dampening --

  private playBypassed(soundFile: string, detune?: number): void {
    // Previews and the pulse skip the decay but not the volume setting, so a
    // preview plays what a notification will.
    const volume = settingsVolume();
    // Muted: some OS players have no volume control, so play nothing at all.
    if (volume <= 0) return;
    // An import that is no longer registered or whose file is gone plays nothing,
    // even from a renderer that still holds it decoded.
    const customPath = isCustomSoundId(soundFile) ? resolveCustomSoundPath(soundFile) : undefined;
    if (customPath === null) return;

    // Try Web Audio via renderer first — renderer fetches via daintree-file://
    // and falls through gracefully on a miss, so no need to stat here.
    // One renderer per machine: every app view owns an AudioContext, so a
    // broadcast plays one copy per open window (#15682) and one reaching
    // cached views wakes frozen renderers — Chromium won't keep an audible page
    // frozen (#12177).
    if (BrowserWindow.getAllWindows().length > 0) {
      const payload: { soundFile: string; detune?: number; volume: number } = { soundFile, volume };
      if (detune !== undefined) payload.detune = detune;
      if (sendToOneVisibleRenderer(CHANNELS.SOUND_TRIGGER, payload)) return;
    }

    // Fallback to OS process spawning when no renderer took the trigger (no window,
    // or a window mid-teardown/crash with no eligible renderer)
    // (OS playback doesn't support detune — cadence variation still helps)
    const soundPath = customPath ?? path.join(getSoundsDir(), soundFile);
    if (!existsSync(soundPath)) return;
    const handle = playSound(soundPath, volume);
    this.activeVoices.push({
      handle,
      priority: 0,
      startedAt: Date.now(),
      durationMs: customPath ? MAX_CUSTOM_SOUND_DURATION_MS : MAX_SOUND_DURATION_MS,
    });
  }

  private playDampened(
    soundFile: string,
    opts: { debounceKey?: string; volume?: number; priority: number }
  ): void {
    const now = Date.now();

    // Debounce on base sound name (not variant) to catch rapid same-type triggers
    const key = opts.debounceKey ?? soundFile;
    const lastPlayed = this.lastPlayedAt.get(key) ?? 0;
    if (now - lastPlayed < DEBOUNCE_MS) return;
    this.lastPlayedAt.set(key, now);

    // The repeat decay (or a fixed level) scaled by the volume setting
    const effectiveVolume = (opts.volume ?? this.computeVolume(now)) * settingsVolume();
    // Muted: some OS players have no volume control, so play nothing at all.
    if (effectiveVolume <= 0) return;
    const customPath = isCustomSoundId(soundFile) ? resolveCustomSoundPath(soundFile) : undefined;
    if (customPath === null) return;

    // Try Web Audio via renderer first — renderer fetches via daintree-file://
    // and falls through gracefully on a miss, so no need to stat here.
    // One renderer for the same reason as playBypassed (#15682, #12177).
    if (BrowserWindow.getAllWindows().length > 0) {
      const delivered = sendToOneVisibleRenderer(CHANNELS.SOUND_TRIGGER, {
        soundFile,
        volume: effectiveVolume,
      });
      if (delivered) return;
    }

    // Fallback to OS process spawning when no renderer took the trigger (no window,
    // or a window mid-teardown/crash with no eligible renderer)
    const soundPath = customPath ?? path.join(getSoundsDir(), soundFile);
    if (!existsSync(soundPath)) return;

    this.pruneStaleVoices(now);
    if (!this.acquireVoiceSlot(opts.priority)) return;

    const handle = playSound(soundPath, effectiveVolume);
    this.activeVoices.push({
      handle,
      priority: opts.priority,
      startedAt: now,
      durationMs: customPath ? MAX_CUSTOM_SOUND_DURATION_MS : MAX_SOUND_DURATION_MS,
    });
  }

  private computeVolume(now: number): number {
    if (now - this.lastSoundAt > DECAY_WINDOW_MS) {
      this.consecutiveCount = 0;
    }
    const volume = Math.max(VOLUME_FLOOR, Math.pow(DECAY_FACTOR, this.consecutiveCount));
    this.consecutiveCount++;
    this.lastSoundAt = now;
    return volume;
  }

  private pruneStaleVoices(now: number): void {
    this.activeVoices = this.activeVoices.filter((v) => now - v.startedAt < v.durationMs);
  }

  private acquireVoiceSlot(priority: number): boolean {
    if (this.activeVoices.length < MAX_VOICES) return true;

    // Find lowest-priority (highest number) voice; on tie, pick oldest
    let worstIdx = -1;
    let worstPriority = -1;
    let worstStartedAt = Infinity;
    for (let i = 0; i < this.activeVoices.length; i++) {
      const v = this.activeVoices[i];
      if (
        v.priority > worstPriority ||
        (v.priority === worstPriority && v.startedAt < worstStartedAt)
      ) {
        worstPriority = v.priority;
        worstStartedAt = v.startedAt;
        worstIdx = i;
      }
    }

    if (worstPriority <= priority) return false; // All voices outrank or tie — drop new sound

    this.activeVoices[worstIdx].handle.cancel();
    this.activeVoices.splice(worstIdx, 1);
    return true;
  }

  private checkCompletionChord(_id: SoundId, now: number): boolean {
    if (now - this.completionBurstWindowStart > CHORD_WINDOW_MS) {
      this.completionBurstCount = 1;
      this.completionBurstWindowStart = now;
      return false;
    }
    this.completionBurstCount++;
    if (this.completionBurstCount >= 2) {
      this.completionBurstCount = 0;
      return true;
    }
    return false;
  }

  private priorityFor(id: SoundId): number {
    return PRIORITY_MAP[id] ?? 4;
  }

  private priorityForFile(soundFile: string): number {
    const base = path.basename(soundFile, path.extname(soundFile)).replace(/\.v\d+$/, "");
    return PRIORITY_MAP[base] ?? 4;
  }

  // -- Private: variant management --

  private getVariant(baseFile: string, index: number): string {
    const variants = this.getVariants(baseFile);
    if (index >= 0 && index < variants.length) return variants[index];
    return baseFile;
  }

  private pickVariant(soundFile: string): string {
    const variants = this.getVariants(soundFile);
    if (variants.length <= 1) return soundFile;

    const lastIdx = this.lastVariant.get(soundFile) ?? -1;
    let nextIdx: number;
    do {
      nextIdx = Math.floor(Math.random() * variants.length);
    } while (nextIdx === lastIdx);

    this.lastVariant.set(soundFile, nextIdx);
    return variants[nextIdx];
  }

  /**
   * Scan the sounds directory once at startup and seed the variant cache for
   * every known SOUND_FILES entry. Avoids per-sound lazy `readdirSync` on the
   * IPC thread when each sound first plays.
   */
  initVariantCache(): void {
    let files: string[];
    try {
      files = readdirSync(getSoundsDir());
    } catch {
      // sounds dir missing or unreadable — leave cache empty so lazy
      // ensureCache() can retry later (e.g., during tests with stubbed paths).
      return;
    }

    for (const soundFile of Object.values(SOUND_FILES)) {
      this.populateCache(soundFile, files);
    }
  }

  private ensureCache(soundFile: string): void {
    if (this.variantCache.has(soundFile)) return;

    try {
      const files = readdirSync(getSoundsDir());
      this.populateCache(soundFile, files);
    } catch {
      // sounds dir missing or unreadable
      this.variantCache.set(soundFile, [soundFile]);
    }
  }

  private populateCache(soundFile: string, files: string[]): void {
    const ext = path.extname(soundFile);
    const base = path.basename(soundFile, ext);
    const variants = [soundFile];

    const variantPattern = new RegExp(`^${base}\\.v\\d+${ext.replace(".", "\\.")}$`);
    for (const f of files) {
      if (variantPattern.test(f)) variants.push(f);
    }
    variants.sort();
    this.variantCache.set(soundFile, variants);
  }
}

export const soundService = new SoundService();
soundService.initVariantCache();
