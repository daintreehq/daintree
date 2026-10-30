import type { CSSProperties } from "react";

/** The narrowest the user can make the list: a row's mark, meters and gaps still leave its title room. */
export const CANOPY_LIST_MIN_WIDTH = 320;
export const CANOPY_LIST_MAX_WIDTH = 960;
/**
 * The room the pane beside the list keeps however wide the list is set: a
 * terminal at the default font still fits well past its 20 columns. A window
 * too narrow for both minimums shows the two halves alike.
 */
export const CANOPY_PANE_MIN_WIDTH = 320;

/** A width the user can keep, or null for one that isn't a number at all. */
export function clampCanopyListWidth(width: number): number | null {
  if (!Number.isFinite(width)) return null;
  return Math.round(Math.min(Math.max(width, CANOPY_LIST_MIN_WIDTH), CANOPY_LIST_MAX_WIDTH));
}

/** The widest the list can show beside the pane's minimum in a split this wide, never below the list's own minimum. */
export function canopyListAttainableWidth(splitWidth: number): number {
  if (splitWidth <= 0) return CANOPY_LIST_MAX_WIDTH;
  return Math.max(CANOPY_LIST_MIN_WIDTH, splitWidth - CANOPY_PANE_MIN_WIDTH);
}

/**
 * The list column's sizing, in the inbox and the pitch alike: the chosen width
 * over the stylesheet's window-sized default, and the pane's minimum its
 * `max-width` keeps clear.
 */
export function canopyListStyle(width: number | null): CSSProperties {
  const style: Record<string, string> = { "--canopy-pane-min-width": `${CANOPY_PANE_MIN_WIDTH}px` };
  if (width !== null) style["--canopy-list-width"] = `${width}px`;
  return style as CSSProperties;
}
