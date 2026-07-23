/**
 * Shared TTL constants for scratch auto-cleanup. Imported by both the main
 * process (`ScratchCleanupService`) and the renderer (`ProjectSwitcherPalette`
 * countdown) so the user-visible countdown can never drift from the actual
 * deletion threshold.
 */

/**
 * A scratch is eligible for cleanup once `lastOpened` is older than this. At the
 * TTL the sweep tombstones the row (hiding it from every renderer-facing query),
 * which is also the point the UI countdown reaches zero.
 */
export const SCRATCH_CLEANUP_TTL_DAYS = 30;

/** TTL expressed in milliseconds for direct comparison against timestamps. */
export const SCRATCH_CLEANUP_TTL_MS = SCRATCH_CLEANUP_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * Minimum delay between tombstoning a scratch and physically removing its
 * directory. Tombstoning happens at the TTL; the directory is only reaped on a
 * later sweep once the tombstone is older than this grace window, so no
 * directory is destroyed in the same sweep it is first found stale. One day
 * spans several of the periodic sweep's four-hour cycles while keeping disk
 * reclamation prompt.
 */
export const SCRATCH_CLEANUP_GRACE_DAYS = 1;

/** Grace window expressed in milliseconds for direct comparison against `deletedAt`. */
export const SCRATCH_CLEANUP_GRACE_MS = SCRATCH_CLEANUP_GRACE_DAYS * 24 * 60 * 60 * 1000;

/** Show the cleanup countdown in the UI when within this many days of expiry. */
export const SCRATCH_CLEANUP_COUNTDOWN_VISIBLE_DAYS = 7;
