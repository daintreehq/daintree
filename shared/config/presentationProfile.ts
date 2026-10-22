/**
 * The per-project presentation profile (#13771): how much room each built-in
 * surface takes in one project.
 *
 * The vocabulary is closed and host-owned. A feature joins it only by a host
 * change here, and nothing a profile can name is a safety or observation
 * signal — agent state and attention, conflicts, dirty state, the trust banner,
 * Project settings, the plugin manager and terminal launch are never features,
 * so no profile, the user's or a repository's, can quiet them.
 *
 * Levels:
 * - `shown` — drawn where it always is.
 * - `demoted` — moved somewhere less prominent but one click away; its actions,
 *   palette entries and MCP tools stay exactly as they are.
 * - `hidden` — not drawn by this surface at all. Its actions still work.
 *
 * A profile grants nothing: no trust, capability or agent access reads it.
 */
export const PRESENTATION_LEVELS = ["shown", "demoted", "hidden"] as const;
export type PresentationLevel = (typeof PRESENTATION_LEVELS)[number];

export interface PresentationDefaultsContext {
  /** `isGitBackedProject` for the project, so a non-git folder keeps today's behaviour as its defaults. */
  gitBacked: boolean;
}

export interface PresentationFeatureDefinition {
  label: string;
  /** The label as it reads mid-sentence ("hiding forge stats"). */
  noun: string;
  /** What the feature is, for the settings row. One sentence, no trailing period. */
  description: string;
  /** The levels this feature supports, in the order the settings control shows them. */
  levels: readonly PresentationLevel[];
  /**
   * The `when` clause key carrying the resolved level. A stable public API once
   * shipped. camelCase, like every built-in key, so it can never shadow a
   * plugin's keys, which sit under its lowercase manifest name.
   */
  contextKey: string;
  defaultLevel: (context: PresentationDefaultsContext) => PresentationLevel;
  /**
   * The surface reports on the repository, so a folder without one has
   * nothing to draw: it resolves to hidden whatever level is set, and the
   * setting stays for the day the folder becomes a repository. This is what
   * keeps an explicit "shown" from polling git in a folder that has none.
   */
  requiresRepository?: boolean;
}

export const PRESENTATION_FEATURES = {
  forgeStats: {
    label: "Forge stats",
    noun: "forge stats",
    description: "The issue, pull request and commit counts on the toolbar",
    levels: PRESENTATION_LEVELS,
    contextKey: "presentationForgeStats",
    // A folder without a repository has no commits, issues or PRs to count.
    defaultLevel: ({ gitBacked }) => (gitBacked ? "shown" : "hidden"),
    requiresRepository: true,
  },
} as const satisfies Record<string, PresentationFeatureDefinition>;

export type PresentationFeatureId = keyof typeof PRESENTATION_FEATURES;

export const PRESENTATION_FEATURE_IDS = Object.keys(
  PRESENTATION_FEATURES
) as readonly PresentationFeatureId[];

/** Levels a profile sets explicitly; a feature it does not name follows its default. */
export type PresentationLevels = Partial<Record<PresentationFeatureId, PresentationLevel>>;

/** Every feature with a level, defaults filled in. */
export type ResolvedPresentation = Record<PresentationFeatureId, PresentationLevel>;

export function isPresentationFeatureId(value: unknown): value is PresentationFeatureId {
  return typeof value === "string" && Object.hasOwn(PRESENTATION_FEATURES, value);
}

export function isPresentationLevel(value: unknown): value is PresentationLevel {
  return (PRESENTATION_LEVELS as readonly unknown[]).includes(value);
}

/** Whether `feature` supports `level` — not every feature need offer all three. */
export function isLevelAllowed(feature: PresentationFeatureId, level: unknown): boolean {
  return (
    isPresentationLevel(level) &&
    (PRESENTATION_FEATURES[feature].levels as readonly PresentationLevel[]).includes(level)
  );
}

/**
 * Lenient per entry: an unknown feature or a level the feature does not offer
 * drops that entry, never the rest. Both the user's stored profile and a
 * repository's suggestion are files someone else can edit.
 */
export function parsePresentationLevels(raw: unknown): PresentationLevels {
  const levels: PresentationLevels = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return levels;
  for (const [id, level] of Object.entries(raw as Record<string, unknown>)) {
    if (isPresentationFeatureId(id) && isLevelAllowed(id, level)) {
      levels[id] = level as PresentationLevel;
    }
  }
  return levels;
}

export function defaultPresentationLevel(
  feature: PresentationFeatureId,
  context: PresentationDefaultsContext
): PresentationLevel {
  return PRESENTATION_FEATURES[feature].defaultLevel(context);
}

/** Whether `feature` can be drawn at all in this project, whatever its level. */
export function isPresentationFeatureAvailable(
  feature: PresentationFeatureId,
  context: PresentationDefaultsContext
): boolean {
  const definition: PresentationFeatureDefinition = PRESENTATION_FEATURES[feature];
  return context.gitBacked || definition.requiresRepository !== true;
}

export function resolvePresentation(
  levels: PresentationLevels,
  context: PresentationDefaultsContext
): ResolvedPresentation {
  const resolved = {} as ResolvedPresentation;
  for (const id of PRESENTATION_FEATURE_IDS) {
    resolved[id] = isPresentationFeatureAvailable(id, context)
      ? (levels[id] ?? defaultPresentationLevel(id, context))
      : "hidden";
  }
  return resolved;
}

/** `{ presentationForgeStats: "demoted", … }` — the profile as `when` clause keys. */
export function buildPresentationWhenContext(
  resolved: ResolvedPresentation
): Record<string, PresentationLevel> {
  const context: Record<string, PresentationLevel> = {};
  for (const id of PRESENTATION_FEATURE_IDS) {
    context[PRESENTATION_FEATURES[id].contextKey] = resolved[id];
  }
  return context;
}
