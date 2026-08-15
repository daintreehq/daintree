/**
 * How long a project keeps its "recently active" mark in the switcher (#11791).
 *
 * Shared because the deadline is computed in main (ProjectStore stamps an
 * absolute `recentlyActiveUntil` on every project it returns) and compared in
 * the renderer against a ticking clock — one constant, two processes.
 */
export const RECENTLY_ACTIVE_WINDOW_MS = 15 * 60 * 1000;
