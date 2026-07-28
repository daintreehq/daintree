import { useEffect, useRef } from "react";
import { terminalInstanceService } from "@/services/TerminalInstanceService";

/**
 * Marks the panel hidden in the store when the pane unmounts — guarded by the
 * attach generation this mount owns. During a warm-swap the old pane's
 * cleanup can fire after the replacement pane has already re-attached (the
 * generation advanced); writing false then would poison store visibility
 * while the service stays visible, pinning the computed refresh tier at
 * BACKGROUND and trapping the reconciliation watchdog in a repair loop
 * (#10416). restartKey is in the deps because a restart re-attaches under a
 * new generation — without re-capturing, the final real unmount would be
 * mistaken for a stale cleanup and skipped.
 *
 * The owned generation is re-read on `attachEpoch` rather than in the cleanup
 * effect's own deps, and the two are deliberately split. This mount's OWN
 * attach lands asynchronously (XtermAdapter awaits `getOrCreate`), so a
 * generation captured at mount is routinely one behind — and a cleanup
 * comparing against it would read the pane's own attach as someone else's
 * warm-swap and skip the write the real unmount needs (#11445). Re-capturing
 * has to happen WITHOUT re-running the cleanup effect: adding the epoch to
 * those deps would fire the cleanup mid-mount, where the freshly matching
 * generation lets it write a spurious false.
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
  updateVisibility: (id: string, isVisible: boolean) => void,
  attachEpoch = 0
): void {
  const ownedGenerationRef = useRef(0);

  useEffect(() => {
    ownedGenerationRef.current = terminalInstanceService.getAttachGeneration(id);
  }, [id, restartKey, attachEpoch]);

  useEffect(() => {
    return () => {
      if (terminalInstanceService.getAttachGeneration(id) === ownedGenerationRef.current) {
        updateVisibility(id, false);
      }
    };
  }, [id, restartKey, updateVisibility]);
}
