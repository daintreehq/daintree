/**
 * Bounds and steps for the file-browser tree column's draggable width (#11331).
 *
 * Fixed constants rather than container-relative bounds, matching the two
 * existing resize handles (worktree `Sidebar` 200/600, `PortalDock` 320/1200):
 * the viewer half is already `min-w-0 flex-1`, so it shrinks/scrolls when the
 * panel is narrow, and a persisted width that never depends on transient
 * layout stays stable across restores and window sizes.
 */
export const FILE_BROWSER_SIDEBAR_DEFAULT_WIDTH = 288; // the old fixed `w-72`
export const FILE_BROWSER_SIDEBAR_MIN_WIDTH = 200;
export const FILE_BROWSER_SIDEBAR_MAX_WIDTH = 600;
/** Keyboard nudge; Shift multiplies to the coarse step. */
export const FILE_BROWSER_SIDEBAR_RESIZE_STEP = 10;
export const FILE_BROWSER_SIDEBAR_RESIZE_STEP_COARSE = 50;

/**
 * Clamp a width into the allowed range, folding non-finite input (`NaN`,
 * `Infinity`) back to the default. `Math.min(Math.max(NaN, …))` is `NaN`, which
 * would otherwise survive as an invalid inline `style.width` and, because
 * `NaN !== NaN`, churn the store on every write — so the finite guard is
 * load-bearing, not cosmetic.
 */
export function clampFileBrowserSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return FILE_BROWSER_SIDEBAR_DEFAULT_WIDTH;
  return Math.min(
    Math.max(width, FILE_BROWSER_SIDEBAR_MIN_WIDTH),
    FILE_BROWSER_SIDEBAR_MAX_WIDTH
  );
}

/**
 * Normalize a possibly-untrusted persisted width to a valid number or
 * undefined. The snapshot schema passes unknown keys through, so a hand-edited
 * or corrupted value (a string, `NaN`, `Infinity`) must fall back to the
 * default rather than reach the pane as an inline `style.width`; a finite
 * number is clamped into range.
 */
export function normalizeFileBrowserSidebarWidth(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return clampFileBrowserSidebarWidth(value);
}
