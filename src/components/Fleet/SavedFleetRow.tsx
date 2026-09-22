import type { ReactElement } from "react";
import { Trash2 } from "lucide-react";
import type { FleetSavedScope } from "@shared/types";
import { actionService } from "@/services/ActionService";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { FLEET_RIBBON_ICON_BUTTON_CLASS } from "./fleetRibbonStyles";

interface SavedFleetRowProps {
  scope: FleetSavedScope;
  onRequestDelete: (id: string) => void;
  /** Live count of panes this scope would currently arm. */
  count: number;
  /** True for snapshots whose stored terminal IDs are all gone. */
  isStale: boolean;
}

export function SavedFleetRow({
  scope,
  onRequestDelete,
  count,
  isStale,
}: SavedFleetRowProps): ReactElement {
  const flavorLabel = scope.kind === "snapshot" ? "Snapshot" : "Live";
  return (
    <DropdownMenuItem
      aria-disabled={isStale || undefined}
      onSelect={() => {
        if (isStale) return;
        void actionService.dispatch("fleet.recallNamedFleet", { id: scope.id }, { source: "user" });
      }}
      data-testid="fleet-saved-row"
      className="flex items-center gap-2"
    >
      {/* Only the recall half fades when a snapshot is stale — Delete is
          exactly the action a dead snapshot still wants. */}
      <span className={cn("flex-1 truncate", isStale && "opacity-50")}>{scope.name}</span>
      <span className={cn("text-3xs text-text-secondary tabular-nums", isStale && "opacity-50")}>
        {count} · {flavorLabel}
      </span>
      <button
        type="button"
        aria-label={`Delete fleet "${scope.name}"`}
        data-testid="fleet-saved-row-delete"
        onClick={(e) => {
          // Stop the parent DropdownMenuItem's onSelect from firing the recall
          // when the user clicks the trash icon. The confirm dialog is hoisted
          // to FleetArmingRibbon (outside this dropdown tree) so it survives
          // the menu closing — see #8023.
          e.preventDefault();
          e.stopPropagation();
          onRequestDelete(scope.id);
        }}
        onPointerDown={(e) => {
          // Radix DropdownMenuItem also commits on pointerdown — guard the
          // delete from triggering recall by stopping propagation early.
          e.stopPropagation();
        }}
        className={FLEET_RIBBON_ICON_BUTTON_CLASS}
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </DropdownMenuItem>
  );
}
