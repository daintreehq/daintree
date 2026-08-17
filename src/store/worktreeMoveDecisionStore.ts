import { create } from "zustand";
import type { LaunchRootAlignment } from "@/utils/worktreeAlignment";

/**
 * Ephemeral UI state for the cross-worktree move decision (#11840).
 *
 * Moving a panel with a live process to another worktree relabels the panel but
 * leaves the process — and its commits — where they were. The choke point writes
 * the pending decision here instead of completing the move silently; an
 * app-level host renders the dialog and calls back into
 * `resolveWorktreeMoveDecision` with the outcome.
 *
 * Pure data, no callbacks, mirroring `terminalPendingDestructiveActionStore`:
 * the resolution lives with the move logic, not in the store.
 */
export interface WorktreeMoveDecisionMember {
  panelId: string;
  title: string;
  alignment: LaunchRootAlignment;
  /** Launch root the process actually runs in, when it could be resolved. */
  launchCwd?: string;
  /** Worktree that launch root belongs to, when it maps to one. */
  launchWorktreeId?: string;
  /** Display name for that worktree, else the bare path. */
  launchWorktreeLabel?: string;
}

export interface WorktreeMoveDecisionRequest {
  destinationWorktreeId: string;
  destinationWorktreeLabel: string;
  /** Worktree the panel(s) were filed under before the move, for the undo path. */
  sourceWorktreeId?: string;
  /**
   * Every panel the gesture moved. A grouped drag relocates the whole group, so
   * the group is decided as one unit and each member is named — but the transfer
   * still runs per member against that member's own launch root, because group
   * membership doesn't imply a shared one.
   */
  members: WorktreeMoveDecisionMember[];
  /** Set when the move came from a tab group. */
  groupId?: string;
  /** Agent name for the copy ("Codex", "Claude Code"), else undefined. */
  agentLabel?: string;
}

interface WorktreeMoveDecisionState {
  pending: WorktreeMoveDecisionRequest | null;
  request: (decision: WorktreeMoveDecisionRequest) => void;
  clear: () => void;
}

export const useWorktreeMoveDecisionStore = create<WorktreeMoveDecisionState>((set) => ({
  pending: null,
  request: (decision) => set({ pending: decision }),
  clear: () => set({ pending: null }),
}));
