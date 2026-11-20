import { useCallback, useState } from "react";
import { DecisionsIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { useAriaKeyshortcuts, useEffectiveCombo, useShortcutHintHover } from "@/hooks";
import {
  useDecisionsStoppedCount,
  useDecisionsWaitingCount,
} from "@/hooks/useDecisionsWaitingCount";
import { useDecisionsInboxStore } from "@/store/decisionsInboxStore";
import { agentStateDotColor } from "@/components/Worktree/terminalStateConfig";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";
import { toolbarIconButtonClass } from "./toolbarItemClasses";
import { decisionsObservations } from "./decisionsToolbarSignal";

const INBOX_ACTION_ID = "decisions.openInbox" as const;
const INBOX_LABEL = "Decisions inbox";

/** What the button says about what needs the person, in its name and tooltip. */
export function decisionsInboxLabel(waiting: number, stopped = 0): string {
  const observations = decisionsObservations(waiting, stopped);
  return observations.length > 0 ? `${INBOX_LABEL} — ${observations.join(", ")}` : INBOX_LABEL;
}

/** Two characters at most, so the badge stays a dot-sized pill. */
function countGlyph(count: number): string {
  return count > 9 ? "9+" : String(count);
}

/**
 * The Decisions inbox (#17236), with how many questions wait on the person,
 * and a warning while a delivery stopped on their answer (#18045). The toolbar
 * renders it only while Decisions is on.
 */
export function DecisionsToolbarButton({
  "data-toolbar-item": dataToolbarItem,
}: {
  "data-toolbar-item"?: string;
}) {
  const isOpen = useDecisionsInboxStore((s) => s.isOpen);
  const waiting = useDecisionsWaitingCount(true);
  const stopped = useDecisionsStoppedCount(true);
  // The badge keeps its last count while it fades out, rather than shrinking away on a "0".
  const [shownCount, setShownCount] = useState(waiting);
  if (waiting > 0 && waiting !== shownCount) setShownCount(waiting);
  const label = decisionsInboxLabel(waiting, stopped);
  const shortcut = useEffectiveCombo(INBOX_ACTION_ID);
  const ariaShortcut = useAriaKeyshortcuts(INBOX_ACTION_ID);
  const hover = useShortcutHintHover(INBOX_ACTION_ID);

  const handleClick = useCallback(() => {
    void actionService.dispatch(INBOX_ACTION_ID, undefined, { source: "user" });
  }, []);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <span className="inline-flex">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onPointerEnter={hover.onPointerEnter}
                onPointerLeave={hover.onPointerLeave}
                onPointerDown={hover.onPointerDown}
                onFocus={hover.onFocus}
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
                {/* A stopped delivery is a separate observation from the
                    questions to answer, so it takes the bottom corner as a
                    warning rather than adding to the count in the top one. */}
                <span className="relative inline-flex">
                  <DecisionsIcon />
                  <span
                    className={cn("toolbar-count toolbar-badge", agentStateDotColor("waiting"))}
                    data-visible={waiting > 0 && !isOpen}
                    aria-hidden="true"
                  >
                    {countGlyph(shownCount)}
                  </span>
                  <span
                    aria-hidden="true"
                    data-testid="decisions-stopped-badge"
                    data-visible={stopped > 0 && !isOpen}
                    data-badge-color="warning"
                    data-pip-corner="bottom"
                    className="toolbar-pip toolbar-badge bg-status-warning"
                  />
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{createTooltipContent(label, shortcut)}</TooltipContent>
          </Tooltip>
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
        <ToolbarContextMenuItems buttonId="decisions-inbox" side="right" />
      </ContextMenuContent>
    </ContextMenu>
  );
}
