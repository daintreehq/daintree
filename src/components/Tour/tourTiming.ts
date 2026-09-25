import { TOUR_CHAPTERS } from "./tourChapters";
import { estimateTiming, narrationFingerprint, parseNarration } from "./tourNarration";
import { TOUR_TIMING_MANIFEST } from "./tourTiming.generated";
import type { TourChapter, TourChapterTiming, TourTimingManifest } from "./tourTypes";

/**
 * Resolve a chapter's timing: the generated manifest when it was produced from
 * this exact narration, otherwise an estimate. A stale entry is never used —
 * its cue times would point at the wrong words and its audio would say
 * something the captions don't.
 */
export function resolveChapterTiming(
  chapter: TourChapter,
  manifest: TourTimingManifest = TOUR_TIMING_MANIFEST
): TourChapterTiming {
  const entry = manifest.chapters[chapter.id];
  const hash = narrationFingerprint(parseNarration(chapter.narration));
  if (entry && entry.narrationHash === hash) {
    const { narrationHash: _hash, ...timing } = entry;
    return timing;
  }
  return estimateTiming(chapter.narration);
}

export function resolveTourTimings(
  chapters: readonly TourChapter[] = TOUR_CHAPTERS,
  manifest?: TourTimingManifest
): TourChapterTiming[] {
  return chapters.map((chapter) => resolveChapterTiming(chapter, manifest));
}

/** The tour's length in whole minutes, as the invitation quotes it. */
export function tourMinutes(timings: readonly TourChapterTiming[] = resolveTourTimings()): number {
  const seconds = timings.reduce((sum, timing) => sum + timing.duration, 0);
  return Math.max(1, Math.round(seconds / 60));
}
