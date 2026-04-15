import { memo, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { SquareTerminal, Globe } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { createTooltipWithShortcut } from "@/lib/platform";
import { useKeybindingDisplay } from "@/hooks";

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

const toolbarIconButtonClass = "toolbar-icon-button text-daintree-text transition-colors";

interface ToolbarLauncherButtonProps {
  type: LauncherType;
  onLaunchAgent: (type: string) => void;
  "data-toolbar-item"?: string;
}

export const ToolbarLauncherButton = memo(function ToolbarLauncherButton({
  type,
  onLaunchAgent,
  "data-toolbar-item": dataToolbarItem,
}: ToolbarLauncherButtonProps) {
  const config = LAUNCHER_CONFIG[type];
  const shortcut = useKeybindingDisplay(config.keybindingAction);

  const handleClick = useCallback(() => {
    onLaunchAgent(type);
  }, [type, onLaunchAgent]);

  const Icon = config.icon;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            data-toolbar-item={dataToolbarItem}
            onClick={handleClick}
            className={toolbarIconButtonClass}
            aria-label={config.label}
          >
            <Icon />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {createTooltipWithShortcut(config.tooltipLabel, shortcut)}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});
