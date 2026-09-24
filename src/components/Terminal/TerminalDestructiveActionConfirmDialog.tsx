import { type ReactElement, type ReactNode, useCallback } from "react";
import { FolderX, GitBranch } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { STATE_COLORS, STATE_ICONS } from "@/components/Worktree/terminalStateConfig";
import { TRASH_TTL_SECONDS } from "@/components/Layout/trashCountdown";
import { actionService } from "@/services/ActionService";
import type { ActionSource } from "@shared/types/actions";
import { closeAndAnnounce } from "@/lib/accessibility";
import { cn } from "@/lib/utils";
import { usePanelStore } from "@/store/panelStore";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import {
  useTerminalPendingDestructiveActionStore,
  type DestructivePreviewGroup,
  type TerminalPendingDestructiveActionSnapshot,
} from "@/store/terminalPendingDestructiveActionStore";

export interface DestructiveConfirmCopy {
  title: string;
  /**
   * The live-work consequence, present only when an agent is working. It leads
   * the body at full weight because it is the one fact a practised reader must
   * not skim past; everything else is the standing consequence of the verb.
   */
  lead?: string;
  description: string;
  /**
   * An alternative to the action, shown after the preview and kept out of the
   * accessible description: it is advice, not a consequence.
   */
  note?: string;
  confirmLabel: string;
}

