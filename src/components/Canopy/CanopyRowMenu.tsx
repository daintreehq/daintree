import { useRef, type ReactNode } from "react";
import {
  AGENT_SNOOZE_DURATION_OPTIONS,
  AGENT_SNOOZE_LABEL,
  type AgentSnoozeDurationOption,
} from "@shared/utils/agentSnoozeDurations";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { isMac } from "@/lib/platform";
import { isNewWindowClick } from "@/components/Hosts/hostSwitching";
import { canReplyTo } from "./CanopyCard";
import { useCanopyFrame } from "./canopyFrame";
import { itemArchived, type CanopyItem } from "./canopyModel";

/** Setting a run aside, on the window's own host: Pilot's park and snooze. */
export interface CanopyAsideActions {
  /** Only a run on the window's own host can be set aside from here. */
  canSetAside: (item: CanopyItem) => boolean;
  /** Open the park editor, for a new park or an edit of the one the run has. */
  onPark: (item: CanopyItem) => void;
  onUnpark: (item: CanopyItem) => void;
  onSnooze: (item: CanopyItem, option: AgentSnoozeDurationOption) => void;
  /** Lift the run's snooze. */
  onWake: (item: CanopyItem) => void;
}

/** The Decisions answers a run holds that need a person: this computer's only. */
export interface CanopyAnswerActions {
  /** The run has answers needing attention, and they are this computer's to review. */
  canReviewAnswers: (item: CanopyItem) => boolean;
  /** Open the list of answers needing attention at this run's. */
  onReviewAnswers: (item: CanopyItem) => void;
}

export interface CanopyRowMenuActions extends CanopyAsideActions, CanopyAnswerActions {
  /** `newWindow`: Cmd/Ctrl held, so another host's run opens in a new window. */
  onOpen: (item: CanopyItem, newWindow?: boolean) => void;
  onReply: (item: CanopyItem) => void;
  onToggleRead: (item: CanopyItem) => void;
  /** Read the run's screen again, words included: for a reading that looks wrong. */
  onReread: (item: CanopyItem) => void;
  onArchive: (item: CanopyItem) => void;
  /** Rename the run's terminal, in its title bar. */
  onRename: (item: CanopyItem) => void;
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
  const canGoTo = useCanopyFrame().goToRun !== null;
  const archived = itemArchived(item);
  const canSetAside = actions.canSetAside(item);
  const parked = item.row.run.park !== undefined;
  const snoozed = item.row.run.snooze !== undefined;
  const trashChord = isMac() ? "Meta+Backspace" : "Control+Backspace";
  // Rename and Reply send focus into the pane on purpose — the run's name
  // field, or its composer: the menu closing must not hand it back to the row
  // it was opened from, which would end the rename and select that row again.
  const focusMovedRef = useRef(false);
  // The list of answers and the Park dialog open once the menu has handed the
  // keyboard back to the row, so the row is what their close returns to;
  // opened any sooner, the menu's own close would take the keyboard from them.
  // Trash focuses its row itself, which the menu's hand-back would undo by
  // selecting the row it was opened from, and the arm with it.
  const afterCloseRef = useRef<{ act: () => void; ownsFocus: boolean } | null>(null);
  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) afterCloseRef.current = null;
        actions.onOpenChange(open);
      }}
    >
      {/* Contents, so the trigger adds no box between the list and its rows. */}
      <ContextMenuTrigger asChild>
        <div className="contents">{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={(event) => {
          const after = afterCloseRef.current;
          afterCloseRef.current = null;
          if (after?.ownsFocus) {
            event.preventDefault();
            after.act();
            return;
          }
          if (after) requestAnimationFrame(after.act);
          if (!focusMovedRef.current) return;
          focusMovedRef.current = false;
          event.preventDefault();
        }}
      >
        {/* The reason the run sits with what needs the user, and what deals
            with it, ahead of everything else the run offers. */}
        {actions.canReviewAnswers(item) && (
          <ContextMenuItem
            onSelect={() => {
              afterCloseRef.current = {
                act: () => actions.onReviewAnswers(item),
                ownsFocus: false,
              };
            }}
          >
            Review answers…
          </ContextMenuItem>
        )}
        {/* On click rather than select, so a Cmd/Ctrl-click keeps its modifier;
            a key select clicks too, with none held. */}
        {canGoTo && (
          <ContextMenuItem
            aria-keyshortcuts="Enter"
            onClick={(event) => actions.onOpen(item, isNewWindowClick(event))}
          >
            Go to terminal
            <ContextMenuShortcut shortcut="Enter" />
          </ContextMenuItem>
        )}
        {canReplyTo(item) && (
          <ContextMenuItem
            aria-keyshortcuts="R"
            onSelect={() => {
              focusMovedRef.current = true;
              actions.onReply(item);
            }}
          >
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
        {!archived && (
          <ContextMenuItem onSelect={() => actions.onReread(item)}>Read again</ContextMenuItem>
        )}
        <ContextMenuItem aria-keyshortcuts="E" onSelect={() => actions.onArchive(item)}>
          {archived ? "Move to inbox" : "Archive"}
          <ContextMenuShortcut shortcut="E" />
        </ContextMenuItem>
        <ContextMenuItem
          aria-keyshortcuts="F2"
          onSelect={() => {
            focusMovedRef.current = true;
            actions.onRename(item);
          }}
        >
          Rename…
          <ContextMenuShortcut shortcut="F2" />
        </ContextMenuItem>
        {canSetAside && (
          <>
            <ContextMenuItem
              onSelect={() => {
                afterCloseRef.current = { act: () => actions.onPark(item), ownsFocus: false };
              }}
            >
              Park…
            </ContextMenuItem>
            {parked && (
              <ContextMenuItem onSelect={() => actions.onUnpark(item)}>Unpark</ContextMenuItem>
            )}
            <ContextMenuSub>
              <ContextMenuSubTrigger>Snooze…</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {AGENT_SNOOZE_DURATION_OPTIONS.map((option) => (
                  <ContextMenuItem key={option} onSelect={() => actions.onSnooze(item, option)}>
                    {AGENT_SNOOZE_LABEL[option]}
                  </ContextMenuItem>
                ))}
                {snoozed && (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => actions.onWake(item)}>
                      Wake now
                    </ContextMenuItem>
                  </>
                )}
              </ContextMenuSubContent>
            </ContextMenuSub>
          </>
        )}
        <ContextMenuSeparator />
        {/* Arms Trash in the agent's pane, as its first press would; the
            second press there confirms it. */}
        <ContextMenuItem
          destructive
          aria-keyshortcuts={trashChord}
          onSelect={() => {
            afterCloseRef.current = { act: () => actions.onTrash(item), ownsFocus: true };
          }}
        >
          Trash terminal…
          <ContextMenuShortcut shortcut={trashChord} />
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
