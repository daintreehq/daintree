import { useMemo } from "react";
import type { AgentState } from "@shared/types/agent";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { getGroupAmbientAgentState } from "@/components/Layout/useDockBlockedState";
import { useUnseenAsks } from "@/hooks/useRunFleetBand";
import { hasUnseenRecordFailure, usePanelFailureStore } from "@/store/panelFailureStore";

/**
 * The state a grid tab group's edge takes from its tabs: waiting for a hidden
 * tab asking something the user hasn't seen, working for any tab at work. Only PTY
 * panels carry agent state; browser and dev-preview tabs contribute nothing.
 */
export function useGridGroupAmbientState(
  panels: readonly PanelInstance[],
  activeTabId: string
): AgentState | undefined {
  const unseenAsks = useUnseenAsks();
  return useMemo(
    () => getGroupAmbientAgentState(panels.filter(isPtyPanel), unseenAsks, activeTabId),
    [panels, unseenAsks, activeTabId]
  );
}

/**
 * Whether a hidden tab shows a failure the user hasn't had in front of them,
 * by the marks its own pane's look writes. The shown tab draws its own. Any PTY
 * tab counts, as its own pane's red edge does for a shell's failed exit too.
 */
export function useGridGroupHiddenFailure(
  panels: readonly PanelInstance[],
  activeTabId: string
): boolean {
  return usePanelFailureStore((state) =>
    panels.some(
      (panel) =>
        panel.id !== activeTabId && isPtyPanel(panel) && hasUnseenRecordFailure(state, panel.id)
    )
  );
}
