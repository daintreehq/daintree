import { useEffect, useEffectEvent, useRef, useState } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { DecisionsSetupCheckRun } from "@shared/types/decisions";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

export interface UseSetupCheckResult {
  /** The run main last showed for this relay: the one running, or the latest this run of Daintree saw. */
  run: DecisionsSetupCheckRun | null;
  starting: boolean;
  /** The check couldn't start; not something a step observed. */
  error: string | null;
  start(): void;
  cancel(): void;
}

/** What was shown, and the relay it was shown for. */
interface Shown<T> {
  relayOrigin: string;
  value: T;
}

function cancelRun(runId: string): void {
  safeFireAndForget(window.electron.decisions.cancelSetupCheck({ runId }), {
    context: "Cancelling the Decisions setup check",
  });
}

/**
 * The setup check (#16024) as main runs it, for the relay set up here
 * (`relayOrigin`; nothing is read without one). It reads the run, then takes
 * every push, keeping the higher revision so a read that lands after a push
 * can't roll it back. What it shows belongs to the relay it was read for, and
 * a reply sent before the relay changed or the view went is dropped. A run
 * this view started is called off when the view goes or its relay changes,
 * a start still on its way included: its diagnostic terminal is shown here,
 * and a check nobody can see the end of proves nothing. A run another window
 * started is only shown.
 */
export function useSetupCheck(relayOrigin: string | undefined): UseSetupCheckResult {
  const [shown, setShown] = useState<Shown<DecisionsSetupCheckRun> | null>(null);
  const [failure, setFailure] = useState<Shown<string> | null>(null);
  const [starting, setStarting] = useState(false);
  const latest = useRef(-1);
  const current = useRef<DecisionsSetupCheckRun | null>(null);
  /** The run this view started, by id. */
  const owned = useRef<string | null>(null);
  /** Moves with every subscription, so a reply meant for an earlier one is dropped. */
  const generation = useRef(0);

  const accept = (next: DecisionsSetupCheckRun | null, gen: number, origin: string) => {
    if (gen !== generation.current || next === null || next.revision <= latest.current) return;
    latest.current = next.revision;
    current.current = next;
    setShown({ relayOrigin: origin, value: next });
  };

  const onRun = useEffectEvent((next: DecisionsSetupCheckRun | null, gen: number, origin: string) =>
    accept(next, gen, origin)
  );
  useEffect(() => {
    const gen = ++generation.current;
    if (relayOrigin === undefined) return;
    const off = window.electron.events.on("decisions:setup-check-changed", (next) =>
      onRun(next, gen, relayOrigin)
    );
    window.electron.decisions.getSetupCheck().then(
      (next) => onRun(next, gen, relayOrigin),
      () => {}
    );
    return () => {
      generation.current += 1;
      off();
      const run = current.current;
      if (owned.current !== null && run?.runId === owned.current && run.state === "running") {
        cancelRun(owned.current);
      }
      owned.current = null;
      current.current = null;
    };
  }, [relayOrigin]);

  const start = () => {
    if (relayOrigin === undefined) return;
    const gen = generation.current;
    const origin = relayOrigin;
    setStarting(true);
    setFailure(null);
    window.electron.decisions.startSetupCheck().then(
      (result) => {
        setStarting(false);
        if (gen !== generation.current) {
          // The view went, or its relay changed, while this was on its way.
          if (result.result === "started") cancelRun(result.run.runId);
          return;
        }
        if (result.result === "started" || result.result === "running") {
          if (result.result === "started") owned.current = result.run.runId;
          accept(result.run, gen, origin);
          return;
        }
        setFailure({
          relayOrigin: origin,
          value:
            result.result === "revoked"
              ? "The relay revoked this computer, so there's nothing to check. Disconnect to set Decisions up again."
              : "No relay is set up on this computer yet.",
        });
      },
      (error: unknown) => {
        setStarting(false);
        if (gen !== generation.current) return;
        setFailure({
          relayOrigin: origin,
          value: formatErrorMessage(error, "The check couldn't start."),
        });
      }
    );
  };

  const run = shown !== null && shown.relayOrigin === relayOrigin ? shown.value : null;

  const cancel = () => {
    if (run === null || relayOrigin === undefined) return;
    const gen = generation.current;
    const origin = relayOrigin;
    window.electron.decisions.cancelSetupCheck({ runId: run.runId }).then(
      (next) => accept(next, gen, origin),
      () => {}
    );
  };

  return {
    run,
    starting,
    error: failure !== null && failure.relayOrigin === relayOrigin ? failure.value : null,
    start,
    cancel,
  };
}
