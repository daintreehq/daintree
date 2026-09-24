import type { ReactElement } from "react";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { SavedFleetRow } from "./SavedFleetRow";
import { useSavedFleets } from "./useSavedFleets";

interface SavedFleetsSectionProps {
  onRequestDelete: (id: string) => void;
  /** Open the save dialog. Hoisted to the ribbon so it outlives the menu. */
  onRequestSave: () => void;
}

export function SavedFleetsSection({
  onRequestDelete,
  onRequestSave,
}: SavedFleetsSectionProps): ReactElement {
  const { snapshotUsable, snapshotStale, rules, countById } = useSavedFleets();

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
              isStale={false}
            />
          ))}
          {showStaleSeparator && <DropdownMenuSeparator />}
          {snapshotStale.map((scope) => (
            <SavedFleetRow
              key={scope.id}
              scope={scope}
              onRequestDelete={onRequestDelete}
              count={countById[scope.id] ?? 0}
              isStale
            />
          ))}
        </DropdownMenuGroup>
      )}
      {hasSnapshots && rules.length > 0 && <DropdownMenuSeparator />}
      {rules.length > 0 && (
        <DropdownMenuGroup>
          <DropdownMenuLabel>Live rules</DropdownMenuLabel>
          {rules.map((scope) => (
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
      {(hasSnapshots || rules.length > 0) && <DropdownMenuSeparator />}
      <DropdownMenuItem onSelect={onRequestSave} data-testid="fleet-save-open">
        Save as fleet…
      </DropdownMenuItem>
    </>
  );
}
