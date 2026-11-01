import { useEffect, useRef, useState } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { DecisionsPolicy } from "@shared/types/decisions";

export interface DecisionsPolicySaveFailure {
  allowed: boolean;
  message: string;
}

export interface UseDecisionsPolicyResult {
  /** Null until main has answered, and while Decisions is off. */
  policy: DecisionsPolicy | null;
  loadError: string | null;
  /** The allowlist value being saved, so the switch shows what was asked while main acts. */
  pending: boolean | null;
  saveFailure: DecisionsPolicySaveFailure | null;
  reload(): Promise<void>;
  setProxyAllowlisted(allowed: boolean): Promise<void>;
}

const READ_FAILED = "Decisions' policy couldn't be read.";

/**
 * The policy as main applies it, read while `active` (Decisions on): on
 * mount, again after every status push (main sends one with each policy
 * change, so another window's change shows here too), and answered by each
 * change asked here. Whichever answer carries the higher revision wins, so a
 * read that lands after a newer change can't roll the switch back. Turning
 * off forgets what was read, and anything still in flight from before lands
 * nowhere, so turning on again starts from main's answer, never a stale one.
 * Promise chains rather than try/finally, which the React Compiler can't lower.
 */
export function useDecisionsPolicy(active: boolean): UseDecisionsPolicyResult {
  const [policy, setPolicy] = useState<DecisionsPolicy | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<boolean | null>(null);
  const [saveFailure, setSaveFailure] = useState<DecisionsPolicySaveFailure | null>(null);
  const savingRef = useRef(false);
  const revisionRef = useRef(-1);
  /** Moves on each turn on and off; an answer asked for in another one is dropped. */
  const generationRef = useRef(0);

  /** Shows `next` unless something newer is already shown, or it was asked for before a turn off. */
  const accept = (next: DecisionsPolicy, generation: number): void => {
    if (generation !== generationRef.current || next.revision < revisionRef.current) return;
    revisionRef.current = next.revision;
    setPolicy(next);
    setLoadError(null);
  };

  const read = (): Promise<void> => {
    const generation = generationRef.current;
    return window.electron.decisions.getPolicy().then(
      (next) => accept(next, generation),
      (error: unknown) => {
        if (generation === generationRef.current) {
          setLoadError(formatErrorMessage(error, READ_FAILED));
        }
      }
    );
  };

  useEffect(() => {
    if (!active) return;
    const generation = ++generationRef.current;
    const show = (next: DecisionsPolicy) => {
      if (generation !== generationRef.current || next.revision < revisionRef.current) return;
      revisionRef.current = next.revision;
      setPolicy(next);
      setLoadError(null);
    };
    const fetchPolicy = () =>
      window.electron.decisions.getPolicy().then(show, (error: unknown) => {
        if (generation === generationRef.current) {
          setLoadError(formatErrorMessage(error, READ_FAILED));
        }
      });
    // Subscribed before the read, so a change between the two is never missed.
    const off = window.electron.events.on("decisions:status-changed", () => void fetchPolicy());
    void fetchPolicy();
    return () => {
      generationRef.current += 1;
      off();
      revisionRef.current = -1;
      setPolicy(null);
      setLoadError(null);
      setSaveFailure(null);
    };
  }, [active]);

  const reload = (): Promise<void> => {
    setLoadError(null);
    return read();
  };

  const setProxyAllowlisted = (allowed: boolean): Promise<void> => {
    if (savingRef.current) return Promise.resolve();
    savingRef.current = true;
    setPending(allowed);
    setSaveFailure(null);
    const generation = generationRef.current;
    return window.electron.decisions
      .setProxyAllowlisted(allowed)
      .then(
        (next) => accept(next, generation),
        (error: unknown) => {
          if (generation !== generationRef.current) return;
          setSaveFailure({ allowed, message: formatErrorMessage(error, "Try again in a moment.") });
          // Show what main holds now rather than what was asked.
          void read();
        }
      )
      .then(() => {
        savingRef.current = false;
        setPending(null);
      });
  };

  return {
    policy: active ? policy : null,
    loadError: active ? loadError : null,
    pending,
    saveFailure: active ? saveFailure : null,
    reload,
    setProxyAllowlisted,
  };
}
