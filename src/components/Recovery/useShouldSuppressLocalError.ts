import { useEffect, useState } from "react";

import { LOCAL_ERROR_SETTLE_MS, getPerformanceModeFloor } from "@/lib/animationUtils";

import { useGlobalBannerPriority, type GlobalBannerSlot } from "./useGlobalBannerPriority";

/** Classification of pane-local error banners. Determines whether an active
 *  global recovery cause (see `useGlobalBannerPriority`) suppresses the banner.
 *
 *  - `backend-dependent` — the banner describes a failure whose only recovery
 *    path runs through the backend (spawn, reconnect, restart). Suppressed only
 *    while a *recovery* global cause is active (see `SLOT_IS_RECOVERY`), because
 *    the user can't act on it until the backend is healthy again. Advisory
 *    causes (`forge-token`, `cloud-sync`) leave the backend connected, so the
 *    banner stays visible and actionable.
 *  - `parse-error` — the banner describes a file-format or replay failure
 *    that's independent of host connectivity (e.g. corrupt saved scrollback).
 *    The terminal itself is operational; never suppressed.
 *  - `permission-error` — the banner describes an OS-level permission denial
 *    on a path the user can fix independently of the backend. Never suppressed.
 */
export type LocalErrorCategory = "backend-dependent" | "parse-error" | "permission-error";

/** Thin alias for `useGlobalBannerPriority`. Returns the active global recovery
 *  cause (or `null` if none). Co-located so callers of
 *  `useShouldSuppressLocalError` import both names from the same module. */
export function useActiveGlobalCause(): GlobalBannerSlot {
  return useGlobalBannerPriority();
}

/** Classifies each global banner slot as a *recovery* cause (the backend is
 *  unhealthy or its protection layer is down) versus an *advisory* cause (the
 *  backend is connected; the banner is informational). Only recovery causes
 *  suppress `backend-dependent` pane-local errors — under an advisory cause the
 *  backend is operational, so spawn/reconnect/restart banners stay actionable.
 *
 *  Declared as an exhaustive `Record` so adding a slot to `GlobalBannerSlot`
 *  without classifying it here is a compile error (TS2741) — the suppression
 *  domain can never silently widen to a new advisory slot. */
const SLOT_IS_RECOVERY: Record<Exclude<GlobalBannerSlot, null>, boolean> = {
  "host-crash": true,
  "watchdog-disabled": true,
  "safe-mode": true,
  "restore-confirmation": true,
  // Advisory: the backend is connected and a pane's own spawn/reconnect errors
  // stay actionable — a missing Git doesn't make them un-fixable.
  "missing-prerequisite": false,
  "forge-token": false,
  // Advisory: a consent question the user has not answered yet. Nothing about
  // the backend is unhealthy, so a pane's own spawn or reconnect error is still
  // both true and fixable while it is up.
  "project-plugin-trust": false,
  "cloud-sync": false,
  rosetta: false,
};

function isSuppressedByGlobalCause(cause: GlobalBannerSlot, category: LocalErrorCategory): boolean {
  if (cause === null) return false;
  switch (category) {
    case "backend-dependent":
      return SLOT_IS_RECOVERY[cause];
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
 *  `"connected"`. The settle tail applies only when no cause is active
 *  (`cause === null`); when an advisory cause (`forge-token`, `cloud-sync`)
 *  takes over the slot the backend is already connected, so un-suppression is
 *  immediate — the tail must not hide a now-actionable pane error (#10038).
 *  Performance mode bypasses the settle window (mirrors raw state instantly via
 *  `getPerformanceModeFloor`). Reduced-motion does NOT collapse this timer: per
 *  the app's policy, CSS owns reduced-motion; JS timers stay intact.
 *
 *  Stacks on top of the 500ms backend-side recoveryTimer in
 *  `src/store/listeners/panel/backendHealth.ts`. The total dead-zone from
 *  reconnect to local banner reappear is roughly `500 + LOCAL_ERROR_SETTLE_MS`. */
export function useShouldSuppressLocalError(category: LocalErrorCategory): boolean {
  const cause = useActiveGlobalCause();
  const rawSuppressed = isSuppressedByGlobalCause(cause, category);
  // `held` tracks the delayed-off tail: once a cause has activated, `held`
  // stays true until the settle window elapses with no cause active. The
  // returned value is `rawSuppressed || (cause === null && held)` so sticky-on
  // is synchronous with render — passive effects run *after* paint, so relying
  // on the effect to set state would leak one paint cycle of the local banner.
  // The `cause === null` guard scopes the tail to true no-cause: an advisory
  // cause holding the slot un-suppresses synchronously without a paint leak.
  const [held, setHeld] = useState(rawSuppressed);

  useEffect(() => {
    if (rawSuppressed) {
      setHeld(true);
      return;
    }
    // An advisory cause holds the slot (backend connected) — drop the tail now
    // rather than letting a leftover settle timer keep suppression alive.
    if (cause !== null) {
      setHeld(false);
      return;
    }
    const delay = getPerformanceModeFloor(LOCAL_ERROR_SETTLE_MS);
    if (delay <= 0) {
      setHeld(false);
      return;
    }
    const timer = setTimeout(() => setHeld(false), delay);
    return () => clearTimeout(timer);
  }, [rawSuppressed, cause]);

  return rawSuppressed || (cause === null && held);
}
