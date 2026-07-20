import { type ReactElement, useCallback } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { actionService } from "@/services/ActionService";
import { closeAndAnnounce } from "@/lib/accessibility";
import {
  useTerminalPendingDestructiveActionStore,
  type DeletedWorktreeGroupPreviewWorktree,
  type TerminalPendingDestructiveActionSnapshot,
} from "@/store/terminalPendingDestructiveActionStore";

interface DialogCopy {
  title: string;
  description: string;
  confirmLabel: string;
}

// Shared with TerminalContextMenu's local kill dialog so the two copies can't drift.
export const KILL_RUNNING_AGENT_DIALOG_COPY: DialogCopy = {
  title: "Kill terminal with running agent?",
  description:
    "An agent is mid-work in this terminal. Killing it stops the agent and discards its scrollback. The terminal process and any unsaved output will be lost.",
  confirmLabel: "Kill terminal",
};

function buildCopy(pending: TerminalPendingDestructiveActionSnapshot): DialogCopy {
  switch (pending.kind) {
    case "kill":
      return KILL_RUNNING_AGENT_DIALOG_COPY;
    case "restart":
      return {
        title: "Restart terminal with running agent?",
        description:
          "An agent is mid-work in this terminal. Restarting respawns the process and discards its scrollback. The current agent session will be interrupted.",
        confirmLabel: "Restart terminal",
      };
    case "killAll": {
      const noun = pending.targetCount === 1 ? "terminal" : "terminals";
      const agentNote =
        pending.runningAgentCount === 1
          ? "1 has a running agent."
          : `${pending.runningAgentCount} have running agents.`;
      return {
        title: `Kill ${pending.targetCount} ${noun}?`,
        description: `Killing every user-facing terminal stops their processes and discards scrollback. ${agentNote} Active work and unsaved output will be lost.`,
        confirmLabel: `Kill ${pending.targetCount} ${noun}`,
      };
    }
    case "restartAll": {
      const noun = pending.targetCount === 1 ? "terminal" : "terminals";
      const agentNote =
        pending.runningAgentCount === 1
          ? "1 has a running agent."
          : `${pending.runningAgentCount} have running agents.`;
      return {
        title: `Restart ${pending.targetCount} ${noun}?`,
        description: `Restarting respawns every active terminal and discards scrollback. ${agentNote} Active agent work will be interrupted.`,
        confirmLabel: `Restart ${pending.targetCount} ${noun}`,
      };
    }
    case "worktreeRestartAll": {
      const noun = pending.targetCount === 1 ? "session" : "sessions";
      const agentNote =
        pending.runningAgentCount === 1
          ? "1 has a running agent."
          : `${pending.runningAgentCount} have running agents.`;
      return {
        title: `Restart ${pending.targetCount} ${noun} in this worktree?`,
        description: `Restarting respawns every active session in the worktree and discards scrollback. ${agentNote} Active agent work will be interrupted.`,
        confirmLabel: `Restart ${pending.targetCount} ${noun}`,
      };
    }
    case "worktreeTrashAll": {
      const noun = pending.targetCount === 1 ? "session" : "sessions";
      const agentNote =
        pending.runningAgentCount === 0
          ? ""
          : pending.runningAgentCount === 1
            ? " 1 has a running agent."
            : ` ${pending.runningAgentCount} have running agents.`;
      return {
        title: `Trash ${pending.targetCount} ${noun} in this worktree?`,
        description: `Every active session in the worktree moves to trash. Running processes and unsaved scrollback will be lost. Sessions can be restored from trash before garbage collection.${agentNote}`,
        confirmLabel: `Trash ${pending.targetCount} ${noun}`,
      };
    }
    case "deletedWorktreeDismiss": {
      const noun = pending.targetCount === 1 ? "terminal" : "terminals";
      const agentNote =
        pending.runningAgentCount === 0
          ? ""
          : pending.runningAgentCount === 1
            ? " 1 still has a running agent."
            : ` ${pending.runningAgentCount} still have running agents.`;
      return {
        title: `Close ${pending.targetCount} ${noun}?`,
        description: `These terminals outlived their deleted worktree. Closing them moves them to trash and ends their running processes; they can be restored from trash before garbage collection. Drag them to another worktree instead to keep them.${agentNote}`,
        confirmLabel: `Close ${pending.targetCount} ${noun}`,
      };
    }
    case "deletedWorktreeGroupDismiss": {
      const worktreeCount = pending.preview?.length ?? 0;
      const noun = pending.targetCount === 1 ? "terminal" : "terminals";
      const agentNote =
        pending.runningAgentCount === 0
          ? ""
          : pending.runningAgentCount === 1
            ? " 1 still has a running agent."
            : ` ${pending.runningAgentCount} still have running agents.`;
      return {
        title: `Close ${pending.targetCount} ${noun} from ${worktreeCount} deleted worktrees?`,
        description: `These terminals outlived the worktrees they belonged to. Closing them moves them to trash and ends their running processes; they can be restored from trash before garbage collection. Drag them to another worktree instead to keep them.${agentNote}`,
        confirmLabel: `Close ${pending.targetCount} ${noun}`,
      };
    }
  }
}

