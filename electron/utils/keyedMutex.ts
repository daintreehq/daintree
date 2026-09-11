/**
 * Per-key serialisation for async work: every `runExclusive(key, fn)` for the
 * same key runs after the previous one settles, and different keys never wait
 * on each other. The queue is a promise tail per key, so there is no lock
 * object to leak and nothing to release — a job that throws still lets the
 * next one run.
 *
 * Two details keep the tail honest (#10108): each link swallows its own
 * rejection before the next job chains on it, so a failed write can never
 * poison the queue for every later caller, and the map entry is dropped only
 * by the job that is still the tail, so a job that finishes after a newer one
 * was queued does not delete the newer job's link.
 */
const tails = new Map<string, Promise<unknown>>();

export function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const link = run.catch(() => undefined);
  tails.set(key, link);
  const settle = () => {
    if (tails.get(key) === link) tails.delete(key);
  };
  link.then(settle, settle);
  return run;
}

/** Whether a job for `key` is running or queued. */
export function isKeyBusy(key: string): boolean {
  return tails.has(key);
}

export function __resetKeyedMutexForTests(): void {
  tails.clear();
}
