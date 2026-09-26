import type { ComponentType } from "react";
import {
  ArrowDownFromLine,
  CirclePlay,
  Maximize2,
  Minimize2,
  OctagonX,
  PanelBottomClose,
  PanelTopClose,
  Pencil,
  RotateCw,
  Settings,
  Trash2,
} from "lucide-react";
import { FolderGit2 } from "@/components/icons";
import type { ActionId } from "@shared/types/actions";
import { isBuiltInPanelKind, type PanelKind } from "@shared/types/panel";
import type { PanelKindConfig } from "@shared/config/panelKindRegistry";

export type GenericPanelMenuCommandId =
  | "move-to-worktree"
  | "move-to-dock"
  | "move-to-grid"
  | "toggle-maximize"
  | "rename"
  | "reload"
  | "tour"
  | "plugin-settings"
  | "background"
  | "trash"
  | "kill";

export interface GenericPanelMenuCommand {
  readonly id: GenericPanelMenuCommandId;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  /** The action whose keybinding the item shows as its shortcut. */
  readonly shortcutActionId?: ActionId;
}

export interface GenericPanelMenuInput {
  location: "grid" | "dock";
  isMaximized: boolean;
  isDockable: boolean;
  canMoveToWorktree: boolean;
  /** Whether the panel is a plugin's, whose view the host can remount. */
  canReload: boolean;
  /** Label of the kind's Welcome Tour item; absent when it declares no tour. */
  tourLabel?: string;
  /**
   * The kind's plugin has settings, so the menu offers "Plugin settings…" as
   * the last of the plugin's own entries.
   */
  hasPluginSettings?: boolean;
}

export interface PanelKindMenuCapabilities {
  hasPty: boolean;
  isDockable: boolean;
  /** The tour the kind declares, which its menus offer by `label` once it is registered. */
  tour: { id: string; label: string } | null;
  /** The plugin instance whose settings "Plugin settings…" opens; null when it has none. */
  pluginSettingsId: string | null;
}

const EMPTY_TOUR_IDS: ReadonlySet<string> = new Set();

/**
 * What the menus need to know about a kind, read from a registry snapshot the
 * caller subscribed to rather than through `panelKindHasPty` and
 * `panelKindIsDockable`: the React Compiler caches a plain registry call on
 * `kind` alone, so a plugin registering, unregistering or re-flagging its kind
 * would leave the menu answering for the old registry (#11636). Same answers
 * as those two helpers, unregistered kinds included.
 */
export function readPanelKindMenuCapabilities(
  registry: Readonly<Record<string, PanelKindConfig>>,
  kind: PanelKind,
  registeredTourIds: ReadonlySet<string> = EMPTY_TOUR_IDS
): PanelKindMenuCapabilities {
  const config = registry[kind];
  const tourId = config?.tourId;
  return {
    hasPty: config?.hasPty ?? false,
    isDockable: config !== undefined && config.dockable !== false,
    // A declared tour nothing has registered would open nothing, so it waits.
    tour:
      tourId && registeredTourIds.has(tourId)
        ? { id: tourId, label: `${config.name} Welcome Tour` }
        : null,
    pluginSettingsId:
      config?.hasPluginSettings === true && config.extensionId ? config.extensionId : null,
  };
}

/**
 * Kinds whose menus are the generic panel one: the non-PTY reading surfaces
 * (file, file browser, diff) and any plugin-contributed kind without a PTY.
 * Only built-ins and plugins register kinds, so a non-built-in kind is a
 * plugin's, and deciding by kind keeps a panel whose plugin has gone missing
 * on this menu. The PTY half is load-bearing: a plugin can contribute a
 * PTY-backed kind, and that is a genuine terminal (#11228).
 */
export function hasGenericPanelMenu(kind: PanelKind, hasPty: boolean): boolean {
  if (hasPty) return false;
  return kind === "file" || kind === "file-browser" || kind === "diff" || !isBuiltInPanelKind(kind);
}

/**
 * Whether a generic-menu kind offers Reload panel (#12611): only a plugin's
 * view can be remounted, so the file, file browser and diff kinds that share
 * the menu do not. Callers have already ruled out PTY kinds.
 */
export function canReloadPanelKind(kind: PanelKind): boolean {
  return !isBuiltInPanelKind(kind);
}

