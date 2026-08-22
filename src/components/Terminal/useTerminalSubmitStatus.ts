import { useEffect, useState } from "react";
import { terminalClient } from "@/clients";
import type { TerminalSubmitStatusState } from "@shared/types";

/** What the pane is currently showing about its submit lane. `null` is the
 *  overwhelming majority case — submits that complete normally report nothing. */
export type TerminalSubmitStatus = Exclude<TerminalSubmitStatusState, "settled"> | null;

/** State is tagged with the terminal it describes. A tab group renders one
 *  unkeyed pane fiber for whichever tab is active, so on a tab switch this
 *  hook's state survives into a commit that already carries the new id —
 *  untagged, that paints terminal A's banner under terminal B's name for a
 *  frame, with a restart button pointed at the wrong process. */
interface TaggedStatus {
  terminalId: string;
  status: TerminalSubmitStatus;
}

/**
 * Pane-local view of one terminal's submit lane (#11875).
 *
 * Deliberately not a store: this is transient per-pane runtime state with no
 * consumer outside the pane that owns the terminal, and nothing about it is
 * worth persisting or restoring. It mirrors how the other pane banners are fed.
 *
 * `reset` is keyed on the things that mean "the process this status described
 * is gone" — a restart or an exit. Without that, a status from a killed
 * process would sit on the restarted pane, since the new process has no reason
 * to emit `settled`.
 */
export function useTerminalSubmitStatus(
  terminalId: string,
  reset: { isRestarting?: boolean; isExited?: boolean } = {}
): TerminalSubmitStatus {
  const [tagged, setTagged] = useState<TaggedStatus | null>(null);
  const { isRestarting, isExited } = reset;

  useEffect(() => {
    return terminalClient.onSubmitStatus((payload) => {
      if (payload.id !== terminalId) return;
      setTagged(
        payload.state === "settled"
          ? null
          : { terminalId, status: payload.state as TerminalSubmitStatus }
      );
    });
  }, [terminalId]);

  useEffect(() => {
    setTagged(null);
  }, [terminalId, isRestarting, isExited]);

  // Read through the tag rather than trusting the stored value: on the commit
  // where `terminalId` changes, this runs before the reset effect above.
  return tagged?.terminalId === terminalId ? tagged.status : null;
}
