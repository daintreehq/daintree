import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Pin, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuActionItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";
import {
  TOOLBAR_CUSTOMIZE_LABEL,
  TOOLBAR_PIN_LABEL,
  TOOLBAR_UNPIN_LABEL,
} from "./toolbarMenuStrings";
import { Package } from "@/components/icons";
import { resolvePluginIcon } from "@/components/icons/pluginIconRegistry";
import { actionService } from "@/services/ActionService";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { useAriaKeyshortcuts, useKeybindingDisplay, useShortcutHintHover } from "@/hooks";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";
import type { PluginToolbarButtonId } from "@shared/types/toolbar";
import { cn } from "@/lib/utils";

export type PluginToolbarConfigs = ReadonlyMap<string, ToolbarButtonConfig>;

export type PluginTrayGroup = {
  pluginId: string;
  displayName: string;
  buttons: ToolbarButtonConfig[];
};

/**
 * Group every plugin toolbar contribution under its owning plugin.
 *
 * Grouping keys off `config.pluginId` — the authoritative field main puts on
 * the broadcast config — never off splitting the dotted button id, whose
 * `{pluginId}.{buttonId}` shape breaks the moment a plugin id contains a dot.
 *
 * Within a group, contributions sort by the manifest's `priority` (documented
 * as sort order, 1 first), then label, then id so the order is total and a
 * re-broadcast can't reshuffle equal-priority rows under the user's cursor.
 * Groups sort by display name so the tray reads alphabetically regardless of
 * plugin load order.
 */
export function groupPluginToolbarButtons(
  configs: PluginToolbarConfigs,
  displayNameFor: (pluginId: string) => string
): PluginTrayGroup[] {
  const byPlugin = new Map<string, ToolbarButtonConfig[]>();
  for (const config of configs.values()) {
    const bucket = byPlugin.get(config.pluginId);
    if (bucket) bucket.push(config);
    else byPlugin.set(config.pluginId, [config]);
  }

  const groups: PluginTrayGroup[] = [];
  for (const [pluginId, buttons] of byPlugin) {
    buttons.sort(
      (a, b) =>
        a.priority - b.priority || a.label.localeCompare(b.label) || a.id.localeCompare(b.id)
    );
    groups.push({ pluginId, displayName: displayNameFor(pluginId), buttons });
  }
  groups.sort(
    (a, b) => a.displayName.localeCompare(b.displayName) || a.pluginId.localeCompare(b.pluginId)
  );
  return groups;
}

/**
 * A plugin contribution the user promoted to its own top-level toolbar slot
 * (#11304). Every contribution also keeps a tray row — promotion adds an
 * access point, it never moves the button out of the tray.
 */
