import { useEffect, useRef, useState } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type {
  ClaimDecisionsRelayPayload,
  DecisionsConnectResult,
  DecisionsStatus,
  RestoreDecisionsIdentityPayload,
} from "@shared/types/decisions";

export type RelayIdentityAction = "claim" | "restore" | "disconnect";

export interface UseRelayIdentityResult {
  /** The change in flight; one at a time. */
  pending: RelayIdentityAction | null;
  /** What the last claim or restore observed, unless it saved the identity. */
  result: DecisionsConnectResult | null;
  /** Main couldn't make the change at all; not something the relay did. */
  error: { action: RelayIdentityAction; message: string } | null;
  claim(payload: ClaimDecisionsRelayPayload): void;
  restore(payload: RestoreDecisionsIdentityPayload): void;
  /** Resolves true once the identity is removed; false when it wasn't (see `error`). */
  disconnect(): Promise<boolean>;
  /** Forgets the last outcome; a change already sent still finishes in main. */
  reset(): void;
}

/**
 * Claims, restores and disconnects, asked of main (#16006). A payload is
 * handed to main and not kept here, so a claim secret or passphrase lives
 * only as long as its field. `onSettled` runs after every attempt, whatever
 * it observed, with the status main answered when it changed the identity
 * and null otherwise, since an unfinished claim's keys can move the status
 * too. Promise chains rather than try/finally, which the React Compiler
 * can't lower.
 */
export function useRelayIdentity(
  onSettled: (status: DecisionsStatus | null) => void
): UseRelayIdentityResult {
  const [pending, setPending] = useState<RelayIdentityAction | null>(null);
  const [result, setResult] = useState<DecisionsConnectResult | null>(null);
  const [error, setError] = useState<UseRelayIdentityResult["error"]>(null);
  const busy = useRef(false);
  const generation = useRef(0);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    []
  );

  const run = (
    action: RelayIdentityAction,
    call: () => Promise<DecisionsConnectResult | DecisionsStatus>
  ): Promise<boolean> => {
    if (busy.current) return Promise.resolve(false);
    busy.current = true;
    const mine = ++generation.current;
    setPending(action);
    setResult(null);
    setError(null);
    let status: DecisionsStatus | null = null;
    return call()
      .then(
        (next) => {
          if ("state" in next) status = next;
          else if (next.result === "saved") status = next.status;
          else if (generation.current === mine) setResult(next);
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
        onSettled(status);
        return done;
      });
  };

  const claim = (payload: ClaimDecisionsRelayPayload) => {
    void run("claim", () => window.electron.decisions.claimRelay(payload));
  };

  const restore = (payload: RestoreDecisionsIdentityPayload) => {
    void run("restore", () => window.electron.decisions.restoreIdentity(payload));
  };

  const disconnect = () => run("disconnect", () => window.electron.decisions.disconnectRelay());

  const reset = () => {
    generation.current += 1;
    setResult(null);
    setError(null);
  };

  return { pending, result, error, claim, restore, disconnect, reset };
}
