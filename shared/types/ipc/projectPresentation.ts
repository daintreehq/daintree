import type { PresentationLevels } from "../../config/presentationProfile.js";

/** What `.daintree/presentation.json` suggests, as this build reads it. */
export interface PresentationSuggestion {
  levels: PresentationLevels;
  /** Identity of the suggested levels; an answer only counts for the suggestion it was about. */
  hash: string;
}

export type PresentationSuggestionAnswer = "accepted" | "declined";

export interface PresentationSuggestionAnswerRecord {
  hash: string;
  answer: PresentationSuggestionAnswer;
  decidedAt: number;
}

/**
 * One project's presentation profile, for every view of that project.
 *
 * `levels` holds only what the user set (or accepted); a feature it does not
 * name follows its host default, which depends on the project being git-backed
 * and is resolved in the renderer with `resolvePresentation`.
 */
export interface ProjectPresentationSnapshot {
  projectId: string;
  levels: PresentationLevels;
  suggestion: PresentationSuggestion | null;
  suggestionAnswer: PresentationSuggestionAnswerRecord | null;
  /**
   * The stored profile's write count, which only grows. A view drops a
   * snapshot older than the one it holds: a push and an invoke reply can
   * arrive out of order, and either could otherwise roll it back.
   */
  revision: number;
}
