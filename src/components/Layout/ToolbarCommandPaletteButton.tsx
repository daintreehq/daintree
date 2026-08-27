import { useCallback } from "react";
import { SquareMenu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { useAriaKeyshortcuts, useKeybindingDisplay, useShortcutHintHover } from "@/hooks";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";
import { actionService } from "@/services/ActionService";

const PALETTE_ACTION_ID = "action.palette.open" as const;
const PALETTE_LABEL = "Command palette";
const toolbarIconButtonClass = "toolbar-icon-button text-text-primary relative";

interface ToolbarCommandPaletteButtonProps {
  "data-toolbar-item"?: string;
}

export function ToolbarCommandPaletteButton({
  "data-toolbar-item": dataToolbarItem,
}: ToolbarCommandPaletteButtonProps) {
  const shortcut = useKeybindingDisplay(PALETTE_ACTION_ID);
  const ariaShortcut = useAriaKeyshortcuts(PALETTE_ACTION_ID);
  const hover = useShortcutHintHover(PALETTE_ACTION_ID);

  // Tooltip and shortcut-hint teardown around the palette's open/close is
  // handled globally by AppPaletteDialog's overlay clearing and the shared
  // focus-open suppression window (issue #11030) — no local suppression.
  const handleClick = useCallback(() => {
    void actionService.dispatch(PALETTE_ACTION_ID, undefined, { source: "user" });
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
              aria-label={PALETTE_LABEL}
              aria-keyshortcuts={ariaShortcut}
            >
              <SquareMenu />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {createTooltipContent(PALETTE_LABEL, shortcut)}
          </TooltipContent>
        </Tooltip>
      </ContextMenuTrigger>
      <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
        <ToolbarContextMenuItems buttonId="command-palette" side="right" />
      </ContextMenuContent>
    </ContextMenu>
  );
}
