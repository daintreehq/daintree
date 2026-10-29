import type { Modifiers } from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";

// Bounded by the strip's scroll viewport (its tablist, the element the strips'
// autoScroll is limited to), never by the dragged node's parent: with
// animations on, each tab sits in a layout wrapper the size of the tab, and a
// parent bound pinned the drag inside it (#14971).
export const TAB_DRAG_MODIFIERS: Modifiers = [
  restrictToHorizontalAxis,
  restrictToFirstScrollableAncestor,
];
