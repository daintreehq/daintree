import { useRef, useState } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { DecisionsStatus } from "@shared/types/decisions";

export interface DecisionsHoldPhonePushesFailure {
  enabled: boolean;
  message: string;
}

export interface UseDecisionsHoldPhonePushesResult {
  /** On as main last showed it, or as being saved. */
  enabled: boolean;
  saving: boolean;
  failure: DecisionsHoldPhonePushesFailure | null;
  /** Settles once main has answered, failure included; never rejects. */
  set(enabled: boolean): Promise<void>;
}

/**
 * Holding phone pushes while the person is here (#17240), shown from the
 * Decisions status, which main pushes to every window with each change. Main
 * answers a change with the status; a failed one reads it again
 * (`onChanged(null)`), since an off is saved before main's queue and can
 * stand even when the change fails. Promise chains rather than try/finally,
 * which the React Compiler can't lower.
 */
export function useDecisionsHoldPhonePushes(
  status: DecisionsStatus,
  onChanged: (next: DecisionsStatus | null) => void
): UseDecisionsHoldPhonePushesResult {
  const [pending, setPending] = useState<boolean | null>(null);
  const [failure, setFailure] = useState<DecisionsHoldPhonePushesFailure | null>(null);
  const savingRef = useRef(false);

  const set = (enabled: boolean): Promise<void> => {
    if (savingRef.current) return Promise.resolve();
    savingRef.current = true;
    setPending(enabled);
    setFailure(null);
    return window.electron.decisions
      .setHoldPhonePushes(enabled)
      .then(
        (next) => onChanged(next),
        (error: unknown) => {
          setFailure({ enabled, message: formatErrorMessage(error, "Try again in a moment.") });
          onChanged(null);
        }
      )
      .then(() => {
        savingRef.current = false;
        setPending(null);
      });
  };

  return {
    enabled: pending ?? status.holdPhonePushes !== false,
    saving: pending !== null,
    failure,
    set,
  };
}
