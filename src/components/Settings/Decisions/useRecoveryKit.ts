import { useEffect, useRef, useState } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type {
  DecisionsKitExportResult,
  DecisionsKitVerifyResult,
  DecisionsStatus,
  ExportDecisionsRecoveryKitPayload,
  VerifyDecisionsRecoveryKitPayload,
} from "@shared/types/decisions";

export type RecoveryKitAction = "export" | "verify";

export type RecoveryKitOutcome =
  | { action: "export"; result: DecisionsKitExportResult }
  | { action: "verify"; result: DecisionsKitVerifyResult };

export interface UseRecoveryKitResult {
  /** The save or check in flight; one at a time. */
  pending: RecoveryKitAction | null;
  /** What the last save or check observed. */
  outcome: RecoveryKitOutcome | null;
  /** Main couldn't save or check at all: a write that failed, or Decisions turning off. */
  error: { action: RecoveryKitAction; message: string } | null;
  exportKit(payload: ExportDecisionsRecoveryKitPayload): void;
  verifyKit(payload: VerifyDecisionsRecoveryKitPayload): void;
  /** Forgets the last outcome; a request already sent still finishes in main. */
  reset(): void;
}

/**
 * Saving and verifying a recovery kit, asked of main (#16007). A payload is
 * handed to main and not kept here, so a passphrase or kit lives only as long
 * as its field. `onVerified` gets the status main answered a verification
 * with. Promise chains rather than try/finally, which the React Compiler
 * can't lower.
 */
export function useRecoveryKit(
  onVerified: (status: DecisionsStatus) => void
): UseRecoveryKitResult {
  const [pending, setPending] = useState<RecoveryKitAction | null>(null);
  const [outcome, setOutcome] = useState<RecoveryKitOutcome | null>(null);
  const [error, setError] = useState<UseRecoveryKitResult["error"]>(null);
  const busy = useRef(false);
  const generation = useRef(0);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    []
  );

  const run = (action: RecoveryKitAction, call: () => Promise<RecoveryKitOutcome>) => {
    if (busy.current) return;
    busy.current = true;
    const mine = ++generation.current;
    setPending(action);
    setOutcome(null);
    setError(null);
    const settle = () => {
      busy.current = false;
      setPending(null);
    };
    call()
      .then(
        (next) => {
          // A verification main recorded stands whatever happened here since.
          if (next.action === "verify" && next.result.result === "verified") {
            onVerified(next.result.status);
          }
          if (generation.current === mine) setOutcome(next);
        },
        (failure: unknown) => {
          if (generation.current === mine) {
            setError({ action, message: formatErrorMessage(failure, "Try again in a moment.") });
          }
        }
      )
      .then(settle, settle);
  };

  const exportKit = (payload: ExportDecisionsRecoveryKitPayload) => {
    run("export", () =>
      window.electron.decisions
        .exportRecoveryKit(payload)
        .then((result) => ({ action: "export", result }))
    );
  };

  const verifyKit = (payload: VerifyDecisionsRecoveryKitPayload) => {
    run("verify", () =>
      window.electron.decisions
        .verifyRecoveryKit(payload)
        .then((result) => ({ action: "verify", result }))
    );
  };

  const reset = () => {
    generation.current += 1;
    setOutcome(null);
    setError(null);
  };

  return { pending, outcome, error, exportKit, verifyKit, reset };
}
