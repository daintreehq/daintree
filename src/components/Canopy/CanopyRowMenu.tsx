import type { ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { isMac } from "@/lib/platform";
import { canReplyTo } from "./CanopyCard";
import { itemArchived, type CanopyItem } from "./canopyModel";

export interface CanopyRowMenuActions {
  onOpen: (item: CanopyItem) => void;
  onReply: (item: CanopyItem) => void;
  onToggleRead: (item: CanopyItem) => void;
  onArchive: (item: CanopyItem) => void;
  /** Arm Trash for the run, for its pane to confirm. */
  onTrash: (item: CanopyItem) => void;
  /** The menu opened or closed: the list holds still while it is open. */
  onOpenChange: (open: boolean) => void;
}

/**
 * What can be done to one run, on a right-click, Shift+F10 or the Menu key on
 * its row. A convenience only: every item is also a key on the selected row,
 * shown beside it, and Archive and Trash are in the pane's own title bar.
 */
export function CanopyRowMenu({
  item,
  children,
  ...actions
}: CanopyRowMenuActions & { item: CanopyItem; children: ReactNode }) {
  const archived = itemArchived(item);
  const trashChord = isMac() ? "Meta+Backspace" : "Control+Backspace";
  return (
    <ContextMenu onOpenChange={actions.onOpenChange}>
      {/* Contents, so the trigger adds no box between the list and its rows. */}
      <ContextMenuTrigger asChild>
        <div className="contents">{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem aria-keyshortcuts="Enter" onSelect={() => actions.onOpen(item)}>
          Go to terminal
          <ContextMenuShortcut shortcut="Enter" />
        </ContextMenuItem>
        {canReplyTo(item) && (
          <ContextMenuItem aria-keyshortcuts="R" onSelect={() => actions.onReply(item)}>
            Reply
            <ContextMenuShortcut shortcut="R" />
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        {!archived && (
          <ContextMenuItem aria-keyshortcuts="U" onSelect={() => actions.onToggleRead(item)}>
            {item.unread ? "Mark as read" : "Mark as unread"}
            <ContextMenuShortcut shortcut="U" />
          </ContextMenuItem>
        )}
        <ContextMenuItem aria-keyshortcuts="E" onSelect={() => actions.onArchive(item)}>
          {archived ? "Move to inbox" : "Archive"}
          <ContextMenuShortcut shortcut="E" />
        </ContextMenuItem>
        <ContextMenuSeparator />
        {/* Arms Trash in the agent's pane, as its first press would; the
            second press there confirms it. */}
        <ContextMenuItem
          destructive
          aria-keyshortcuts={trashChord}
          onSelect={() => actions.onTrash(item)}
        >
          Trash terminal…
          <ContextMenuShortcut shortcut={trashChord} />
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
