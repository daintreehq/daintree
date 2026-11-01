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
  /** Shows a status main answered some other change with. */
  applyStatus(next: DecisionsStatus): void;
  setEnabled(payload: SetDecisionsEnabledPayload): Promise<void>;
}

/**
 * Decisions as main last reported it: read on mount, pushed on every change
 * (`decisions:status-changed`, the relay connection's included), and answered
 * by every change asked here. Whichever carries the higher revision wins, so
 * a read that lands after a newer push can't roll it back. Changes go through
 * one at a time, with promise chains rather than try/finally, which the React
 * Compiler can't lower.
 */
export function useDecisions(): UseDecisionsResult {
  const [status, setStatus] = useState<DecisionsStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<SetDecisionsEnabledPayload | null>(null);
  const [saveFailure, setSaveFailure] = useState<DecisionsSaveFailure | null>(null);
  const savingRef = useRef(false);
  const revisionRef = useRef(-1);

  /** Shows `next` unless something newer is already shown. */
  const accept = (next: DecisionsStatus): boolean => {
    const revision = next.revision ?? 0;
    if (revision < revisionRef.current) return false;
    revisionRef.current = revision;
    setStatus(next);
    return true;
  };

  const reload = (): Promise<void> => {
    setLoadError(null);
    return window.electron.decisions.getStatus().then(
      (next) => {
        accept(next);
      },
      (error: unknown) =>
        setLoadError(formatErrorMessage(error, "Decisions status couldn't be read."))
    );
  };

  useEffect(() => {
    let active = true;
    // Subscribed before the read, so a change between the two is never missed.
    const off = window.electron.events.on("decisions:status-changed", (next) => {
      if (active && accept(next)) setLoadError(null);
    });
    window.electron.decisions.getStatus().then(
      (next) => {
        if (active) accept(next);
      },
      (error: unknown) => {
        if (active) setLoadError(formatErrorMessage(error, "Decisions status couldn't be read."));
      }
    );
    return () => {
      active = false;
      off();
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
          accept(next);
          setLoadError(null);
        },
        (error: unknown) => {
          setSaveFailure({
            payload,
            message: formatErrorMessage(error, "Try again in a moment."),
          });
          // A failed start can still have saved the switch (the store didn't
          // open, say), so show what main now holds rather than what was asked.
          return window.electron.decisions.getStatus().then(
            (next) => {
              accept(next);
            },
            () => {}
          );
        }
      )
      .then(() => {
        savingRef.current = false;
        setPending(null);
      });
  };

  const applyStatus = (next: DecisionsStatus) => {
    if (accept(next)) setLoadError(null);
  };

  return { status, loadError, pending, saveFailure, reload, applyStatus, setEnabled };
}
