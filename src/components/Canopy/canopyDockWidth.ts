import { RESIZE_HANDLE_INLINE_TRACK_PX } from "@/components/ui/ResizeHandle";
import { CANOPY_PANE_MIN_WIDTH } from "./canopyListWidth";

/**
 * The global assistant docked beside the selected agent (#16214): each pane
 * keeps the room one pane alone keeps, the terminal's 20 columns at the
 * largest font, and the user can widen the assistant up to the list's own cap.
 */
export const CANOPY_DOCK_MIN_WIDTH = CANOPY_PANE_MIN_WIDTH;
export const CANOPY_DOCK_MAX_WIDTH = 960;

/** Narrower than this, the two panes stack, the agent above the assistant. */
export const CANOPY_DOCK_SIDE_BY_SIDE_MIN =
  CANOPY_PANE_MIN_WIDTH + RESIZE_HANDLE_INLINE_TRACK_PX + CANOPY_DOCK_MIN_WIDTH;

/** A width the user can keep, or null for one that isn't a number at all. */
export function clampCanopyDockWidth(width: number): number | null {
  if (!Number.isFinite(width)) return null;
  return Math.round(Math.min(Math.max(width, CANOPY_DOCK_MIN_WIDTH), CANOPY_DOCK_MAX_WIDTH));
}

/**
 * Whether a split this wide sits the two panes side by side. Unmeasured, it
 * does: nothing has said the room is short.
 */
export function canopyDockSideBySide(splitWidth: number): boolean {
  return splitWidth <= 0 || splitWidth >= CANOPY_DOCK_SIDE_BY_SIDE_MIN;
}

/**
 * The widest the assistant can show in a split this wide: all but the agent
 * pane's minimum and the handle's track. Unmeasured, nothing narrows it.
 */
export function canopyDockRoom(splitWidth: number): number {
  if (splitWidth <= 0) return CANOPY_DOCK_MAX_WIDTH;
  return Math.max(
    CANOPY_DOCK_MIN_WIDTH,
    splitWidth - CANOPY_PANE_MIN_WIDTH - RESIZE_HANDLE_INLINE_TRACK_PX
  );
}
