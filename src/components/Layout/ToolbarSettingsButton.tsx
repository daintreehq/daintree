import { memo } from "react";
import { Button } from "@/components/ui/button";
import { SlidersHorizontal } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { createTooltipWithShortcut } from "@/lib/platform";
import { useKeybindingDisplay } from "@/hooks";
import { actionService } from "@/services/ActionService";

const toolbarIconButtonClass = "toolbar-icon-button text-daintree-text transition-colors";

const SETTINGS_CONTEXT_MENU_TABS = [
  { tab: "general", label: "General" },
  { tab: "agents", label: "Agents" },
  { tab: "terminal", label: "Terminal" },
  { tab: "keyboard", label: "Keyboard" },
  { tab: "notifications", label: "Notifications" },
  { tab: "portal", label: "Portal" },
] as const;

interface ToolbarSettingsButtonProps {
  onSettings: () => void;
  onPreloadSettings?: () => void;
  "data-toolbar-item"?: string;
}

export const ToolbarSettingsButton = memo(function ToolbarSettingsButton({
  onSettings,
  onPreloadSettings,
  "data-toolbar-item": dataToolbarItem,
}: ToolbarSettingsButtonProps) {
  const settingsShortcut = useKeybindingDisplay("app.settings");

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                data-toolbar-item={dataToolbarItem}
                onClick={onSettings}
                onPointerEnter={onPreloadSettings}
                className={toolbarIconButtonClass}
                aria-label="Open settings"
              >
                <SlidersHorizontal />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {createTooltipWithShortcut("Open Settings", settingsShortcut)}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {SETTINGS_CONTEXT_MENU_TABS.map(({ tab, label }) => (
          <ContextMenuItem
            key={tab}
            onSelect={() =>
              void actionService.dispatch(
                "app.settings.openTab",
                { tab },
                { source: "context-menu" }
              )
            }
          >
            {label}
          </ContextMenuItem>
        ))}
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() =>
            void actionService.dispatch(
              "app.settings.openTab",
              { tab: "toolbar" },
              { source: "context-menu" }
            )
          }
        >
          Customize Toolbar…
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            void actionService.dispatch(
              "app.settings.openTab",
              { tab: "troubleshooting" },
              { source: "context-menu" }
            )
          }
        >
          Troubleshooting
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});
