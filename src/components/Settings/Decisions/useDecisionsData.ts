import { useEffect, useRef, useState } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type {
  DecisionsExportResult,
  DecisionsLocalDeleteResult,
  DecisionsRelayDeleteResult,
  DecisionsStatus,
} from "@shared/types/decisions";

export type DecisionsDataAction = "export" | "delete-relay" | "delete-local";

export type DecisionsDataOutcome =
  | { action: "export"; result: DecisionsExportResult }
  | { action: "delete-relay"; result: DecisionsRelayDeleteResult }
  | { action: "delete-local"; result: DecisionsLocalDeleteResult };

export interface UseDecisionsDataResult {
  /** The action in flight; one at a time. */
  pending: DecisionsDataAction | null;
  /** What the last action observed. */
  outcome: DecisionsDataOutcome | null;
  /** Main couldn't carry the action out at all; nothing it observed. */
  error: { action: DecisionsDataAction; message: string } | null;
  /** Each resolves true once main answered, whatever it observed; false when it couldn't (see `error`). */
  exportHistory(passphrase: string): Promise<boolean>;
  deleteRelayData(origin: string): Promise<boolean>;
  deleteLocalData(): Promise<boolean>;
  /** Forgets the last outcome; an action already sent still finishes in main. */
  reset(): void;
}

/**
 * Exporting the decision history and deleting the relay's or this
 * computer's data, asked of main (#16025). The export's passphrase is handed
 * to main and kept nowhere here. `onLocalDeleted` runs after every local
 * deletion with the status main answered, or null when it didn't say, since
 * the relay record goes with the data. Promise chains rather than
 * try/finally, which the React Compiler can't lower.
 */
export function useDecisionsData(
  onLocalDeleted: (status: DecisionsStatus | null) => void
): UseDecisionsDataResult {
  const [pending, setPending] = useState<DecisionsDataAction | null>(null);
  const [outcome, setOutcome] = useState<DecisionsDataOutcome | null>(null);
  const [error, setError] = useState<UseDecisionsDataResult["error"]>(null);
  const busy = useRef(false);
  const generation = useRef(0);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    []
  );

  const run = (
    action: DecisionsDataAction,
    call: () => Promise<DecisionsDataOutcome>
  ): Promise<boolean> => {
    if (busy.current) return Promise.resolve(false);
    busy.current = true;
    const mine = ++generation.current;
    setPending(action);
    setOutcome(null);
    setError(null);
    let status: DecisionsStatus | null = null;
    return call()
      .then(
        (next) => {
          if (next.action === "delete-local" && next.result.result !== "failed") {
            status = next.result.status;
          }
          if (generation.current === mine) setOutcome(next);
          return true;
        },
        (failure: unknown) => {
          if (generation.current === mine) {
            setError({ action, message: formatErrorMessage(failure, "Try again in a moment.") });
          }
          return false;
        }
      )
      .then((done) => {
        busy.current = false;
        setPending(null);
        // A reply that outlived a reset or unmount says how things stood then:
        // the status is read afresh instead.
        if (action === "delete-local") onLocalDeleted(generation.current === mine ? status : null);
        return done;
      });
  };

  const exportHistory = (passphrase: string) =>
    run("export", () =>
      window.electron.decisions
        .exportData({ passphrase })
        .then((result) => ({ action: "export" as const, result }))
    );

  const deleteRelayData = (origin: string) =>
    run("delete-relay", () =>
      window.electron.decisions
        .deleteRelayData({ origin })
        .then((result) => ({ action: "delete-relay" as const, result }))
    );

  const deleteLocalData = () =>
    run("delete-local", () =>
      window.electron.decisions
        .deleteLocalData()
        .then((result) => ({ action: "delete-local" as const, result }))
    );

  const reset = () => {
    generation.current += 1;
    setOutcome(null);
    setError(null);
  };

  return { pending, outcome, error, exportHistory, deleteRelayData, deleteLocalData, reset };
}
