import { useEffect, useRef, useState } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { DecisionsStatus, SetDecisionsEnabledPayload } from "@shared/types/decisions";

export interface DecisionsSaveFailure {
  payload: SetDecisionsEnabledPayload;
  message: string;
}

export interface UseDecisionsResult {
  status: DecisionsStatus | null;
  loadError: string | null;
  /** The change in flight, so the switch shows what was asked while main acts. */
  pending: SetDecisionsEnabledPayload | null;
  saveFailure: DecisionsSaveFailure | null;
  reload(): Promise<void>;
  setEnabled(payload: SetDecisionsEnabledPayload): Promise<void>;
}

/**
 * Decisions as main last reported it, read on mount and after every change.
 * There is no status push yet; the child that first needs live status adds
 * one. Changes go through one at a time, with promise chains rather than
 * try/finally, which the React Compiler can't lower.
 */
export function useDecisions(): UseDecisionsResult {
  const [status, setStatus] = useState<DecisionsStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<SetDecisionsEnabledPayload | null>(null);
  const [saveFailure, setSaveFailure] = useState<DecisionsSaveFailure | null>(null);
  const savingRef = useRef(false);

  const reload = (): Promise<void> => {
    setLoadError(null);
    return window.electron.decisions.getStatus().then(
      (next) => setStatus(next),
      (error: unknown) =>
        setLoadError(formatErrorMessage(error, "Decisions status couldn't be read."))
    );
  };

  useEffect(() => {
    let active = true;
    window.electron.decisions.getStatus().then(
      (next) => {
        if (active) setStatus(next);
      },
      (error: unknown) => {
        if (active) setLoadError(formatErrorMessage(error, "Decisions status couldn't be read."));
      }
    );
    return () => {
      active = false;
    };
  }, []);

  const setEnabled = (payload: SetDecisionsEnabledPayload): Promise<void> => {
    if (savingRef.current) return Promise.resolve();
    savingRef.current = true;
    setPending(payload);
    setSaveFailure(null);
    return window.electron.decisions
      .setEnabled(payload)
      .then(
        (next) => {
          setStatus(next);
          setLoadError(null);
        },
        (error: unknown) => {
          setSaveFailure({
            payload,
            message: formatErrorMessage(error, "Try again in a moment."),
          });
          // A failed start can still have saved the switch (the store didn't
          // open, say), so show what main now holds rather than what was asked.
          return window.electron.decisions.getStatus().then(setStatus, () => {});
        }
      )
      .then(() => {
        savingRef.current = false;
        setPending(null);
      });
  };

  return { status, loadError, pending, saveFailure, reload, setEnabled };
}
