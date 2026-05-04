import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorktreeColorMap } from "@/hooks";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";
import type { AgentState } from "@/types";

export interface FleetWorktreeScope {
  worktreeCount: number;
  colors: string[];
  exitedCount: number;
}

export function useFleetWorktreeScope(): FleetWorktreeScope {
  const armOrder = useFleetArmingStore((s) => s.armOrder);
  const colorMap = useWorktreeColorMap();
  // Two primitive-valued selectors instead of one nested-object selector so
  // useShallow's one-level equality check stays effective and we don't trigger
  // an infinite re-render loop on every store tick.
  const worktreeIdsByPane = usePanelStore(
    useShallow((state) => {
      const out: Record<string, string | undefined> = {};
      for (const id of armOrder) {
        out[id] = state.panelsById[id]?.worktreeId;
      }
      return out;
    })
  );
  const agentStatesByPane = usePanelStore(
    useShallow((state) => {
      const out: Record<string, AgentState | undefined> = {};
      for (const id of armOrder) {
        out[id] = state.panelsById[id]?.agentState;
      }
      return out;
    })
  );

  return useMemo<FleetWorktreeScope>(() => {
    let exitedCount = 0;
    const uniqueWorktreeIds = new Set<string>();
    for (const paneId of armOrder) {
      if (agentStatesByPane[paneId] === "exited") exitedCount += 1;
      const wtId = worktreeIdsByPane[paneId];
      if (wtId) uniqueWorktreeIds.add(wtId);
    }

    if (!colorMap) {
      return { worktreeCount: uniqueWorktreeIds.size, colors: [], exitedCount };
    }

    const sortedIds = Array.from(uniqueWorktreeIds).sort();
    const seenColors = new Set<string>();
    const colors: string[] = [];
    for (const wtId of sortedIds) {
      const color = colorMap[wtId];
      if (!color || seenColors.has(color)) continue;
      seenColors.add(color);
      colors.push(color);
    }
    return { worktreeCount: uniqueWorktreeIds.size, colors, exitedCount };
  }, [armOrder, worktreeIdsByPane, agentStatesByPane, colorMap]);
}
