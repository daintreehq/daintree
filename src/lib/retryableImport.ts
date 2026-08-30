/**
 * Dynamic-import wrapper whose failures stay retryable.
 *
 * `React.lazy` memoizes the *rejected* payload, so once a chunk import fails
 * the lazy component re-throws that same error forever and no remount, boundary
 * reset, or reopen ever re-fetches. A transient miss — a dev rebuild swapping
 * `dist/` out from under a running window, an asar read that fails once — then
 * disables the view for the rest of the session. This keeps the success cache
 * and drops the failure, so the next call issues a fresh `import()`.
 *
 * `peek()` returns the already-resolved module for a synchronous first render
 * on later opens, skipping the placeholder entirely.
 */
export interface RetryableImport<T> {
  (): Promise<T>;
  peek: () => T | null;
}

export function retryableImport<T>(load: () => Promise<T>): RetryableImport<T> {
  let cached: T | null = null;
  let inFlight: Promise<T> | null = null;

  const run = (): Promise<T> => {
    if (cached !== null) return Promise.resolve(cached);
    inFlight ??= load().then(
      (mod) => {
        cached = mod;
        inFlight = null;
        return mod;
      },
      (err: unknown) => {
        inFlight = null;
        throw err;
      }
    );
    return inFlight;
  };

  return Object.assign(run, { peek: () => cached });
}
