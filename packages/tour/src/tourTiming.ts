import { estimateTiming, narrationFingerprint, parseNarration } from "./tourNarration.js";
import type { TourChapter, TourChapterTiming, TourTimingManifest } from "./tourTypes.js";

/**
 * Resolve a chapter's timing: the manifest entry when it was produced from
 * this exact narration, otherwise an estimate. A stale entry is never used —
 * its cue times would point at the wrong words and its audio would say
 * something the captions don't.
 */
export function resolveChapterTiming(
  chapter: TourChapter,
  manifest?: TourTimingManifest
): TourChapterTiming {
  const entry = manifest?.chapters[chapter.id];
  const hash = narrationFingerprint(parseNarration(chapter.narration));
  if (entry && entry.narrationHash === hash) {
    const { narrationHash: _hash, voice: _voice, ...timing } = entry;
    return timing;
  }
  return estimateTiming(chapter.narration);
}

export function resolveTourTimings(
  chapters: readonly TourChapter[],
  manifest?: TourTimingManifest
): TourChapterTiming[] {
  return chapters.map((chapter) => resolveChapterTiming(chapter, manifest));
}

/** A tour's length in whole minutes, never less than one. */
export function tourMinutes(timings: readonly TourChapterTiming[]): number {
  const seconds = timings.reduce((sum, timing) => sum + timing.duration, 0);
  return Math.max(1, Math.round(seconds / 60));
}
