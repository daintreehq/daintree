import type * as React from "react";
import { cn } from "@/lib/utils";
import type { ChipState } from "../utils/computeChipState";

export type WorktreeStatusTickState = Exclude<ChipState, null>;

/** Shared by the tick's tooltip and its accessible name, so they cannot drift. */
export const CHIP_LABELS: Record<WorktreeStatusTickState, string> = {
  waiting: "Agent waiting for input",
  cleanup: "Ready for cleanup",
  complete: "Complete: in review",
};

/**
 * How many pieces the tick's slot is cut into, one count per state.
 *
 * Colour cannot be the only difference between the states (WCAG 1.4.1), and
 * this mark is the only place on the card where `cleanup` and `complete` are
 * distinguished at all — so the second channel is doing real work, not
 * decoration. Under `forced-colors` it is the ONLY channel: `.status-mark`
 * repaints every state as one system colour, so whatever tells them apart
 * there has to be geometry.
 *
 * This was three 45-degree corner wedges for several rounds. A dog-ear is a
 * loaded shape (spreadsheet cell comment, unsaved-file marker, resize handle,
 * bookmark) and three wedges that differ only in how much of a 12x12 box they
 * fill do not actually separate at that size. The tick trades the diagonal for
 * a 3x16 rectangle on the leading edge, which is what a dev tool already uses
 * to mean "this one wants looking at" — the SCM gutter bar, the Outlook unread
 * bar, the Discord unread tick.
 *
 * The slot is a FIXED 16px, and what varies is how many pieces it is cut into.
 * Length would have been the obvious knob and is the wrong one: it is relative,
 * so a card read on its own gives no reference for whether a short bar is the
 * middle state or the smallest. A count of segments is absolute — one glance,
 * no neighbour required — and the ink still descends with urgency:
 *
 *   waiting  — one unbroken 16px bar. The most ink, the only state that is
 *              blocking on the person reading it.
 *   cleanup  — two segments. Same slot, same footprint, visibly interrupted:
 *              something to decide, not something to answer.
 *   complete — three segments. The most broken up and the least ink, for the
 *              state that wants nothing.
 *
 * That order also puts the coarsest shape on the state that most needs reading
 * at a glance and the fussiest on the one that wants nothing, which is the way
 * round it has to be: three segments are 4px each, and 4px is the smallest
 * thing here.
 */
export const CHIP_SEGMENTS: Record<WorktreeStatusTickState, number> = {
  waiting: 1,
  cleanup: 2,
  complete: 3,
};

const CHIP_FILLS: Record<WorktreeStatusTickState, string> = {
  waiting: "bg-activity-waiting",
  cleanup: "bg-pr-merged",
  complete: "bg-category-blue",
};

/**
 * The card's status mark: a segmented vertical tick on the leading edge.
 *
 * Geometry is load-bearing in three directions, so none of these numbers are
 * free:
 *
 * `h-4` + `gap-0.5` is the one pairing where every count divides into whole
 * pixels — one segment is 16px, two are 7px either side of the 2px gap, three
 * are 4px. A count that landed on a half pixel would blur at 1x, and the blur
 * closes the gaps, which is the whole encoding.
 *
 * `top-2.5` clears the grid variant's 8px corner radius. That offset is what
 * lets one geometry serve both variants and is why the mark no longer has to be
 * a corner wedge to survive the rounded card.
 *
 * `start-1` clears the 2px inset outlines that full-card focus and cursor
 * states paint — the grid keyboard cursor, the sidebar focus ring, the
 * drop-target ring, and the forced-colors membership fallback. Those outlines
 * are CONTINUOUS: drawn over the tick they would not merely cover it, they
 * would bridge its gaps and flatten every state to one bar for exactly the
 * forced-colors reader who has nothing but the gaps left.
 *
 * Square ends, not the `rounded-full` of `.palette-row::before`. Both marks are
 * 3px verticals near this edge, so radius is what keeps them apart: a pill is
 * selection, a rectangle is status. Do not round these.
 *
 * Logical `start-*`, not `left-*`: the selection rail this is separated from is
 * itself logical, so a physical inset would put the two on the same side again
 * under RTL.
 */
export function WorktreeStatusTick({
  state,
  ...rest
}: { state: WorktreeStatusTickState } & React.ComponentProps<"div">) {
  return (
    <div
      // Spread first: the card wraps this in a `TooltipTrigger asChild`, which
      // clones the element with its own handlers and ref. Anything below this
      // line is the component's own and must win over what Radix passes.
      {...rest}
      className="absolute top-2.5 start-1 z-10 flex h-4 w-[3px] cursor-default flex-col gap-0.5"
      data-testid="worktree-status-tick"
      data-state={state}
      role="img"
      aria-label={CHIP_LABELS[state]}
    >
      {Array.from({ length: CHIP_SEGMENTS[state] }, (_, index) => (
        <span
          key={index}
          data-testid="worktree-status-tick-segment"
          className={cn(
            // status-mark: the fill is the whole signal, so forced colors has
            // to repaint it rather than flatten it to the canvas. It goes on
            // each SEGMENT, never the container — the gaps are real absences
            // between elements, and that is what keeps the three states apart
            // once the repaint has taken the hue away.
            "status-mark flex-1",
            CHIP_FILLS[state]
          )}
        />
      ))}
    </div>
  );
}
