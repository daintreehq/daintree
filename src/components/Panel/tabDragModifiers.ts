import type { Modifier, Modifiers } from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { isKeyboardEvent } from "@dnd-kit/utilities";

// A pointer drag is bounded by the strip's scroll viewport (its tablist, the
// element the strips' autoScroll is limited to), never by the dragged node's
// parent: with animations on, each tab sits in a layout wrapper the size of
// the tab, and a parent bound pinned the drag inside it (#14971). A keyboard
// move always lands on a sibling's slot, and in an overflowing strip that slot
// can reach past the viewport before the sensor scrolls; clamping it there
// leaves the tab short of its neighbour and the move stalls.
const restrictPointerToStrip: Modifier = (args) =>
  isKeyboardEvent(args.activatorEvent) ? args.transform : restrictToFirstScrollableAncestor(args);

export const TAB_DRAG_MODIFIERS: Modifiers = [restrictToHorizontalAxis, restrictPointerToStrip];
