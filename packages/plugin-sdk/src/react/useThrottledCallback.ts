import { useEffect, useRef, useState } from "react";

export interface ThrottledCallbackOptions {
  /**
   * Minimum gap between calls, in ms. Omitted, calls coalesce to one per
   * animation frame (trailing, with the latest arguments). With `ms`, the first
   * call runs at once and later ones within the window collapse into one
   * trailing call with the latest arguments.
   */
  ms?: number;
}

/** A throttled function from {@link useThrottledCallback}. Identity is stable for the life of the component. */
export type ThrottledCallback<A extends unknown[]> = ((...args: A) => void) & {
  /** Drop a pending trailing call. */
  cancel: () => void;
};

function schedule(ms: number | undefined, run: () => void): () => void {
  if (ms === undefined && typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(run);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(run, ms ?? 16);
  return () => clearTimeout(id);
}

/**
 * Coalesce a callback that fires faster than the view can usefully paint —
 * progress ticks, the latest status, pointer moves — so it runs at most once
 * per frame (or per `ms`) with the latest arguments. Wrap the state setter
 * rather than the render: pushes still arrive at full rate, React just commits
 * once per frame.
 *
 * Calls inside a window are dropped in favour of the last one, so this is for
 * values where only the newest matters. For logs or streamed lines, push every
 * chunk into a buffer (a ref) and flush the buffer to state once per frame.
 *
 * ```tsx
 * const [progress, setProgress] = useState(0);
 * const onTick = useThrottledCallback((p: { done: number }) => setProgress(p.done));
 * usePluginEvent(pluginId, "build-progress", onTick);
 * ```
 *
 * The latest `callback` is always the one called. A pending call is dropped on
 * unmount, and calls after unmount do nothing.
 */
export function useThrottledCallback<A extends unknown[]>(
  callback: (...args: A) => void,
  options: ThrottledCallbackOptions = {}
): ThrottledCallback<A> {
  const { ms } = options;
  const callbackRef = useRef(callback);
  const msRef = useRef(ms);
  useEffect(() => {
    callbackRef.current = callback;
    msRef.current = ms;
  });

  const timing = useRef<{
    pending: A | null;
    cancelTimer: (() => void) | null;
    lastRun: number;
    mounted: boolean;
  }>({ pending: null, cancelTimer: null, lastRun: Number.NEGATIVE_INFINITY, mounted: false });

  // Built once: `ms` is read at call time so changing it keeps the identity
  // and any pending call.
  const [throttled] = useState(() => {
    const flush = (): void => {
      const t = timing.current;
      t.cancelTimer = null;
      if (!t.pending || !t.mounted) return;
      const args = t.pending;
      t.pending = null;
      t.lastRun = Date.now();
      callbackRef.current(...args);
    };

    const call = (...args: A): void => {
      const t = timing.current;
      // A retained reference called after unmount is a no-op.
      if (!t.mounted) return;
      t.pending = args;
      if (t.cancelTimer) return;
      const gap = msRef.current;
      if (gap === undefined) {
        t.cancelTimer = schedule(undefined, flush);
        return;
      }
      const wait = t.lastRun + gap - Date.now();
      if (wait <= 0) flush();
      else t.cancelTimer = schedule(wait, flush);
    };

    const cancel = (): void => {
      const t = timing.current;
      t.pending = null;
      t.cancelTimer?.();
      t.cancelTimer = null;
    };

    return Object.assign(call, { cancel });
  });

  // Set in setup (not at creation) so StrictMode's simulated unmount and
  // remount leaves the function live.
  useEffect(() => {
    const t = timing.current;
    t.mounted = true;
    return () => {
      t.mounted = false;
      throttled.cancel();
    };
  }, [throttled]);
  return throttled;
}
