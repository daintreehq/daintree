import { useEffect, useState } from "react";
import { scheduleFlip } from "@/utils/flipScheduler";

/**
 * The wall-clock time a component renders from: read when it mounts, re-read
 * whenever `key` changes, and re-read when the delay `nextDelay` returns runs
 * out (null means nothing will change, so nothing is scheduled).
 *
 * Render must never call `Date.now()` itself. React Compiler memoizes
 * render-time calls by their arguments and cannot see that the clock moved, so
 * a component that re-renders on a timer keeps serving the reading from its
 * first render — the activity light held full green forever and its age label
 * never advanced. Holding the reading in state makes everything derived from
 * it depend on it, compiled or not.
 */
export function useWallClock(key: unknown, nextDelay: (now: number) => number | null): number {
  const [reading, setReading] = useState(() => ({ key, now: Date.now() }));

  if (!Object.is(reading.key, key)) {
    // A new subject is a new observation. Adjusting state during render means
    // React discards this pass and re-renders before committing, so no frame
    // is drawn against the previous subject's reading. The clock is read in
    // the updater, never in render, where the compiler would cache it once.
    setReading(() => ({ key, now: Date.now() }));
  }
  const { now } = reading;

  useEffect(() => {
    const delay = nextDelay(now);
    if (delay === null) return;
    return scheduleFlip(delay, () => setReading({ key, now: Date.now() }));
  }, [key, now, nextDelay]);

  return now;
}
