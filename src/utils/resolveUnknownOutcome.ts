import type { OperationId, OperationOutcome } from "@shared/types/remoteHosts";
import type { OperationsEvent } from "@shared/types/ipc/operations";
import { operationsClient } from "@/clients/operationsClient";
import { isRemoteHostsSupported } from "@/lib/remoteHosts";
import { isClientAppError } from "./clientAppError";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_SETTLE_TIMEOUT_MS = 5 * 60_000;

type OperationsSource = Pick<typeof operationsClient, "getStatus" | "onEvent">;

export interface ResolveUnknownOutcomeOptions {
  /** Resolves once the link to the window's host is back. */
  waitForConnected: (signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  /**
   * How long to follow an operation the Host still reports as running before
   * handing back that running outcome.
   */
  settleTimeoutMs?: number;
  pollIntervalMs?: number;
  client?: OperationsSource;
}

/**
 * A mutation that failed this way may well have happened: the link dropped
 * between the request and its answer. Its outcome is unknown, not a failure.
 */
export function isUnknownOutcomeError(error: unknown): boolean {
  return (
    isClientAppError(error) &&
    (error.code === "HOST_DISCONNECTED" || error.code === "OUTCOME_UNKNOWN")
  );
}

function abortError(): Error {
  return new DOMException("Aborted", "AbortError");
}

/**
 * Asks the Host what became of an operation whose invoke never answered.
 * Waits for the link to come back, then reads the Host's record; an operation
 * still running is followed until it settles or `settleTimeoutMs` passes.
 * `unknown` means the Host has no record — the request never arrived, or its
 * retention window passed — and is itself an answer, not an error.
 */
export async function resolveUnknownOutcome(
  opId: OperationId,
  options: ResolveUnknownOutcomeOptions
): Promise<OperationOutcome> {
  // The operations handlers are registered only where Remote Hosts runs, so
  // elsewhere there is no Host record to ask for.
  if (!options.client && !isRemoteHostsSupported()) return { status: "unknown" };
  const client = options.client ?? operationsClient;
  const { signal } = options;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + (options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS);

  // Held in an object: the event callback writes it, and a plain `let` would
  // be narrowed to its initial null at every read in the loop.
  const state: { settled: OperationOutcome | null; wake: (() => void) | null } = {
    settled: null,
    wake: null,
  };
  const unsubscribe = client.onEvent((event: OperationsEvent) => {
    if (event.type === "settled" && event.record.opId === opId) {
      state.settled = event.record.outcome;
      state.wake?.();
    }
  });
  const onAbort = () => state.wake?.();
  signal?.addEventListener("abort", onAbort);

  try {
    await options.waitForConnected(signal);
    let outcome: OperationOutcome;
    for (;;) {
      if (signal?.aborted) throw abortError();
      if (state.settled) return state.settled;

      try {
        outcome = await client.getStatus(opId);
      } catch (error) {
        // The link dropped again before the Host could answer: wait it out.
        if (!isUnknownOutcomeError(error)) throw error;
        await options.waitForConnected(signal);
        continue;
      }
      if (outcome.status !== "running") return outcome;
      if (Date.now() >= deadline) return state.settled ?? outcome;

      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          state.wake = null;
          resolve();
        };
        const timer = setTimeout(done, Math.min(pollIntervalMs, deadline - Date.now()));
        state.wake = done;
      });
    }
  } finally {
    unsubscribe();
    signal?.removeEventListener("abort", onAbort);
  }
}