/**
 * D2 preview: a bulk clear spanning several worktrees is the one case where a
 * count tells the user nothing about what they're losing, so the dialog lists
 * the actual terminals it will trash, grouped under the worktree each came
 * from (#7880).
 */
function GroupDismissPreview({ preview }: { preview: DeletedWorktreeGroupPreviewWorktree[] }) {
  return (
    <ul className="mt-3 max-h-56 space-y-3 overflow-y-auto rounded border border-border-default bg-overlay-subtle p-3">
      {preview.map((entry) => (
        <li key={entry.worktreeId}>
          <span className="block truncate font-mono text-[11px] font-medium text-text-secondary">
            {entry.worktreeTitle}
          </span>
          <ul className="mt-1 space-y-0.5">
            {entry.terminals.map((terminal) => (
              <li
                key={terminal.terminalId}
                className="flex items-center gap-1.5 truncate text-xs text-text-muted"
              >
                <span className="truncate">{terminal.terminalTitle}</span>
                {terminal.hasRunningAgent && (
                  <span className="shrink-0 rounded-full bg-overlay-soft px-1.5 py-0.5 text-[10px] text-text-muted">
                    Running
                  </span>
                )}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
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
          { source: "user" }
        );
        announcement = "Terminal killed";
        break;
      case "restart":
        if (!pending.terminalId) break;
        void actionService.dispatch(
          "terminal.restart",
          { terminalId: pending.terminalId, confirmed: true },
          { source: "user" }
        );
        announcement = "Terminal restarted";
        break;
      case "killAll": {
        void actionService.dispatch("terminal.killAll", { confirmed: true }, { source: "user" });
        const noun = pending.targetCount === 1 ? "terminal" : "terminals";
        announcement = `Killed ${pending.targetCount} ${noun}`;
        break;
      }
      case "restartAll": {
        void actionService.dispatch("terminal.restartAll", { confirmed: true }, { source: "user" });
        const noun = pending.targetCount === 1 ? "terminal" : "terminals";
        announcement = `Restarted ${pending.targetCount} ${noun}`;
        break;
      }
      case "worktreeRestartAll": {
        if (!pending.worktreeId) break;
        void actionService.dispatch(
          "worktree.sessions.restartAll",
          { worktreeId: pending.worktreeId, confirmed: true },
          { source: "user" }
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
          { source: "user" }
        );
        const noun = pending.targetCount === 1 ? "session" : "sessions";
        announcement = `Trashed ${pending.targetCount} ${noun}`;
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
          { source: "user" }
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
            { source: "user" }
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

  return (
    <ConfirmDialog
      isOpen
      onClose={clear}
      title={copy.title}
      description={copy.description}
      confirmLabel={copy.confirmLabel}
      variant="destructive"
      onConfirm={handleConfirm}
    >
      {pending.kind === "deletedWorktreeGroupDismiss" && pending.preview && (
        <GroupDismissPreview preview={pending.preview} />
      )}
    </ConfirmDialog>
  );
}
