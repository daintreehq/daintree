import { useCallback, useState } from "react";
import { Telescope } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { useAriaKeyshortcuts, useEffectiveCombo, useShortcutHintHover } from "@/hooks";
import { isCanopyUnacknowledged, useCanopyStore } from "@/store/canopyStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import { CANOPY_URGENT_PRIORITY, type CanopySnapshot } from "@shared/types/ipc/canopy";
import { agentStateDotColor } from "@/components/Worktree/terminalStateConfig";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { preloadCanopyView } from "@/lazyPanels";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";

const CANOPY_ACTION_ID = "canopy.toggle" as const;
const CANOPY_LABEL = "Canopy";
const toolbarIconButtonClass = "toolbar-icon-button text-text-primary relative";

/**
 * Runs Canopy reads as blocked on the user right now, not yet answered or put
 * aside, nor shown in the open panel already — and, while the fleet is known,
 * still running in the same incarnation and neither snoozed nor parked.
 */
function urgentCount(
  snapshot: CanopySnapshot,
  runs: readonly FleetRunRow[] | null,
  acknowledged: Record<string, string>
): number {
  const aside = new Set(snapshot.dispositions.map((d) => `${d.runId}:${d.spawnedAt}`));
  const live =
    runs === null
      ? null
      : new Set(
          runs
            .filter((run) => !run.snooze && !run.park)
            .map((run) => `${run.runId}:${run.spawnedAt}`)
        );
  return snapshot.cards.filter((card) => {
    const id = `${card.runId}:${card.spawnedAt}`;
    return (
      card.priority >= CANOPY_URGENT_PRIORITY &&
      card.handledAt === null &&
      isCanopyUnacknowledged(acknowledged, card) &&
      !aside.has(id) &&
      (live === null || live.has(id))
    );
  }).length;
}

/** Two characters at most, so the badge stays a dot-sized pill. */
function countGlyph(count: number): string {
  return count > 9 ? "9+" : String(count);
}

export function CanopyToolbarButton({
  "data-toolbar-item": dataToolbarItem,
}: {
  "data-toolbar-item"?: string;
}) {
  const isOpen = useCanopyStore((s) => s.isOpen);
  // Turned on, read (by useCanopySnapshotSync) before the panel opens, so it
  // opens on the inbox or the offer without a frame of the wrong one.
  const activated = useCanopyStore((s) => s.snapshot?.activated === true);
  // Agents Canopy read as blocked on the user right now — an approval or a
  // question it is sure of — in any project, not yet answered or put aside,
  // and not yet shown in the open panel: opening it clears the count until a
  // new prompt arrives. Waiting alone never lights it: a finished turn can sit
  // quietly.
  const canopy = useCanopyStore((s) => s.snapshot);
  const runs = useFleetSnapshotStore((s) => s.snapshot?.runs ?? null);
  const acknowledged = useCanopyStore((s) => s.acknowledged);
  const needYou = canopy ? urgentCount(canopy, runs, acknowledged) : 0;
  // The badge keeps its last count while it fades out, rather than shrinking
  // away on a "0".
  const [shownCount, setShownCount] = useState(needYou);
  if (needYou > 0 && needYou !== shownCount) setShownCount(needYou);
  // "Asking", not "need you": the badge counts only urgent asks, while the
  // panel's own "need you" counts everything left for the user to check.
  const label = activated && needYou > 0 ? `${CANOPY_LABEL}, ${needYou} asking you` : CANOPY_LABEL;
  const shortcut = useEffectiveCombo(CANOPY_ACTION_ID);
  const ariaShortcut = useAriaKeyshortcuts(CANOPY_ACTION_ID);
  const hover = useShortcutHintHover(CANOPY_ACTION_ID);

  const handleClick = useCallback(() => {
    void actionService.dispatch(CANOPY_ACTION_ID, undefined, { source: "user" });
  }, []);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <span className="inline-flex">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onPointerEnter={(event) => {
                  // Warm the panel's chunk on intent rather than at boot, so the
                  // first click doesn't flash a frame of nothing.
                  void preloadCanopyView();
                  hover.onPointerEnter(event);
                }}
                onPointerLeave={hover.onPointerLeave}
                onPointerDown={hover.onPointerDown}
                onFocus={(event) => {
                  void preloadCanopyView();
                  hover.onFocus(event);
                }}
                onBlur={hover.onBlur}
                variant="ghost"
                size="icon"
                data-toolbar-item={dataToolbarItem}
                onClick={handleClick}
                className={toolbarIconButtonClass}
                aria-label={label}
                aria-keyshortcuts={ariaShortcut}
                aria-expanded={isOpen}
                aria-haspopup="dialog"
              >
                <span className="relative inline-flex">
                  <Telescope />
                  <span
                    className={cn("toolbar-count toolbar-badge", agentStateDotColor("waiting"))}
                    data-visible={activated && needYou > 0 && !isOpen}
                    aria-hidden="true"
                  >
                    {countGlyph(shownCount)}
                  </span>
                </span>
              </Button>
            </TooltipTrigger>
            {/* The name alone says nothing to someone who hasn't used it. */}
            <TooltipContent side="bottom">
              {createTooltipContent(
                needYou > 0 && activated ? label : `${CANOPY_LABEL} — agent inbox`,
                shortcut
              )}
            </TooltipContent>
          </Tooltip>
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
        <ToolbarContextMenuItems buttonId="canopy" side="right" />
      </ContextMenuContent>
    </ContextMenu>
  );
}
