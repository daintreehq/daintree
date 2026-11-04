import { useRef, useState } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type {
  DecisionsStatus,
  SetDecisionsTerminalSnapshotsPayload,
} from "@shared/types/decisions";

export interface DecisionsTerminalSnapshotsFailure {
  payload: SetDecisionsTerminalSnapshotsPayload;
  message: string;
}

export interface UseDecisionsTerminalSnapshotsResult {
  /** On as main last showed it, or as being saved. */
  enabled: boolean;
  saving: boolean;
  failure: DecisionsTerminalSnapshotsFailure | null;
  /**
   * Turning on sends `consent` only from the dialog the person just agreed
   * in. Settles once main has answered, failure included; never rejects.
   */
  set(payload: SetDecisionsTerminalSnapshotsPayload): Promise<void>;
}

/**
 * The terminal snapshots switch (#16228), shown from the Decisions status,
 * which main pushes to every window with each change. Main answers a change
 * with the status; a failed one reads it again (`onChanged(null)`), since an
 * off is saved before main's queue and can stand even when the change fails.
 * Promise chains rather than try/finally, which the React Compiler can't lower.
 */
export function useDecisionsTerminalSnapshots(
  status: DecisionsStatus,
  onChanged: (next: DecisionsStatus | null) => void
): UseDecisionsTerminalSnapshotsResult {
  const [pending, setPending] = useState<SetDecisionsTerminalSnapshotsPayload | null>(null);
  const [failure, setFailure] = useState<DecisionsTerminalSnapshotsFailure | null>(null);
  const savingRef = useRef(false);

  const set = (payload: SetDecisionsTerminalSnapshotsPayload): Promise<void> => {
    if (savingRef.current) return Promise.resolve();
    savingRef.current = true;
    setPending(payload);
    setFailure(null);
    return window.electron.decisions
      .setTerminalSnapshots(payload)
      .then(
        (next) => onChanged(next),
        (error: unknown) => {
          setFailure({ payload, message: formatErrorMessage(error, "Try again in a moment.") });
          onChanged(null);
        }
      )
      .then(() => {
        savingRef.current = false;
        setPending(null);
      });
  };

  return {
    enabled: pending?.enabled ?? status.terminalSnapshots === true,
    saving: pending !== null,
    failure,
    set,
  };
}
