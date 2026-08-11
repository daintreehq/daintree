/**
 * Deadline-bounded `AbortSignal`s that release their timer as soon as the work
 * they guard settles.
 *
 * `AbortSignal.timeout(ms)` is the obvious thing to reach for, but it has no
 * cancellation handle: the timer it arms stays pending for the whole duration
 * even when the fetch it guards resolves in 40ms, keeping the signal and every
 * listener attached to it reachable until the deadline elapses. On a surface
 * that issues many short-lived requests behind a long ceiling — the GitHub
 * provider's 15s budget, the voice correction path's 7s/15s budgets — that is a
 * steady drip of live timers that exist only to fire into nothing.
 *
 * These helpers keep `AbortSignal.timeout`'s observable contract exactly:
 * `signal.reason` is a `DOMException` named `TimeoutError`, so callers that
 * branch on `err.name === "TimeoutError"` are unaffected. They add a `dispose()`
 * that clears the timer once the caller no longer needs the deadline.
 *
 * Being built on `setTimeout` rather than the platform's internal timer queue
 * also makes the deadline observable to test clocks, which the native signal is
 * not.
 */

export interface DisposableTimeoutSignal {
  readonly signal: AbortSignal;
  /** Clears the pending timer. Idempotent; safe after the signal has aborted. */
  dispose(): void;
}

function timeoutReason(): DOMException {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

/**
 * An `AbortSignal` that aborts with a `TimeoutError` after `timeoutMs`,
 * optionally also aborting when any of `linked` does.
 *
 * Call `dispose()` in a `finally` once the guarded work has settled.
 */
export function createTimeoutSignal(
  timeoutMs: number,
  ...linked: ReadonlyArray<AbortSignal | null | undefined>
): DisposableTimeoutSignal {
  const controller = new AbortController();
  const upstream = linked.filter((s): s is AbortSignal => s != null);

  // An already-aborted input wins outright — mirrors AbortSignal.any(), and
  // skips arming a timer that could never be observed.
  const alreadyAborted = upstream.find((s) => s.aborted);
  if (alreadyAborted) {
    controller.abort(alreadyAborted.reason);
    return { signal: controller.signal, dispose: () => {} };
  }

  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timer = undefined;
    cleanup();
    controller.abort(timeoutReason());
  }, timeoutMs);

  // Node keeps the process alive for pending timers; a deadline guard should
  // never be the reason a CLI or utility process refuses to exit.
  timer?.unref?.();

  const forwarders: Array<() => void> = [];
  function cleanup(): void {
    for (const off of forwarders.splice(0)) off();
  }

  for (const source of upstream) {
    const onAbort = () => {
      dispose();
      controller.abort(source.reason);
    };
    source.addEventListener("abort", onAbort, { once: true });
    forwarders.push(() => source.removeEventListener("abort", onAbort));
  }

  function dispose(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    cleanup();
  }

  return { signal: controller.signal, dispose };
}

/**
 * Runs `work` under a deadline signal and disposes the timer once it settles.
 * The common shape — everything the caller needs is the signal for the duration
 * of one awaited call.
 */
export async function withTimeoutSignal<T>(
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
  ...linked: ReadonlyArray<AbortSignal | null | undefined>
): Promise<T> {
  const handle = createTimeoutSignal(timeoutMs, ...linked);
  try {
    return await work(handle.signal);
  } finally {
    handle.dispose();
  }
}
