import { useRef, useState } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { DecisionsStatus } from "@shared/types/decisions";

export interface DecisionsSwitchFailure {
  enabled: boolean;
  message: string;
}

export interface UseDecisionsSwitchResult {
  /** On as main last showed it, or as being saved. */
  enabled: boolean;
  saving: boolean;
  failure: DecisionsSwitchFailure | null;
  /** Settles once main has answered, failure included; never rejects. */
  set(enabled: boolean): Promise<void>;
}

/**
 * A Decisions switch that needs no consent of its own: holding phone pushes
 * while the person is here (#17240), or telling the phone when an agent
 * stops (#17319). `saved` is the switch as the Decisions status shows it,
 * which main pushes to every window with each change. Main answers a change
 * with the status; a failed one reads it again (`onChanged(null)`), since an
 * off is saved before main's queue and can stand even when the change fails.
 * Promise chains rather than try/finally, which the React Compiler can't
 * lower.
 */
export function useDecisionsSwitch(
  saved: boolean,
  save: (enabled: boolean) => Promise<DecisionsStatus>,
  onChanged: (next: DecisionsStatus | null) => void
): UseDecisionsSwitchResult {
  const [pending, setPending] = useState<boolean | null>(null);
  const [failure, setFailure] = useState<DecisionsSwitchFailure | null>(null);
  const savingRef = useRef(false);

  const set = (enabled: boolean): Promise<void> => {
    if (savingRef.current) return Promise.resolve();
    savingRef.current = true;
    setPending(enabled);
    setFailure(null);
    return save(enabled)
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
    enabled: pending ?? saved,
    saving: pending !== null,
    failure,
    set,
  };
}
