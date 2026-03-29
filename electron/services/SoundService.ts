import path from "path";
import { existsSync, readdirSync } from "fs";
import { app } from "electron";
import { playSound, type SoundHandle } from "../utils/soundPlayer.js";

function getSoundsDir(): string {
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
} as const;

export type SoundId = keyof typeof SOUND_FILES;

/** Set of all valid base sound filenames (for input validation). */
export const ALLOWED_SOUND_FILES = new Set<string>(Object.values(SOUND_FILES));

interface ActiveVoice {
  handle: SoundHandle;
  priority: number;
  startedAt: number;
}

const DEBOUNCE_MS = 150;
const DECAY_WINDOW_MS = 2000;
const DECAY_FACTOR = 0.7;
const VOLUME_FLOOR = 0.1;
const MAX_VOICES = 3;
const MAX_SOUND_DURATION_MS = 600;
const CHORD_WINDOW_MS = 2000;

const PRIORITY_MAP: Record<string, number> = {
  error: 1,
  waiting: 2,
  chime: 3,
  complete: 3,
  ping: 4,
};

class SoundService {
  private variantCache = new Map<string, string[]>();
  private lastVariant = new Map<string, number>();

  // Dampening state
  private lastPlayedAt = new Map<string, number>();
  private consecutiveCount = 0;
  private lastSoundAt = 0;
  private activeVoices: ActiveVoice[] = [];
  private completionBurstCount = 0;
  private completionBurstWindowStart = 0;

  play(id: SoundId, variant?: number): void {
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
    const resolved = this.pickVariant(soundFile);
    this.playDampened(resolved, {
      debounceKey: soundFile,
      priority: this.priorityForFile(soundFile),
    });
  }

  preview(id: SoundId): void {
    this.playBypassed(SOUND_FILES[id]);
  }

  previewFile(soundFile: string): void {
    this.playBypassed(soundFile);
  }

  cancel(): void {
    for (const voice of this.activeVoices) {
      voice.handle.cancel();
    }
    this.activeVoices = [];
  }

  getVariants(soundFile: string): string[] {
    this.ensureCache(soundFile);
    return this.variantCache.get(soundFile)!;
  }

  getVariantCount(soundFile: string): number {
    return this.getVariants(soundFile).length;
  }

  // -- Private: dampening --

  private playBypassed(soundFile: string): void {
    const soundPath = path.join(getSoundsDir(), soundFile);
    if (!existsSync(soundPath)) return;
    const handle = playSound(soundPath);
    this.activeVoices.push({ handle, priority: 0, startedAt: Date.now() });
  }

  private playDampened(
    soundFile: string,
    opts: { debounceKey?: string; volume?: number; priority: number }
  ): void {
    const soundPath = path.join(getSoundsDir(), soundFile);
    if (!existsSync(soundPath)) return;

    const now = Date.now();

    // Debounce on base sound name (not variant) to catch rapid same-type triggers
    const key = opts.debounceKey ?? soundFile;
    const lastPlayed = this.lastPlayedAt.get(key) ?? 0;
    if (now - lastPlayed < DEBOUNCE_MS) return;
    this.lastPlayedAt.set(key, now);

    // Compute volume via exponential decay
    const effectiveVolume = opts.volume ?? this.computeVolume(now);

    // Voice pool management
    this.pruneStaleVoices(now);
    if (!this.acquireVoiceSlot(opts.priority)) return;

    const handle = playSound(soundPath, effectiveVolume);
    this.activeVoices.push({ handle, priority: opts.priority, startedAt: now });
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
    this.activeVoices = this.activeVoices.filter((v) => now - v.startedAt < MAX_SOUND_DURATION_MS);
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

  private ensureCache(soundFile: string): void {
    if (this.variantCache.has(soundFile)) return;

    const ext = path.extname(soundFile);
    const base = path.basename(soundFile, ext);
    const variants = [soundFile];

    const variantPattern = new RegExp(`^${base}\\.v\\d+${ext.replace(".", "\\.")}$`);
    try {
      const files = readdirSync(getSoundsDir());
      for (const f of files) {
        if (variantPattern.test(f)) variants.push(f);
      }
      variants.sort();
    } catch {
      // sounds dir missing or unreadable
    }

    this.variantCache.set(soundFile, variants);
  }
}

export const soundService = new SoundService();
