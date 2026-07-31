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
