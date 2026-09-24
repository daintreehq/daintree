import type { ReactElement } from "react";
import { Trash2 } from "lucide-react";
import type { FleetSavedScope } from "@shared/types";
import { actionService } from "@/services/ActionService";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { FLEET_RIBBON_ICON_BUTTON_CLASS } from "./fleetRibbonStyles";
import { describeRule, formatSavedFleetCount, savedFleetAccessibleName } from "./savedFleetMeta";

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
  return (
    <DropdownMenuItem
      aria-label={
        isStale
          ? `${savedFleetAccessibleName(scope, count)}, select to delete`
          : savedFleetAccessibleName(scope, count)
      }
      // The trash button is pointer-only inside a menuitem, so the row itself
      // takes Delete/Backspace — the keyboard route to the same confirm.
      aria-keyshortcuts="Delete"
      title={scope.name}
      onSelect={() => {
        // A stale snapshot can't be recalled, and deleting it is the one thing
        // it's still for — so selecting it opens the same confirm as the trash.
        // Marking it disabled instead left an inert row holding a live delete
        // control, which disabled semantics can't describe.
        if (isStale) {
          onRequestDelete(scope.id);
          return;
        }
        void actionService.dispatch("fleet.recallNamedFleet", { id: scope.id }, { source: "user" });
      }}
      onKeyDown={(e) => {
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          onRequestDelete(scope.id);
        }
      }}
      data-testid="fleet-saved-row"
      data-stale={isStale || undefined}
      className="gap-2"
    >
      {/* Only the recall half steps down when a snapshot is stale — Delete is
          exactly the action a dead snapshot still wants. */}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          isStale ? "text-text-secondary" : "text-text-primary"
        )}
      >
        {scope.name}
      </span>
      <span aria-hidden="true" className="flex shrink-0 items-center gap-3">
        {scope.kind === "predicate" && (
          <span className="text-2xs text-text-secondary">{describeRule(scope)}</span>
        )}
        <span className="text-2xs tabular-nums text-text-secondary">
          {formatSavedFleetCount(scope, count)}
        </span>
      </span>
      <button
        type="button"
        tabIndex={-1}
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
          e.stopPropagation();
        }}
        onPointerUp={(e) => {
          // Radix's item treats a pointerup it never saw go down as a
          // pointer-select and synthesises a click on itself. Stopping only
          // pointerdown hid the press from the item, so releasing over the
          // trash recalled the fleet and closed the menu instead of deleting.
          e.stopPropagation();
        }}
        // A 24px target in a 28px row: the negative margin keeps the target
        // size without making saved rows taller than every other menu row.
        className={cn(FLEET_RIBBON_ICON_BUTTON_CLASS, "-my-1 -mr-1.5")}
      >
        <Trash2 className="h-3 w-3" aria-hidden="true" />
      </button>
    </DropdownMenuItem>
  );
}
