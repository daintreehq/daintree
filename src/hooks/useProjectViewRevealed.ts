import { useEffect, useEffectEvent, useRef } from "react";
import { subscribeProjectViewLifecycle } from "@/lib/viewCacheState";

interface ProjectViewRevealedOptions {
  /**
   * Whether this consumer is on screen. A reveal arriving while false is
   * remembered and run once the consumer becomes presented — skipping outright
   * would strand it, since nothing re-emits the phase later.
   */
  enabled?: boolean;
}

/**
 * Run one-shot catch-up work when this project view returns to the foreground.
 *
 * `revealed` is the phase to gate on, not `active`: a switch superseded
 * mid-flight only ever reaches `active` (see `viewCacheState`), and a view that
 * never became the presenting surface has nothing to catch up for. A cold page
 * load emits no phase at all — a fresh view was never cached — so consumers keep
 * their own initial load without needing a page-load guard here.
 *
 * The listener is registered once and reads the newest callback through
 * `useEffectEvent`, so a caller can pass an inline closure over live state
 * without churning the subscription every render.
 */
export function useProjectViewRevealed(
  callback: () => void,
  { enabled = true }: ProjectViewRevealedOptions = {}
): void {
  // One bit, not a count: the work is "read the current state", so a consumer
  // hidden across several switches owes exactly one catch-up on the way back.
  const pendingRef = useRef(false);
  const enabledRef = useRef(enabled);

  const handleReveal = useEffectEvent(() => {
    if (!enabledRef.current) {
      pendingRef.current = true;
      return;
    }
    pendingRef.current = false;
    callback();
  });

  const flushPending = useEffectEvent(() => {
    if (!pendingRef.current) return;
    pendingRef.current = false;
    callback();
  });

  useEffect(() => {
    return subscribeProjectViewLifecycle((phase) => {
      if (phase === "revealed") handleReveal();
    });
  }, []);

  useEffect(() => {
    enabledRef.current = enabled;
    if (enabled) flushPending();
  }, [enabled]);
}
