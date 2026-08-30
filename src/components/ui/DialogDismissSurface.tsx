import { useEffect } from "react";
import { useDismissableLayerSurface } from "@radix-ui/react-dismissable-layer";

/**
 * Teaches Radix that a click inside an {@link AppDialog} counts as a click
 * outside any popover the dialog hosts.
 *
 * Without this, every combobox, picker and menu opened inside a dialog stays
 * open once you click elsewhere in the form — only Escape or a second click on
 * its own trigger would dismiss it. The chain:
 *
 * 1. `AppDialog` portals into `<body>` and stops click propagation on its
 *    panel, because React events travel the React tree: without it a click
 *    inside the dialog would reach the handlers of whatever component rendered
 *    it. React's `stopPropagation` stops the NATIVE event too, and it does so
 *    at the portal container — one hop below `document`.
 * 2. Radix defers popover dismissal to the click after the outside pointerdown,
 *    and since 1.1.15 it reads a click that never reaches `document` as
 *    "intercepted" and cancels the dismissal (radix-ui#3346).
 *
 * A layer's own dismiss affordance is exactly the case that mechanism carves
 * out, so the dialog registers itself as one. That is the whole fix: nothing is
 * added here, one thing is stopped from being suppressed.
 *
 * The static Radix import is deliberate — `dismissable-layer` is a leaf module
 * (its only sizeable dependency, `react-slot`, is already eager via `button`),
 * and the hook has to be a stable function identity or the React Compiler bails
 * out of every component that reaches it.
 */
export function DialogDismissSurface({ node }: { node: HTMLDivElement | null }) {
  // Radix keys its registry off the node it is handed and drops it when this
  // component unmounts, so the effect only has to keep it pointed at the
  // current one.
  const setSurface = useDismissableLayerSurface();
  useEffect(() => {
    setSurface(node);
  }, [node, setSurface]);
  return null;
}