export function PluginToolbarButton({
  pluginId,
  config,
  "data-toolbar-item": dataToolbarItem,
}: {
  pluginId: PluginToolbarButtonId;
  config: ToolbarButtonConfig;
  "data-toolbar-item"?: string;
}) {
  const hover = useShortcutHintHover(config.actionId);
  const ariaShortcut = useAriaKeyshortcuts(config.actionId);
  const setPluginButtonPromoted = useToolbarPreferencesStore((s) => s.setPluginButtonPromoted);
  const Icon = resolvePluginIcon(config.iconId);

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
              onClick={() => {
                void actionService.dispatch(
                  config.actionId as Parameters<typeof actionService.dispatch>[0],
                  undefined,
                  { source: "user" }
                );
              }}
              className="toolbar-icon-button text-daintree-text relative"
              aria-label={config.label}
              aria-keyshortcuts={ariaShortcut}
            >
              <Icon />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{config.label}</TooltipContent>
        </Tooltip>
      </ContextMenuTrigger>
      <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
        {/*
          The generic toggle would also demote (it writes `false`, and only an
          explicit `true` grants a top-level slot), but it would leave a
          redundant key behind. Routing through the dedicated action deletes it,
          keeping `pinnedButtons` sparse for the stale-plugin sweep.
        */}
        <ToolbarContextMenuItems
          buttonId={pluginId}
          side="right"
          onUnpin={() => setPluginButtonPromoted(pluginId, false)}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function PluginTrayRow({
  config,
  promoted,
  onSelect,
  onTogglePin,
}: {
  config: ToolbarButtonConfig;
  promoted: boolean;
  onSelect: (config: ToolbarButtonConfig) => void;
  onTogglePin: (config: ToolbarButtonConfig) => void;
}) {
  const displayCombo = useKeybindingDisplay(config.actionId);
  const Icon = resolvePluginIcon(config.iconId);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "p" || e.key === "P") {
      e.preventDefault();
      e.stopPropagation();
      onTogglePin(config);
    }
  };

  return (
    <DropdownMenuItem
      onSelect={() => onSelect(config)}
      onKeyDown={handleKeyDown}
      className="group h-7"
      data-testid={`plugin-tray-row-${config.id}`}
    >
      <span className="mr-2 inline-flex h-4 w-4 items-center justify-center">
        <Icon className="h-3.5 w-3.5 text-text-secondary" />
      </span>

      <span className="flex-1">{config.label}</span>

      {displayCombo && <DropdownMenuShortcut>{displayCombo}</DropdownMenuShortcut>}

      <span className="sr-only">Press P to {promoted ? "unpin from" : "pin to"} toolbar</span>

      <span
        role="presentation"
        aria-hidden="true"
        data-testid={`plugin-tray-pin-${config.id}`}
        data-pinned={promoted ? "true" : "false"}
        title={promoted ? `${TOOLBAR_UNPIN_LABEL} (P)` : `${TOOLBAR_PIN_LABEL} (P)`}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin(config);
        }}
        className={cn(
          "ml-1 inline-flex h-5 w-5 items-center justify-center rounded-sm text-daintree-text/50 transition-opacity hover:bg-overlay-emphasis hover:text-daintree-text",
          promoted ? "opacity-100" : "opacity-0 group-data-[highlighted]:opacity-100"
        )}
      >
        <Pin
          className={cn(
            "h-3 w-3",
            promoted &&
              "fill-current text-daintree-text/40 group-data-[highlighted]:text-daintree-text"
          )}
          strokeWidth={promoted ? 2 : 1.75}
        />
      </span>
    </DropdownMenuItem>
  );
}

/**
 * One toolbar button collecting every plugin's toolbar contributions, grouped
 * by owning plugin (#11304). Replaces the pre-#11304 behavior where each
 * contribution claimed its own top-level slot and all of them rendered the
 * same generic glyph.
 *
 * Mirrors `DockLaunchButton`'s structure deliberately: same controlled
 * Dropdown + ContextMenu + Tooltip nesting, same focus-restoration
 * suppression, and the same hover-reveal pin affordance — here promoting a
 * contribution to its own top-level button instead of pinning an agent.
 */
