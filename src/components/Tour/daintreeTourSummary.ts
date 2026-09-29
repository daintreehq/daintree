import { DAINTREE_TOUR_ID } from "@shared/utils/tourIds";
import type { TourRegistration, TourSummary } from "./tourDefinition";
// The summary, not tourChapters/tourTiming: invitations render at startup, and
// those pull the narration, cue manifest and parser in with them.
import { TOUR_CHAPTER_TITLES, TOUR_MINUTES } from "./tourSummary.generated";

export const DAINTREE_TOUR_SUMMARY: TourSummary = {
  id: DAINTREE_TOUR_ID,
  title: "Daintree Tour",
  minutes: TOUR_MINUTES,
  chapterTitles: TOUR_CHAPTER_TITLES,
};

export const DAINTREE_TOUR_REGISTRATION: TourRegistration = {
  summary: DAINTREE_TOUR_SUMMARY,
  load: () => import("./daintreeTour").then((m) => m.DAINTREE_TOUR),
};
