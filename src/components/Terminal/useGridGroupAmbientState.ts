import { useMemo } from "react";
import type { AgentState } from "@shared/types/agent";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { getGroupAmbientAgentState } from "@/components/Layout/useDockBlockedState";
import { useFleetBandRunIds } from "@/hooks/useRunFleetBand";
import { NEEDS_YOU_BANDS } from "@/lib/fleetAttention";

/**
 * The state a grid tab group's edge takes from its tabs: waiting for a hidden
 * tab the fleet places in needs-you, working for any tab at work. Only PTY
 * panels carry agent state; browser and dev-preview tabs contribute nothing.
 */
export function useGridGroupAmbientState(
  panels: readonly PanelInstance[],
  activeTabId: string
): AgentState | undefined {
  const needsYouRunIds = useFleetBandRunIds(NEEDS_YOU_BANDS);
  return useMemo(
    () => getGroupAmbientAgentState(panels.filter(isPtyPanel), needsYouRunIds, activeTabId),
    [panels, needsYouRunIds, activeTabId]
  );
}
