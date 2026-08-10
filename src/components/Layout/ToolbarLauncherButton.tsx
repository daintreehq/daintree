import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { SquareTerminal, Globe } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { useAriaKeyshortcuts, useKeybindingDisplay } from "@/hooks/useKeybinding";
import { useShortcutHintHover } from "@/hooks/useShortcutHintHover";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";

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
    label: "Open terminal",
    tooltipLabel: "Open terminal",
    keybindingAction: "agent.terminal",
  },
  browser: {
    icon: Globe,
    label: "Open browser",
    tooltipLabel: "Open browser",
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
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {createTooltipContent(config.tooltipLabel, shortcut)}
          </TooltipContent>
        </Tooltip>
      </ContextMenuTrigger>
      <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
        <ToolbarContextMenuItems buttonId={type} side="left" />
      </ContextMenuContent>
    </ContextMenu>
  );
}
