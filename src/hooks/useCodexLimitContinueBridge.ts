import { useEffect } from "react";
import { useCodexLimitContinueStore } from "@/store/codexLimitContinueStore";

/**
 * Mirrors main's armed Codex panes for this view (#17909): the list when the
 * view loads, then every change main pushes. A change pushed before the list
 * answers is newer than it, so it is kept over the list's entry.
 */
export function useCodexLimitContinueBridge(): void {
  useEffect(() => {
    const api = window.electron?.codexLimitContinue;
    if (!api) return;
    let disposed = false;
    const changedSinceSnapshot = new Set<string>();

    const offChanged = api.onChanged((change) => {
      changedSinceSnapshot.add(change.terminalId);
      useCodexLimitContinueStore.getState().applyChange(change);
    });
    void api
      .list()
      .then((entries) => {
        if (disposed) return;
        const store = useCodexLimitContinueStore.getState();
        const kept = Object.entries(store.panes)
          .filter(([terminalId]) => changedSinceSnapshot.has(terminalId))
          .map(([terminalId, pane]) => ({ terminalId, ...pane }));
        store.replaceAll([
          ...entries.filter((entry) => !changedSinceSnapshot.has(entry.terminalId)),
          ...kept,
        ]);
      })
      .catch(() => {
        // Nothing armed is shown, which is what a view that can't ask should show.
      });

    return () => {
      disposed = true;
      offChanged();
    };
  }, []);
}
