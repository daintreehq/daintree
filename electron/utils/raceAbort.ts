/**
 * Settle with `onAbort` as soon as `signal` aborts, without waiting for
 * `work`. For awaits that can't take a signal themselves — plugin activation,
 * a queued semaphore, a shared PATH refresh — so a caller's deadline still
 * bounds them. `work` keeps running in the background; its eventual rejection
 * is handled here, so an abandoned promise never surfaces as unhandled.
 */
export function raceAbort<T, A>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: A
): Promise<T | A> {
  if (!signal) return work;
  return new Promise<T | A>((resolve, reject) => {
    const abort = () => resolve(onAbort);
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}