function quoted(name: string | undefined, fallback: string): string {
  const trimmed = name?.trim();
  return trimmed ? `'${trimmed}'` : fallback;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

function workingLead(count: number, outcome: string): string | undefined {
  if (count <= 0) return undefined;
  return count === 1
    ? `1 agent is working and ${outcome}.`
    : `${count} agents are working and ${outcome}.`;
}

/**
 * Shared with TerminalContextMenu's local kill/restart dialogs so the copies
 * can't drift.
 */
export function buildKillRunningAgentCopy(terminalTitle?: string): DestructiveConfirmCopy {
  return {
    title: `Kill ${quoted(terminalTitle, "terminal")}?`,
    lead: "Its agent is working and will be stopped.",
    description: "The process ends and its scrollback is discarded.",
    confirmLabel: "Kill terminal",
  };
}

export function buildRestartRunningAgentCopy(terminalTitle?: string): DestructiveConfirmCopy {
  return {
    title: `Restart ${quoted(terminalTitle, "terminal")}?`,
    lead: "Its agent is working and will be interrupted.",
    description: "The process respawns and its scrollback is discarded.",
    confirmLabel: "Restart terminal",
  };
}

/**
 * Trashing does not end a process: the PTY keeps running in Recently closed
 * for the trash TTL and is only killed if nobody restores it. The copy has to
 * say so, or a recoverable close reads exactly as final as a kill. The
 * non-breaking space keeps the window from splitting across a line.
 */
function recentlyClosedSentence(count: number): string {
  const ttl = `${TRASH_TTL_SECONDS}\u00a0seconds`;
  return count === 1
    ? `It moves to Recently closed and keeps running for ${ttl}. Restore it before then, or its process ends.`
    : `They move to Recently closed and keep running for ${ttl}. Restore them before then, or their processes end.`;
}

function buildCopy(pending: TerminalPendingDestructiveActionSnapshot): DestructiveConfirmCopy {
  const count = pending.targetCount;
  const worktree = quoted(pending.worktreeTitle, "this worktree");
  switch (pending.kind) {
    case "kill":
      return buildKillRunningAgentCopy(pending.terminalTitle);
    case "restart":
      return buildRestartRunningAgentCopy(pending.terminalTitle);
    case "killAll": {
      const noun = plural(count, "terminal");
      return {
        title: `Kill ${count} ${noun}?`,
        lead: workingLead(pending.runningAgentCount, "will be stopped"),
        description:
          count === 1
            ? "The process ends and its scrollback is discarded."
            : "Every terminal's process ends and its scrollback is discarded.",
        confirmLabel: `Kill ${count} ${noun}`,
      };
    }
    case "restartAll": {
      const noun = plural(count, "terminal");
      return {
        title: `Restart ${count} ${noun}?`,
        lead: workingLead(pending.runningAgentCount, "will be interrupted"),
        description:
          count === 1
            ? "The process respawns and its scrollback is discarded."
            : "Every terminal respawns and its scrollback is discarded.",
        confirmLabel: `Restart ${count} ${noun}`,
      };
    }
    case "worktreeRestartAll": {
      const noun = plural(count, "session");
      return {
        title: `Restart ${count} ${noun} in ${worktree}?`,
        lead: workingLead(pending.runningAgentCount, "will be interrupted"),
        description:
          count === 1
            ? "The session respawns and its scrollback is discarded."
            : "Every session respawns and its scrollback is discarded.",
        confirmLabel: `Restart ${count} ${noun}`,
      };
    }
    case "worktreeTrashAll": {
      const noun = plural(count, "session");
      return {
        title: `Trash ${count} ${noun} in ${worktree}?`,
        lead: workingLead(pending.runningAgentCount, "will stop unless restored"),
        description: recentlyClosedSentence(count),
        confirmLabel: `Trash ${count} ${noun}`,
      };
    }
    case "worktreeEndAll": {
      const noun = plural(count, "session");
      return {
        title: `End ${count} ${noun} in ${worktree}?`,
        lead: workingLead(pending.runningAgentCount, "will be stopped"),
        description:
          count === 1
            ? "The session is removed outright and its scrollback is discarded. Unlike trashing, it can't be restored."
            : "The sessions are removed outright and their scrollback is discarded. Unlike trashing, they can't be restored.",
        confirmLabel: `End ${count} ${noun}`,
      };
    }
    case "worktreeClearHistory": {
      // No live panels are touched, so `targetCount`/`runningAgentCount` are 0
      // and the copy deliberately says nothing about a session count.
      return {
        title: `Clear session history for ${worktree}?`,
        description:
          "Permanently deletes the records of this worktree's closed sessions, so they no longer appear when you resume an agent. Open and bookmarked sessions are kept.",
        confirmLabel: "Clear session history",
      };
    }
    case "deletedWorktreeDismiss": {
      const noun = plural(count, "terminal");
      return {
        title: `Close ${count} ${noun} from ${worktree}?`,
        lead: workingLead(pending.runningAgentCount, "will stop unless restored"),
        description: recentlyClosedSentence(count),
        note:
          count === 1
            ? "To keep it open, cancel and drag it to another worktree."
            : "To keep one open, cancel and drag it to another worktree.",
        confirmLabel: `Close ${count} ${noun}`,
      };
    }
    case "deletedWorktreeGroupDismiss": {
      const worktreeCount = pending.preview?.length ?? 0;
      // A member whose terminals all left is dropped from the preview, so the
      // group can be clearing a single worktree even though it holds several.
      const worktreeNoun = plural(worktreeCount, "deleted worktree");
      const noun = plural(count, "terminal");
      return {
        title: `Close ${count} ${noun} from ${worktreeCount} ${worktreeNoun}?`,
        lead: workingLead(pending.runningAgentCount, "will stop unless restored"),
        description: recentlyClosedSentence(count),
        note:
          count === 1
            ? "To keep it open, cancel and drag it to another worktree."
            : "To keep one open, cancel and drag it to another worktree.",
        confirmLabel: `Close ${count} ${noun}`,
      };
    }
  }
}

/**
 * The body of a destructive confirm: the working-agent consequence first, at
 * full weight, then the standing consequence of the verb. One element, so the
 * dialog's `aria-describedby` reads both and nothing else.
 */
export function DestructiveConsequence({
  copy,
}: {
  copy: Pick<DestructiveConfirmCopy, "lead" | "description">;
}): ReactNode {
  if (!copy.lead) return copy.description;
  return (
    <>
      <span className="block font-medium text-text-primary">{copy.lead}</span>
      <span className="mt-1 block">{copy.description}</span>
    </>
  );
}

/** Kinds whose title already names the one worktree the preview covers. */
const TITLE_NAMES_WORKTREE = new Set<TerminalPendingDestructiveActionSnapshot["kind"]>([
  "worktreeRestartAll",
  "worktreeTrashAll",
  "worktreeEndAll",
  "deletedWorktreeDismiss",
]);

function shouldShowPreview(pending: TerminalPendingDestructiveActionSnapshot): boolean {
  return (
    pending.kind !== "kill" &&
    pending.kind !== "restart" &&
    pending.kind !== "worktreeClearHistory" &&
    (pending.preview?.length ?? 0) > 0
  );
}

const WorkingIcon = STATE_ICONS.working;

/**
 * The terminals the action will touch, grouped by worktree, with the working
 * ones marked in the app's own agent-state vocabulary. A count says how much;
 * this says which, and which of them hold live work (#7880).
 */
function TargetPreview({
  groups,
  showGroupTitles,
  deletedWorktrees,
}: {
  groups: DestructivePreviewGroup[];
  showGroupTitles: boolean;
  deletedWorktrees: boolean;
}) {
  const panelsById = usePanelStore((s) => s.panelsById);
  const GroupIcon = deletedWorktrees ? FolderX : GitBranch;
  return (
    <div
      // No scroller of its own: a long list grows the dialog body, which already
      // scrolls with edge shadows, so an overflowing target is never clipped
      // out of sight inside a nested box.
      className="divide-y divide-divider rounded-[var(--radius-md)] border border-divider bg-surface-canvas/40"
      data-testid="destructive-confirm-preview"
    >
      {groups.map((group) => (
        <div key={group.worktreeId || "__none"} className="px-3 py-2">
          {showGroupTitles && (
            <div className="mb-1.5 flex min-w-0 items-start gap-1.5 text-xs text-text-secondary">
              <GroupIcon className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="min-w-0 font-mono [overflow-wrap:anywhere]">
                {group.worktreeTitle}
              </span>
            </div>
          )}
          <ul
            className="space-y-1"
            aria-label={showGroupTitles ? group.worktreeTitle : "Affected terminals"}
          >
            {group.terminals.map((terminal) => {
              const panel = panelsById[terminal.terminalId];
              return (
                <li
                  key={terminal.terminalId}
                  className="flex min-w-0 items-center gap-2 text-sm text-text-primary"
                >
                  <TerminalIcon
                    chrome={panel ? deriveTerminalChrome(panel) : undefined}
                    className="h-3.5 w-3.5 shrink-0"
                  />
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                    {terminal.terminalTitle.trim() || "Untitled terminal"}
                  </span>
                  {terminal.hasRunningAgent && (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-text-secondary">
                      <WorkingIcon
                        className={cn("h-3 w-3", STATE_COLORS.working)}
                        aria-hidden="true"
                      />
                      Working
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * App-level confirm-dialog host for terminal destructive actions dispatched
 * outside a component that owns its own dialog (keybindings, the action
 * palette, bulk surfaces). Subscribes to the terminal-pending action store
 * and re-dispatches the matching action with `{ confirmed: true }` on
 * confirm. Single-terminal kill/restart from the context menu use a local
 * dialog in `TerminalContextMenu` and bypass this host.
 */
export function TerminalDestructiveActionConfirmDialog(): ReactElement | null {
  const pending = useTerminalPendingDestructiveActionStore((s) => s.pending);
  const clear = useTerminalPendingDestructiveActionStore((s) => s.clear);

  const handleConfirm = useCallback(() => {
    if (pending === null) return;
    // Answer in the voice the action arrived in: a keybinding-raised confirm
    // must not be read back as a pointer dispatch, or the shortcut hint teaches
    // the combo the user just pressed.
    const source: ActionSource = pending.dispatchSource === "keybinding" ? "keybinding" : "user";
    let announcement: string | null = null;
    switch (pending.kind) {
      case "kill":
        // Defensive: refuse to dispatch when the snapshot lost the target.
        // Without this guard, `terminal.kill` would fall back to
        // `focusedId`, which may have changed since the dialog opened.
        if (!pending.terminalId) break;
        void actionService.dispatch(
          "terminal.kill",
          { terminalId: pending.terminalId, confirmed: true },
          { source }
        );
        announcement = "Terminal killed";
        break;
      case "restart":
        if (!pending.terminalId) break;
        void actionService.dispatch(
          "terminal.restart",
          { terminalId: pending.terminalId, confirmed: true },
          { source }
        );
        announcement = "Terminal restarted";
        break;
      case "killAll": {
        void actionService.dispatch("terminal.killAll", { confirmed: true }, { source });
        const noun = pending.targetCount === 1 ? "terminal" : "terminals";
        announcement = `Killed ${pending.targetCount} ${noun}`;
        break;
      }
      case "restartAll": {
        void actionService.dispatch("terminal.restartAll", { confirmed: true }, { source });
        const noun = pending.targetCount === 1 ? "terminal" : "terminals";
        announcement = `Restarted ${pending.targetCount} ${noun}`;
        break;
      }
      case "worktreeRestartAll": {
        if (!pending.worktreeId) break;
        void actionService.dispatch(
          "worktree.sessions.restartAll",
          { worktreeId: pending.worktreeId, confirmed: true },
          { source }
        );
        const noun = pending.targetCount === 1 ? "session" : "sessions";
        announcement = `Restarted ${pending.targetCount} ${noun}`;
        break;
      }
      case "worktreeTrashAll": {
        if (!pending.worktreeId) break;
        void actionService.dispatch(
          "worktree.sessions.trashAll",
          { worktreeId: pending.worktreeId, confirmed: true },
          { source }
        );
        const noun = pending.targetCount === 1 ? "session" : "sessions";
        announcement = `Trashed ${pending.targetCount} ${noun}`;
        break;
      }
      case "worktreeEndAll": {
        if (!pending.worktreeId) break;
        void actionService.dispatch(
          "worktree.sessions.endAll",
          { worktreeId: pending.worktreeId, confirmed: true },
          { source }
        );
        const noun = pending.targetCount === 1 ? "session" : "sessions";
        announcement = `Ended ${pending.targetCount} ${noun}`;
        break;
      }
      case "worktreeClearHistory": {
        if (!pending.worktreeId) break;
        void actionService.dispatch(
          "worktree.sessions.clearHistory",
          { worktreeId: pending.worktreeId, confirmed: true },
          { source }
        );
        announcement = "Cleared session history";
        break;
      }
      case "deletedWorktreeDismiss": {
        if (!pending.worktreeId) break;
        // Same executor as `worktreeTrashAll` — the panels still carry the
        // dead worktree's id, so the worktree-scoped trash reaches exactly
        // the deleted-worktree row's terminals. Trashing the last one prunes the worktree
        // row itself, so there is nothing else to clean up here (#11232).
        void actionService.dispatch(
          "worktree.sessions.trashAll",
          { worktreeId: pending.worktreeId, confirmed: true },
          { source }
        );
        const noun = pending.targetCount === 1 ? "terminal" : "terminals";
        announcement = `Closed ${pending.targetCount} ${noun}`;
        break;
      }
      case "deletedWorktreeGroupDismiss": {
        if (!pending.preview || pending.preview.length === 0) break;
        // Fans the single-row executor over each previewed worktree rather than
        // introducing a multi-worktree one: `worktree.sessions.trashAll`
        // re-derives its targets, so a terminal rescued while the dialog was
        // open is simply no longer there. Nothing unpreviewed can appear in the
        // meantime either — a deleted row never accepts drops (it deliberately
        // omits `SortableWorktreeCard`), so the live set is always a subset of
        // what the user just confirmed.
        for (const entry of pending.preview) {
          void actionService.dispatch(
            "worktree.sessions.trashAll",
            { worktreeId: entry.worktreeId, confirmed: true },
            { source }
          );
        }
        const noun = pending.targetCount === 1 ? "terminal" : "terminals";
        announcement = `Closed ${pending.targetCount} ${noun}`;
        break;
      }
    }
    if (announcement) {
      closeAndAnnounce(clear, announcement);
    } else {
      clear();
    }
  }, [pending, clear]);

  if (pending === null) return null;

  const copy = buildCopy(pending);
  const showPreview = shouldShowPreview(pending);
  const isDeleted =
    pending.kind === "deletedWorktreeDismiss" || pending.kind === "deletedWorktreeGroupDismiss";

  return (
    <ConfirmDialog
      isOpen
      onClose={clear}
      title={copy.title}
      description={<DestructiveConsequence copy={copy} />}
      confirmLabel={copy.confirmLabel}
      variant="destructive"
      // A scrollable preview list makes AppDialog expose a plain dialog
      // rather than an alertdialog, per the APG.
      hasPreview={showPreview}
      onConfirm={handleConfirm}
    >
      {showPreview && pending.preview && (
        <TargetPreview
          groups={pending.preview}
          showGroupTitles={pending.preview.length > 1 || !TITLE_NAMES_WORKTREE.has(pending.kind)}
          deletedWorktrees={isDeleted}
        />
      )}
      {copy.note && <p className="text-sm text-text-secondary">{copy.note}</p>}
    </ConfirmDialog>
  );
}
