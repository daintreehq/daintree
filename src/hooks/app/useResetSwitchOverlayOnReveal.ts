import { useEffect } from "react";
import { useProjectStore } from "@/store/projectStore";

/**
 * Clears a stale project-switch busy flag when this view is revealed as the
 * foreground after being reactivated from the LRU cache (#10736 follow-up).
 *
 * Each project runs in its own `WebContentsView` with its own `projectStore`.
 * When a view initiates a switch it sets `isSwitching` true and is then
 * detached and parked in the LRU view cache — the happy path never clears the
 * flag because that renderer is replaced, not re-rendered. Switching *back*
 * later reactivates the cached view with `isSwitching` still true, so the
 * full-screen busy overlay reappears labelled with the project it once
 * switched away to and never clears, trapping all input.
 *
 * We key off the explicit main-process `app:view-revealed` signal, which
 * ProjectViewManager sends *only* to the cached view once it has detached the
 * anti-flash bridge and that view is the focused foreground surface (guarded by
 * `activeProjectId === projectId`). That is precisely "this cached view is now
 * the foreground" — unlike a bare DOM `visibilitychange`, which also fires on a
 * window minimize/restore and would wrongly clear the overlay of a switch still
 * legitimately in flight on the visible outgoing view. The overlay's own
 * watchdog is the backstop for any reveal path that doesn't emit the signal.
 */
export function useResetSwitchOverlayOnReveal(): void {
  useEffect(() => {
    return window.electron?.app?.onViewRevealed?.(() => {
      useProjectStore.getState().clearSwitching();
    });
  }, []);
}
