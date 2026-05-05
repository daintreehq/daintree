/**
 * Schedule a recurring timer aligned to wall-clock boundaries.
 *
 * The first tick fires at the next multiple of `periodMs` (e.g., for a 30s
 * period, at :00 or :30 past the minute). Subsequent ticks run at fixed
 * `periodMs` intervals from that point.
 *
 * Both the initial alignment timeout and the ongoing interval are unref'd so
 * the timer never blocks process exit.
 *
 * @returns An idempotent cleanup function that cancels whichever timer is
 *          active (timeout before the first tick, interval after).
 */
export function setAlignedInterval(fn: () => void, periodMs: number): () => void {
  if (!Number.isFinite(periodMs) || periodMs <= 0) {
    throw new RangeError("periodMs must be a positive finite number");
  }

  const delay = (periodMs - (Date.now() % periodMs)) % periodMs;

  let interval: ReturnType<typeof setInterval> | null = null;
  let cleared = false;

  const timeout = setTimeout(() => {
    if (cleared) return;
    fn();
    if (cleared) return;
    interval = setInterval(fn, periodMs);
    interval.unref();
  }, delay);
  timeout.unref();

  return () => {
    if (cleared) return;
    cleared = true;
    clearTimeout(timeout);
    if (interval !== null) {
      clearInterval(interval);
      interval = null;
    }
  };
}
