import { useCallback, useState } from "react";
import { Telescope } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { useAriaKeyshortcuts, useEffectiveCombo, useShortcutHintHover } from "@/hooks";
import { useCanopyStore } from "@/store/canopyStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";
import { bandForRun } from "@shared/utils/fleetBands";
import { agentStateDotColor } from "@/components/Worktree/terminalStateConfig";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { preloadCanopyView } from "@/lazyPanels";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";
import { toolbarIconButtonClass } from "./toolbarItemClasses";

const CANOPY_ACTION_ID = "canopy.toggle" as const;
const CANOPY_LABEL = "Canopy";

/**
 * Runs Canopy read asking the user something they haven't had in front of them
 * since: the fleet's own `needs-you` band. Main marks the ask read once the run
 * has been in front of the user for the read dwell, in its pane or in Canopy's
 * panel, so a look in any project view takes it off every view's count, and a
 * new ask is a new turn that counts again. Parked, snoozed, archived and
 * replied runs never band there.
 */
function urgentCount(fleet: FleetSnapshot | null): number {
  if (!fleet) return 0;
  let count = 0;
  for (const run of fleet.runs) if (bandForRun(run) === "needs-you") count += 1;
  return count;
}

/** Urgent asks the toolbar shows for Canopy: none until it is turned on. */
export function useCanopyUrgentCount(): number {
  const activated = useCanopyStore((s) => s.snapshot?.activated === true);
  const count = useFleetSnapshotStore((s) => urgentCount(s.snapshot));
  return activated ? count : 0;
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
  // Agents Canopy read asking the user something, in any project, that they
  // haven't looked at since. Waiting alone never lights it: a finished turn
  // can sit quietly, and without a reading a wait is at most unread.
  const needYou = useCanopyUrgentCount();
  // The badge keeps its last count while it fades out, rather than shrinking
  // away on a "0".
  const [shownCount, setShownCount] = useState(needYou);
  if (needYou > 0 && needYou !== shownCount) setShownCount(needYou);
  // "Urgent", not "need you": the badge counts only unread asks, while the
  // panel's own "need you" counts everything left for the user to check.
  const label = needYou > 0 ? `${CANOPY_LABEL} — ${needYou} urgent` : CANOPY_LABEL;
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
                    data-visible={needYou > 0 && !isOpen}
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
                needYou > 0 ? label : `${CANOPY_LABEL} — agent inbox`,
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
