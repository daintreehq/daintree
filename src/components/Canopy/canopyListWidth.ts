import type { CSSProperties } from "react";

/** The narrowest the user can make the list: a row's mark, meters and gaps still leave its title room. */
export const CANOPY_LIST_MIN_WIDTH = 320;
export const CANOPY_LIST_MAX_WIDTH = 960;
/**
 * The room the pane beside the list keeps however wide the list is set: the
 * terminal's 20 columns at the largest font (24px), with the pane's padding,
 * the frame's inset and the scrollbar. Where that would leave the list
 * narrower than the pane, the two split evenly instead.
 */
export const CANOPY_PANE_MIN_WIDTH = 360;

/** A width the user can keep, or null for one that isn't a number at all. */
export function clampCanopyListWidth(width: number): number | null {
  if (!Number.isFinite(width)) return null;
  return Math.round(Math.min(Math.max(width, CANOPY_LIST_MIN_WIDTH), CANOPY_LIST_MAX_WIDTH));
}

/**
 * The widest the list can show in a split this wide, as `.canopy-list-column`'s
 * `max-width` works it out: all but the pane's minimum, or half the split,
 * whichever is wider. Unmeasured, nothing narrows it.
 */
export function canopyListRoom(splitWidth: number): number {
  if (splitWidth <= 0) return CANOPY_LIST_MAX_WIDTH;
  return Math.max(splitWidth - CANOPY_PANE_MIN_WIDTH, splitWidth / 2);
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
