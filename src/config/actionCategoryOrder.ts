/**
 * Browse-order taxonomy for the command palette's empty-query inventory.
 *
 * Deliberately separate from `categoryColors.ts`: that map is a visual badge
 * lookup whose keys have already drifted from the manifest (`agents`/`panels`
 * plural vs the `agent`/`panel` singular the definitions actually emit), so it
 * can't serve as the category source of truth.
 *
 * `ActionManifestEntry.category` is a plain `string`, not a union — plugins
 * contribute their own. So the order is a preference, never a filter: anything
 * unlisted still renders, appended alphabetically after the known set.
 */

/**
 * Fixed browse order. Sequenced by task flow rather than by how many actions a
 * category happens to hold — raw counts overweight low-level terminal and
 * worktree plumbing and would reshuffle as actions are added. Stability is the
 * point: a browse list that reorders itself between opens isn't browsable.
 */
export const ACTION_CATEGORY_ORDER: readonly string[] = [
  "worktree",
  "panel",
  "git",
  "project",
  "forge",
  "agent",
  "terminal",
  "files",
  "browser",
  "portal",
  "recipes",
  "devServer",
  "copyTree",
  "navigation",
  "app",
  "ui",
  "settings",
  "preferences",
  "voice",
  "help",
  "diagnostics",
  "logs",
  "errors",
  "system",
  "artifacts",
  "introspection",
];

/**
 * Display labels for the known categories. Plural where the category names a
 * countable thing the user manipulates ("Worktrees", "Panels"), singular where
 * it names a surface or subsystem ("Git", "Browser"). Everything else falls
 * through `humanizeActionCategory`.
 */
export const ACTION_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  worktree: "Worktrees",
  panel: "Panels",
  git: "Git",
  project: "Projects",
  forge: "Forge",
  agent: "Agents",
  terminal: "Terminals",
  files: "Files",
  browser: "Browser",
  portal: "Portal",
  recipes: "Recipes",
  devServer: "Dev server",
  copyTree: "CopyTree",
  navigation: "Navigation",
  app: "App",
  ui: "User interface",
  settings: "Settings",
  preferences: "Preferences",
  voice: "Voice",
  help: "Help",
  diagnostics: "Diagnostics",
  logs: "Logs",
  errors: "Errors",
  system: "System",
  artifacts: "Artifacts",
  introspection: "Introspection",
};

const ACTION_CATEGORY_RANK: ReadonlyMap<string, number> = new Map(
  ACTION_CATEGORY_ORDER.map((category, index) => [category, index])
);

const FALLBACK_CATEGORY_LABEL = "General";

/**
 * Sentence-case a category string the label map doesn't cover — a plugin's
 * category, or one added to the manifest without a label. `pluginTools` becomes
 * "Plugin tools", `custom-actions` becomes "Custom actions".
 */
export function humanizeActionCategory(category: string): string {
  const words = category
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim();
  if (words.length === 0) return FALLBACK_CATEGORY_LABEL;
  const lowered = words.toLowerCase();
  return lowered.charAt(0).toUpperCase() + lowered.slice(1);
}

/** Display label for a category, falling back to a humanized form. */
export function getActionCategoryLabel(category: string): string {
  return ACTION_CATEGORY_LABELS[category] ?? humanizeActionCategory(category);
}

/**
 * Order the given categories for browsing: the curated sequence first, then
 * everything else alphabetically. Never drops a category — an unknown one that
 * fell out of the list would take its actions with it, and the whole point of
 * the browse section is that the full surface is reachable.
 */
export function orderActionCategories(categories: Iterable<string>): string[] {
  return [...new Set(categories)].sort((a, b) => {
    const rankA = ACTION_CATEGORY_RANK.get(a);
    const rankB = ACTION_CATEGORY_RANK.get(b);
    if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
    // Known categories always precede unknown ones, so appending a plugin
    // category can never push a built-in group further down the list.
    if (rankA !== undefined) return -1;
    if (rankB !== undefined) return 1;
    const byLabel = a.toLowerCase().localeCompare(b.toLowerCase());
    return byLabel !== 0 ? byLabel : a.localeCompare(b);
  });
}
