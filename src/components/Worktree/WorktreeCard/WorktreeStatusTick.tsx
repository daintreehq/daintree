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
 * a 4px vertical in the grip gutter, which is what a dev tool already uses to
 * mean "this one wants looking at" — the SCM gutter bar, the Outlook unread
 * bar, the Discord unread tick.
 *
 * The slot is the title row's own height, and what varies is how many pieces it
 * is cut into. Length would have been the obvious knob and is the wrong one: it
 * is relative, so a card read on its own gives no reference for whether a short
 * bar is the middle state or the smallest. A count of segments is absolute —
 * one glance, no neighbour required — and the ink still descends with urgency:
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
 * round it has to be: three segments of a 22px row are 6px each, and that is
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
 * The card's status mark: a segmented vertical tick in the grip gutter.
 *
 * Positioned against the header's TITLE ROW, not the card, and stretched with
 * `inset-y-0` so its height is the row's height. That is the whole reason it
 * lives inside the header: a fixed height had to guess at the title's, and a
 * mark that guesses 16px against a 22px row sits proud of the text at both
 * ends. Deriving it means it cannot drift when the row's contents change —
 * the same trap the grip's own comment in `WorktreeCard` records paying for.
 *
 * `-start-2.5` (-10px) puts it dead centre of the 16px grip gutter, which is
 * the header's sibling column and therefore OUTSIDE this element's positioning
 * parent — hence the negative inset. The arithmetic is
 * `-(gutter + width) / 2 = -(16 + 4) / 2 = -10`, and it is exact only because
 * the tick is 4px: at 3px it lands on -9.5px and a half-pixel bar blurs.
 * The gutter is 16px whether or not the card has a grip (`ps-4` stands in for
 * it on the main worktree), so one offset serves every card.
 *
 * Logical `-start-*`, not `-left-*`: the gutter itself flips under RTL, so a
 * physical inset would leave the tick on the wrong side of the card.
 *
 * `gap-0.5` is a FIXED 2px whatever the row's height, which is what makes the
 * encoding safe to stretch: the gaps cannot close, and the gaps are the whole
 * signal. Segment heights follow the row and are only whole pixels when it
 * divides — 22px, the row's floor, gives 22 / 10 / 6 — so what a taller row
 * costs is a soft segment END, never a closed gap.
 *
 * Square ends, not the `rounded-full` of `.palette-row::before`. Both marks are
 * thin verticals near this edge, so radius is what keeps them apart: a pill is
 * selection, a rectangle is status. Do not round these.
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
      className="absolute inset-y-0 -start-2.5 z-10 flex w-1 cursor-default flex-col gap-0.5"
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