/**
 * The panel-level commands of the generic panel menu, in groups a separator
 * divides. The header's overflow menu and the right-click menu both render
 * this list verbatim, so the two cannot disagree on what a panel offers, in
 * what order, or under which name (#12606). Right-click extras that depend on
 * where the click landed are not panel commands and stay out of it.
 *
 * No Duplicate: none of these kinds has a duplicate recipe, and a Duplicate
 * that throws is worse than none.
 */
export function getGenericPanelMenuGroups({
  location,
  isMaximized,
  isDockable,
  canMoveToWorktree,
  canReload,
  tourLabel,
  hasPluginSettings = false,
}: GenericPanelMenuInput): GenericPanelMenuCommand[][] {
  // The plugin's own entries share one group, its settings last: they are
  // about the plugin behind the panel rather than the panel itself.
  const pluginOwned: GenericPanelMenuCommand[] = [
    ...(tourLabel ? [{ id: "tour" as const, label: tourLabel, icon: CirclePlay }] : []),
    ...(hasPluginSettings
      ? [{ id: "plugin-settings" as const, label: "Plugin settings…", icon: Settings }]
      : []),
  ];
  const layout: GenericPanelMenuCommand[] = [];
  if (canMoveToWorktree) {
    // The ellipsis on both surfaces: a destination is still to be chosen,
    // from a submenu on right-click and from the picker in the header.
    layout.push({ id: "move-to-worktree", label: "Move to worktree…", icon: FolderGit2 });
  }
  if (location === "grid") {
    layout.push({
      id: "move-to-dock",
      label: "Move to dock",
      icon: PanelBottomClose,
      disabled: !isDockable,
    });
    layout.push({
      id: "toggle-maximize",
      label: isMaximized ? "Restore" : "Maximize",
      icon: isMaximized ? Minimize2 : Maximize2,
      shortcutActionId: "terminal.maximize",
    });
  } else {
    layout.push({ id: "move-to-grid", label: "Move to grid", icon: PanelTopClose });
  }

  return [
    layout,
    [
      { id: "rename", label: "Rename panel", icon: Pencil },
      ...(canReload ? [{ id: "reload" as const, label: "Reload panel", icon: RotateCw }] : []),
    ],
    ...(pluginOwned.length > 0 ? [pluginOwned] : []),
    [
      { id: "background", label: "Send to background", icon: ArrowDownFromLine },
      { id: "trash", label: "Trash panel", icon: Trash2 },
      { id: "kill", label: "Remove panel", icon: OctagonX, destructive: true },
    ],
  ];
}

/**
 * The action each command dispatches for the panel it was opened on, as
 * `{ terminalId }`. "move-to-worktree" has none of its own: it picks a
 * destination first. "reload" names its panel as `{ panelId }` — see
 * {@link GENERIC_PANEL_RELOAD_ACTION_ID} — "tour" names a tour, not a panel —
 * see {@link GENERIC_PANEL_TOUR_ACTION_ID} — and "plugin-settings" names a
 * plugin, see {@link GENERIC_PANEL_PLUGIN_SETTINGS_ACTION_ID}.
 */
export const GENERIC_PANEL_MENU_ACTION_IDS: Readonly<
  Record<
    Exclude<GenericPanelMenuCommandId, "move-to-worktree" | "reload" | "tour" | "plugin-settings">,
    ActionId
  >
> = {
  "move-to-dock": "terminal.moveToDock",
  "move-to-grid": "terminal.moveToGrid",
  "toggle-maximize": "terminal.toggleMaximize",
  rename: "terminal.rename",
  background: "terminal.background",
  trash: "terminal.trash",
  kill: "terminal.kill",
};

/**
 * The action "reload" dispatches, as `{ panelId }`: it is also an MCP tool, so
 * its argument has no focused-panel fallback to share with the others.
 */
export const GENERIC_PANEL_RELOAD_ACTION_ID = "plugin.reloadPanel" satisfies ActionId;

/**
 * The action "tour" dispatches, as `{ tourId }` from the kind's
 * {@link PanelKindMenuCapabilities.tour}: the same one that plays Daintree's
 * own tour.
 */
export const GENERIC_PANEL_TOUR_ACTION_ID = "help.tour.show" satisfies ActionId;

/**
 * The action "plugin-settings" dispatches, as `{ pluginId }` from the kind's
 * {@link PanelKindMenuCapabilities.pluginSettingsId}: it lands in whichever home
 * the plugin's settings already live in.
 */
export const GENERIC_PANEL_PLUGIN_SETTINGS_ACTION_ID = "plugin.openSettings" satisfies ActionId;
