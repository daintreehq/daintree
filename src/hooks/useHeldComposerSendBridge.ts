import { useEffect } from "react";
import { composerHoldClient } from "@/clients/composerHoldClient";
import { notify } from "@/lib/notify";
import { useHeldComposerSendStore } from "@/store/heldComposerSendStore";
import { usePanelStore } from "@/store/panelStore";
import type { ComposerHoldChange } from "@shared/types/ipc/composerHold";

/**
 * A drop its pane can't show: the pane was closed, or is in the trash. The
 * inbox says so, without the message, which stays in the pane's row should it
 * come back from the trash.
 */
function noteDropOutOfSight(change: ComposerHoldChange): void {
  if (change.ended?.outcome.kind !== "dropped") return;
  const panel = usePanelStore.getState().panelsById[change.terminalId];
  if (panel !== undefined && panel.location !== "trash") return;
  if (panel === undefined) useHeldComposerSendStore.getState().clearDropped(change.terminalId);
  const title = panel?.title?.trim();
  const message = title
    ? `“${title}” closed before its held message was sent.`
    : "A pane closed before its held message was sent.";
  notify({
    type: "info",
    title: "Held message not sent",
    message,
    inboxMessage: message,
    priority: "low",
  });
}

/**
 * Mirrors main's held composer sends for this view's project (#16379). Pushes
 * that arrive before the snapshot answers are newer than it. A pane this view
 * removes takes its dropped send's text with it.
 */
export function useHeldComposerSendBridge(): void {
  useEffect(() => {
    if (!window.electron?.composerHold) return;
    let disposed = false;
    const changedSinceSnapshot = new Set<string>();
    const offChanged = composerHoldClient.onChanged((change) => {
      changedSinceSnapshot.add(change.terminalId);
      useHeldComposerSendStore.getState().applyChange(change);
      noteDropOutOfSight(change);
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
    const offPanels = usePanelStore.subscribe((state, previous) => {
      if (state.panelsById === previous.panelsById) return;
      useHeldComposerSendStore
        .getState()
        .forgetDroppedExcept(new Set(Object.keys(state.panelsById)));
    });
    return () => {
      disposed = true;
      offChanged();
      offPanels();
    };
  }, []);
}
