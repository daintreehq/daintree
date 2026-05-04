import type { ReactElement } from "react";
import { useShallow } from "zustand/react/shallow";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { SavedFleetRow } from "./SavedFleetRow";
import { SaveFleetForm } from "./SaveFleetForm";

export function SavedFleetsSection(): ReactElement {
  const armedCount = useFleetArmingStore((s) => s.armedIds.size);
  const savedScopes = useProjectSettingsStore(
    useShallow((s) => s.settings?.fleetSavedScopes ?? [])
  );
  return (
    <>
      <DropdownMenuSeparator />
      {savedScopes.length > 0 ? (
        <>
          <DropdownMenuLabel>Saved fleets</DropdownMenuLabel>
          {savedScopes.map((scope) => (
            <SavedFleetRow key={scope.id} scope={scope} />
          ))}
        </>
      ) : null}
      <SaveFleetForm armedCount={armedCount} />
    </>
  );
}
