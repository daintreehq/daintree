import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { SquareTerminal, Globe, Unplug } from "lucide-react";
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

type LauncherType = "terminal" | "browser";

const LAUNCHER_CONFIG: Record<
  LauncherType,
  {
    icon: typeof SquareTerminal;
    label: string;
    tooltipLabel: string;
    keybindingAction: string;
  }
> = {
  terminal: {
    icon: SquareTerminal,
    label: "Open Terminal",
    tooltipLabel: "Open Terminal",
    keybindingAction: "agent.terminal",
  },
  browser: {
    icon: Globe,
    label: "Open Browser",
    tooltipLabel: "Open Browser",
    keybindingAction: "agent.browser",
  },
};

const toolbarIconButtonClass = "toolbar-icon-button text-daintree-text relative";

interface ToolbarLauncherButtonProps {
  type: LauncherType;
  onLaunchAgent: (type: string) => void;
  "data-toolbar-item"?: string;
}

export function ToolbarLauncherButton({
  type,
  onLaunchAgent,
  "data-toolbar-item": dataToolbarItem,
}: ToolbarLauncherButtonProps) {
  const config = LAUNCHER_CONFIG[type];
  const shortcut = useKeybindingDisplay(config.keybindingAction);
  const ariaShortcut = useAriaKeyshortcuts(config.keybindingAction);
  const launcherHover = useShortcutHintHover(config.keybindingAction);
  const toggleButtonVisibility = useToolbarPreferencesStore((s) => s.toggleButtonVisibility);

  const handleClick = useCallback(() => {
    onLaunchAgent(type);
  }, [type, onLaunchAgent]);

  const Icon = config.icon;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              {...launcherHover}
              variant="ghost"
              size="icon"
              data-toolbar-item={dataToolbarItem}
              onClick={handleClick}
              className={toolbarIconButtonClass}
              aria-label={config.label}
              aria-keyshortcuts={ariaShortcut}
            >
              <Icon />
              <ShortcutRevealChip actionId={config.keybindingAction} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {createTooltipContent(config.tooltipLabel, shortcut)}
          </TooltipContent>
        </Tooltip>
      </ContextMenuTrigger>
      <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
        <ContextMenuItem onSelect={() => toggleButtonVisibility(type, "left")}>
          <Unplug className="mr-2 h-3.5 w-3.5" />
          Unpin from Toolbar
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
