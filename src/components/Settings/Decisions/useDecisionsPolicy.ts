import { useEffect, useRef, useState } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { DecisionsPolicy } from "@shared/types/decisions";

export interface DecisionsPolicySaveFailure {
  allowed: boolean;
  message: string;
}

export interface UseDecisionsPolicyResult {
  policy: DecisionsPolicy | null;
  loadError: string | null;
  /** The allowlist value being saved, so the switch shows what was asked while main acts. */
  pending: boolean | null;
  saveFailure: DecisionsPolicySaveFailure | null;
  reload(): Promise<void>;
  setProxyAllowlisted(allowed: boolean): Promise<void>;
}

/**
 * The policy as main applies it: read on mount, and answered by each change
 * asked here. A read that lands after a newer answer is dropped, so it can't
 * roll the switch back. Promise chains rather than try/finally, which the
 * React Compiler can't lower.
 */
export function useDecisionsPolicy(): UseDecisionsPolicyResult {
  const [policy, setPolicy] = useState<DecisionsPolicy | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<boolean | null>(null);
  const [saveFailure, setSaveFailure] = useState<DecisionsPolicySaveFailure | null>(null);
  const savingRef = useRef(false);
  const latestRef = useRef(0);

  const read = (): Promise<void> => {
    const ticket = ++latestRef.current;
    return window.electron.decisions.getPolicy().then(
      (next) => {
        if (ticket !== latestRef.current) return;
        setPolicy(next);
        setLoadError(null);
      },
      (error: unknown) => {
        if (ticket !== latestRef.current) return;
        setLoadError(formatErrorMessage(error, "Decisions' policy couldn't be read."));
      }
    );
  };

  useEffect(() => {
    let active = true;
    const ticket = ++latestRef.current;
    window.electron.decisions.getPolicy().then(
      (next) => {
        if (active && ticket === latestRef.current) setPolicy(next);
      },
      (error: unknown) => {
        if (active && ticket === latestRef.current) {
          setLoadError(formatErrorMessage(error, "Decisions' policy couldn't be read."));
        }
      }
    );
    return () => {
      active = false;
    };
  }, []);

  const reload = (): Promise<void> => {
    setLoadError(null);
    return read();
  };

  const setProxyAllowlisted = (allowed: boolean): Promise<void> => {
    if (savingRef.current) return Promise.resolve();
    savingRef.current = true;
    setPending(allowed);
    setSaveFailure(null);
    const ticket = ++latestRef.current;
    return window.electron.decisions
      .setProxyAllowlisted(allowed)
      .then(
        (next) => {
          if (ticket === latestRef.current) setPolicy(next);
        },
        (error: unknown) => {
          setSaveFailure({ allowed, message: formatErrorMessage(error, "Try again in a moment.") });
          // Show what main holds now rather than what was asked. Not waited
          // for: a retry may go first, and then this read is the stale one.
          void read();
        }
      )
      .then(() => {
        savingRef.current = false;
        setPending(null);
      });
  };

  return { policy, loadError, pending, saveFailure, reload, setProxyAllowlisted };
}
