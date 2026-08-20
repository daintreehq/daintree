import { useEffect, useState } from "react";
import { terminalClient } from "@/clients";
import type { TerminalSubmitStatusState } from "@shared/types";

/** What the pane is currently showing about its submit lane. `null` is the
 *  overwhelming majority case — submits that complete normally report nothing. */
export type TerminalSubmitStatus = Exclude<TerminalSubmitStatusState, "settled"> | null;

/**
 * Pane-local view of one terminal's submit lane (#11875).
 *
 * Deliberately not a store: this is transient per-pane runtime state with no
 * consumer outside the pane that owns the terminal, and nothing about it is
 * worth persisting or restoring. It mirrors how the other pane banners are fed.
 *
 * `reset` is keyed on the things that mean "the process this status described
 * is gone" — a restart, an exit, or the pane being pointed at a different
 * terminal. Without that, a status from a killed process would sit on the
 * restarted pane forever, since the new process has no reason to emit
 * `settled`.
 */
export function useTerminalSubmitStatus(
  terminalId: string,
  reset: { isRestarting?: boolean; isExited?: boolean } = {}
): TerminalSubmitStatus {
  const [status, setStatus] = useState<TerminalSubmitStatus>(null);
  const { isRestarting, isExited } = reset;

  useEffect(() => {
    return terminalClient.onSubmitStatus((payload) => {
      if (payload.id !== terminalId) return;
      setStatus(payload.state === "settled" ? null : payload.state);
    });
  }, [terminalId]);

  // Clearing on id change is handled by this effect too — the state is per-pane
  // and a new id means the previous terminal's status is meaningless here.
  useEffect(() => {
    setStatus(null);
  }, [terminalId, isRestarting, isExited]);

  return status;
}
