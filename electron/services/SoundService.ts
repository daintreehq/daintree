import path from "path";
import { fileURLToPath } from "url";
import { existsSync, readdirSync } from "fs";
import { playSound, type SoundHandle } from "../utils/soundPlayer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOUNDS_DIR = path.join(__dirname, "..", "resources", "sounds");

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

/**
 * Central sound playback service.  Handles variant discovery, no-repeat
 * round-robin selection, and playback cancellation.
 *
 * Usage:
 *   soundService.play("chime")          — plays a random chime variant
 *   soundService.play("chime", 2)       — plays chime.v2.wav specifically
 *   soundService.play("error")          — plays error.wav (no variants)
 *   soundService.playFile("custom.wav") — plays a raw filename (no variants)
 *   soundService.preview("chime")       — plays the base chime.wav (v0, no variant)
 */
class SoundService {
  private variantCache = new Map<string, string[]>();
  private lastVariant = new Map<string, number>();
  private lastHandle: SoundHandle | null = null;

  /** Play a built-in sound by ID, with automatic variant selection.
   *  Pass a specific `variant` index (0-N) to force a particular variant. */
  play(id: SoundId, variant?: number): void {
    const baseFile = SOUND_FILES[id];
    const resolved =
      variant !== undefined ? this.getVariant(baseFile, variant) : this.pickVariant(baseFile);
    this.playResolved(resolved);
  }

  /** Play a raw sound filename (e.g., a user-configured custom file).
   *  Variant resolution still applies — if the file has siblings, one is picked. */
  playFile(soundFile: string): void {
    const resolved = this.pickVariant(soundFile);
    this.playResolved(resolved);
  }

  /** Play the canonical (v0) version of a sound — no variant selection.
   *  Used for settings preview so users hear the exact base sound. */
  preview(id: SoundId): void {
    this.playResolved(SOUND_FILES[id]);
  }

  /** Preview a raw filename without variant resolution. */
  previewFile(soundFile: string): void {
    this.playResolved(soundFile);
  }

  /** Cancel any currently playing sound. */
  cancel(): void {
    if (this.lastHandle) {
      this.lastHandle.cancel();
      this.lastHandle = null;
    }
  }

  /** Get the list of variant filenames for a base sound (including the base itself). */
  getVariants(soundFile: string): string[] {
    this.ensureCache(soundFile);
    return this.variantCache.get(soundFile)!;
  }

  /** Get the count of variants for a sound (1 = no variants, 4 = base + 3). */
  getVariantCount(soundFile: string): number {
    return this.getVariants(soundFile).length;
  }

  // -- Private --

  private playResolved(soundFile: string): void {
    const soundPath = path.join(SOUNDS_DIR, soundFile);
    if (!existsSync(soundPath)) return;
    this.cancel();
    this.lastHandle = playSound(soundPath);
  }

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
      const files = readdirSync(SOUNDS_DIR);
      for (const f of files) {
        if (variantPattern.test(f)) variants.push(f);
      }
      variants.sort();
    } catch {
      // SOUNDS_DIR missing or unreadable
    }

    this.variantCache.set(soundFile, variants);
  }
}

export const soundService = new SoundService();
