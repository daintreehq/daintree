import { Button } from "@/components/ui/button";
import { SlidersHorizontal } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuActionItem,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { useAriaKeyshortcuts, useKeybindingDisplay, useShortcutHintHover } from "@/hooks";

const toolbarIconButtonClass = "toolbar-icon-button text-daintree-text relative";

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

export function ToolbarSettingsButton({
  onSettings,
  onPreloadSettings,
  "data-toolbar-item": dataToolbarItem,
}: ToolbarSettingsButtonProps) {
  const settingsShortcut = useKeybindingDisplay("app.settings");
  const settingsAriaShortcut = useAriaKeyshortcuts("app.settings");
  const settingsHover = useShortcutHintHover("app.settings");

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              data-toolbar-item={dataToolbarItem}
              onClick={onSettings}
              onPointerEnter={(e) => {
                onPreloadSettings?.();
                settingsHover.onPointerEnter(e);
              }}
              onPointerLeave={settingsHover.onPointerLeave}
              onPointerDown={settingsHover.onPointerDown}
              onFocus={settingsHover.onFocus}
              onBlur={settingsHover.onBlur}
              className={toolbarIconButtonClass}
              aria-label="Open settings"
              aria-keyshortcuts={settingsAriaShortcut}
            >
              <SlidersHorizontal />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {createTooltipContent("Open settings", settingsShortcut)}
          </TooltipContent>
        </Tooltip>
      </ContextMenuTrigger>
      <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
        {SETTINGS_CONTEXT_MENU_TABS.map(({ tab, label }) => (
          <ContextMenuActionItem key={tab} actionId="app.settings.openTab" args={{ tab }}>
            {label}
          </ContextMenuActionItem>
        ))}
        <ContextMenuSeparator />
        <ContextMenuActionItem actionId="app.settings.openTab" args={{ tab: "troubleshooting" }}>
          Troubleshooting
        </ContextMenuActionItem>
        <ContextMenuSeparator />
        <ContextMenuActionItem actionId="app.settings.openTab" args={{ tab: "toolbar" }}>
          Customize toolbar…
        </ContextMenuActionItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
