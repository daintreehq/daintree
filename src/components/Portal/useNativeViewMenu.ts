import { useCallback, useEffect, useRef, useState } from "react";
import { useOverlayClaim } from "@/hooks";

/**
 * A menu drawn over the portal's native page view. While it is open it claims
 * an overlay so the page hides instead of painting over it, and because portal
 * actions refuse to act while any overlay is claimed, a chosen command runs only
 * once the menu has closed and released its claim.
 */
export function useNativeViewMenu(claimId: string) {
  const [open, setOpen] = useState(false);
  const pendingRef = useRef<(() => void) | null>(null);
  useOverlayClaim(claimId, open);
  useEffect(() => {
    if (open || !pendingRef.current) return;
    const run = pendingRef.current;
    pendingRef.current = null;
    run();
  }, [open]);
  const afterClose = useCallback(
    (run: () => void) => () => {
      pendingRef.current = run;
    },
    []
  );
  return { setOpen, afterClose };
}