export function PluginTrayButton({
  configs,
  "data-toolbar-item": dataToolbarItem,
}: {
  configs: PluginToolbarConfigs;
  "data-toolbar-item"?: string;
}) {
  const pinnedButtons = useToolbarPreferencesStore((s) => s.layout.pinnedButtons);
  const setPluginButtonPromoted = useToolbarPreferencesStore((s) => s.setPluginButtonPromoted);
  const pluginMetaById = usePluginRuntimeStore((s) => s.pluginMetaById);

  const [open, setOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  // Mirrors DockLaunchButton: Radix reopens the Tooltip whenever the trigger
  // regains focus, including the programmatic restore from onCloseAutoFocus
  // and from a dialog opened via a menu item closing much later. Hold the
  // suppression until the next genuine pointer hover (see #5153).
  const isRestoringFocusRef = useRef(false);
  const wasPointerCloseRef = useRef(false);
  const lastPinActionAt = useRef(0);

  const groups = useMemo(
    () => groupPluginToolbarButtons(configs, (id) => pluginMetaById.get(id)?.displayName ?? id),
    [configs, pluginMetaById]
  );

  // Defensive close for a direct consumer that keeps this mounted through the
  // last plugin unloading. `Toolbar` gates the registry entry on the same
  // condition and unmounts us first, so in the app this normally never fires.
  // Runs before the early return below so hook order stays stable across the
  // has-contributions boundary.
  useEffect(() => {
    if (configs.size === 0) setOpen(false);
  }, [configs.size]);

  // An empty tray is not a slot worth reserving. `Toolbar.tsx` also gates the
  // registry entry on `isAvailable`, which keeps the button out of overflow
  // measurement; this return is the component's own guarantee.
  if (configs.size === 0) return null;

  const handleOpenChange = (next: boolean) => {
    setTooltipOpen(false);
    setOpen(next);
    if (!next) return;
    // A dev-attached plugin registers its buttons without broadcasting
    // provenance, so the runtime store can be missing its display name at
    // this point — pull once on open rather than rendering a raw plugin id.
    usePluginRuntimeStore.getState().refresh();
  };

  const handleSelect = (config: ToolbarButtonConfig) => {
    void actionService.dispatch(
      config.actionId as Parameters<typeof actionService.dispatch>[0],
      undefined,
      { source: "user" }
    );
  };

  const handleTogglePin = (config: ToolbarButtonConfig) => {
    const now = Date.now();
    if (now - lastPinActionAt.current < 50) return;
    lastPinActionAt.current = now;
    setPluginButtonPromoted(config.id, pinnedButtons[config.id] !== true);
  };

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Tooltip
            open={tooltipOpen}
            onOpenChange={(next) => {
              if (next && isRestoringFocusRef.current) return;
              setTooltipOpen(next);
            }}
          >
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  data-toolbar-item={dataToolbarItem}
                  className="toolbar-icon-button text-daintree-text relative"
                  aria-label="Plugin tray"
                  onPointerEnter={() => {
                    isRestoringFocusRef.current = false;
                  }}
                >
                  <Package />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">Plugin tray</TooltipContent>
          </Tooltip>
        </ContextMenuTrigger>
        <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
          <ToolbarContextMenuItems buttonId="plugin-tray" side="right" />
        </ContextMenuContent>
      </ContextMenu>
      <DropdownMenuContent
        align="end"
        sideOffset={4}
        className="min-w-[16rem]"
        onPointerDownOutside={() => {
          wasPointerCloseRef.current = true;
        }}
        onCloseAutoFocus={(e) => {
          setTooltipOpen(false);
          isRestoringFocusRef.current = true;
          // Skip focus restoration for pointer dismissals so the trigger
          // doesn't keep a focus-visible ring the user never asked for;
          // keyboard close still returns focus for WAI-ARIA.
          if (wasPointerCloseRef.current) {
            e.preventDefault();
            wasPointerCloseRef.current = false;
          }
        }}
      >
        {groups.map((group, index) => (
          <DropdownMenuGroup key={group.pluginId}>
            {index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel>{group.displayName}</DropdownMenuLabel>
            {group.buttons.map((config) => (
              <PluginTrayRow
                key={config.id}
                config={config}
                promoted={pinnedButtons[config.id] === true}
                onSelect={handleSelect}
                onTogglePin={handleTogglePin}
              />
            ))}
          </DropdownMenuGroup>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuActionItem actionId="app.pluginManager" className="h-7">
          <Package className="mr-2 h-3.5 w-3.5 text-text-secondary" />
          Manage plugins
        </DropdownMenuActionItem>
        <DropdownMenuActionItem
          actionId="app.settings.openTab"
          args={{ tab: "toolbar" }}
          className="h-7"
        >
          <Settings2 className="mr-2 h-3.5 w-3.5 text-text-secondary" />
          {TOOLBAR_CUSTOMIZE_LABEL}
        </DropdownMenuActionItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
