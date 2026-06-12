import { useMemo, type ReactElement } from "react";
import { useShallow } from "zustand/react/shallow";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { usePanelStore } from "@/store/panelStore";
import {
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { SavedFleetRow } from "./SavedFleetRow";
import { SaveFleetForm } from "./SaveFleetForm";
import { rankSavedFleets, rankPredicateFleets } from "./fleetRanking";
import { computeSavedScopePaneCount } from "@/services/actions/definitions/fleetActions";
import type { FleetSavedScope } from "@shared/types";

interface SavedFleetsSectionProps {
  onRequestDelete: (id: string) => void;
}

const PRESET_PREDICATE_KEYS = new Set([
  "waiting:current",
  "waiting:all",
  "working:current",
  "working:all",
  "all:current",
]);

function isPresetPredicate(scope: { kind: string; stateFilter?: string; scope?: string }): boolean {
  if (scope.kind !== "predicate") return false;
  return PRESET_PREDICATE_KEYS.has(`${scope.stateFilter}:${scope.scope}`);
}

export function SavedFleetsSection({ onRequestDelete }: SavedFleetsSectionProps): ReactElement {
  const armedCount = useFleetArmingStore((s) => s.armedIds.size);
  const savedScopes = useProjectSettingsStore(
    useShallow((s) => s.settings?.fleetSavedScopes ?? [])
  );
  // Primitive-valued selection (FleetCountChip pattern): re-derive counts when
  // panes open/close, but return a flat Record so unrelated panel ticks —
  // agent-state churn while the dropdown is open — reuse the previous
  // reference and skip the re-render entirely. A snapshot scope is stale
  // exactly when none of its stored ids is still arm-eligible (count 0).
  const countById = usePanelStore(
    useShallow(() => {
      const counts: Record<string, number> = {};
      for (const scope of savedScopes) {
        if (scope.kind === "snapshot" || !isPresetPredicate(scope)) {
          counts[scope.id] = computeSavedScopePaneCount(scope);
        }
      }
      return counts;
    })
  );

  const { snapshotUsable, snapshotStale, predicateRanked, isStaleById } = useMemo(() => {
    const snapshots: FleetSavedScope[] = [];
    const predicates: FleetSavedScope[] = [];
    for (const scope of savedScopes) {
      if (scope.kind === "snapshot") {
        snapshots.push(scope);
      } else if (!isPresetPredicate(scope)) {
        predicates.push(scope);
      }
    }
    const now = Date.now();
    const isStaleByIdLocal = new Map<string, boolean>();
    for (const scope of snapshots) {
      isStaleByIdLocal.set(scope.id, (countById[scope.id] ?? 0) === 0);
    }
    for (const scope of predicates) {
      isStaleByIdLocal.set(scope.id, false);
    }
    const { usable, stale } = rankSavedFleets(snapshots, now, isStaleByIdLocal);
    return {
      snapshotUsable: usable,
      snapshotStale: stale,
      predicateRanked: rankPredicateFleets(predicates, now),
      isStaleById: isStaleByIdLocal,
    };
  }, [savedScopes, countById]);

  const hasSnapshots = snapshotUsable.length + snapshotStale.length > 0;
  const showStaleSeparator = snapshotUsable.length > 0 && snapshotStale.length > 0;

  return (
    <>
      <DropdownMenuSeparator />
      {hasSnapshots && (
        <DropdownMenuGroup>
          <DropdownMenuLabel>Snapshots</DropdownMenuLabel>
          {snapshotUsable.map((scope) => (
            <SavedFleetRow
              key={scope.id}
              scope={scope}
              onRequestDelete={onRequestDelete}
              count={countById[scope.id] ?? 0}
              isStale={isStaleById.get(scope.id) ?? false}
            />
          ))}
          {showStaleSeparator && <DropdownMenuSeparator />}
          {snapshotStale.map((scope) => (
            <SavedFleetRow
              key={scope.id}
              scope={scope}
              onRequestDelete={onRequestDelete}
              count={countById[scope.id] ?? 0}
              isStale={isStaleById.get(scope.id) ?? false}
            />
          ))}
        </DropdownMenuGroup>
      )}
      {predicateRanked.length > 0 && (
        <DropdownMenuGroup>
          <DropdownMenuLabel>Smart-Sets</DropdownMenuLabel>
          {predicateRanked.map((scope) => (
            <SavedFleetRow
              key={scope.id}
              scope={scope}
              onRequestDelete={onRequestDelete}
              count={countById[scope.id] ?? 0}
              isStale={false}
            />
          ))}
        </DropdownMenuGroup>
      )}
      <SaveFleetForm armedCount={armedCount} />
    </>
  );
}
