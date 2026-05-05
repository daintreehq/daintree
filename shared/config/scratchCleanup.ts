/**
 * Shared TTL constants for scratch auto-cleanup. Imported by both the main
 * process (`ScratchCleanupService`) and the renderer (`ProjectSwitcherPalette`
 * countdown) so the user-visible countdown can never drift from the actual
 * deletion threshold.
 */

/** A scratch is eligible for cleanup once `lastOpened` is older than this. */
export const SCRATCH_CLEANUP_TTL_DAYS = 30;

/** TTL expressed in milliseconds for direct comparison against timestamps. */
export const SCRATCH_CLEANUP_TTL_MS = SCRATCH_CLEANUP_TTL_DAYS * 24 * 60 * 60 * 1000;

/** Show the cleanup countdown in the UI when within this many days of expiry. */
export const SCRATCH_CLEANUP_COUNTDOWN_VISIBLE_DAYS = 7;
