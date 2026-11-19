import { useEffect } from "react";
import { useCodexLimitContinueStore } from "@/store/codexLimitContinueStore";
import { onHostResync } from "@/store/hostResyncSignal";

/**
 * Mirrors main's armed Codex panes for this view (#17909): the list when the
 * view loads, then every change main pushes, and the list again when a remote
 * view's link comes back, since pushes may have been lost on the way.
 */
export function useCodexLimitContinueBridge(): void {
  useEffect(() => {
    const api = window.electron?.codexLimitContinue;
    if (!api) return;
    let disposed = false;
    // The panes pushed since the latest list was asked for.
    let pushedSince = new Set<string>();

    const offChanged = api.onChanged((change) => {
      // Only a push the view took is newer than the list it may be racing.
      if (useCodexLimitContinueStore.getState().applyChange(change)) {
        pushedSince.add(change.terminalId);
      }
    });
    const refresh = () => {
      const asked = new Set<string>();
      pushedSince = asked;
      void api
        .list()
        .then((entries) => {
          // A later ask supersedes this one.
          if (disposed || pushedSince !== asked) return;
          useCodexLimitContinueStore.getState().mergeSnapshot(entries, asked);
        })
        .catch(() => {
          // Nothing armed is shown, which is what a view that can't ask should show.
        });
    };
    refresh();
    const offResync = onHostResync(refresh);

    return () => {
      disposed = true;
      offChanged();
      offResync();
    };
  }, []);
}
