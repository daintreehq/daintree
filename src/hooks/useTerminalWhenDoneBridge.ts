import { useEffect } from "react";
import { isPtyPanel } from "@shared/types/panel";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useTerminalWhenDoneStore } from "@/store/terminalWhenDoneStore";
import { hasHeldComposerSend } from "@/store/heldComposerSendStore";

/**
 * Whether someone is using a pane in this view (#16171), so its When done
 * choice must leave it where it is: it, or its expanded composer, holds real
 * keyboard focus in a focused window, or its composer holds a draft or a
 * held send that closing it would lose. Anything else (a glance, the pointer over it) can't
 * be observed, so it doesn't count.
 */
export function isTerminalPaneInUseHere(terminalId: string): boolean {
  if (typeof document !== "undefined" && document.hasFocus()) {
    const active = document.activeElement;
    if (active instanceof Element) {
      const pane = active.closest("[data-panel-id]");
      if (pane?.getAttribute("data-panel-id") === terminalId) return true;
      // The expanded composer portals out of its pane and names it instead.
      const composer = active.closest("[data-composer-terminal-id]");
      if (composer?.getAttribute("data-composer-terminal-id") === terminalId) return true;
    }
  }
  // A send held for the pane's next prompt (#16379) is a draft closing would lose.
  if (hasHeldComposerSend(terminalId)) return true;
  // Drafts are keyed by the composer's project scope, so match the id alone.
  for (const [key, draft] of useTerminalInputStore.getState().draftInputs) {
    if (draft.trim() === "") continue;
    if (key === terminalId || key.endsWith(`:${terminalId}`)) return true;
  }
  return false;
}

/**
 * Mirrors main's When done choices for this view's terminals, answers main's
 * question whether a pane is in use, and moves or removes a pane when main
 * applies its choice. A pane someone started using since main asked stays
 * where it is; a closed one is left exited, its session already captured.
 */
export function useTerminalWhenDoneBridge(): void {
  useEffect(() => {
    const api = window.electron?.terminalWhenDone;
    if (!api) return;
    let disposed = false;
    // Changes pushed before the snapshot answers are newer than it.
    const changedSinceSnapshot = new Set<string>();

    const offChanged = api.onChanged((change) => {
      changedSinceSnapshot.add(change.terminalId);
      useTerminalWhenDoneStore.getState().applyChange(change);
    });
    void api
      .list()
      .then((entries) => {
        if (disposed) return;
        const store = useTerminalWhenDoneStore.getState();
        const kept = Object.entries(store.choices)
          .filter(([terminalId]) => changedSinceSnapshot.has(terminalId))
          .map(([terminalId, choice]) => ({ terminalId, choice }));
        store.replaceAll([
          ...entries.filter((entry) => !changedSinceSnapshot.has(entry.terminalId)),
          ...kept,
        ]);
      })
      .catch(() => {
        // Nothing armed is shown, which is what a view that can't ask should show.
      });

    const offInUse = api.onInUseQuery(({ requestId, terminalId }) => {
      api.sendInUseReply({ requestId, inUse: isTerminalPaneInUseHere(terminalId) });
    });

    const offFinish = api.onFinishRequest(({ terminalId, action }) => {
      const state = usePanelStore.getState();
      const panel = state.panelsById[terminalId];
      if (!panel || !isPtyPanel(panel)) return;
      if (isTerminalPaneInUseHere(terminalId)) return;
      if (action === "remove") {
        // Main already closed the terminal the quit way; a second kill could
        // reach a same-id successor.
        state.removePanel(terminalId, { backendAlreadyClosed: true });
        return;
      }
      if (panel.location === "grid" || panel.location === "dock") {
        state.backgroundTerminal(terminalId);
      }
    });

    return () => {
      disposed = true;
      offChanged();
      offInUse();
      offFinish();
    };
  }, []);
}
