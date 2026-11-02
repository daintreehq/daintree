import { useMemo } from "react";
import type { AgentState } from "@shared/types/agent";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { getGroupAmbientAgentState } from "@/components/Layout/useDockBlockedState";
import { useUnseenAskRunIds } from "@/hooks/useRunFleetBand";

/**
 * The state a grid tab group's edge takes from its tabs: waiting for a hidden
 * tab asking something the user hasn't seen, working for any tab at work. Only PTY
 * panels carry agent state; browser and dev-preview tabs contribute nothing.
 */
export function useGridGroupAmbientState(
  panels: readonly PanelInstance[],
  activeTabId: string
): AgentState | undefined {
  const unseenAskRunIds = useUnseenAskRunIds();
  return useMemo(
    () => getGroupAmbientAgentState(panels.filter(isPtyPanel), unseenAskRunIds, activeTabId),
    [panels, unseenAskRunIds, activeTabId]
  );
}
