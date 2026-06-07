/**
 * Bounded-wait primitives for async work that must never block a poll loop or
 * a serialized queue indefinitely.
 *
 * `withTimeout` races a promise against a timer and rejects on expiry — it does
 * NOT cancel the underlying work (the orphaned promise keeps running). Use it
 * for queue-task watchdogs and for fs calls that don't accept an AbortSignal
 * (`fs.access`).
 *
 * `timeoutSignal` returns an AbortSignal that fires after `ms` (or when an
 * optional parent signal aborts). Pass it to fs/promises calls that accept a
 * `signal` option (`readFile` does; `stat` and `access` do NOT — bound those
 * with `withTimeout`) so a hung syscall is actually cancelled and its libuv
 * threadpool slot released — otherwise repeated hangs on a dead mount exhaust
 * the (default 4-thread) pool and stall ALL fs work process-wide.
 *
 * Both rely solely on `setTimeout`, so they remain deterministic under fake
 * timers in tests (unlike `AbortSignal.timeout`, which uses an internal timer).
 */

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Reject with `TimeoutError(message)` if `promise` hasn't settled within `ms`.
 * The timer is always cleared, so a fast-settling promise leaves nothing armed.
 * The underlying promise is not cancelled — pair with `timeoutSignal` when the
 * work supports an AbortSignal and the resource must be reclaimed on timeout.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export interface TimeoutSignalHandle {
  signal: AbortSignal;
  /** Clears the timer and detaches the parent listener. Always call in a finally. */
  dispose: () => void;
}

/**
 * Build an AbortSignal that aborts after `ms`, or immediately/eventually when
 * `parent` aborts. Returns a `dispose()` the caller MUST invoke in a `finally`
 * to clear the timer and detach the parent listener (otherwise a long-lived
 * parent signal leaks a listener per call).
 */
export function timeoutSignal(ms: number, parent?: AbortSignal): TimeoutSignalHandle {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new TimeoutError(`Operation timed out after ${ms}ms`));
  }, ms);

  let onParentAbort: (() => void) | undefined;
  if (parent) {
    if (parent.aborted) {
      controller.abort(parent.reason);
    } else {
      onParentAbort = () => controller.abort(parent.reason);
      parent.addEventListener("abort", onParentAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      if (parent && onParentAbort) {
        parent.removeEventListener("abort", onParentAbort);
      }
    },
  };
}
