import { useEffect, useRef } from "react";
import { subscribeViewIdle } from "./hostBridge.js";

export interface AnimationFrameOptions {
  /** False stops the loop. Default true. */
  enabled?: boolean;
  /**
   * The view's `disposeSignal` (or a {@link ViewScope}'s `signal`). Once it
   * aborts no further frame is requested, even before React unmounts the view.
   */
  signal?: AbortSignal;
}

/**
 * Called once per frame. `dt` is the time since the previous frame the loop
 * ran, in ms, and is 0 on the first frame after the loop starts or resumes, so
 * a simulation never jumps by the time it spent paused. `time` is the frame's
 * `requestAnimationFrame` timestamp.
 */
export type AnimationFrameCallback = (dt: number, time: number) => void;

/**
 * A `requestAnimationFrame` loop that stops while nobody can see the view and
 * starts again when someone can.
 *
 * It pauses while the document is hidden (the window is minimised or covered)
 * and while main has cached this project view — the case the DOM cannot see:
 * a backgrounded project keeps reporting `visibilityState === "visible"` and
 * keeps firing frames at the full rate. Both come back as a resume, with
 * `dt` 0 on its first frame.
 *
 * ```tsx
 * useAnimationFrame((dt) => {
 *   sim.step(dt / 1000);
 *   sim.draw(ctx);
 * }, { signal: disposeSignal });
 * ```
 *
 * The latest `callback` is always the one called, so an inline closure does
 * not restart the loop. A callback that throws is logged and the loop goes on.
 * Outside a browser (SSR, no `requestAnimationFrame`) it does nothing.
 */
export function useAnimationFrame(
  callback: AnimationFrameCallback,
  options: AnimationFrameOptions = {}
): void {
  const { enabled = true, signal } = options;
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  });

  useEffect(() => {
    if (!enabled || signal?.aborted) return;
    if (typeof requestAnimationFrame !== "function") return;

    let frame: number | null = null;
    let last: number | null = null;
    let stopped = false;

    const tick = (time: number): void => {
      frame = null;
      if (stopped) return;
      const dt = last === null ? 0 : Math.max(0, time - last);
      last = time;
      try {
        callbackRef.current(dt, time);
      } catch (error) {
        console.error("@daintreehq/plugin-sdk/react: a useAnimationFrame callback threw.", error);
      }
      // The callback may have hidden the view or aborted the signal.
      if (!stopped && frame === null && !idle.isIdle()) frame = requestAnimationFrame(tick);
    };

    const pause = (): void => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      last = null;
    };

    // Reconcile on every edge rather than trusting which one fired: a mount
    // can land in an already-cached view, and the latch is what says so.
    const sync = (): void => {
      if (stopped) return;
      if (idle.isIdle()) pause();
      else if (frame === null) frame = requestAnimationFrame(tick);
    };

    const idle = subscribeViewIdle(sync);
    const stop = (): void => {
      stopped = true;
      pause();
      idle.dispose();
      signal?.removeEventListener("abort", stop);
    };
    signal?.addEventListener("abort", stop, { once: true });
    sync();
    return stop;
  }, [enabled, signal]);
}
