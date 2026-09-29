import {
  resolveChapterTiming as resolveVariantTiming,
  tourMinutes as tourMinutesOf,
  type TourChapter,
  type TourChapterTiming,
  type TourTimingManifest,
} from "@daintreehq/tour";
import { TOUR_CHAPTERS } from "./tourChapters";
import { currentTourKeyboard, narrationVariant, type TourKeyboard } from "./tourKeys";
import { TOUR_TIMING_MANIFEST } from "./tourTiming.generated";

/**
 * Resolve a chapter's timing for a keyboard: the recording of the narration
 * that keyboard hears (keyed `<id>` or `<id>.<keyboard>` in the manifest), or
 * an estimate of it when that recording is missing or stale.
 */
export function resolveChapterTiming(
  chapter: TourChapter,
  keyboard: TourKeyboard = currentTourKeyboard(),
  manifest: TourTimingManifest = TOUR_TIMING_MANIFEST
): TourChapterTiming {
  const variant = narrationVariant(chapter, keyboard);
  return resolveVariantTiming(
    { ...chapter, id: variant.key, narration: variant.narration },
    manifest
  );
}

export function resolveTourTimings(
  keyboard: TourKeyboard = currentTourKeyboard(),
  chapters: readonly TourChapter[] = TOUR_CHAPTERS,
  manifest: TourTimingManifest = TOUR_TIMING_MANIFEST
): TourChapterTiming[] {
  return chapters.map((chapter) => resolveChapterTiming(chapter, keyboard, manifest));
}

/** The tour's length in whole minutes, as the invitation quotes it. */
export function tourMinutes(timings: readonly TourChapterTiming[] = resolveTourTimings()): number {
  return tourMinutesOf(timings);
}
