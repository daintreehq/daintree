import { cn } from "@/lib/utils";

// One ink for every "where will it land" cue — insertion lines between chips
// and rows, and the perimeter of a drop slot. text-primary composited at 60%
// clears WCAG 1.4.11's 3:1 floor against the dock, sidebar and grid surfaces
// of all 15 built-in themes (worst case hokkaido's grid at 3.56:1); the
// border-strong hairline it replaces composited to 1.2–1.5:1 on every one of
// them, so on dark themes the line read as a chip edge. Neutral on purpose:
// accent is reserved for focus (design-system.md). Under forced colours the
// fill is repainted in CanvasText, the repo's convention for state marks.
//
// The utilities below spell the ink out in full: Tailwind only generates classes
// it can read verbatim from source, so `bg-${ink}` would silently compile to
// nothing and the line would paint transparent. The test asserts the literals
// still agree with DROP_INDICATOR_INK.
export const DROP_INDICATOR_INK = "text-primary/60";

/** A 2px insertion line. The caller adds the axis (`inset-y-0 w-0.5`) and edge. */
export const DROP_INDICATOR_LINE = cn(
  "pointer-events-none absolute z-10",
  "bg-text-primary/60 forced-colors:bg-[CanvasText]"
);

/** The perimeter of a drop slot, over the container's own surface. */
export const DROP_SLOT_FRAME = cn(
  "border border-text-primary/60 bg-overlay-subtle",
  "forced-colors:border-[CanvasText]"
);

/**
 * The same frame drawn inside a container that takes the drop as a whole: the
 * grid, the dock rail, the trash pill, a toolbar column. An inset outline, not
 * a border, so arming a target never shifts its layout, and not a ring, which
 * is a box-shadow that forced colours strip. Dashed there, because solid is the
 * focus ring's shape and a keyboard-focused container can also be the target,
 * and stepped in past the container's own edge: pills and settings groups get
 * a CanvasText border in that mode, and a dashed line drawn on top of it
 * disappears into it.
 * The sidebar's worktree card spells the same frame in sidebar.css, where its
 * unlayered base rules would beat these utilities.
 */
export const DROP_TARGET_FRAME = cn(
  "outline-1 -outline-offset-1 outline-text-primary/60 bg-overlay-subtle",
  "forced-colors:outline-dashed forced-colors:outline-[CanvasText] forced-colors:-outline-offset-3"
);
