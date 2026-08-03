import { useEffect, useState } from "react";

import { useDohertyGate } from "./useDeferredLoading";

/** Past this, a label alone stops reassuring (the >5s loading rule). */
const STILL_WORKING_MS = 5_000;

export interface ScratchDeletionProgress {
  /**
   * Doherty-gated display truth — false for the first 400ms so a scratch that
   * deletes instantly never flashes a label. Never branch state on this; the
   * caller's raw pending flag is the state truth.
   */
  isVisible: boolean;
  isStillWorking: boolean;
}

/**
 * Long-wait state for the single-scratch delete confirmation.
 *
 * Deliberately does NOT narrate which backend step is running. `scratch:remove`
 * snapshots the scratch's terminals, awaits a project-wide graceful kill bounded
 * by a 10s RPC timeout, resolves branches, journals each agent session, and only
 * then tombstones the row and recursively `fs.rm`s the folder — with no event at
 * any boundary. Every candidate for inferring the current step was checked and
 * rejected:
 *
 * - Elapsed time has no defensible crossover. The kills run in parallel under
 *   one bound, and the snapshot and journal writes on either side of them are
 *   themselves unbounded, so any threshold claims a boundary it cannot see.
 * - A row's `processCount` is not "terminals main will kill": it nets out the
 *   assistant help PTY (`electron/ipc/handlers/projectCrud/stats.ts`), defaults
 *   to zero when stats are missing, and is polled — so it reads zero for a
 *   scratch whose terminals main is about to tear down.
 *
 * Naming a step we cannot observe would put a confident lie in a destructive
 * dialog, which is worse than saying less. The copy therefore states the whole
 * operation, which is true for its entire duration.
 */
export function useScratchDeletionProgress(isDeleting: boolean): ScratchDeletionProgress {
  const [isStillWorking, setIsStillWorking] = useState(false);
  const isVisible = useDohertyGate(isDeleting);

  useEffect(() => {
    // Reset on the falling edge too: a failed delete leaves the dialog open on
    // its retry, and that run starts its own clock.
    if (!isDeleting) {
      setIsStillWorking(false);
      return;
    }
    const timer = setTimeout(() => setIsStillWorking(true), STILL_WORKING_MS);
    return () => clearTimeout(timer);
  }, [isDeleting]);

  return { isVisible, isStillWorking };
}
