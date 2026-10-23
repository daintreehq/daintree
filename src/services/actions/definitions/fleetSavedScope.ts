import { usePanelStore } from "@/store/panelStore";
import {
  isFleetArmEligible,
  collectEligibleIds,
  computeArmByStateIds,
  type FleetArmStatePreset,
} from "@/store/fleetArmingStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import type { FleetSavedScope } from "@shared/types";

/**
 * The panes a saved scope would arm right now. Snapshots keep only their
 * still-eligible stored IDs (silent drop semantics); predicates re-evaluate
 * against the current panel state and active worktree.
 */
export function resolveSavedScopeIds(scope: FleetSavedScope): string[] {
  if (scope.kind === "snapshot") {
    const { panelsById } = usePanelStore.getState();
    const ids = Array.isArray(scope.terminalIds) ? scope.terminalIds : [];
    return ids.filter((id) => isFleetArmEligible(getNarrowPanel(panelsById, id)));
  }
  const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId ?? null;
  if (scope.stateFilter === "all") {
    return collectEligibleIds(scope.scope, activeWorktreeId);
  }
  return computeArmByStateIds(
    scope.stateFilter as FleetArmStatePreset,
    scope.scope,
    activeWorktreeId
  );
}

/**
 * Compute how many panes a saved scope would currently arm. Used by the UI to
 * render live counts on saved-fleet rows.
 */
export function computeSavedScopePaneCount(scope: FleetSavedScope): number {
  return resolveSavedScopeIds(scope).length;
}
