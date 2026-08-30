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
 * a 4px vertical, which is what a dev tool already uses to mean "this one wants
 * looking at" — the SCM gutter bar, the Outlook unread bar, the Discord unread
 * tick.
 *
 * The slot is a FIXED 16px, and what varies is how many pieces it is cut into.
 * Length would have been the obvious knob and is the wrong one: it is relative,
 * so a card read on its own gives no reference for whether a short bar is the
 * middle state or the smallest. A count of segments is absolute — one glance,
 * no neighbour required — and the ink still descends with urgency:
 *
 *   waiting  — one unbroken bar. The most ink, the only state that is blocking
 *              on the person reading it.
 *   cleanup  — two segments. Same slot, same footprint, visibly interrupted:
 *              something to decide, not something to answer.
 *   complete — three segments. The most broken up and the least ink, for the
 *              state that wants nothing.
 *
 * That order also puts the coarsest shape on the state that most needs reading
 * at a glance and the fussiest on the one that wants nothing, which is the way
 * round it has to be: three segments of a 16px slot are 4px each, and that is
 * the smallest thing here.
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
 * The card's status mark: a segmented vertical tick in the card's top-left
 * corner.
 *
 * Positioned against the CARD, and 16px tall whatever the header does. It was
 * stretched to the title row's own height for a round, which is what a mark
 * anchored inside the header can do — and that is exactly why it stopped
 * working: a bar the height of the title, starting on the title's top edge and
 * ending on its bottom one, reads as punctuation belonging to that line rather
 * than as a statement about the card. The corner is what buys the hierarchy.
 * The row's height is the header's business and this mark is not the header's.
 *
 * 16px + `gap-0.5` is the one pairing where every count divides into whole
 * pixels — one segment is 16px, two are 7px either side of the 2px gap, three
 * are 4px. A count that landed on a half pixel would blur at 1x, and the blur
 * closes the gaps, which is the whole encoding. It is also less total ink than
 * the 12x12 corner wedge this lineage started from.
 *
 * The corner means the CORNER: flush at 0,0. A mark held off the edge by a few
 * pixels is a mark floating near a corner, and the whole point of the position
 * is that it is outside the content entirely. The inset is not a design knob,
 * it is a clearance — so it is spent only where something is actually there to
 * clear, which is one surface and not the other:
 *
 * - `sidebar` — the card is square and full-bleed (`sidebar.css` cuts the rows
 *   apart with a `border-bottom` gutter, no radius), so nothing clips and the
 *   mark goes on the corner itself.
 * - `grid` — the overview cell is `rounded-lg overflow-hidden`, so its arc eats
 *   whatever sits inside it. `--radius-lg` is 10px scaled by the theme's
 *   `--theme-radius-scale`, and inside the cell's 1px border the clip radius is
 *   R-1. A mark at inset `i` on both axes survives when its top-left corner is
 *   inside the arc, i.e. `i >= r(1 - 1/sqrt2)` — about 2.64px at the default
 *   r=9. 4px is the first whole pixel past that, keeps ~1.4px of slack, and the
 *   largest built-in (R=10.5) costs 0.2px of it. A custom `radiusScale` past
 *   ~1.5 would start shaving the first segment; the theme schema puts no
 *   ceiling on that number, so it is the one thing that can move this.
 *
 * Equal on both axes wherever it is inset, so the mark sits on the corner's
 * diagonal rather than hanging off one edge of it.
 *
 * Logical `start-*`, not `left-*`: the overview grid's membership rail is
 * itself logical, so a physical inset would put the two on the same side again
 * under RTL.
 *
 * `z-30`, not the `z-20` this sat at while it was inset. Three full-card
 * overlays paint at `z-20` and come later in the tree, so they win the tie: the
 * border flash and the input receipt (`inset-0` in `WorktreeCard`) and
 * sidebar.css's `::after` drop-target ring (`inset 0 0 0 2px`). At 4px in, none
 * of them reached the mark. Flush on the edge, all three run straight down it —
 * and a continuous line over a segmented one does not merely tint it, it
 * BRIDGES the gaps and flattens all three states to one bar. The forced-colors
 * row outline is fine either way: an `outline` on the card root paints with the
 * root, below any positioned descendant. Nothing needs to cover a 4px mark, so
 * it goes above them.
 *
 * Square ends, not the `rounded-full` of `.palette-row::before`. Both marks are
 * thin verticals near this edge, so radius is what keeps them apart: a pill is
 * selection, a rectangle is status. Do not round these.
 */
export function WorktreeStatusTick({
  state,
  variant = "sidebar",
  ...rest
}: {
  state: WorktreeStatusTickState;
  /** Which card the mark is sitting on — the corner it gets is a property of that card's radius, not of the mark. */
  variant?: "sidebar" | "grid";
} & React.ComponentProps<"div">) {
  return (
    <div
      // Spread first: the card wraps this in a `TooltipTrigger asChild`, which
      // clones the element with its own handlers and ref. Anything below this
      // line is the component's own and must win over what Radix passes.
      {...rest}
      className={cn(
        "absolute z-30 flex h-4 w-1 cursor-default flex-col gap-0.5",
        variant === "grid" ? "top-1 start-1" : "top-0 start-0"
      )}
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
