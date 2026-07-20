import { create } from "zustand";

/**
 * Ephemeral UI state for terminal-surface destructive confirmations
 * (kill/restart at single, bulk, and worktree-scope). Actions dispatched
 * from a keybinding or palette write here instead of running immediately;
 * the app-level confirm-dialog host subscribes and renders a modal that
 * re-dispatches the action with `{ confirmed: true }` (and any scope
 * args) on confirm or clears the store on cancel.
 *
 * Context-menu surfaces wire their own local `ConfirmDialog` for
 * single-terminal kill/restart — this store is the fallback for
 * keybinding/palette/bulk surfaces that have no local dialog.
 */
export type TerminalPendingDestructiveActionKind =
  | "kill" // single terminal kill
  | "restart" // single terminal restart
  | "killAll"
  | "restartAll"
  | "worktreeRestartAll"
  | "worktreeTrashAll"
  // Closing the terminals held by a deleted worktree's deleted-worktree row (#11232).
  // Executes through `worktree.sessions.trashAll` like `worktreeTrashAll`;
  // it exists as its own kind purely so the copy can speak about a worktree
  // that no longer exists rather than "this worktree".
  | "deletedWorktreeDismiss"
  // Clearing every deleted-worktree row at once from the grouped summary
  // (#11260). Fans the same `worktree.sessions.trashAll` executor over each
  // member, and carries `preview` because D2 requires the dialog to list the
  // terminals it is about to trash rather than just count them.
  | "deletedWorktreeGroupDismiss";

/** One terminal the group-dismiss confirm is about to trash. */
export interface DeletedWorktreeGroupPreviewTerminal {
  terminalId: string;
  terminalTitle: string;
  hasRunningAgent: boolean;
}

/** One deleted worktree in the group-dismiss confirm, with its terminals. */
export interface DeletedWorktreeGroupPreviewWorktree {
  worktreeId: string;
  worktreeTitle: string;
  terminals: DeletedWorktreeGroupPreviewTerminal[];
}

export interface TerminalPendingDestructiveActionSnapshot {
  kind: TerminalPendingDestructiveActionKind;
  /** Total panels in scope (e.g., all non-ephemeral for killAll). */
  targetCount: number;
  /** Subset of targets with a running agent session — drives the warning copy. */
  runningAgentCount: number;
  /** Worktree id for worktree-scoped actions. */
  worktreeId?: string;
  /** Terminal id for single-terminal actions (kill/restart). */
  terminalId?: string;
  /**
   * The actual terminals a `deletedWorktreeGroupDismiss` will trash, grouped by
   * their deleted worktree. Required for that kind — D2 (#7880) wants the
   * dialog to preview real content, and a bulk clear spanning several worktrees
   * is the one case where a count tells the user nothing about what they lose.
   */
  preview?: DeletedWorktreeGroupPreviewWorktree[];
}

interface TerminalPendingDestructiveActionState {
  pending: TerminalPendingDestructiveActionSnapshot | null;
  request: (snapshot: TerminalPendingDestructiveActionSnapshot) => void;
  clear: () => void;
}

export const useTerminalPendingDestructiveActionStore =
  create<TerminalPendingDestructiveActionState>((set) => ({
    pending: null,
    request: (snapshot) => set({ pending: snapshot }),
    clear: () => set({ pending: null }),
  }));
