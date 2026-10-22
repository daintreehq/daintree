/**
 * The per-project presentation profile (#13771): how much room each built-in
 * surface takes in one project.
 *
 * The vocabulary is closed and host-owned. A feature joins it only by a host
 * change here, and nothing a profile can name is a safety or observation
 * signal — agent state and attention, conflicts, dirty state, the trust banner,
 * Project settings, the plugin manager and the launcher are never features,
 * so no profile, the user's or a repository's, can quiet them.
 *
 * Toolbar features (#13783) only ever demote: a demoted button moves into the
 * toolbar's `…` overflow, where it still launches what it always did. The
 * toolbar buttons that carry state or reach the rest of the app — the app
 * menu, sidebar, assistant and portal toggles, memory pause, voice recording,
 * problems, notifications, Canopy, settings, the launcher, the plugin tray and
 * the overflow itself — are never features.
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
   * What a level is called for this feature where the generic word misleads
   * ("Quiet" git detail stays on the card, so it is not "demoted" anywhere).
   * The level itself, and its `when` value, are unchanged.
   */
  levelWords?: Partial<Record<PresentationLevel, { label: string; verb: string }>>;
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
  /**
   * The toolbar item this feature places (#13783): its button id, or `true`
   * for a toolbar surface with no button of its own (the branch chip). Toolbar
   * features follow "Use this project's toolbar" — while that is off they draw
   * as the app-wide toolbar does.
   */
  toolbar?: string | true;
}

const DEMOTABLE: readonly PresentationLevel[] = ["shown", "demoted"];
const shownByDefault = () => "shown" as const;

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
    toolbar: "forge-stats",
  },
  copyTree: {
    label: "CopyTree",
    noun: "CopyTree",
    description: "The toolbar button that copies the worktree's context for an agent",
    levels: DEMOTABLE,
    contextKey: "presentationCopyTree",
    defaultLevel: shownByDefault,
    toolbar: "copy-tree",
  },
  resumeSessions: {
    label: "Resume sessions",
    noun: "resume sessions",
    description: "The toolbar button that reopens agent sessions from earlier",
    levels: DEMOTABLE,
    contextKey: "presentationResumeSessions",
    defaultLevel: shownByDefault,
    toolbar: "resume-sessions",
  },
  terminal: {
    label: "Terminal button",
    noun: "the terminal button",
    description: "The toolbar button that opens a terminal",
    levels: DEMOTABLE,
    contextKey: "presentationTerminal",
    defaultLevel: shownByDefault,
    toolbar: "terminal",
  },
  fileBrowser: {
    label: "File browser button",
    noun: "the file browser button",
    description: "The toolbar button that opens the file browser",
    levels: DEMOTABLE,
    contextKey: "presentationFileBrowser",
    defaultLevel: shownByDefault,
    toolbar: "file-browser",
  },
  browser: {
    label: "Browser button",
    noun: "the browser button",
    description: "The toolbar button that opens a browser",
    levels: DEMOTABLE,
    contextKey: "presentationBrowser",
    defaultLevel: shownByDefault,
    toolbar: "browser",
  },
  devServer: {
    label: "Dev server button",
    noun: "the dev server button",
    description: "The toolbar button that starts the dev server",
    levels: DEMOTABLE,
    contextKey: "presentationDevServer",
    defaultLevel: shownByDefault,
    toolbar: "dev-server",
  },
  branchChip: {
    label: "Branch chip",
    noun: "the branch chip",
    description: "The current branch on the project pill",
    levels: DEMOTABLE,
    contextKey: "presentationBranchChip",
    defaultLevel: shownByDefault,
    // A folder without a repository has no branch to name.
    requiresRepository: true,
    toolbar: true,
  },
  gitDetail: {
    label: "Git detail",
    noun: "git detail",
    description:
      "The branch, pull request, issue and last-commit detail on worktree cards, and their git menu rows",
    // No hidden level: quiet moves the detail into the card's expanded details
    // and its menu's Git submenu, and nothing here should leave a card unable
    // to say which branch it is on.
    levels: ["shown", "demoted"],
    levelWords: { demoted: { label: "Quiet", verb: "quieting" } },
    contextKey: "presentationGitDetail",
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

/** Whether `feature` places something on the toolbar, and so follows "Use this project's toolbar". */
export function isToolbarPresentationFeature(feature: PresentationFeatureId): boolean {
  const definition: PresentationFeatureDefinition = PRESENTATION_FEATURES[feature];
  return definition.toolbar !== undefined;
}

/** The toolbar features that place a button, keyed by that button's id. */
export const PRESENTATION_FEATURE_BY_TOOLBAR_BUTTON: ReadonlyMap<string, PresentationFeatureId> =
  new Map(
    PRESENTATION_FEATURE_IDS.flatMap((id) => {
      const toolbar = (PRESENTATION_FEATURES[id] as PresentationFeatureDefinition).toolbar;
      return typeof toolbar === "string" ? [[toolbar, id] as const] : [];
    })
  );

/** At most this many of a project plugin's own toolbar buttons can be promoted by its profile. */
export const MAX_PROMOTED_PLUGIN_BUTTONS = 3;

/**
 * Whether this project's toolbar overlay applies (#13783). An explicit choice
 * wins; with none, it is on exactly when the profile places something on the
 * toolbar, so a project nobody has touched keeps the app-wide toolbar.
 */
export function isProjectToolbarActive(profile: {
  levels: PresentationLevels;
  useProjectToolbar: boolean | null;
  promotedPluginButtons: readonly string[];
}): boolean {
  if (profile.useProjectToolbar !== null) return profile.useProjectToolbar;
  return hasProjectToolbarOverrides(profile);
}

/** Whether the profile sets anything the toolbar draws differently. */
export function hasProjectToolbarOverrides(profile: {
  levels: PresentationLevels;
  promotedPluginButtons: readonly string[];
}): boolean {
  return (
    profile.promotedPluginButtons.length > 0 ||
    PRESENTATION_FEATURE_IDS.some(
      (id) => isToolbarPresentationFeature(id) && profile.levels[id] !== undefined
    )
  );
}

/**
 * `toolbar: false` resolves every toolbar feature to its default, which is
 * what "Use this project's toolbar" turned off means; the levels stay stored.
 */
export function resolvePresentation(
  levels: PresentationLevels,
  context: PresentationDefaultsContext,
  options: { toolbar?: boolean } = {}
): ResolvedPresentation {
  const resolved = {} as ResolvedPresentation;
  const toolbar = options.toolbar ?? true;
  for (const id of PRESENTATION_FEATURE_IDS) {
    const applies = toolbar || !isToolbarPresentationFeature(id);
    resolved[id] = isPresentationFeatureAvailable(id, context)
      ? ((applies ? levels[id] : undefined) ?? defaultPresentationLevel(id, context))
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
