import { TOUR_CHAPTERS } from "./tourChapters";
import { currentTourKeyboard, narrationVariant, type TourKeyboard } from "./tourKeys";
import { estimateTiming, narrationFingerprint, parseNarration } from "./tourNarration";
import { TOUR_TIMING_MANIFEST } from "./tourTiming.generated";
import type { TourChapter, TourChapterTiming, TourTimingManifest } from "./tourTypes";

/**
 * Resolve a chapter's timing for a keyboard: the generated manifest when it was
 * produced from this exact narration, otherwise an estimate. A stale entry is
 * never used — its cue times would point at the wrong words and its audio
 * would say something the captions don't.
 */
export function resolveChapterTiming(
  chapter: TourChapter,
  keyboard: TourKeyboard = currentTourKeyboard(),
  manifest: TourTimingManifest = TOUR_TIMING_MANIFEST
): TourChapterTiming {
  const variant = narrationVariant(chapter, keyboard);
  const entry = manifest.chapters[variant.key];
  const hash = narrationFingerprint(parseNarration(variant.narration));
  if (entry && entry.narrationHash === hash) {
    const { narrationHash: _hash, voice: _voice, ...timing } = entry;
    return timing;
  }
  return estimateTiming(variant.narration);
}

export function resolveTourTimings(
  keyboard: TourKeyboard = currentTourKeyboard(),
  chapters: readonly TourChapter[] = TOUR_CHAPTERS,
  manifest?: TourTimingManifest
): TourChapterTiming[] {
  return chapters.map((chapter) => resolveChapterTiming(chapter, keyboard, manifest));
}

/** The tour's length in whole minutes, as the invitation quotes it. */
export function tourMinutes(timings: readonly TourChapterTiming[] = resolveTourTimings()): number {
  const seconds = timings.reduce((sum, timing) => sum + timing.duration, 0);
  return Math.max(1, Math.round(seconds / 60));
}
