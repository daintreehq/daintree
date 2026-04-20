import { memo, type MouseEvent, type ReactElement } from "react";
import { cn } from "@/lib/utils";
import { usePanelStore } from "@/store/panelStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { PanelKindIcon } from "@/components/PanelPalette/PanelKindIcon";
import type { AgentState } from "@shared/types";

interface FleetDeckRowProps {
  panelId: string;
  filteredIds: readonly string[];
  worktreeName: string | null;
}

function stateClass(state: AgentState | null | undefined): string {
  if (state === "waiting" || state === "directing") return "text-state-waiting";
  if (state === "working" || state === "running") return "text-state-working";
  if (state === "completed") return "text-status-success";
  if (state === "exited") return "text-status-error";
  return "text-daintree-text/60";
}

function FleetDeckRowInternal({
  panelId,
  filteredIds,
  worktreeName,
}: FleetDeckRowProps): ReactElement | null {
  const panel = usePanelStore((s) => s.panelsById[panelId]);
  const isArmed = useFleetArmingStore((s) => s.armedIds.has(panelId));
  const toggleId = useFleetArmingStore((s) => s.toggleId);
  const extendTo = useFleetArmingStore((s) => s.extendTo);

  if (!panel) return null;

  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    if (event.shiftKey) {
      extendTo(panelId, filteredIds as string[]);
      return;
    }
    toggleId(panelId);
  };

  const title = panel.lastObservedTitle ?? panel.title ?? "(unknown)";
  const stateLabel = panel.agentState ?? "idle";
  const iconId = panel.agentId ?? "terminal";

  return (
    <button
      type="button"
      data-testid="fleet-deck-row"
      data-panel-id={panelId}
      data-armed={isArmed ? "true" : undefined}
      onClick={handleClick}
      aria-pressed={isArmed}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] transition-colors",
        "hover:bg-tint/[0.08]",
        isArmed && "bg-daintree-accent/15 hover:bg-daintree-accent/20"
      )}
    >
      <input
        type="checkbox"
        checked={isArmed}
        readOnly
        tabIndex={-1}
        aria-hidden="true"
        className="shrink-0 h-3 w-3 accent-daintree-accent pointer-events-none"
      />
      <PanelKindIcon iconId={iconId} size={14} className="text-daintree-text/80" />
      <span className="flex-1 min-w-0 truncate text-daintree-text" title={title}>
        {title}
      </span>
      <span
        className={cn(
          "shrink-0 rounded-full bg-tint/[0.08] px-1.5 py-0.5 text-[10px]",
          stateClass(panel.agentState)
        )}
        data-testid="fleet-deck-row-state"
      >
        {stateLabel}
      </span>
      {worktreeName !== null && (
        <span
          className="shrink-0 max-w-[90px] truncate text-[10px] text-daintree-text/55"
          data-testid="fleet-deck-row-worktree"
          title={worktreeName}
        >
          {worktreeName}
        </span>
      )}
    </button>
  );
}

export const FleetDeckRow = memo(FleetDeckRowInternal);
