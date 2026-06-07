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
import { computeSavedScopePaneCount } from "@/services/actions/definitions/fleetActions";
import { rankSavedFleets, rankPredicateFleets } from "./fleetRanking";
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
  // Subscribe so the stale sub-group re-derives when panes open/close. The
  // value itself feeds the memo's dep array; the per-row aria-disabled check
  // in SavedFleetRow reads panel state directly so it stays in sync too.
  const panelsById = usePanelStore(useShallow((s) => s.panelsById));

  const { snapshotUsable, snapshotStale, predicateRanked } = useMemo(() => {
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
    const isStaleById = new Map<string, boolean>();
    for (const scope of snapshots) {
      isStaleById.set(scope.id, computeSavedScopePaneCount(scope) === 0);
    }
    const { usable, stale } = rankSavedFleets(snapshots, now, isStaleById);
    return {
      snapshotUsable: usable,
      snapshotStale: stale,
      predicateRanked: rankPredicateFleets(predicates, now),
    };
    // panelsById is in the dep list to re-rank when the panel set changes;
    // savedScopes is the primary driver of re-rank.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- panelsById is a render-trigger
  }, [savedScopes, panelsById]);

  const hasSnapshots = snapshotUsable.length + snapshotStale.length > 0;
  const showStaleSeparator = snapshotUsable.length > 0 && snapshotStale.length > 0;

  return (
    <>
      <DropdownMenuSeparator />
      {hasSnapshots && (
        <DropdownMenuGroup>
          <DropdownMenuLabel>Snapshots</DropdownMenuLabel>
          {snapshotUsable.map((scope) => (
            <SavedFleetRow key={scope.id} scope={scope} onRequestDelete={onRequestDelete} />
          ))}
          {showStaleSeparator && <DropdownMenuSeparator />}
          {snapshotStale.map((scope) => (
            <SavedFleetRow key={scope.id} scope={scope} onRequestDelete={onRequestDelete} />
          ))}
        </DropdownMenuGroup>
      )}
      {predicateRanked.length > 0 && (
        <DropdownMenuGroup>
          <DropdownMenuLabel>Smart-Sets</DropdownMenuLabel>
          {predicateRanked.map((scope) => (
            <SavedFleetRow key={scope.id} scope={scope} onRequestDelete={onRequestDelete} />
          ))}
        </DropdownMenuGroup>
      )}
      <SaveFleetForm armedCount={armedCount} />
    </>
  );
}
