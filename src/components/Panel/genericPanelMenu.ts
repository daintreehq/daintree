import type { ComponentType } from "react";
import {
  ArrowDownFromLine,
  CirclePlay,
  DatabaseBackup,
  Maximize2,
  Minimize2,
  OctagonX,
  PanelBottomClose,
  PanelTopClose,
  Pencil,
  Puzzle,
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
  | "plugin-backup"
  | "plugin-settings"
  | PluginMenuCommandId
  | "background"
  | "trash"
  | "kill";

/** A plugin-contributed item, keyed by the action it dispatches. */
export type PluginMenuCommandId = `plugin-action:${string}`;

const PLUGIN_MENU_COMMAND_PREFIX = "plugin-action:";

/** Whether a command is a plugin-contributed one rather than the host's. */
export function isPluginMenuCommandId(commandId: string): commandId is PluginMenuCommandId {
  return commandId.startsWith(PLUGIN_MENU_COMMAND_PREFIX);
}

/** The action a plugin-contributed command dispatches, with `{ panelId }`. */
export function pluginMenuCommandActionId(commandId: PluginMenuCommandId): ActionId {
  return commandId.slice(PLUGIN_MENU_COMMAND_PREFIX.length);
}

/** A `contributes.panels[].menu` entry whose action is registered, labelled for display. */
export interface PluginPanelMenuItem {
  readonly actionId: string;
  readonly label: string;
}

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
  /** The kind's plugin declares databases, so the menu offers "Back up data…". */
  hasPluginDatabases?: boolean;
  /**
   * The kind's own `menu` items, already narrowed to registered actions, in
   * declared order. They get a group of their own above the plugin's entries.
   */
  pluginMenuItems?: readonly PluginPanelMenuItem[];
}

export interface PanelKindMenuCapabilities {
  hasPty: boolean;
  isDockable: boolean;
  /** The tour the kind declares, which its menus offer by `label` once it is registered. */
  tour: { id: string; label: string } | null;
  /** The plugin instance whose settings "Plugin settings…" opens; null when it has none. */
  pluginSettingsId: string | null;
  /** The plugin instance whose databases "Back up data…" snapshots; null when it declares none. */
  pluginBackupId: string | null;
  /** The kind's `menu` items whose actions are registered right now, in declared order. */
  pluginMenuItems: readonly PluginPanelMenuItem[];
}

const EMPTY_TOUR_IDS: ReadonlySet<string> = new Set();
const EMPTY_ACTION_TITLES: ReadonlyMap<string, string> = new Map();
const NO_PLUGIN_MENU_ITEMS: readonly PluginPanelMenuItem[] = [];

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
  registeredTourIds: ReadonlySet<string> = EMPTY_TOUR_IDS,
  registeredPluginActions: ReadonlyMap<string, string> = EMPTY_ACTION_TITLES
): PanelKindMenuCapabilities {
  const config = registry[kind];
  const tourId = config?.tourId;
  const declaredMenu = config?.pluginMenu;
  // An item whose action is not registered would dispatch nothing, so it waits,
  // as a declared tour does; the label falls back to the action's own title.
  const pluginMenuItems =
    declaredMenu && declaredMenu.length > 0
      ? declaredMenu.flatMap((item) => {
          const title = registeredPluginActions.get(item.actionId);
          if (title === undefined) return [];
          const label = item.label ?? title;
          return label.length > 0 ? [{ actionId: item.actionId, label }] : [];
        })
      : NO_PLUGIN_MENU_ITEMS;
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
    pluginBackupId:
      config?.hasPluginDatabases === true && config.extensionId ? config.extensionId : null,
    pluginMenuItems,
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
  hasPluginDatabases = false,
  pluginMenuItems = NO_PLUGIN_MENU_ITEMS,
}: GenericPanelMenuInput): GenericPanelMenuCommand[][] {
  // The plugin's own entries share one group, its settings last: they are
  // about the plugin behind the panel rather than the panel itself.
  const pluginOwned = getPluginOwnedMenuCommands({
    tourLabel,
    hasPluginSettings,
    hasPluginDatabases,
  });
  // What the plugin put on its own menu sits directly above them, in the
  // order it declared.
  const pluginContributed = getPluginContributedMenuCommands(pluginMenuItems);
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
    ...(pluginContributed.length > 0 ? [pluginContributed] : []),
    ...(pluginOwned.length > 0 ? [pluginOwned] : []),
    [
      { id: "background", label: "Send to background", icon: ArrowDownFromLine },
      { id: "trash", label: "Trash panel", icon: Trash2 },
      { id: "kill", label: "Remove panel", icon: OctagonX, destructive: true },
    ],
  ];
}

/**
 * The host's entries about the plugin behind a panel — its tour, "Back up
 * data…" and "Plugin settings…", settings always last.
 */
function getPluginOwnedMenuCommands({
  tourLabel,
  hasPluginSettings = false,
  hasPluginDatabases = false,
}: Pick<
  GenericPanelMenuInput,
  "tourLabel" | "hasPluginSettings" | "hasPluginDatabases"
>): GenericPanelMenuCommand[] {
  return [
    ...(tourLabel ? [{ id: "tour" as const, label: tourLabel, icon: CirclePlay }] : []),
    // The ellipsis: a destination is still to be chosen, in a native dialog.
    ...(hasPluginDatabases
      ? [{ id: "plugin-backup" as const, label: "Back up data…", icon: DatabaseBackup }]
      : []),
    ...(hasPluginSettings
      ? [{ id: "plugin-settings" as const, label: "Plugin settings…", icon: Settings }]
      : []),
  ];
}

/**
 * A panel kind's own `menu` items as commands, in declared order. One icon for
 * all of them: the manifest names no icon, and a row without one would break
 * the column every other row's icon keeps.
 */
function getPluginContributedMenuCommands(
  items: readonly PluginPanelMenuItem[]
): GenericPanelMenuCommand[] {
  return items.map((item) => ({
    id: `${PLUGIN_MENU_COMMAND_PREFIX}${item.actionId}` as PluginMenuCommandId,
    label: item.label,
    icon: Puzzle,
  }));
}

/**
 * The action each command dispatches for the panel it was opened on, as
 * `{ terminalId }`. "move-to-worktree" has none of its own: it picks a
 * destination first. "reload" names its panel as `{ panelId }` — see
 * {@link GENERIC_PANEL_RELOAD_ACTION_ID} — "tour" names a tour, not a panel —
 * see {@link GENERIC_PANEL_TOUR_ACTION_ID} — "plugin-settings" and
 * "plugin-backup" name a plugin, see {@link GENERIC_PANEL_PLUGIN_SETTINGS_ACTION_ID}
 * and {@link GENERIC_PANEL_PLUGIN_BACKUP_ACTION_ID} — and a plugin-contributed
 * command dispatches its own action with `{ panelId }`, see
 * {@link pluginMenuCommandActionId}.
 */
export const GENERIC_PANEL_MENU_ACTION_IDS: Readonly<
  Record<
    Exclude<
      GenericPanelMenuCommandId,
      | "move-to-worktree"
      | "reload"
      | "tour"
      | "plugin-settings"
      | "plugin-backup"
      | PluginMenuCommandId
    >,
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

/**
 * The action "plugin-backup" dispatches, as `{ pluginId }` from the kind's
 * {@link PanelKindMenuCapabilities.pluginBackupId}: main finds the plugin's
 * databases itself and asks where to put the copies.
 */
export const GENERIC_PANEL_PLUGIN_BACKUP_ACTION_ID = "plugin.backupDatabases" satisfies ActionId;
