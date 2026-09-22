import type { ComponentType } from "react";
import {
  ArrowDownFromLine,
  Maximize2,
  Minimize2,
  OctagonX,
  PanelBottomClose,
  PanelTopClose,
  Pencil,
  Trash2,
} from "lucide-react";
import { FolderGit2 } from "@/components/icons";
import type { ActionId } from "@shared/types/actions";
import { isBuiltInPanelKind, type PanelKind } from "@shared/types/panel";
import { panelKindHasPty, panelKindIsDockable } from "@shared/config/panelKindRegistry";

export type GenericPanelMenuCommandId =
  | "move-to-worktree"
  | "move-to-dock"
  | "move-to-grid"
  | "toggle-maximize"
  | "rename"
  | "background"
  | "trash"
  | "kill";

export interface GenericPanelMenuCommand {
  id: GenericPanelMenuCommandId;
  label: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  disabled?: boolean;
  destructive?: boolean;
}

export interface GenericPanelMenuInput {
  kind: PanelKind;
  location: "grid" | "dock";
  isMaximized: boolean;
  canMoveToWorktree: boolean;
}

/**
 * Kinds whose menus are the generic panel one: the non-PTY reading surfaces
 * (file, file browser, diff) and any plugin-contributed kind without a PTY.
 * Only built-ins and plugins register kinds, so a non-built-in kind is a
 * plugin's, and deciding by kind alone keeps a panel whose plugin has gone
 * missing on this menu. The PTY half is load-bearing: a plugin can contribute
 * a PTY-backed kind, and that is a genuine terminal (#11228).
 */
export function hasGenericPanelMenu(kind: PanelKind): boolean {
  if (kind === "file" || kind === "file-browser" || kind === "diff") return true;
  return !isBuiltInPanelKind(kind) && !panelKindHasPty(kind);
}

/**
 * The panel-level commands of the generic panel menu, in groups a separator
 * divides. The header's overflow menu and the right-click menu both render
 * this list, so the two cannot disagree on what a panel offers, in what order,
 * or under which name (#12606). Right-click extras that depend on where the
 * click landed are not panel commands and stay out of it.
 *
 * No Duplicate: none of these kinds has a duplicate recipe, and a Duplicate
 * that throws is worse than none.
 */
export function getGenericPanelMenuGroups({
  kind,
  location,
  isMaximized,
  canMoveToWorktree,
}: GenericPanelMenuInput): GenericPanelMenuCommand[][] {
  const layout: GenericPanelMenuCommand[] = [];
  if (canMoveToWorktree) {
    layout.push({ id: "move-to-worktree", label: "Move to worktree", icon: FolderGit2 });
  }
  if (location === "grid") {
    layout.push({
      id: "move-to-dock",
      label: "Move to dock",
      icon: PanelBottomClose,
      disabled: !panelKindIsDockable(kind),
    });
    layout.push(
      isMaximized
        ? { id: "toggle-maximize", label: "Restore", icon: Minimize2 }
        : { id: "toggle-maximize", label: "Maximize", icon: Maximize2 }
    );
  } else {
    layout.push({ id: "move-to-grid", label: "Move to grid", icon: PanelTopClose });
  }

  return [
    layout,
    [{ id: "rename", label: "Rename panel", icon: Pencil }],
    [
      { id: "background", label: "Send to background", icon: ArrowDownFromLine },
      { id: "trash", label: "Trash panel", icon: Trash2 },
      { id: "kill", label: "Remove panel", icon: OctagonX, destructive: true },
    ],
  ];
}

/**
 * The action each command dispatches for the panel it was opened on.
 * "move-to-worktree" has none of its own: it picks a destination first.
 */
export const GENERIC_PANEL_MENU_ACTION_IDS: Record<
  Exclude<GenericPanelMenuCommandId, "move-to-worktree">,
  ActionId
> = {
  "move-to-dock": "terminal.moveToDock",
  "move-to-grid": "terminal.moveToGrid",
  "toggle-maximize": "terminal.toggleMaximize",
  rename: "terminal.rename",
  background: "terminal.background",
  trash: "terminal.trash",
  kill: "terminal.kill",
};
