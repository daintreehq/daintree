import { useEffect } from "react";
import { composerHoldClient } from "@/clients/composerHoldClient";
import { notify } from "@/lib/notify";
import { useHeldComposerSendStore } from "@/store/heldComposerSendStore";
import { usePanelStore } from "@/store/panelStore";

type PanelsById = ReturnType<typeof usePanelStore.getState>["panelsById"];

/**
 * A drop its pane can't show, because the pane was closed or is in the
 * trash, whether the drop or the close came first. The inbox says so once,
 * without the message, which stays in the pane's row should it come back from
 * the trash.
 */
function reportDropsOutOfSight(
  panels: PanelsById,
  previous: PanelsById,
  reported: Set<string>
): void {
  for (const [terminalId, note] of Object.entries(useHeldComposerSendStore.getState().dropped)) {
    const panel = panels[terminalId];
    if (panel !== undefined && panel.location !== "trash") continue;
    if (reported.has(note.token)) continue;
    reported.add(note.token);
    const title = (panel ?? previous[terminalId])?.title?.trim();
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
  useHeldComposerSendStore.getState().forgetDroppedExcept(new Set(Object.keys(panels)));
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
    const reported = new Set<string>();
    const offChanged = composerHoldClient.onChanged((change) => {
      changedSinceSnapshot.add(change.terminalId);
      useHeldComposerSendStore.getState().applyChange(change);
      if (change.ended?.outcome.kind !== "dropped") return;
      const { panelsById } = usePanelStore.getState();
      reportDropsOutOfSight(panelsById, panelsById, reported);
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
      reportDropsOutOfSight(state.panelsById, previous.panelsById, reported);
    });
    return () => {
      disposed = true;
      offChanged();
      offPanels();
    };
  }, []);
}
