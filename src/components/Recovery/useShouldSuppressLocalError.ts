import { useEffect, useState } from "react";

import { LOCAL_ERROR_SETTLE_MS, getPerformanceModeFloor } from "@/lib/animationUtils";

import { useRecoveryPriority, type RecoveryBannerSlot } from "./useRecoveryPriority";

/** Classification of pane-local error banners. Determines whether an active
 *  global recovery cause (see `useRecoveryPriority`) suppresses the banner.
 *
 *  - `backend-dependent` — the banner describes a failure whose only recovery
 *    path runs through the backend (spawn, reconnect, restart). Always
 *    suppressed while a global cause is active, because the user can't act on
 *    it until the global cause clears.
 *  - `parse-error` — the banner describes a file-format or replay failure
 *    that's independent of host connectivity (e.g. corrupt saved scrollback).
 *    The terminal itself is operational; never suppressed.
 *  - `permission-error` — the banner describes an OS-level permission denial
 *    on a path the user can fix independently of the backend. Never suppressed.
 */
export type LocalErrorCategory = "backend-dependent" | "parse-error" | "permission-error";

/** Thin alias for `useRecoveryPriority`. Returns the active global recovery
 *  cause (or `null` if none). Co-located so callers of
 *  `useShouldSuppressLocalError` import both names from the same module. */
export function useActiveGlobalCause(): RecoveryBannerSlot {
  return useRecoveryPriority();
}

function isSuppressedByGlobalCause(
  cause: RecoveryBannerSlot,
  category: LocalErrorCategory
): boolean {
  if (cause === null) return false;
  switch (category) {
    case "backend-dependent":
      return true;
    case "parse-error":
    case "permission-error":
      return false;
    default: {
      const _exhaustive: never = category;
      return _exhaustive;
    }
  }
}

/** Returns whether a pane-local error banner of the given `category` should be
 *  suppressed because of an active global recovery cause.
 *
 *  Sticky-on / delayed-off: suppression turns true immediately when a global
 *  cause activates (so a local banner never races a host-crash banner into
 *  view), and turns false only after `LOCAL_ERROR_SETTLE_MS` of sustained
 *  no-cause — this absorbs `backendStatus` flicker between `"recovering"` and
 *  `"connected"`. Performance mode bypasses the settle window (mirrors raw
 *  state instantly via `getPerformanceModeFloor`). Reduced-motion does NOT
 *  collapse this timer: per the app's policy, CSS owns reduced-motion;
 *  JS timers stay intact.
 *
 *  Stacks on top of the 500ms backend-side recoveryTimer in
 *  `src/store/listeners/panel/backendHealth.ts`. The total dead-zone from
 *  reconnect to local banner reappear is roughly `500 + LOCAL_ERROR_SETTLE_MS`. */
export function useShouldSuppressLocalError(category: LocalErrorCategory): boolean {
  const cause = useActiveGlobalCause();
  const rawSuppressed = isSuppressedByGlobalCause(cause, category);
  // `held` tracks the delayed-off tail: once a cause has activated, `held`
  // stays true until the settle window elapses with no cause active. The
  // returned value is `rawSuppressed || held` so sticky-on is synchronous
  // with render — passive effects run *after* paint, so relying on the
  // effect to set state would leak one paint cycle of the local banner.
  const [held, setHeld] = useState(rawSuppressed);

  useEffect(() => {
    if (rawSuppressed) {
      setHeld(true);
      return;
    }
    const delay = getPerformanceModeFloor(LOCAL_ERROR_SETTLE_MS);
    if (delay <= 0) {
      setHeld(false);
      return;
    }
    const timer = setTimeout(() => setHeld(false), delay);
    return () => clearTimeout(timer);
  }, [rawSuppressed]);

  return rawSuppressed || held;
}
