import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { computeSavedScopePaneCount } from "@/services/actions/definitions/fleetActions";
import type { FleetSavedScope } from "@shared/types";
import { rankSavedFleets, rankPredicateFleets } from "./fleetRanking";

export interface SavedFleetList {
  /** Snapshots with at least one pane still open, frecency-ranked. */
  snapshotUsable: FleetSavedScope[];
  /** Snapshots whose stored panes are all gone — kept visible for cleanup. */
  snapshotStale: FleetSavedScope[];
  /** Live rules, frecency-ranked. */
  rules: FleetSavedScope[];
  /** Panes each fleet would arm right now. */
  countById: Record<string, number>;
}

/**
 * Every saved fleet, grouped and ranked, with its live pane count. Shared by
 * the ribbon's selection menu and the cold-start picker palette so the two
 * never disagree about what is saved or what it would arm.
 *
 * Nothing the user saved is filtered out. A live rule that happens to match
 * one of the menu's built-in presets still carries the user's name, and hiding
 * it left a fleet that could be neither found, recalled by name, nor deleted.
 */
export function useSavedFleets(): SavedFleetList {
  const savedScopes = useProjectSettingsStore(
    useShallow((s) => s.settings?.fleetSavedScopes ?? [])
  );
  // "This worktree" rules count against the active worktree, which lives in
  // its own store — subscribe so switching worktrees re-derives the counts.
  useWorktreeSelectionStore((s) => s.activeWorktreeId);
  // Primitive-valued selection (FleetCountChip pattern): re-derive counts when
  // panes open/close, but return a flat Record so unrelated panel ticks —
  // agent-state churn while a menu is open — reuse the previous reference and
  // skip the re-render entirely. A snapshot is stale exactly when none of its
  // stored ids is still arm-eligible (count 0).
  const countById = usePanelStore(
    useShallow(() => {
      const counts: Record<string, number> = {};
      for (const scope of savedScopes) {
        counts[scope.id] = computeSavedScopePaneCount(scope);
      }
      return counts;
    })
  );

  return useMemo(() => {
    const snapshots: FleetSavedScope[] = [];
    const rules: FleetSavedScope[] = [];
    for (const scope of savedScopes) {
      if (scope.kind === "snapshot") snapshots.push(scope);
      else rules.push(scope);
    }
    const now = Date.now();
    const isStaleById = new Map<string, boolean>();
    for (const scope of snapshots) {
      isStaleById.set(scope.id, (countById[scope.id] ?? 0) === 0);
    }
    const { usable, stale } = rankSavedFleets(snapshots, now, isStaleById);
    return {
      snapshotUsable: usable,
      snapshotStale: stale,
      rules: rankPredicateFleets(rules, now),
      countById,
    };
  }, [savedScopes, countById]);
}
