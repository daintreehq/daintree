import { useEffect, useEffectEvent, useRef, useState } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { DecisionsSetupCheckRun } from "@shared/types/decisions";

export interface UseSetupCheckResult {
  /** The run main last showed: the one running, or the latest this run of Daintree saw. */
  run: DecisionsSetupCheckRun | null;
  starting: boolean;
  /** The check couldn't start; not something a step observed. */
  error: string | null;
  start(): void;
  cancel(): void;
  /** Forgets what was shown, as when the relay set up here changes; a run still going carries on in main. */
  reset(): void;
}

/**
 * The setup check (#16024) as main runs it, while `active` (a relay is set
 * up). It reads the run then and takes every push after, keeping the higher
 * revision, so a read that lands after a push can't roll it back. A run this
 * view started is called off when it unmounts or goes inactive: its
 * diagnostic terminal lives here, and a check nobody can see the end of
 * proves nothing.
 */
export function useSetupCheck(active: boolean): UseSetupCheckResult {
  const [run, setRun] = useState<DecisionsSetupCheckRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(-1);
  const shown = useRef<DecisionsSetupCheckRun | null>(null);
  const startedHere = useRef<string | null>(null);
  const mounted = useRef(true);

  const accept = (next: DecisionsSetupCheckRun | null) => {
    if (!mounted.current || next === null || next.revision <= latest.current) return;
    latest.current = next.revision;
    shown.current = next;
    setRun(next);
  };

  const onRun = useEffectEvent((next: DecisionsSetupCheckRun | null) => accept(next));
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    const off = window.electron.events.on("decisions:setup-check-changed", (next) => onRun(next));
    window.electron.decisions.getSetupCheck().then(
      (next) => onRun(next),
      () => {}
    );
    return () => {
      off();
      const current = shown.current;
      if (current?.state === "running" && current.runId === startedHere.current) {
        void window.electron.decisions.cancelSetupCheck().catch(() => {});
      }
    };
  }, [active]);

  const start = () => {
    setStarting(true);
    setError(null);
    window.electron.decisions.startSetupCheck().then(
      (result) => {
        if (!mounted.current) return;
        setStarting(false);
        if (result.result === "started") {
          startedHere.current = result.run.runId;
          accept(result.run);
          return;
        }
        setError(
          result.result === "revoked"
            ? "The relay revoked this computer, so there's nothing to check. Disconnect to set Decisions up again."
            : "No relay is set up on this computer yet."
        );
      },
      (failure: unknown) => {
        if (!mounted.current) return;
        setStarting(false);
        setError(formatErrorMessage(failure, "The check couldn't start."));
      }
    );
  };

  const cancel = () => {
    window.electron.decisions.cancelSetupCheck().then(accept, () => {});
  };

  const reset = () => {
    shown.current = null;
    startedHere.current = null;
    setRun(null);
    setStarting(false);
    setError(null);
  };

  return { run, starting, error, start, cancel, reset };
}
