import type { OperationId, OperationOutcome } from "@shared/types/remoteHosts";
import type { OperationsEvent } from "@shared/types/ipc/operations";
import { operationsClient } from "@/clients/operationsClient";
import { isRemoteShellSupported } from "@/lib/remoteHosts";
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
   * handing back that running outcome. Spent only by the waits between polls,
   * each at its scheduled length, so neither the wait for the link to come
   * back nor a machine asleep mid-wait uses it up.
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
 * still running is followed until it settles or `settleTimeoutMs` of polling
 * passes, however long the link took to come back.
 * `unknown` means the Host has no record — the request never arrived, or its
 * retention window passed — and is itself an answer, not an error.
 */
export async function resolveUnknownOutcome(
  opId: OperationId,
  options: ResolveUnknownOutcomeOptions
): Promise<OperationOutcome> {
  // The operations handlers are registered only where Remote Hosts runs, so
  // elsewhere there is no Host record to ask for.
  if (!options.client && !isRemoteShellSupported()) return { status: "unknown" };
  const client = options.client ?? operationsClient;
  const { signal } = options;
  // At least 1ms, so every wait spends some of the window and it runs out.
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  let remainingMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;

  // Held in an object: the event callback writes it, and a plain `let` would
  // be narrowed to its initial null at every read in the loop.
  const state: { settled: OperationOutcome | null; wake: (() => void) | null } = {
    settled: null,
    wake: null,
  };
  const unsubscribe = client.onEvent((event: OperationsEvent) => {
    if (event.type !== "settled" || event.record.opId !== opId) return;
    const { outcome } = event.record;
    // The record type allows these, but neither is a settlement to stop on.
    if (outcome.status === "running" || outcome.status === "unknown") return;
    state.settled = outcome;
    state.wake?.();
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
        if (signal?.aborted) throw abortError();
        // A settlement that arrived during the read answers it, whatever the read did.
        if (state.settled) return state.settled;
        // The link dropped again before the Host could answer: wait it out.
        if (!isUnknownOutcomeError(error)) throw error;
        await options.waitForConnected(signal);
        continue;
      }
      // The reply was read before any settlement that arrived while it was in
      // flight, so a running or unknown answer is stale next to it.
      if (signal?.aborted) throw abortError();
      if (state.settled) return state.settled;
      if (outcome.status !== "running") return outcome;
      if (remainingMs <= 0) return outcome;

      // A wait is charged its scheduled length when its timer fires, not the
      // wall time that passed: a timer firing late after a sleep costs no more.
      const delayMs = Math.min(pollIntervalMs, remainingMs);
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          state.wake = null;
          resolve();
        };
        const timer = setTimeout(() => {
          remainingMs -= delayMs;
          done();
        }, delayMs);
        state.wake = done;
      });
    }
  } finally {
    unsubscribe();
    signal?.removeEventListener("abort", onAbort);
  }
}
