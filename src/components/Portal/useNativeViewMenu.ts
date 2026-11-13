import { useCallback, useEffect, useRef, useState } from "react";
import { useOverlayClaim } from "@/hooks";

/**
 * A menu drawn over the portal's native page view. While it is open it claims
 * an overlay so the page hides instead of painting over it, and because portal
 * actions refuse to act while any overlay is claimed, a chosen command runs only
 * once the menu has closed and released its claim.
 *
 * `enabled` is for a menu whose trigger can unmount while it is open, which
 * Radix never reports as a close: turning it off closes the menu, releases the
 * claim and runs anything already chosen.
 */
export function useNativeViewMenu(claimId: string, enabled = true) {
  const [open, setOpen] = useState(false);
  if (!enabled && open) setOpen(false);
  const isOpen = open && enabled;
  const pendingRef = useRef<(() => void) | null>(null);
  // The claim drops in an effect cleanup, and a commit runs every cleanup
  // before any effect body, so the chosen command runs with the claim gone.
  useOverlayClaim(claimId, isOpen);
  useEffect(() => {
    if (isOpen || !pendingRef.current) return;
    const run = pendingRef.current;
    pendingRef.current = null;
    run();
  }, [isOpen]);
  const afterClose = useCallback(
    (run: () => void) => () => {
      pendingRef.current = run;
    },
    []
  );
  return { open: isOpen, setOpen, afterClose };
}
