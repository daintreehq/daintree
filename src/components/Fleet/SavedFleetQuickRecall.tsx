import type { ReactElement } from "react";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { useSavedFleets } from "./useSavedFleets";
import { formatSavedFleetCount, savedFleetAccessibleName } from "./savedFleetMeta";

interface SavedFleetQuickRecallProps {
  /** Called after a recall is dispatched — the host closes itself. */
  onRecalled: () => void;
}

/**
 * Saved fleets as one-click recalls in the cold-start picker. The full list —
 * with stale snapshots, delete, and save — lives in the ribbon's selection
 * menu, but the ribbon only exists once two panes are armed, so without this
 * a user had to assemble a throwaway fleet to reach the one they had saved.
 *
 * Stale snapshots are left out: they would arm nothing, and cleaning them up
 * belongs with the rest of management in the menu.
 */
export function SavedFleetQuickRecall({
  onRecalled,
}: SavedFleetQuickRecallProps): ReactElement | null {
  const { snapshotUsable, rules, countById } = useSavedFleets();
  const recallable = [...snapshotUsable, ...rules];
  if (recallable.length === 0) return null;

  return (
    <div
      role="group"
      aria-label="Saved fleets"
      className="flex flex-wrap items-center gap-1.5 pt-2"
      data-testid="fleet-picker-saved-fleets"
    >
      <span aria-hidden="true" className="pr-0.5 text-2xs text-text-secondary">
        Saved
      </span>
      {recallable.map((scope) => {
        const count = countById[scope.id] ?? 0;
        return (
          <button
            key={scope.id}
            type="button"
            aria-label={`Recall ${savedFleetAccessibleName(scope, count)}`}
            title={scope.name}
            onClick={() => {
              void actionService.dispatch(
                "fleet.recallNamedFleet",
                { id: scope.id },
                { source: "user" }
              );
              onRecalled();
            }}
            data-testid="fleet-picker-saved-fleet"
            className={cn(
              "inline-flex h-6 max-w-[14rem] items-center gap-1.5 rounded-[var(--radius-md)] bg-tint/[0.06] px-2 text-xs text-text-primary",
              "hover:bg-tint/[0.12] transition-colors duration-150",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
            )}
          >
            <span className="min-w-0 truncate">{scope.name}</span>
            <span className="shrink-0 text-2xs tabular-nums text-text-secondary">
              {formatSavedFleetCount(scope, count)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
