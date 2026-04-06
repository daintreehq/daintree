import { memo, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { SquareTerminal, Globe, LayoutGrid } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { createTooltipWithShortcut } from "@/lib/platform";
import { useKeybindingDisplay } from "@/hooks";
import { usePaletteStore } from "@/store";
import { actionService } from "@/services/ActionService";

type LauncherType = "terminal" | "browser" | "panel-palette";

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
  "panel-palette": {
    icon: LayoutGrid,
    label: "Panel Palette",
    tooltipLabel: "Panel Palette",
    keybindingAction: "panel.palette",
  },
};

const toolbarIconButtonClass = "toolbar-icon-button text-canopy-text transition-colors";

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
  const panelPaletteOpen = usePaletteStore((state) =>
    type === "panel-palette" ? state.activePaletteId === "panel" : false
  );

  const handleClick = useCallback(() => {
    if (type === "panel-palette") {
      if (usePaletteStore.getState().activePaletteId === "panel") {
        usePaletteStore.getState().closePalette("panel");
      } else {
        void actionService.dispatch("panel.palette", undefined, { source: "user" });
      }
    } else {
      onLaunchAgent(type);
    }
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
            aria-label={
              type === "panel-palette"
                ? panelPaletteOpen
                  ? "Close panel palette"
                  : "Open panel palette"
                : config.label
            }
            aria-pressed={type === "panel-palette" ? panelPaletteOpen : undefined}
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
