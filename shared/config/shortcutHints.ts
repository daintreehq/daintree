/** Invocation counts at which a shortcut hint is shown. Encodes the lifetime cap (set size). */
export const SHORTCUT_HINT_MILESTONES: ReadonlySet<number> = new Set([1, 2, 4, 8, 16, 32]);

/**
 * The count at which an action's hints are spent: no dispatch or hover hint can
 * fire past the last milestone, so neither process records increments from
 * here on. Each one Main persisted was a full config.json rewrite per click.
 */
export const SHORTCUT_HINT_EXHAUSTED_COUNT = Math.max(...SHORTCUT_HINT_MILESTONES) + 1;
