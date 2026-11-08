import { useEffect } from "react";
import { composerHoldClient } from "@/clients/composerHoldClient";
import { useHeldComposerSendStore } from "@/store/heldComposerSendStore";

/**
 * Mirrors main's held composer sends for this view's project (#16379). Pushes
 * that arrive before the snapshot answers are newer than it.
 */
export function useHeldComposerSendBridge(): void {
  useEffect(() => {
    if (!window.electron?.composerHold) return;
    let disposed = false;
    const changedSinceSnapshot = new Set<string>();
    const offChanged = composerHoldClient.onChanged((change) => {
      changedSinceSnapshot.add(change.terminalId);
      useHeldComposerSendStore.getState().applyChange(change);
    });
    void composerHoldClient
      .list()
      .then((sends) => {
        if (disposed) return;
        const store = useHeldComposerSendStore.getState();
        const kept = Object.values(store.held).filter((send) =>
          changedSinceSnapshot.has(send.terminalId)
        );
        store.replaceAll([
          ...sends.filter((send) => !changedSinceSnapshot.has(send.terminalId)),
          ...kept,
        ]);
      })
      .catch(() => {
        // A view that can't ask shows nothing held, and a send it makes asks again.
      });
    return () => {
      disposed = true;
      offChanged();
    };
  }, []);
}
