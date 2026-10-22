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
  "plugins",
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
 * Category ids built-in actions use that are not part of the browse order, plus
 * the plural spellings `categoryColors` keys on. A plugin's `category` is a
 * label under its own palette group, so none of these may be claimed: a plugin
 * saying `worktree` would otherwise read as the built-in group.
 */
const EXTRA_RESERVED_ACTION_CATEGORIES: readonly string[] = [
  "workspace",
  "test",
  "core",
  "github",
  "agents",
  "panels",
];

const RESERVED_ACTION_CATEGORY_KEYS: ReadonlySet<string> = new Set(
  [...ACTION_CATEGORY_ORDER, ...EXTRA_RESERVED_ACTION_CATEGORIES].map((c) => c.toLowerCase())
);

/** Longest `category` a plugin command may declare. */
export const PLUGIN_ACTION_CATEGORY_MAX_LENGTH = 40;

/**
 * Normalise a plugin-declared category for comparison and display: NFC, control
 * characters removed, outer whitespace trimmed.
 */
export function normalizePluginActionCategory(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .trim();
}

/** Whether a (normalised) category collides with a built-in category id. */
export function isReservedActionCategory(category: string): boolean {
  return RESERVED_ACTION_CATEGORY_KEYS.has(category.toLowerCase());
}
