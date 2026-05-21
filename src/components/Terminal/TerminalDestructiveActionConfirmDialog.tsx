import { type ReactElement, useCallback } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { actionService } from "@/services/ActionService";
import {
  useTerminalPendingDestructiveActionStore,
  type TerminalPendingDestructiveActionSnapshot,
} from "@/store/terminalPendingDestructiveActionStore";

interface DialogCopy {
  title: string;
  description: string;
  confirmLabel: string;
}

function buildCopy(pending: TerminalPendingDestructiveActionSnapshot): DialogCopy {
  switch (pending.kind) {
    case "kill":
      return {
        title: "Kill terminal with running agent?",
        description:
          "An agent is mid-work in this terminal. Killing it stops the agent and discards its scrollback. The PTY process and any unsaved output will be lost.",
        confirmLabel: "Kill terminal",
      };
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
        description: `Killing every non-ephemeral terminal stops their processes and discards scrollback. ${agentNote} Active work and unsaved output will be lost.`,
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
  }
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
        break;
      case "restart":
        if (!pending.terminalId) break;
        void actionService.dispatch(
          "terminal.restart",
          { terminalId: pending.terminalId, confirmed: true },
          { source: "user" }
        );
        break;
      case "killAll":
        void actionService.dispatch("terminal.killAll", { confirmed: true }, { source: "user" });
        break;
      case "restartAll":
        void actionService.dispatch("terminal.restartAll", { confirmed: true }, { source: "user" });
        break;
      case "worktreeRestartAll":
        if (!pending.worktreeId) break;
        void actionService.dispatch(
          "worktree.sessions.restartAll",
          { worktreeId: pending.worktreeId, confirmed: true },
          { source: "user" }
        );
        break;
      case "worktreeTrashAll":
        if (!pending.worktreeId) break;
        void actionService.dispatch(
          "worktree.sessions.trashAll",
          { worktreeId: pending.worktreeId, confirmed: true },
          { source: "user" }
        );
        break;
    }
    clear();
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
    />
  );
}
