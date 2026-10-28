import type { PresentationLevels } from "../../config/presentationProfile.js";

/** What `.daintree/presentation.json` suggests, as this build reads it. */
export interface PresentationSuggestion {
  levels: PresentationLevels;
  /** The launcher entry it suggests featuring, `{publisher.name}.{entry id}` (#13791). */
  featuredLaunchEntry?: string;
  /** Identity of what it suggests; an answer only counts for the suggestion it was about. */
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
   * "Use this project's toolbar" as the user last set it, or `null` for never:
   * then the overlay applies exactly when the profile places anything on the
   * toolbar (`isProjectToolbarActive`).
   */
  useProjectToolbar: boolean | null;
  /**
   * Up to three of this project's own plugin buttons, by toolbar button id,
   * shown on the toolbar in this project rather than only in the plugin tray.
   * May name a button whose plugin is not loaded right now; it draws nothing
   * until it is.
   */
  promotedPluginButtons: string[];
  /**
   * The user's order for the launcher's groups (#13791): `agents`, `panels`,
   * `recipes` and `plugin:{pluginId}`. Groups it does not name follow the
   * profile's order. May name groups that are not there right now.
   */
  launcherGroupOrder: string[];
  /**
   * The project plugin entry the launcher preselects, `{publisher.name}.{entry
   * id}`, or `null`. Selecting is all it does; an entry that is not there
   * right now leaves the launcher's first row selected.
   */
  featuredLaunchEntry: string | null;
  /**
   * Whether the project's files look like a web project (#14069), read on the
   * host each time this is built and never stored: `null` when they could not
   * be read. Only a default for the dev preview, which the user's level beats.
   */
  webProject: boolean | null;
  /**
   * The stored profile's write count, which only grows. A view drops a
   * snapshot older than the one it holds: a push and an invoke reply can
   * arrive out of order, and either could otherwise roll it back.
   */
  revision: number;
}
