import type { ReactElement } from "react";
import { useShallow } from "zustand/react/shallow";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import {
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { SavedFleetRow } from "./SavedFleetRow";
import { SaveFleetForm } from "./SaveFleetForm";

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

  const snapshotScopes = savedScopes.filter((s) => s.kind === "snapshot");
  const smartSetScopes = savedScopes.filter((s) => s.kind === "predicate" && !isPresetPredicate(s));

  return (
    <>
      <DropdownMenuSeparator />
      {snapshotScopes.length > 0 && (
        <DropdownMenuGroup>
          <DropdownMenuLabel>Pinned</DropdownMenuLabel>
          {snapshotScopes.map((scope) => (
            <SavedFleetRow key={scope.id} scope={scope} onRequestDelete={onRequestDelete} />
          ))}
        </DropdownMenuGroup>
      )}
      {smartSetScopes.length > 0 && (
        <DropdownMenuGroup>
          <DropdownMenuLabel>Smart-Sets</DropdownMenuLabel>
          {smartSetScopes.map((scope) => (
            <SavedFleetRow key={scope.id} scope={scope} onRequestDelete={onRequestDelete} />
          ))}
        </DropdownMenuGroup>
      )}
      <SaveFleetForm armedCount={armedCount} />
    </>
  );
}
