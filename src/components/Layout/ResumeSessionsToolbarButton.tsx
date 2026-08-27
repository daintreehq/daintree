import { useCallback } from "react";
import { History } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { useAriaKeyshortcuts, useKeybindingDisplay, useShortcutHintHover } from "@/hooks";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";
import { actionService } from "@/services/ActionService";

const RESUME_ACTION_ID = "terminal.resumeSessions" as const;
const RESUME_LABEL = "Resume session";
const toolbarIconButtonClass = "toolbar-icon-button text-text-primary relative";

interface ResumeSessionsToolbarButtonProps {
  "data-toolbar-item"?: string;
}

export function ResumeSessionsToolbarButton({
  "data-toolbar-item": dataToolbarItem,
}: ResumeSessionsToolbarButtonProps) {
  const shortcut = useKeybindingDisplay(RESUME_ACTION_ID);
  const ariaShortcut = useAriaKeyshortcuts(RESUME_ACTION_ID);
  const hover = useShortcutHintHover(RESUME_ACTION_ID);

  // Tooltip and shortcut-hint teardown around the launcher's open/close is
  // handled globally by AppPaletteDialog's overlay clearing and the shared
  // focus-open suppression window (issue #11030) — no local suppression.
  const handleClick = useCallback(() => {
    void actionService.dispatch(RESUME_ACTION_ID, undefined, { source: "user" });
  }, []);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
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
              aria-label={RESUME_LABEL}
              aria-keyshortcuts={ariaShortcut}
            >
              <History />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {createTooltipContent(RESUME_LABEL, shortcut)}
          </TooltipContent>
        </Tooltip>
      </ContextMenuTrigger>
      <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
        <ToolbarContextMenuItems buttonId="resume-sessions" side="right" />
      </ContextMenuContent>
    </ContextMenu>
  );
}
