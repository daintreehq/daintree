import type React from "react";
import type { PanelLocation, WorktreeState } from "@/types";
import { getWorktreeHeadline } from "@/lib/worktreeHeadline";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import {
  ArrowDownFromLine,
  Maximize2,
  Minimize2,
  Move,
  PanelBottomClose,
  PanelTopClose,
  RotateCcw,
} from "lucide-react";
import { FolderGit2 } from "@/components/icons";
import { ICON_CLASS, type MenuActionHandler } from "./menuShared";

// Main, the pins and the most recent few: what a hover submenu is good for.
// Anything past that is found by searching the picker.
const MOVE_TO_WORKTREE_SUBMENU_LIMIT = 10;

export function MoveToWorktreeSubmenu({
  label,
  worktrees,
  currentWorktreeId,
  customTitles,
  onAction,
  onMoreWorktrees,
}: {
  label: string;
  worktrees: readonly WorktreeState[];
  currentWorktreeId: string | undefined;
  customTitles: Readonly<Record<string, string>>;
  onAction: MenuActionHandler;
  onMoreWorktrees: () => void;
}) {
  const submenuWorktrees = worktrees.slice(0, MOVE_TO_WORKTREE_SUBMENU_LIMIT);
  const hasMoreWorktrees = worktrees.length > submenuWorktrees.length;
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <FolderGit2 className={ICON_CLASS} />
        {label}
      </ContextMenuSubTrigger>
      {/* No search field in here: Radix's typeahead claims printable keys
          inside a submenu, so finding a worktree past the cap is the
          picker's job. */}
      <ContextMenuSubContent>
        {submenuWorktrees.map((wt) => {
          const isCurrent = wt.id === currentWorktreeId;
          return (
            <ContextMenuItem
              key={wt.id}
              disabled={isCurrent}
              onSelect={() => onAction(`move-to-worktree:${wt.id}`)}
            >
              <FolderGit2 className={ICON_CLASS} />
              {getWorktreeHeadline(wt, customTitles[wt.id]).label}
            </ContextMenuItem>
          );
        })}
        {hasMoreWorktrees && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem aria-haspopup="dialog" onSelect={onMoreWorktrees}>
              <FolderGit2 className={ICON_CLASS} />
              More worktrees…
            </ContextMenuItem>
          </>
        )}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

function MoveToNewWorktreeItem({ onSelect }: { onSelect: () => void }) {
  return (
    <ContextMenuItem onSelect={onSelect}>
      <FolderGit2 className={ICON_CLASS} />
      Move to new worktree…
    </ContextMenuItem>
  );
}

function RestoreFromBackgroundItem({ onAction }: { onAction: MenuActionHandler }) {
  return (
    <ContextMenuItem onSelect={() => onAction("restore-from-background")}>
      <RotateCcw className={ICON_CLASS} aria-hidden="true" />
      Restore from background
    </ContextMenuItem>
  );
}

function DockOrGridItem({
  currentLocation,
  isDockable,
  onAction,
}: {
  currentLocation: PanelLocation;
  isDockable: boolean;
  onAction: MenuActionHandler;
}) {
  return (
    <ContextMenuItem
      // Move-to-grid is always safe; move-to-dock only for kinds the dock
      // renders (PTY + dockable non-PTY like file panels).
      disabled={currentLocation === "grid" && !isDockable}
      onSelect={() => onAction(currentLocation === "grid" ? "move-to-dock" : "move-to-grid")}
    >
      {currentLocation === "grid" ? (
        <PanelBottomClose className={ICON_CLASS} />
      ) : (
        <PanelTopClose className={ICON_CLASS} />
      )}
      {currentLocation === "grid" ? "Move to dock" : "Move to grid"}
    </ContextMenuItem>
  );
}

function MaximizeItem({
  isMaximized,
  onAction,
}: {
  isMaximized: boolean;
  onAction: MenuActionHandler;
}) {
  return (
    <ContextMenuItem onSelect={() => onAction("toggle-maximize")} keybinding="terminal.maximize">
      {isMaximized ? (
        <Minimize2 className={ICON_CLASS} aria-hidden="true" />
      ) : (
        <Maximize2 className={ICON_CLASS} aria-hidden="true" />
      )}
      {isMaximized ? "Restore" : "Maximize"}
    </ContextMenuItem>
  );
}

interface LayoutMenuItemsProps {
  /** Present only when the panel has somewhere else to move to. */
  moveToWorktreeSubmenu: React.ReactNode;
  canMoveToNewWorktree: boolean;
  isBackgrounded: boolean;
  currentLocation: PanelLocation;
  isDockable: boolean;
  isInActiveWorktree: boolean;
  isMaximized: boolean;
  onMoveToNewWorktree: () => void;
  onAction: MenuActionHandler;
}

/** Where the panel lives: worktree, dock or grid, and maximize. */
export function LayoutMenuItems({
  moveToWorktreeSubmenu,
  canMoveToNewWorktree,
  isBackgrounded,
  currentLocation,
  isDockable,
  isInActiveWorktree,
  isMaximized,
  onMoveToNewWorktree,
  onAction,
}: LayoutMenuItemsProps) {
  return (
    <>
      {moveToWorktreeSubmenu}
      {canMoveToNewWorktree && <MoveToNewWorktreeItem onSelect={onMoveToNewWorktree} />}
      {isBackgrounded ? (
        <RestoreFromBackgroundItem onAction={onAction} />
      ) : (
        <DockOrGridItem
          currentLocation={currentLocation}
          isDockable={isDockable}
          onAction={onAction}
        />
      )}
      {currentLocation === "grid" && isInActiveWorktree && (
        <MaximizeItem isMaximized={isMaximized} onAction={onAction} />
      )}
    </>
  );
}

/**
 * The terminal menu's layout group: the moves, background included, behind one
 * Move submenu, and Maximize left a click away. A backgrounded terminal has
 * one way back and nowhere else to go, so its Restore stays inline.
 */
export function TerminalLayoutMenuItems({
  moveToWorktreeSubmenu,
  canMoveToNewWorktree,
  isBackgrounded,
  currentLocation,
  isDockable,
  isInActiveWorktree,
  isMaximized,
  onMoveToNewWorktree,
  onAction,
}: LayoutMenuItemsProps) {
  return (
    <>
      {isBackgrounded ? (
        <RestoreFromBackgroundItem onAction={onAction} />
      ) : (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Move className={ICON_CLASS} aria-hidden="true" />
            Move
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {moveToWorktreeSubmenu}
            {canMoveToNewWorktree && <MoveToNewWorktreeItem onSelect={onMoveToNewWorktree} />}
            <DockOrGridItem
              currentLocation={currentLocation}
              isDockable={isDockable}
              onAction={onAction}
            />
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onAction("background")}>
              <ArrowDownFromLine className={ICON_CLASS} aria-hidden="true" />
              Send to background
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {currentLocation === "grid" && isInActiveWorktree && (
        <MaximizeItem isMaximized={isMaximized} onAction={onAction} />
      )}
    </>
  );
}
