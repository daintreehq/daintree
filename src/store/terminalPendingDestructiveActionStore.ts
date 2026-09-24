import { create } from "zustand";
import type { ActionSource } from "@shared/types/actions";

/**
 * Ephemeral UI state for worktree-session destructive confirmations
 * (kill/restart at single, bulk, and worktree-scope, plus ending every
 * session or clearing a worktree's recorded session history). Actions
 * dispatched from a keybinding or palette write here instead of running
 * immediately; the app-level confirm-dialog host subscribes and renders a
 * modal that re-dispatches the action with `{ confirmed: true }` (and any
 * scope args) on confirm or clears the store on cancel.
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
  // Permanently ending every session in a worktree (#11345). Like
  // `worktreeTrashAll` this executes `worktree.sessions.endAll`, but it
  // removes the panels outright rather than moving them to trash, so its
  // copy speaks of a permanent end.
  | "worktreeEndAll"
  // Clearing a worktree's recorded resumable-session history (#11345). Unlike
  // every other kind here it touches no live panels — it clears the historical
  // journal — so it carries no meaningful `targetCount`/`runningAgentCount`
  // (both are 0) and its copy ignores them.
  | "worktreeClearHistory"
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

/** One terminal a confirm is about to act on, as the preview list shows it. */
export interface DestructivePreviewTerminal {
  terminalId: string;
  terminalTitle: string;
  /** Observed agent state is `working` — the same gate that raised the confirm. */
  hasRunningAgent: boolean;
}

/** The terminals a confirm acts on in one worktree. */
export interface DestructivePreviewGroup {
  worktreeId: string;
  worktreeTitle: string;
  terminals: DestructivePreviewTerminal[];
}

export interface TerminalPendingDestructiveActionSnapshot {
  kind: TerminalPendingDestructiveActionKind;
  /** Total panels in scope (e.g., all non-ephemeral for killAll). */
  targetCount: number;
  /** Subset of targets with a running agent session — drives the warning copy. */
  runningAgentCount: number;
  /** Worktree id for worktree-scoped actions. */
  worktreeId?: string;
  /**
   * Display name of the worktree a worktree-scoped action targets, captured
   * when the confirm is requested so the title can name it. A deleted
   * worktree is no longer in the live map, so its row supplies this itself.
   */
  worktreeTitle?: string;
  /**
   * How the unconfirmed dispatch arrived. The confirm re-dispatches a
   * keybinding-raised action as a keybinding, so the shortcut hint doesn't
   * teach the user the combo they just pressed.
   */
  dispatchSource?: ActionSource;
  /** Terminal id for single-terminal actions (kill/restart). */
  terminalId?: string;
  /** Display title of the terminal a single-terminal action targets. */
  terminalTitle?: string;
  /**
   * The actual terminals the action will touch, grouped by worktree, with the
   * working ones flagged. Required for `deletedWorktreeGroupDismiss` — D2
   * (#7880) wants the dialog to preview real content — and carried by every
   * bulk kind so a count never stands in for which terminals hold live work.
   */
  preview?: DestructivePreviewGroup[];
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
