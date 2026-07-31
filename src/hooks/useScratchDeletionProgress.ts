import { useEffect, useState } from "react";

import { useDohertyGate } from "./useDeferredLoading";

/**
 * Main runs `scratch:remove` as two sequential awaits with no reportable
 * boundary between them — a graceful terminal teardown, then a recursive
 * `fs.rm` of the scratch folder. Neither emits progress, so the phase the
 * dialog names is inferred here rather than reported.
 *
 * The teardown's 10s bound is an RPC ceiling, not a typical duration: the host
 * signals and escalates well inside it. Crossing to the folder phase at 4s is
 * past the overwhelming majority of real teardowns while still landing before
 * the long-wait line, so the dialog keeps moving instead of freezing on one
 * string.
 */
const TERMINAL_PHASE_MS = 4_000;

/** Past this, a phase label alone stops reassuring (the >5s loading rule). */
const STILL_WORKING_MS = 5_000;

export const SCRATCH_DELETION_PHASES = {
  terminals: "Closing terminals…",
  folder: "Deleting files…",
} as const;

export interface ScratchDeletionProgress {
  /**
   * Doherty-gated display truth — false for the first 400ms so a scratch that
   * deletes instantly never flashes a phase line. Never branch state on this;
   * the caller's raw pending flag is the state truth.
   */
  isVisible: boolean;
  phase: string;
  isStillWorking: boolean;
}

/**
 * Narrates which step a scratch deletion is on.
 *
 * `hasTerminals` comes from the frozen confirm snapshot, not the live row: main
 * awaits the teardown unconditionally, but with nothing to kill it returns
 * immediately, so naming that phase for a scratch with no live processes would
 * misreport the wait on the most common path.
 */
export function useScratchDeletionProgress(
  isDeleting: boolean,
  hasTerminals: boolean
): ScratchDeletionProgress {
  const [isPastTerminalPhase, setIsPastTerminalPhase] = useState(false);
  const [isStillWorking, setIsStillWorking] = useState(false);
  const isVisible = useDohertyGate(isDeleting);

  useEffect(() => {
    // Reset on the falling edge too: a failed delete leaves the dialog open on
    // its retry, and that run has to narrate from the first phase again.
    if (!isDeleting) {
      setIsPastTerminalPhase(false);
      setIsStillWorking(false);
      return;
    }
    const timers = [
      setTimeout(() => setIsPastTerminalPhase(true), TERMINAL_PHASE_MS),
      setTimeout(() => setIsStillWorking(true), STILL_WORKING_MS),
    ];
    return () => timers.forEach(clearTimeout);
  }, [isDeleting]);

  return {
    isVisible,
    phase:
      hasTerminals && !isPastTerminalPhase
        ? SCRATCH_DELETION_PHASES.terminals
        : SCRATCH_DELETION_PHASES.folder,
    isStillWorking,
  };
}
