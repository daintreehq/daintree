import { isFleetArmEligible } from "@/store/fleetArmingStore";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import type { FleetSavedScope } from "@shared/types";
import type { PanelInstance } from "@shared/types/panel";

/**
 * A snapshot scope is "stale" when none of its stored terminal IDs still
 * resolve to an arm-eligible panel. Predicate scopes are never stale —
 * they re-evaluate against the current panel set on recall.
 *
 * Accepts `panelsById` as a parameter so the caller can pass the value
 * it's already memoized on. The `SavedFleetsSection` uses this for both
 * the sub-group placement and the per-row `aria-disabled` indicator.
 */
export function isSnapshotStale(
  scope: FleetSavedScope,
  panelsById: Record<string, PanelInstance>
): boolean {
  if (scope.kind !== "snapshot") return false;
  for (const id of scope.terminalIds) {
    if (isFleetArmEligible(getNarrowPanel(panelsById, id))) return false;
  }
  return true;
}
