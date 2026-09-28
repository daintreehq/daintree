import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { actionService } from "@/services/ActionService";
import { resolveSavedScopeIds } from "@/services/actions/definitions/fleetActions";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useSavedFleets } from "./useSavedFleets";
import { formatSavedFleetCount, savedFleetAccessibleName } from "./savedFleetMeta";

interface SavedFleetQuickRecallProps {
  /** The picker's commit mode: a saved fleet replaces the armed set or joins it. */
  mode: "replace" | "append";
  /** Called after the fleet is armed — the host closes itself. */
  onRecalled: () => void;
  /** Open the saved-fleets dialog, where stale fleets are cleaned up. */
  onManage: () => void;
}

/**
 * Saved fleets as one-click recalls in the cold-start picker. The full list —
 * with stale snapshots, delete, and save — lives in the ribbon's selection
 * menu and the saved-fleets dialog, but the ribbon only exists once two panes
 * are armed, so without this a user had to assemble a throwaway fleet to reach
 * the one they had saved.
 *
 * Only fleets that would change the armed set are offered, counted by what
 * they'd actually do: in Append mode that's the panes not already armed. A
 * stale snapshot, a rule with no matches, or a fleet that's already fully armed
 * would close the picker having done nothing. Manage… reaches all of them.
 */
export function SavedFleetQuickRecall({
  mode,
  onRecalled,
  onManage,
}: SavedFleetQuickRecallProps): ReactElement | null {
  const { snapshotUsable, snapshotStale, rules, countById } = useSavedFleets();
  const armedIds = useFleetArmingStore((s) => s.armedIds);
  const hasAny = snapshotUsable.length + snapshotStale.length + rules.length > 0;
  if (!hasAny) return null;

  const offers = [...snapshotUsable, ...rules]
    .map((scope) => {
      if (mode !== "append") return { scope, count: countById[scope.id] ?? 0 };
      const adds = resolveSavedScopeIds(scope).filter((id) => !armedIds.has(id));
      return { scope, count: adds.length };
    })
    .filter((o) => o.count > 0);

  return (
    <div
      role="group"
      aria-label="Arm a saved fleet"
      className="flex flex-wrap items-center gap-1.5 pt-2"
      data-testid="fleet-picker-saved-fleets"
    >
      <span aria-hidden="true" className="pr-0.5 text-2xs text-text-secondary">
        {mode === "append" ? "Add a saved fleet" : "Arm a saved fleet"}
      </span>
      {offers.map(({ scope, count }) => (
        <Button
          key={scope.id}
          variant="subtle"
          size="xs"
          aria-label={
            mode === "append"
              ? `Add ${count} pane${count === 1 ? "" : "s"} from ${scope.name}`
              : `Arm ${savedFleetAccessibleName(scope, count)}`
          }
          title={scope.name}
          onClick={() => {
            if (mode === "append") {
              // Resolved at the click, not from the render: a live rule
              // re-evaluates on recall, and the armed set may have moved.
              const { armedIds: armedNow, addToFleet } = useFleetArmingStore.getState();
              addToFleet(resolveSavedScopeIds(scope).filter((id) => !armedNow.has(id)));
            } else {
              void actionService.dispatch(
                "fleet.recallNamedFleet",
                { id: scope.id },
                { source: "user" }
              );
            }
            onRecalled();
          }}
          data-testid="fleet-picker-saved-fleet"
          className="max-w-[14rem] gap-1.5 px-2 text-xs text-text-primary"
        >
          <span className="min-w-0 truncate">{scope.name}</span>
          <span className="shrink-0 text-2xs tabular-nums text-text-secondary">
            {mode === "append" ? `+${count}` : formatSavedFleetCount(scope, count)}
          </span>
        </Button>
      ))}
      <Button
        variant="ghost"
        size="xs"
        onClick={onManage}
        data-testid="fleet-picker-saved-manage"
        className="px-2 text-xs"
      >
        Manage…
      </Button>
    </div>
  );
}
