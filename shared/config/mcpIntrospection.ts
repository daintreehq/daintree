/**
 * Bounds for `actions.search`, shared because two processes depend on them
 * agreeing. The renderer owns the tool's zod schema and its result slice; main
 * over-fetches to the same ceiling before applying the caller's tier filter
 * (#11525). If these drifted apart — a renderer maximum of 50 against a main
 * over-fetch of 100 — every valid search would be rewritten into a request the
 * renderer then rejects, so they resolve from one constant rather than three
 * copies.
 */
export const ACTIONS_SEARCH_MAX_LIMIT = 100;
export const ACTIONS_SEARCH_DEFAULT_LIMIT = 20;

/**
 * Page bounds for `actions.list` (#11529), shared for the same reason: the
 * renderer pages the match set, but tier filtering happens in main, so main
 * has to walk those pages itself before it can page the *permitted* set.
 */
export const ACTIONS_LIST_MAX_LIMIT = 100;
export const ACTIONS_LIST_DEFAULT_LIMIT = 50;

/**
 * The page main's own `actions.list` walk asks a local view for (#17036), so a
 * registry of a few hundred actions comes back in one round trip rather than
 * one per hundred. Never a caller's: the tool's schema still caps a call at
 * `ACTIONS_LIST_MAX_LIMIT`, and main pages the permitted set back down to the
 * page the caller asked for.
 */
export const ACTIONS_LIST_WALK_LIMIT = 1000;
