import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Pin, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { ROW_CONTROL_CLASS, RowControlTooltip } from "@/components/ui/RowControl";
import {
  ContextMenu,
  ContextMenuActionItem,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { PopoverAnchor, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuActionItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";
import { saveProjectToolbar } from "./saveProjectToolbar";
import {
  TOOLBAR_CUSTOMIZE_ICON,
  TOOLBAR_CUSTOMIZE_LABEL,
  TOOLBAR_PIN_LABEL,
  TOOLBAR_UNPIN_LABEL,
} from "./toolbarMenuStrings";
import { Package } from "@/components/icons";
import { Spinner } from "@/components/ui/Spinner";
import { ARIA_DISABLED_CLASSES } from "@/components/ui/ariaDisabled";
import { actionService } from "@/services/ActionService";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { useProjectPresentationStore } from "@/store/projectPresentationStore";
import { useProjectToolbarOverlay } from "@/hooks/useResolvedPresentation";
import { usePluginToolbarPopoverStore } from "@/store/pluginToolbarPopoverStore";
import { MAX_PROMOTED_PLUGIN_BUTTONS } from "@shared/config/presentationProfile";
import {
  pluginManifestIdFromInstanceKey,
  projectIdFromPluginInstanceKey,
  type PluginPanelBadge,
} from "@shared/types/plugin";
import { useAriaKeyshortcuts, useShortcutHintHover } from "@/hooks";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";
import type { PluginToolbarButtonId } from "@shared/types/toolbar";
import { cn } from "@/lib/utils";
import { pluralize } from "@/lib/pluralize";
import {
  toolbarBadgeFor,
  usePluginToolbarBadge,
  usePluginToolbarBadgeStore,
} from "@/store/pluginToolbarBadgeStore";
import { PLUGIN_BADGE_DOT_COLOR, PluginBadgeIndicator } from "@/components/Panel/PluginPanelBadges";
import {
  describeToolbarBadge,
  mostSevereBadgeColor,
  toolbarBadgeCountGlyph,
} from "./pluginToolbarBadge";
import { presentPluginToolbarButton } from "./pluginToolbarButtonState";
import { usePluginToolbarMenu, type PluginToolbarMenuEntry } from "./pluginToolbarMenu";
import { usePluginToolbarButtonState } from "@/store/pluginToolbarStateStore";
import {
  PluginToolbarPopover,
  focusToolbarControl,
  isHiddenToolbarControl,
  pluginCommandFocusTarget,
} from "./PluginToolbarPopover";

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

/** The same words every plugin surface uses for its way into the plugin's settings. */
const PLUGIN_SETTINGS_MENU_LABEL = "Plugin settings…";

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
  // A popover button dispatches no action, so it has no shortcut to hint.
  const hover = useShortcutHintHover(config.actionId ?? "");
  const ariaShortcut = useAriaKeyshortcuts(config.actionId ?? "");
  const ownConfig = useMemo(() => new Map([[config.id, config]]), [config]);
  const setPluginButtonPromoted = useToolbarPreferencesStore((s) => s.setPluginButtonPromoted);
  const appPromoted = useToolbarPreferencesStore((s) => s.layout.pinnedButtons[pluginId] === true);
  const projectPromoted = useProjectToolbarOverlay().promotedPluginButtons.includes(pluginId);
  const setProjectPromoted = useProjectPresentationStore((s) => s.setPluginButtonPromoted);
  const reasonId = useId();
  const { Icon, tooltip, pressed, busy, disabled, blocked } = presentPluginToolbarButton(
    config,
    usePluginToolbarButtonState(config)
  );
  const badge = usePluginToolbarBadge(config);
  // The mark keeps its last badge while it fades out, as Canopy's count does.
  const [shownBadge, setShownBadge] = useState(badge);
  if (badge !== null && badge !== shownBadge) setShownBadge(badge);
  // Two characters fit: a whole-number label is a count, anything else a pip,
  // with the full text in the tooltip and on the tray row.
  const countGlyph = shownBadge ? toolbarBadgeCountGlyph(shownBadge) : null;
  const badgeColor = shownBadge?.color ?? "default";
  const name = badge ? `${config.label}, ${describeToolbarBadge(badge)}` : config.label;
  const tooltipText = badge ? `${tooltip}, ${describeToolbarBadge(badge)}` : tooltip;
  // Never both: a popover button's click is its `PopoverTrigger`'s.
  const actionId = config.popover ? undefined : config.actionId;
  const menuEntries = usePluginToolbarMenu(config);
  // With an action the menu is a chevron beside the button; without one the
  // button itself opens it. A popover button carries no menu.
  const hasMenu = !config.popover && menuEntries.length > 0;
  const opensMenu = hasMenu && actionId === undefined && !blocked;

  const button = (
    <Button
      {...hover}
      variant="ghost"
      size="icon"
      data-toolbar-item={dataToolbarItem}
      loading={busy}
      onClick={(event) => {
        // Announced unavailable rather than natively disabled, so the
        // reason's tooltip still opens and the veto happens here. Preventing
        // the click is also what keeps a popover button's trigger shut.
        if (blocked) {
          event.preventDefault();
          return;
        }
        if (actionId === undefined) return;
        void actionService.dispatch(
          actionId as Parameters<typeof actionService.dispatch>[0],
          undefined,
          { source: "user" }
        );
      }}
      className={cn(
        "toolbar-icon-button toolbar-quiet-ink text-text-secondary relative",
        hasMenu && actionId !== undefined && "rounded-r-none",
        disabled && !busy && ARIA_DISABLED_CLASSES
      )}
      aria-label={name}
      // A toggle keeps one name; aria-pressed announces the state.
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      aria-describedby={disabled ? reasonId : undefined}
      aria-keyshortcuts={ariaShortcut}
    >
      <span className="relative inline-flex">
        <Icon />
        <span
          aria-hidden="true"
          data-testid={`plugin-toolbar-badge-${config.id}`}
          data-visible={badge !== null}
          className={cn(
            countGlyph !== null ? "toolbar-count" : "toolbar-pip",
            "toolbar-badge",
            PLUGIN_BADGE_DOT_COLOR[badgeColor]
          )}
          data-badge-color={badgeColor}
        >
          {countGlyph}
        </span>
      </span>
    </Button>
  );

  const body = (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <span className="inline-flex">
          <Tooltip>
            <TooltipTrigger asChild>
              {config.popover ? (
                <PopoverTrigger asChild>{button}</PopoverTrigger>
              ) : opensMenu ? (
                <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
              ) : (
                button
              )}
            </TooltipTrigger>
            <TooltipContent side="bottom">{tooltipText}</TooltipContent>
          </Tooltip>
          {hasMenu && actionId !== undefined && (
            <PluginToolbarMenuChevron
              config={config}
              entries={menuEntries}
              blocked={blocked}
              dataToolbarItem={dataToolbarItem}
            />
          )}
          {disabled && (
            <span id={reasonId} className="sr-only">
              {tooltip}
            </span>
          )}
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
        {/*
          The generic toggle would also demote (it writes `false`, and only an
          explicit `true` grants a top-level slot), but it would leave a
          redundant key behind. Routing through the dedicated action deletes it,
          keeping `pinnedButtons` sparse for the stale-plugin sweep.
        */}
        {config.hasPluginSettings === true && (
          <>
            <ContextMenuActionItem
              actionId="plugin.openSettings"
              args={{ pluginId: config.pluginId }}
            >
              <Settings data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
              {PLUGIN_SETTINGS_MENU_LABEL}
            </ContextMenuActionItem>
            <ContextMenuSeparator />
          </>
        )}
        <ToolbarContextMenuItems
          buttonId={pluginId}
          side="right"
          onUnpin={() => {
            // Promoted by this project's toolbar (#13783), the app-wide
            // layout, or both: unpinning takes away whichever put it here.
            if (projectPromoted) saveProjectToolbar(() => setProjectPromoted(pluginId, false));
            if (appPromoted || !projectPromoted) setPluginButtonPromoted(pluginId, false);
          }}
        />
      </ContextMenuContent>
    </ContextMenu>
  );

  if (opensMenu) {
    return (
      <DropdownMenu>
        {body}
        <DropdownMenuContent
          align="start"
          sideOffset={4}
          className="min-w-[12rem] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto"
        >
          <PluginToolbarMenuItems entries={menuEntries} blocked={blocked} />
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  if (!config.popover) return body;
  return (
    <PluginToolbarPopover origin="button" buttonId={config.id} configs={ownConfig}>
      {body}
    </PluginToolbarPopover>
  );
}

function dispatchPluginMenuEntry(actionId: string): void {
  // Only the action: nothing the plugin supplies travels with the click.
  void actionService.dispatch(actionId as Parameters<typeof actionService.dispatch>[0], undefined, {
    source: "user",
  });
}

/** A plugin toolbar button's menu rows, each dispatching its own action. */
function PluginToolbarMenuItems({
  entries,
  blocked = false,
}: {
  entries: readonly PluginToolbarMenuEntry[];
  /** The button went busy or disabled while its menu was open: selecting does nothing. */
  blocked?: boolean;
}) {
  return (
    <>
      {entries.map((entry) => (
        <DropdownMenuItem
          key={entry.actionId}
          onSelect={(event) => {
            if (blocked) {
              event.preventDefault();
              return;
            }
            dispatchPluginMenuEntry(entry.actionId);
          }}
          aria-disabled={blocked || undefined}
          keybinding={entry.actionId}
          data-testid={`plugin-toolbar-menu-item-${entry.actionId}`}
        >
          <span className="min-w-0 flex-1 truncate">{entry.label}</span>
        </DropdownMenuItem>
      ))}
    </>
  );
}

/**
 * The chevron half of a split plugin button: the button's own click stays its
 * action and this opens the plugin's menu. A busy or disabled button blocks the
 * chevron too, announced rather than natively disabled so its reason still shows.
 */
function PluginToolbarMenuChevron({
  config,
  entries,
  blocked,
  dataToolbarItem,
}: {
  config: ToolbarButtonConfig;
  entries: readonly PluginToolbarMenuEntry[];
  blocked: boolean;
  dataToolbarItem?: string;
}) {
  const label = `${config.label} menu`;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              aria-label={label}
              aria-disabled={blocked || undefined}
              onPointerDown={(e) => {
                if (blocked) e.preventDefault();
              }}
              onKeyDown={(e) => {
                if (blocked && (e.key === "Enter" || e.key === " " || e.key === "ArrowDown")) {
                  e.preventDefault();
                }
              }}
              data-toolbar-item={dataToolbarItem}
              data-testid={`plugin-toolbar-menu-chevron-${config.id}`}
              className={cn(
                "group/split-toggle toolbar-icon-button text-text-secondary aria-expanded:text-text-primary rounded-l-none",
                "h-8 w-6 p-0 flex items-center justify-center",
                blocked && ARIA_DISABLED_CLASSES
              )}
            >
              <ChevronDown
                className="h-3 w-3 transition-transform duration-150 ease-out group-aria-expanded/split-toggle:rotate-180"
                aria-hidden="true"
              />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        className="min-w-[12rem] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto"
      >
        <PluginToolbarMenuItems entries={entries} blocked={blocked} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A plugin contribution inside the toolbar's overflow `…` menu, from either
 * route there (an overflowed promoted button, or an overflowed tray's rows),
 * carrying its live badge in full as the tray row does (#13503).
 */
export function PluginOverflowItem({
  config,
  onSelect,
  keybinding,
}: {
  config: ToolbarButtonConfig;
  onSelect: () => void;
  keybinding?: string;
}) {
  const presentation = presentPluginToolbarButton(config, usePluginToolbarButtonState(config));
  const badge = usePluginToolbarBadge(config);
  const menuEntries = usePluginToolbarMenu(config);
  if (!config.popover && menuEntries.length > 0 && !presentation.blocked) {
    // Same shape as a tray row: the row opens the submenu, and a button with
    // an action lists that action first.
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <PluginMenuRowIcon presentation={presentation} />
          <span className="min-w-0 flex-1 truncate">{config.label}</span>
          <PluginMenuRowState presentation={presentation} />
          {badge && (
            <>
              <span className="ml-2 inline-flex shrink-0 items-center">
                <PluginBadgeIndicator pluginId={config.pluginId} badge={badge} live={false} />
              </span>
              <span className="sr-only">, {describeToolbarBadge(badge)}</span>
            </>
          )}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-[12rem]">
          {config.actionId !== undefined && (
            <>
              <DropdownMenuItem
                onSelect={onSelect}
                keybinding={config.actionId}
                {...menuToggleProps(presentation.pressed)}
              >
                <span className="min-w-0 flex-1 truncate">{config.label}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <PluginToolbarMenuItems entries={menuEntries} />
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  }
  return (
    <DropdownMenuItem
      onClick={(event) => {
        if (presentation.blocked) {
          event.preventDefault();
          return;
        }
        onSelect();
      }}
      keybinding={keybinding}
      {...menuToggleProps(presentation.pressed)}
      aria-disabled={presentation.blocked || undefined}
      className={cn(presentation.blocked && ARIA_DISABLED_CLASSES)}
    >
      <PluginMenuRowIcon presentation={presentation} />
      <TruncatedTooltip
        content={presentation.tooltip}
        isTruncated={presentation.tooltip !== config.label}
        focusable={false}
      >
        <span className="flex-1">{config.label}</span>
      </TruncatedTooltip>
      <PluginMenuRowState presentation={presentation} />
      {badge && (
        <>
          <span className="ml-2 inline-flex shrink-0 items-center">
            <PluginBadgeIndicator pluginId={config.pluginId} badge={badge} live={false} />
          </span>
          <span className="sr-only">, {describeToolbarBadge(badge)}</span>
        </>
      )}
    </DropdownMenuItem>
  );
}

/** A menu row's icon: a spinner while busy, else the live icon. */
function PluginMenuRowIcon({
  presentation,
}: {
  presentation: ReturnType<typeof presentPluginToolbarButton>;
}) {
  if (presentation.busy) {
    return (
      <span data-menu-icon className="mr-2 inline-flex h-3.5 w-3.5 shrink-0" aria-hidden="true">
        <Spinner size="sm" />
      </span>
    );
  }
  const { Icon } = presentation;
  return <Icon data-menu-icon className="mr-2 h-3.5 w-3.5 shrink-0" aria-hidden="true" />;
}

/**
 * A toggle's menu row is a `menuitemcheckbox`, the menu's form of
 * `aria-pressed`. The plugin's state stays authoritative: selecting the row
 * dispatches, and the check only moves when the plugin republishes.
 */
function menuToggleProps(pressed: boolean | undefined) {
  if (pressed === undefined) return {};
  return { role: "menuitemcheckbox" as const, "aria-checked": pressed };
}

/** A menu row's live state: a check for a toggle that is on, and why a blocked row won't run. */
function PluginMenuRowState({
  presentation,
}: {
  presentation: ReturnType<typeof presentPluginToolbarButton>;
}) {
  return (
    <>
      {presentation.pressed === true && (
        <Check className="ml-2 h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
      )}
      {presentation.busy && <span className="sr-only">, busy</span>}
      {presentation.disabled && !presentation.busy && (
        <span className="sr-only">, unavailable: {presentation.tooltip}</span>
      )}
    </>
  );
}

function PluginTrayRow({
  config,
  promoted,
  pinDisabled = false,
  onSelect,
  onTogglePin,
}: {
  config: ToolbarButtonConfig;
  promoted: boolean;
  /** This project's toolbar already shows as many plugin buttons as it can (#13783). */
  pinDisabled?: boolean;
  onSelect: (config: ToolbarButtonConfig) => void;
  onTogglePin: (config: ToolbarButtonConfig) => void;
}) {
  const presentation = presentPluginToolbarButton(config, usePluginToolbarButtonState(config));
  const badge = usePluginToolbarBadge(config);
  const menuEntries = usePluginToolbarMenu(config);
  // A menu turns the row into a submenu: a button with an action lists that
  // action first, since the row itself opens the submenu rather than running it.
  const asSubmenu = !config.popover && menuEntries.length > 0 && !presentation.blocked;

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "p" || e.key === "P") {
      e.preventDefault();
      e.stopPropagation();
      if (!pinDisabled) onTogglePin(config);
    }
  };

  const content = (
    <>
      <PluginMenuRowIcon presentation={presentation} />

      {/* The plugin's tooltip or disabled reason shows on hover whether or not
          the label is cut off; with neither, only a truncated label does. */}
      <TruncatedTooltip
        content={presentation.tooltip}
        isTruncated={presentation.tooltip !== config.label ? true : undefined}
        focusable={false}
      >
        <span className="min-w-0 flex-1 truncate">{config.label}</span>
      </TruncatedTooltip>

      <PluginMenuRowState presentation={presentation} />

      {badge && (
        <>
          <span className="ml-2 inline-flex shrink-0 items-center">
            <PluginBadgeIndicator pluginId={config.pluginId} badge={badge} live={false} />
          </span>
          <span className="sr-only">, {describeToolbarBadge(badge)}</span>
        </>
      )}

      {pinDisabled ? (
        <span className="sr-only">
          This project&apos;s toolbar already shows {MAX_PROMOTED_PLUGIN_BUTTONS} plugin buttons
        </span>
      ) : (
        <span className="sr-only">Press P to {promoted ? "unpin from" : "pin to"} toolbar</span>
      )}

      {!pinDisabled && (
        <RowControlTooltip label={promoted ? TOOLBAR_UNPIN_LABEL : TOOLBAR_PIN_LABEL} shortcut="P">
          <span
            role="presentation"
            aria-hidden="true"
            data-testid={`plugin-tray-pin-${config.id}`}
            data-pinned={promoted ? "true" : "false"}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin(config);
            }}
            className={cn(
              ROW_CONTROL_CLASS,
              // 24px inside a 28px menu row: the negative margin keeps the row's
              // height where every other menu item has it.
              "-my-1 ml-1",
              !promoted && "opacity-0 group-data-[highlighted]:opacity-100"
            )}
          >
            <Pin
              className={cn(
                "h-3 w-3",
                promoted &&
                  "fill-current text-text-secondary group-data-[highlighted]:text-text-primary"
              )}
              strokeWidth={promoted ? 2 : 1.75}
            />
          </span>
        </RowControlTooltip>
      )}
    </>
  );

  if (asSubmenu) {
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger
          onKeyDown={handleKeyDown}
          className="group"
          data-testid={`plugin-tray-row-${config.id}`}
        >
          {content}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-[12rem]">
          {config.actionId !== undefined && (
            <>
              <DropdownMenuItem
                onSelect={() => onSelect(config)}
                keybinding={config.actionId}
                {...menuToggleProps(presentation.pressed)}
                data-testid={`plugin-tray-primary-${config.id}`}
              >
                <span className="min-w-0 flex-1 truncate">{config.label}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <PluginToolbarMenuItems entries={menuEntries} />
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  }

  return (
    <DropdownMenuItem
      // Not Radix's `disabled`: that would skip the row in keyboard navigation
      // and take its pin control with it. The row stays reachable, says why,
      // and only selecting it is vetoed — the menu stays open.
      onSelect={(event) => {
        if (presentation.blocked) {
          event.preventDefault();
          return;
        }
        onSelect(config);
      }}
      onKeyDown={handleKeyDown}
      {...menuToggleProps(presentation.pressed)}
      aria-disabled={presentation.blocked || undefined}
      className={cn("group", presentation.blocked && ARIA_DISABLED_CLASSES)}
      data-testid={`plugin-tray-row-${config.id}`}
      keybinding={config.actionId}
    >
      {content}
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
  const toolbarOverlay = useProjectToolbarOverlay();
  const projectPromoted = toolbarOverlay.promotedPluginButtons;
  const setProjectPromoted = useProjectPresentationStore((s) => s.setPluginButtonPromoted);
  const isPromoted = (id: PluginToolbarButtonId) =>
    pinnedButtons[id] === true || projectPromoted.includes(id);
  const isProjectPromotable = (config: ToolbarButtonConfig) =>
    toolbarOverlay.active && projectIdFromPluginInstanceKey(config.pluginId) !== null;
  // At the profile's cap a further project button can't be pinned; it says so
  // rather than quietly pinning it app-wide.
  const atProjectCap = projectPromoted.length >= MAX_PROMOTED_PLUGIN_BUTTONS;
  const pluginMetaById = usePluginRuntimeStore((s) => s.pluginMetaById);
  const badgesByPlugin = usePluginToolbarBadgeStore((s) => s.badgesByPlugin);

  const [open, setOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  // Mirrors DockLaunchButton: Radix reopens the Tooltip whenever the trigger
  // regains focus, including the programmatic restore from onCloseAutoFocus
  // and from a dialog opened via a menu item closing much later. Hold the
  // suppression until the next genuine pointer hover (see #5153).
  const isRestoringFocusRef = useRef(false);
  const wasPointerCloseRef = useRef(false);
  const lastPinActionAt = useRef(0);
  const trayButtonRef = useRef<HTMLButtonElement>(null);
  const openPopover = usePluginToolbarPopoverStore((s) => s.open);
  // A popover row defers its button in the store and the menu's close hook
  // spends it; the store drops it if `when` hides the button meanwhile.
  const deferPopover = usePluginToolbarPopoverStore((s) => s.defer);
  const takeDeferredPopover = usePluginToolbarPopoverStore((s) => s.takeDeferred);

  const groups = useMemo(
    () =>
      groupPluginToolbarButtons(
        configs,
        (id) => pluginMetaById.get(id)?.displayName ?? pluginManifestIdFromInstanceKey(id)
      ),
    [configs, pluginMetaById]
  );

  // Only rows without a top-level button of their own count toward the tray's
  // dot, so one badge never lights two buttons.
  const trayBadges = useMemo(() => {
    const out: PluginPanelBadge[] = [];
    for (const config of configs.values()) {
      if (pinnedButtons[config.id] === true || projectPromoted.includes(config.id)) continue;
      const badge = toolbarBadgeFor(badgesByPlugin, config);
      if (badge) out.push(badge);
    }
    return out;
  }, [configs, pinnedButtons, projectPromoted, badgesByPlugin]);
  const trayBadgeColor = mostSevereBadgeColor(trayBadges);
  // The dot keeps its last colour while it fades out, rather than greying.
  const [shownTrayColor, setShownTrayColor] = useState(trayBadgeColor);
  if (trayBadgeColor !== null && trayBadgeColor !== shownTrayColor) {
    setShownTrayColor(trayBadgeColor);
  }
  const trayName =
    trayBadges.length > 0 ? `Plugin tray, ${pluralize(trayBadges.length, "badge")}` : "Plugin tray";

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
    // A menu reopened inside its exit animation never unmounts, so the close
    // hook never ran for that close; drop the intent rather than let it open
    // the popover on some later, unrelated close.
    takeDeferredPopover("tray");
    // A dev-attached plugin registers its buttons without broadcasting
    // provenance, so the runtime store can be missing its display name at
    // this point — pull once on open rather than rendering a raw plugin id.
    usePluginRuntimeStore.getState().refresh();
  };

  const handleSelect = (config: ToolbarButtonConfig) => {
    if (config.popover) {
      deferPopover(config.id, "tray");
      return;
    }
    // A menu button whose items are gone has nothing left to run.
    if (config.actionId === undefined) return;
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
    const appPinned = pinnedButtons[config.id] === true;
    // While this project's toolbar is in use, its own plugin's buttons are
    // promoted by the profile (#13783), never app-wide. Installed plugins keep
    // the app-wide pin they always had.
    if (isProjectPromotable(config)) {
      const promoted = projectPromoted.includes(config.id);
      if (promoted || appPinned) {
        if (promoted) saveProjectToolbar(() => setProjectPromoted(config.id, false));
        if (appPinned) setPluginButtonPromoted(config.id, false);
      } else if (projectPromoted.length < MAX_PROMOTED_PLUGIN_BUTTONS) {
        saveProjectToolbar(() => setProjectPromoted(config.id, true));
      }
      return;
    }
    setPluginButtonPromoted(config.id, !appPinned);
  };

  return (
    <PluginToolbarPopover origin="tray" configs={configs}>
      <DropdownMenu open={open} onOpenChange={handleOpenChange}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <span className="inline-flex">
              <Tooltip
                open={tooltipOpen}
                onOpenChange={(next) => {
                  if (next && isRestoringFocusRef.current) return;
                  setTooltipOpen(next);
                }}
              >
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    {/* Also where a popover picked from one of the rows hangs,
                      and where focus goes when it closes: the row is gone with
                      the menu. */}
                    <PopoverAnchor asChild restoreFocus>
                      <Button
                        ref={trayButtonRef}
                        variant="ghost"
                        size="icon"
                        data-toolbar-item={dataToolbarItem}
                        className="toolbar-icon-button toolbar-quiet-ink text-text-secondary relative"
                        aria-label={trayName}
                        onPointerEnter={() => {
                          isRestoringFocusRef.current = false;
                        }}
                      >
                        <span className="relative inline-flex">
                          <Package />
                          <span
                            aria-hidden="true"
                            data-testid="plugin-tray-badge"
                            data-visible={trayBadgeColor !== null}
                            data-badge-color={shownTrayColor ?? "default"}
                            className={cn(
                              "toolbar-pip toolbar-badge",
                              PLUGIN_BADGE_DOT_COLOR[shownTrayColor ?? "default"]
                            )}
                          />
                        </span>
                      </Button>
                    </PopoverAnchor>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">{trayName}</TooltipContent>
              </Tooltip>
            </span>
          </ContextMenuTrigger>
          <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
            <ToolbarContextMenuItems buttonId="plugin-tray" side="right" />
          </ContextMenuContent>
        </ContextMenu>
        <DropdownMenuContent
          align="end"
          sideOffset={4}
          className="min-w-[16rem] max-w-[22rem]"
          onPointerDownOutside={() => {
            wasPointerCloseRef.current = true;
          }}
          onCloseAutoFocus={(e) => {
            setTooltipOpen(false);
            isRestoringFocusRef.current = true;
            const pendingPopover = takeDeferredPopover("tray");
            if (pendingPopover !== null) {
              // The popover takes focus into itself; returning it to this button
              // first would only flash a ring on the way.
              e.preventDefault();
              wasPointerCloseRef.current = false;
              const tray = trayButtonRef.current;
              if (tray === null || !isHiddenToolbarControl(tray)) {
                openPopover(pendingPopover, "tray");
                return;
              }
              // The tray moved into overflow while its menu was open: a popover
              // would hang off a button nobody can see, so focus goes where the
              // command lives now instead.
              const target = pluginCommandFocusTarget(pendingPopover);
              if (target !== null) focusToolbarControl(target);
              return;
            }
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
                  promoted={isPromoted(config.id)}
                  pinDisabled={
                    !isPromoted(config.id) && atProjectCap && isProjectPromotable(config)
                  }
                  onSelect={handleSelect}
                  onTogglePin={handleTogglePin}
                />
              ))}
              {group.buttons.some((config) => config.hasPluginSettings === true) && (
                <DropdownMenuActionItem
                  actionId="plugin.openSettings"
                  args={{ pluginId: group.pluginId }}
                >
                  <Settings data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                  {PLUGIN_SETTINGS_MENU_LABEL}
                </DropdownMenuActionItem>
              )}
            </DropdownMenuGroup>
          ))}

          <DropdownMenuSeparator />
          <DropdownMenuActionItem actionId="app.pluginManager">
            <Package data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            Manage plugins
          </DropdownMenuActionItem>
          <DropdownMenuActionItem actionId="app.settings.openTab" args={{ tab: "toolbar" }}>
            <TOOLBAR_CUSTOMIZE_ICON
              data-menu-icon
              className="mr-2 h-3.5 w-3.5"
              aria-hidden="true"
            />
            {TOOLBAR_CUSTOMIZE_LABEL}
          </DropdownMenuActionItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </PluginToolbarPopover>
  );
}
