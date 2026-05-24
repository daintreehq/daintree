import { useCallback } from "react";
import { SquareMenu, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ShortcutRevealChip } from "@/components/ui/ShortcutRevealChip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { useAriaKeyshortcuts, useKeybindingDisplay, useShortcutHintHover } from "@/hooks";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { actionService } from "@/services/ActionService";

const PALETTE_ACTION_ID = "action.palette.open" as const;
const PALETTE_LABEL = "Command palette";
const toolbarIconButtonClass = "toolbar-icon-button text-daintree-text relative";

interface ToolbarCommandPaletteButtonProps {
  "data-toolbar-item"?: string;
}

export function ToolbarCommandPaletteButton({
  "data-toolbar-item": dataToolbarItem,
}: ToolbarCommandPaletteButtonProps) {
  const shortcut = useKeybindingDisplay(PALETTE_ACTION_ID);
  const ariaShortcut = useAriaKeyshortcuts(PALETTE_ACTION_ID);
  const hover = useShortcutHintHover(PALETTE_ACTION_ID);
  const toggleButtonVisibility = useToolbarPreferencesStore((s) => s.toggleButtonVisibility);

  const handleClick = useCallback(() => {
    void actionService.dispatch(PALETTE_ACTION_ID, undefined, { source: "user" });
  }, []);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              {...hover}
              variant="ghost"
              size="icon"
              data-toolbar-item={dataToolbarItem}
              onClick={handleClick}
              className={toolbarIconButtonClass}
              aria-label={PALETTE_LABEL}
              aria-keyshortcuts={ariaShortcut}
            >
              <SquareMenu />
              <ShortcutRevealChip actionId={PALETTE_ACTION_ID} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {createTooltipContent(PALETTE_LABEL, shortcut)}
          </TooltipContent>
        </Tooltip>
      </ContextMenuTrigger>
      <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
        <ContextMenuItem onSelect={() => toggleButtonVisibility("command-palette", "right")}>
          <Unplug className="mr-2 h-3.5 w-3.5" />
          Unpin from Toolbar
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
