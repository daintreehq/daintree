import { useEffect } from "react";
import { isPtyPanel } from "@shared/types/panel";
import { usePanelStore } from "@/store/panelStore";

/**
 * Applies a scheduled run's done policy to its pane in this view (#15982),
 * when main asks: move it to the background, or remove it once main has
 * closed its terminal and captured its session. Only a pane launched for that
 * run is touched, so a request can't move any other pane, and a pane the user
 * already took out of the grid and dock stays where they put it.
 */
export function useScheduledRunFinishBridge(): void {
  useEffect(() => {
    const onFinishRequest = window.electron?.schedules?.onFinishRequest;
    if (!onFinishRequest) return;
    return onFinishRequest(({ runId, terminalId, action }) => {
      const state = usePanelStore.getState();
      const panel = state.panelsById[terminalId];
      if (!panel || !isPtyPanel(panel) || panel.scheduledRun?.runId !== runId) return;
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
  }, []);
}
