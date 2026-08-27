import type { ReactElement } from "react";
import { Trash2 } from "lucide-react";
import type { FleetSavedScope } from "@shared/types";
import { actionService } from "@/services/ActionService";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";

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
      className={isStale ? "flex items-center gap-2 opacity-50" : "flex items-center gap-2"}
    >
      <span className="flex-1 truncate">{scope.name}</span>
      <span className="text-3xs text-daintree-text/50 tabular-nums">
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
        className="inline-flex shrink-0 items-center rounded p-0.5 text-daintree-text/50 transition-colors hover:bg-tint/[0.08] hover:text-daintree-text"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </DropdownMenuItem>
  );
}
