import type { ReactNode } from "react";
import { TERMINAL_SCROLLBAR_WIDTH } from "@/config/xtermConfig";

// XtermAdapter pads the terminal `pl-3`/`pr-3` and xterm draws its overlay
// scrollbar inside the right padding, so the track runs from 12px to 12px +
// TERMINAL_SCROLLBAR_WIDTH off the pane's right edge. Each chip sits 2px inside
// the text column, which frames the column symmetrically and keeps the trailing
// chip off the track — a chip over the track swallows track clicks and hides
// the thumb, which sits right there whenever the user is only a few lines back.
export const CHIP_ROW_LEFT_INSET = 14;
export const CHIP_ROW_RIGHT_INSET = 14 + TERMINAL_SCROLLBAR_WIDTH;

export interface TerminalChipRowProps {
  /** Pinned to the leading edge; shrinks first when the row runs out of width. */
  leading?: ReactNode;
  /** Pinned to the trailing edge at its natural width. */
  trailing?: ReactNode;
}

/**
 * The row of floating chips along the bottom of a terminal viewport — the
 * fleet drafting chip leading, "New output below" trailing. One row rather than
 * two stacked overlays, so on a narrow pane the chips share the width budget and
 * keep a gap instead of sliding under each other.
 *
 * `overflow-hidden` keeps the chips' floating shadow inside the viewport.
 * Unclipped, the light themes' deep floating shadow smeared a grey patch across
 * the composer below. Popovers opened from a chip portal out, so nothing is cut.
 */
export function TerminalChipRow({ leading, trailing }: TerminalChipRowProps) {
  return (
    <div
      className="absolute inset-0 z-30 pointer-events-none overflow-hidden flex items-end gap-2 pb-1.5"
      style={{ paddingLeft: CHIP_ROW_LEFT_INSET, paddingRight: CHIP_ROW_RIGHT_INSET }}
    >
      {/* The fleet chip has no hit-target opt-in of its own; ScrollPill bakes one in. */}
      <div className="pointer-events-auto min-w-0 flex">{leading}</div>
      <div className="ml-auto shrink-0 flex">{trailing}</div>
    </div>
  );
}
