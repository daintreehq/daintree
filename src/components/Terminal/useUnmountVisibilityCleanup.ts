import { useEffect } from "react";
import { terminalInstanceService } from "@/services/TerminalInstanceService";

/**
 * Marks the panel hidden in the store when the pane unmounts — guarded by the
 * attach generation captured at mount. During a warm-swap the old pane's
 * cleanup can fire after the replacement pane has already re-attached (the
 * generation advanced); writing false then would poison store visibility
 * while the service stays visible, pinning the computed refresh tier at
 * BACKGROUND and trapping the reconciliation watchdog in a repair loop
 * (#10416). restartKey is in the deps because a restart re-attaches under a
 * new generation — without re-capturing, the final real unmount would be
 * mistaken for a stale cleanup and skipped.
 *
 * StrictMode double-invoke is safe: XtermAdapter's attach (useLayoutEffect,
 * generation bump) replays before this passive effect first runs, so the
 * captured generation matches the live mount and the replayed cleanup writes
 * false at worst transiently — the IntersectionObserver's first real reading
 * restores it, same as the unguarded cleanup this hook replaced.
 */
export function useUnmountVisibilityCleanup(
  id: string,
  restartKey: number,
  updateVisibility: (id: string, isVisible: boolean) => void
): void {
  useEffect(() => {
    const gen = terminalInstanceService.getAttachGeneration(id);
    return () => {
      if (terminalInstanceService.getAttachGeneration(id) === gen) {
        updateVisibility(id, false);
      }
    };
  }, [id, restartKey, updateVisibility]);
}
