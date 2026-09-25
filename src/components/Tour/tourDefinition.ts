import type { ComponentType } from "react";
import type { TourChapterTiming } from "@daintreehq/tour";
import type { MockKit } from "./mockup/MockKitContext";
import type { TourKeyboard } from "./tourKeys";

/**
 * What a tour says about itself before it is loaded: enough for an invitation
 * to quote its length and chapters without pulling in narration or scenes.
 */
export interface TourSummary {
  id: string;
  title: string;
  /** Length in whole minutes, as an invitation quotes it. */
  minutes: number;
  /** Chapter titles in play order. */
  chapterTitles: readonly string[];
}

export interface TourDefinitionChapter {
  id: string;
  title: string;
  /** The chapter's mockup. Third-party code: a throw fails this chapter only. */
  scene: ComponentType;
}

/** A playable tour: the dialog, controls and captions are the same for every one. */
export interface TourDefinition {
  id: string;
  title: string;
  /** Beside the title in the dialog header. */
  icon?: ComponentType<{ className?: string }>;
  chapters: readonly TourDefinitionChapter[];
  /** One timing per chapter, in chapter order. Tours that don't vary by keyboard ignore it. */
  resolveTimings: (keyboard: TourKeyboard) => TourChapterTiming[];
  /** The data the mockup kit draws agents, states and CI marks from. */
  mockKit?: MockKit;
  /** What Finish does beyond closing, and the line on the last end card that says so. */
  finish?: { hint: string; run: () => void };
}

export interface TourRegistration {
  summary: TourSummary;
  /** Crosses the lazy boundary: scenes, narration and timings load only here. */
  load: () => Promise<TourDefinition>;
}
