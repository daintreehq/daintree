import type { ReactElement } from "react";
import type { FleetSavedScope } from "@shared/types";
import { actionService } from "@/services/ActionService";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
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
  // A live rule matching nothing right now would recall an empty fleet. It
  // stays listed and focusable but inert, like any disabled menu row — the
  // rule may match again later, and the manage dialog can still delete it.
  const isEmptyRule = scope.kind === "predicate" && count === 0;
  return (
    <DropdownMenuItem
      aria-label={
        isStale
          ? `${savedFleetAccessibleName(scope, count)}, select to delete`
          : savedFleetAccessibleName(scope, count)
      }
      aria-disabled={isEmptyRule || undefined}
      // One action per menu row, like every other menu in the app: recall.
      // Delete/Backspace is the accelerator to the same confirm the manage
      // dialog offers as a button — not advertised on an inert row.
      aria-keyshortcuts={isEmptyRule ? undefined : "Delete"}
      title={scope.name}
      onSelect={(e) => {
        if (isEmptyRule) {
          e.preventDefault();
          return;
        }
        // A stale snapshot can't be recalled, and deleting it is the one thing
        // it's still for — so selecting it opens the delete confirm rather than
        // sitting there disabled.
        if (isStale) {
          onRequestDelete(scope.id);
          return;
        }
        void actionService.dispatch("fleet.recallNamedFleet", { id: scope.id }, { source: "user" });
      }}
      onKeyDown={(e) => {
        if (isEmptyRule) return;
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          onRequestDelete(scope.id);
        }
      }}
      data-testid="fleet-saved-row"
      data-stale={isStale || undefined}
      className="gap-3"
    >
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          isStale || isEmptyRule ? "text-text-secondary" : "text-text-primary"
        )}
      >
        {scope.name}
      </span>
      <span aria-hidden="true" className="ml-auto flex shrink-0 items-center gap-3">
        {scope.kind === "predicate" && (
          <span className="text-2xs text-text-secondary">{describeRule(scope)}</span>
        )}
        <span className="text-2xs tabular-nums text-text-secondary">
          {formatSavedFleetCount(scope, count)}
        </span>
        {/* Says out loud what selecting this row now does. */}
        {isStale && <span className="text-2xs text-text-secondary">Delete…</span>}
      </span>
    </DropdownMenuItem>
  );
}
