import { useEffect, useRef } from "react";
import { isProjectViewObservable, subscribeProjectViewObservability } from "@/lib/viewCacheState";

/**
 * Per-component 1Hz-style interval that pauses while nobody can observe the
 * view (hidden window or cached project view) and snaps to wall-clock time on
 * restore. Replaces the global-singleton `useGlobalSecondTicker` for consumers
 * that genuinely need per-second fidelity (live countdowns, elapsed timers) —
 * the interval only runs while the owning component is mounted and `enabled`,
 * instead of waking every relative-time label in the app.
 */
export function useVisibilityAwareInterval(
  callback: () => void,
  intervalMs: number,
  enabled = true
): void {
  const savedCallback = useRef(callback);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled) return;

    let id: ReturnType<typeof setInterval> | null = null;
    const tick = () => savedCallback.current();

    const start = () => {
      if (id === null) id = setInterval(tick, intervalMs);
    };
    const stop = () => {
      if (id !== null) {
        clearInterval(id);
        id = null;
      }
    };
    const unsubscribe = subscribeProjectViewObservability((observable) => {
      if (observable) {
        tick();
        start();
      } else {
        stop();
      }
    });
    if (isProjectViewObservable()) start();

    return () => {
      stop();
      unsubscribe();
    };
  }, [intervalMs, enabled]);
}
