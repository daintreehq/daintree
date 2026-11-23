import { DAINTREE_TOUR_ID } from "@shared/utils/tourIds";
import type { TourRegistration, TourSummary } from "./tourDefinition";
import { currentTourPlatform, playableChapters } from "./tourPlatform";
// The summary, not tourChapters/tourTiming: invitations render at startup, and
// those pull the narration, cue manifest and parser in with them.
import { TOUR_CHAPTER_CATALOG, TOUR_MINUTES } from "./tourSummary.generated";

/**
 * Bumped when the chapters change enough that saved progress would land on the
 * wrong one. Version 2 is the rewrite around many agents on many machines.
 */
export const DAINTREE_TOUR_VERSION = "2";

const PLATFORM = currentTourPlatform();
const CHAPTERS = playableChapters(TOUR_CHAPTER_CATALOG, PLATFORM);

export const DAINTREE_TOUR_SUMMARY: TourSummary = {
  id: DAINTREE_TOUR_ID,
  title: "Daintree Tour",
  minutes: TOUR_MINUTES[PLATFORM],
  chapterTitles: CHAPTERS.map((chapter) => chapter.title),
  chapterIds: CHAPTERS.map((chapter) => chapter.id),
  version: DAINTREE_TOUR_VERSION,
};

export const DAINTREE_TOUR_REGISTRATION: TourRegistration = {
  summary: DAINTREE_TOUR_SUMMARY,
  load: () => import("./daintreeTour").then((m) => m.DAINTREE_TOUR),
};
