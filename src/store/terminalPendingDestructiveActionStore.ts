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
  | "worktreeTrashAll";

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
