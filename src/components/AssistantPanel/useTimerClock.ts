import { useEffect, useState } from "react";

/**
 * How often a surface showing a countdown re-reads the clock.
 *
 * One second, because the shortest thing these surfaces render is a countdown whose
 * display granularity IS one second ("in 9s"). Anything slower makes a timer about to
 * fire look stuck; anything faster re-renders for a reading that cannot have changed.
 */
export const TIMER_CLOCK_TICK_MS = 1000;

/**
 * A clock that actually moves — and only while something is watching it.
 *
 * Every relative time on the assistant's timer surfaces is computed against `now`, and
 * `now` used to be a bare `Date.now()` read during render. That is a reading, not a
 * clock: React had no reason to render again, so a countdown froze at whatever the
 * time was when the surface appeared and sat there while the timer underneath it came
 * due and fired. The one thing on screen that points FORWARDS was the one thing that
 * never moved.
 *
 * `active` is not an optimisation, it is the correctness half. The assistant panel
 * HIDES rather than unmounts — it slides off-canvas — so a bare interval keeps
 * re-rendering a surface nobody can see for the rest of the session. Pass whatever
 * says "this is on screen"; the interval is torn down whenever that goes false, and
 * the clock re-reads immediately when it comes back so it never shows a stale time
 * from before it was paused.
 *
 * Uses rendered state rather than an unread counter on purpose: this repo compiles
 * with the React Compiler, which has previously turned a `setTick(t => t + 1)` whose
 * value nothing read into a no-op. `now` is returned and rendered, so it cannot be
 * elided.
 */
export function useTimerClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    // Re-read on the way in. Resuming after a pause with the old reading would draw
    // one frame of a countdown that is however long the pause was out of date.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TIMER_CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, [active]);
  return now;
}
