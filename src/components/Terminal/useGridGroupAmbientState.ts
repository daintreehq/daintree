import { useMemo } from "react";
import type { AgentState } from "@shared/types/agent";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import {
  getGroupAmbientAgentState,
  useDockBlockedState,
} from "@/components/Layout/useDockBlockedState";
import { useUnseenAsks } from "@/hooks/useRunFleetBand";
import {
  hasUnseenRecordFailure,
  RECORD_FAILURE_SOURCES,
  usePanelFailureStore,
  type PanelFailureState,
  type RecordFailureSource,
} from "@/store/panelFailureStore";

const WAIT_SOURCES: readonly RecordFailureSource[] = ["wait"];
const HELD_SOURCES = RECORD_FAILURE_SOURCES.filter((source) => source !== "wait");

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
  const hiddenFailure = (state: PanelFailureState, sources: readonly RecordFailureSource[]) =>
    panels.some(
      (panel) =>
        panel.id !== activeTabId &&
        isPtyPanel(panel) &&
        hasUnseenRecordFailure(state, panel.id, sources)
    );
  const held = usePanelFailureStore((state) => hiddenFailure(state, HELD_SOURCES));
  const waiting = usePanelFailureStore((state) => hiddenFailure(state, WAIT_SOURCES));
  // An error wait draws through the debounce its own pane's edge does, so a
  // wait that passes in a moment never flashes the group red.
  const waitShown = useDockBlockedState(waiting ? "waiting" : undefined) === "waiting";
  return held || waitShown;
}
