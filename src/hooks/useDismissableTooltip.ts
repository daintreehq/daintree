import { useCallback, useRef, useState } from "react";

/**
 * Controlled-open state for a Radix tooltip that hides on click and won't pop
 * back up while focus/pointer settles on the trigger afterwards — the toolbar's
 * tooltip-suppression pattern (AgentButton, DockLaunchButton) lifted into one
 * hook. Radix opens tooltips on focus as well as hover, so a click that draws
 * focus back to the trigger (or reveals a popover over it) would otherwise leave
 * the hover tooltip stranded open. Spread `open`/`onOpenChange` onto <Tooltip>
 * and `onPointerEnter` onto its trigger, then call `dismiss()` from the click
 * handler that owns the trigger's primary action.
 */
export function useDismissableTooltip() {
  const [open, setOpen] = useState(false);
  const suppressReopenRef = useRef(false);

  const onOpenChange = useCallback((next: boolean) => {
    // Block the re-open Radix fires when focus/pointer lands back on the trigger
    // right after a click; cleared by the next genuine pointer hover.
    if (next && suppressReopenRef.current) return;
    setOpen(next);
  }, []);

  const onPointerEnter = useCallback(() => {
    suppressReopenRef.current = false;
  }, []);

  const dismiss = useCallback(() => {
    suppressReopenRef.current = true;
    setOpen(false);
  }, []);

  return { open, onOpenChange, onPointerEnter, dismiss };
}
