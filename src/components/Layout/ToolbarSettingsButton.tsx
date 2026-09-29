import { Button } from "@/components/ui/button";
import {
  Bell,
  Keyboard,
  LayoutGrid,
  LifeBuoy,
  PanelRight,
  Plug,
  Settings2,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuActionItem,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { useAriaKeyshortcuts, useEffectiveCombo, useShortcutHintHover } from "@/hooks";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";

const toolbarIconButtonClass = "toolbar-icon-button text-text-primary relative";

// Each row wears the icon its tab wears in the Settings sidebar
// (`settingsTabRegistry.tsx`), and "Panel grid" is that tab's own name.
export const SETTINGS_CONTEXT_MENU_TABS = [
  { tab: "general", label: "General", icon: Settings2 },
  { tab: "agents", label: "CLI agents", icon: Plug },
  { tab: "terminal", label: "Panel grid", icon: LayoutGrid },
  { tab: "keyboard", label: "Keyboard", icon: Keyboard },
  { tab: "notifications", label: "Notifications", icon: Bell },
  { tab: "portal", label: "Portal", icon: PanelRight },
] as const satisfies readonly { tab: string; label: string; icon: LucideIcon }[];

export const SETTINGS_CONTEXT_MENU_TROUBLESHOOTING = {
  tab: "troubleshooting",
  label: "Troubleshooting",
  icon: LifeBuoy,
} as const;

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
  const settingsShortcut = useEffectiveCombo("app.settings");
  const settingsAriaShortcut = useAriaKeyshortcuts("app.settings");
  const settingsHover = useShortcutHintHover("app.settings");

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <span className="inline-flex">
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
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
        {SETTINGS_CONTEXT_MENU_TABS.map(({ tab, label, icon: Icon }) => (
          <ContextMenuActionItem key={tab} actionId="app.settings.openTab" args={{ tab }}>
            <Icon data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            {label}
          </ContextMenuActionItem>
        ))}
        <ContextMenuSeparator />
        <ContextMenuActionItem
          actionId="app.settings.openTab"
          args={{ tab: SETTINGS_CONTEXT_MENU_TROUBLESHOOTING.tab }}
        >
          <SETTINGS_CONTEXT_MENU_TROUBLESHOOTING.icon
            data-menu-icon
            className="mr-2 h-3.5 w-3.5"
            aria-hidden="true"
          />
          {SETTINGS_CONTEXT_MENU_TROUBLESHOOTING.label}
        </ContextMenuActionItem>
        <ContextMenuSeparator />
        <ToolbarContextMenuItems buttonId="settings" side="right" />
      </ContextMenuContent>
    </ContextMenu>
  );
}
