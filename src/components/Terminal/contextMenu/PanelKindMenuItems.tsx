import { Fragment } from "react";
import type React from "react";
import {
  ArrowDownFromLine,
  CirclePlay,
  CircleStop,
  Copy,
  CopyPlus,
  DatabaseBackup,
  Globe,
  OctagonX,
  Pencil,
  RotateCw,
  Settings,
  Trash2,
} from "lucide-react";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import {
  getGenericPanelMenuGroups,
  type GenericPanelMenuInput,
  type PanelKindMenuCapabilities,
} from "@/components/Panel/genericPanelMenu";
import { ICON_CLASS, type MenuActionHandler } from "./menuShared";

/**
 * The kind's tour. The generic list carries it as a command of its own; the
 * built-in menus draw this beside Rename, so a built-in kind that declares a
 * tour gets it on right-click with no menu changes.
 */
export function TourMenuItem({
  tour,
  onAction,
}: {
  tour: PanelKindMenuCapabilities["tour"];
  onAction: MenuActionHandler;
}) {
  if (!tour) return null;
  return (
    <ContextMenuItem onSelect={() => onAction("tour")}>
      <CirclePlay className={ICON_CLASS} aria-hidden="true" />
      {tour.label}
    </ContextMenuItem>
  );
}

/**
 * A PTY-backed plugin kind's plugin settings, beside its tour on the same
 * terminal menus: the last of the plugin's own entries, with "Back up data…"
 * just before it as on the generic list.
 */
export function PluginOwnedMenuItems({
  pluginBackupId,
  pluginSettingsId,
  onAction,
}: {
  pluginBackupId: string | null;
  pluginSettingsId: string | null;
  onAction: MenuActionHandler;
}) {
  return (
    <>
      {pluginBackupId && (
        <ContextMenuItem onSelect={() => onAction("plugin-backup")}>
          <DatabaseBackup className={ICON_CLASS} aria-hidden="true" />
          Back up data…
        </ContextMenuItem>
      )}
      {pluginSettingsId && (
        <ContextMenuItem onSelect={() => onAction("plugin-settings")}>
          <Settings className={ICON_CLASS} aria-hidden="true" />
          Plugin settings…
        </ContextMenuItem>
      )}
    </>
  );
}

interface KindMenuItemsProps {
  /** The kind's tour and its plugin's own entries, drawn after Rename. */
  kindOwnedItems: React.ReactNode;
  isBackgrounded: boolean;
  onAction: MenuActionHandler;
}

const URL_PANEL_COPY = {
  browser: {
    reload: "Reload page",
    duplicate: "Duplicate browser",
    rename: "Rename browser",
    trash: "Trash browser",
    kill: "Remove browser",
    KillIcon: OctagonX,
  },
  "dev-preview": {
    reload: "Reload preview",
    duplicate: "Duplicate dev preview",
    rename: "Rename dev preview",
    trash: "Trash dev preview",
    kill: "Stop dev server",
    KillIcon: CircleStop,
  },
} as const;

/**
 * Browser and dev preview, one component for both so a dock group mixing the
 * two keeps the menu's rows mounted when its active tab switches kind.
 */
export function UrlPanelMenuItems({
  variant,
  kindOwnedItems,
  isBackgrounded,
  hasUrl,
  onAction,
}: KindMenuItemsProps & { variant: keyof typeof URL_PANEL_COPY; hasUrl: boolean }) {
  const copy = URL_PANEL_COPY[variant];
  return (
    <>
      <ContextMenuItem onSelect={() => onAction("reload-browser")}>
        <RotateCw className={ICON_CLASS} aria-hidden="true" />
        {copy.reload}
      </ContextMenuItem>
      <ContextMenuItem disabled={!hasUrl} onSelect={() => onAction("open-external")}>
        <Globe className={ICON_CLASS} aria-hidden="true" />
        Open in external browser
      </ContextMenuItem>
      <ContextMenuItem disabled={!hasUrl} onSelect={() => onAction("copy-url")}>
        <Copy className={ICON_CLASS} aria-hidden="true" />
        Copy URL
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => onAction("duplicate")}>
        <CopyPlus className={ICON_CLASS} aria-hidden="true" />
        {copy.duplicate}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onAction("rename")}>
        <Pencil className={ICON_CLASS} aria-hidden="true" />
        {copy.rename}
      </ContextMenuItem>
      {kindOwnedItems}
      <ContextMenuSeparator />
      {!isBackgrounded && (
        <ContextMenuItem onSelect={() => onAction("background")}>
          <ArrowDownFromLine className={ICON_CLASS} aria-hidden="true" />
          Send to background
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => onAction("trash")}>
        <Trash2 className={ICON_CLASS} aria-hidden="true" />
        {copy.trash}
      </ContextMenuItem>
      <ContextMenuItem destructive onSelect={() => onAction("kill")}>
        <copy.KillIcon className={ICON_CLASS} aria-hidden="true" />
        {copy.kill}
      </ContextMenuItem>
    </>
  );
}

export function ReviewMenuItems({ kindOwnedItems, isBackgrounded, onAction }: KindMenuItemsProps) {
  return (
    <>
      <ContextMenuItem onSelect={() => onAction("duplicate")}>
        <CopyPlus className={ICON_CLASS} aria-hidden="true" />
        Duplicate review
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onAction("rename")}>
        <Pencil className={ICON_CLASS} aria-hidden="true" />
        Rename review
      </ContextMenuItem>
      {kindOwnedItems}
      <ContextMenuSeparator />
      {!isBackgrounded && (
        <ContextMenuItem onSelect={() => onAction("background")}>
          <ArrowDownFromLine className={ICON_CLASS} aria-hidden="true" />
          Send to background
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => onAction("trash")}>
        <Trash2 className={ICON_CLASS} aria-hidden="true" />
        Trash review
      </ContextMenuItem>
      <ContextMenuItem destructive onSelect={() => onAction("kill")}>
        <OctagonX className={ICON_CLASS} aria-hidden="true" />
        Remove review
      </ContextMenuItem>
    </>
  );
}

/**
 * File, file browser, diff and non-PTY plugin kinds: the generic panel list,
 * which the header's overflow menu renders too (#12606).
 */
export function GenericPanelMenuItems({
  menuInput,
  renderMoveToWorktreeSubmenu,
  onAction,
}: {
  menuInput: GenericPanelMenuInput;
  renderMoveToWorktreeSubmenu: (label: string) => React.ReactNode;
  onAction: MenuActionHandler;
}) {
  return getGenericPanelMenuGroups(menuInput).map((group, groupIndex) => (
    <Fragment key={group[0]?.id ?? groupIndex}>
      {groupIndex > 0 && <ContextMenuSeparator />}
      {group.map((command) =>
        command.id === "move-to-worktree" ? (
          <Fragment key={command.id}>{renderMoveToWorktreeSubmenu(command.label)}</Fragment>
        ) : (
          <ContextMenuItem
            key={command.id}
            disabled={command.disabled}
            destructive={command.destructive}
            onSelect={() => onAction(command.id)}
            keybinding={command.shortcutActionId}
          >
            <command.icon className={ICON_CLASS} aria-hidden="true" />
            {command.label}
          </ContextMenuItem>
        )
      )}
    </Fragment>
  ));
}
