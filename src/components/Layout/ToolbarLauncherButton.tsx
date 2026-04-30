import { memo, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { SquareTerminal, Globe } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ShortcutRevealChip } from "@/components/ui/ShortcutRevealChip";
import { createTooltipWithShortcut } from "@/lib/platform";
import { useKeybindingDisplay, useShortcutHintHover } from "@/hooks";

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

const toolbarIconButtonClass = "toolbar-icon-button text-daintree-text transition-colors relative";

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
  const launcherHover = useShortcutHintHover(config.keybindingAction);

  const handleClick = useCallback(() => {
    onLaunchAgent(type);
  }, [type, onLaunchAgent]);

  const Icon = config.icon;

  return (
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
        >
          <Icon />
          <ShortcutRevealChip actionId={config.keybindingAction} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {createTooltipWithShortcut(config.tooltipLabel, shortcut)}
      </TooltipContent>
    </Tooltip>
  );
});
