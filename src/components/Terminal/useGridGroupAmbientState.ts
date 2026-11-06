import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { AgentState } from "@shared/types/agent";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import {
  BLOCKED_DEBOUNCE_MS,
  getGroupAmbientAgentState,
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
  const hiddenWith = (state: PanelFailureState, sources: readonly RecordFailureSource[]) =>
    panels.filter(
      (panel) =>
        panel.id !== activeTabId &&
        isPtyPanel(panel) &&
        hasUnseenRecordFailure(state, panel.id, sources)
    );
  const held = usePanelFailureStore((state) => hiddenWith(state, HELD_SOURCES).length > 0);
  const waitingIds = usePanelFailureStore(
    useShallow((state) => hiddenWith(state, WAIT_SOURCES).map((panel) => panel.id))
  );
  // An error wait draws through the debounce its own pane's edge does, timed
  // per tab, so a wait that passes in a moment never flashes the group red.
  const sustained = useSustainedIds(waitingIds, BLOCKED_DEBOUNCE_MS);
  return held || waitingIds.some((id) => sustained.has(id));
}

/** The ids that have stayed in `ids` for `delayMs`, each timed from when it joined. */
function useSustainedIds(ids: readonly string[], delayMs: number): ReadonlySet<string> {
  const [sustained, setSustained] = useState<ReadonlySet<string>>(() => new Set());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const tracked = timers.current;
    const current = new Set(ids);
    for (const [id, timer] of tracked) {
      if (current.has(id)) continue;
      clearTimeout(timer);
      tracked.delete(id);
    }
    for (const id of current) {
      if (tracked.has(id)) continue;
      tracked.set(
        id,
        setTimeout(() => setSustained((prev) => new Set(prev).add(id)), delayMs)
      );
    }
    setSustained((prev) => {
      const kept = [...prev].filter((id) => current.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [ids, delayMs]);

  useEffect(() => {
    const tracked = timers.current;
    return () => {
      for (const timer of tracked.values()) clearTimeout(timer);
      tracked.clear();
    };
  }, []);

  return sustained;
}
