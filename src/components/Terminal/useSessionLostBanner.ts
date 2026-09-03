import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { isPtyPanel, type SessionLostReason } from "@shared/types/panel";
import { usePanelStore } from "@/store/panelStore";
import { selectHasMultipleSessionLost } from "@/store/slices/panelRegistry/selectors";

export interface SessionLostBanner {
  /**
   * Set while this pane has an unacknowledged lost-session signal, naming why
   * (#12182). Feeds `getRestartBannerVariant`, which gates the banner below
   * the in-flight restart states.
   */
  sessionLostOnRestore: SessionLostReason | undefined;
  /** Acknowledge this pane's signal. */
  dismiss: () => void;
  /**
   * Acknowledge every flagged pane's signal, or `undefined` when this is the
   * only flagged pane — then the per-pane control already covers the whole set
   * and a second button would be noise.
   */
  dismissAll: (() => void) | undefined;
}

/**
 * Owns the "Session no longer reachable" banner's acknowledgement state for one
 * pane (issue #11589).
 *
 * Deliberately reads and writes the panel store rather than component state:
 * the grid renders only the active worktree's panels, so switching worktrees
 * unmounts this pane outright and any local dismissal would be lost on the way
 * back. Acknowledgement consumes `sessionLostOnRestore` itself — there is no
 * second "was it dismissed" flag to drift out of sync with the signal.
 *
 * Keeping this path in its own hook also makes the issue #10823 guarantee
 * structural rather than incidental: nothing here can reach
 * `dismissedRestartPrompt`, so acknowledging a lost session cannot suppress a
 * later exit-error banner for the fresh session.
 */
export function useSessionLostBanner(panelId: string): SessionLostBanner {
  const { sessionLostOnRestore, hasOtherSessionLost } = usePanelStore(
    useShallow((state) => {
      const panel = state.panelsById[panelId];
      const pty = panel && isPtyPanel(panel) ? panel : undefined;
      const flagged = pty?.sessionLostOnRestore;
      return {
        sessionLostOnRestore: flagged,
        // Gate the cross-panel scan on this pane's own flag: with no banner to
        // show there is nothing to offer a bulk dismissal for, so the common
        // case costs nothing. Flagged panes share one memoized scan per store
        // snapshot (see `selectHasMultipleSessionLost`).
        hasOtherSessionLost: flagged ? selectHasMultipleSessionLost(state.panelsById) : false,
      };
    })
  );

  const dismissSessionLost = usePanelStore((state) => state.dismissSessionLost);
  const dismissAllSessionLost = usePanelStore((state) => state.dismissAllSessionLost);

  const dismiss = useCallback(() => dismissSessionLost(panelId), [dismissSessionLost, panelId]);

  return {
    sessionLostOnRestore,
    dismiss,
    dismissAll: hasOtherSessionLost ? dismissAllSessionLost : undefined,
  };
}
