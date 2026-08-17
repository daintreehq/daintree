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
  /**
   * Identifies the gesture this request belongs to, so a resolution can tell
   * whether it is still the move in flight or one a newer gesture superseded.
   */
  transactionId: number;
  destinationWorktreeId: string;
  destinationWorktreeLabel: string;
  /** Worktree the panel(s) were filed under before the move, for the undo path. */
  sourceWorktreeId?: string;
  /**
   * The moved panels this decision is actually about — the ones whose launch root
   * isn't the destination. A grouped drag relocates the whole group, so the group
   * is decided as one unit and each member is named, but the outcome still applies
   * per member against that member's own launch root, because group membership
   * doesn't imply a shared one.
   *
   * Members already aligned with the destination are deliberately absent: they
   * need no decision, and transferring one would restart a healthy session for
   * nothing.
   */
  members: WorktreeMoveDecisionMember[];
  /**
   * Every panel whose input the gesture locked — a superset of `members` that
   * also covers the aligned ones and any that vanished during classification.
   * Unlocking must run over this rather than `members`, or a panel the decision
   * doesn't concern stays locked for good.
   */
  lockedPanelIds: string[];
  /**
   * Moved panels whose process had already exited. They need no decision, but a
   * mixed group still moves as a unit, and their next launch must be re-pointed
   * at the destination once the decision resolves as anything but cancel.
   */
  alignOnlyPanelIds: string[];
  /** Set when the move came from a tab group. */
  groupId?: string;
  /** Agent name for the copy ("Codex", "Claude Code"), else undefined. */
  agentLabel?: string;
}

interface WorktreeMoveDecisionState {
  pending: WorktreeMoveDecisionRequest | null;
  /**
   * Panels whose input is held pending a decision.
   *
   * Store-owned rather than written straight onto the xterm instance:
   * `terminalInstanceService.setInputLocked` no-ops when a panel has no live
   * instance, and `XtermAdapter` re-applies the panel's *persisted* lock on
   * mount — so an instance-only lock is silently dropped by the remount that
   * following the destination causes, which is exactly when the lock matters.
   * Kept out of the panel record so a quit mid-decision can't leave
   * `isInputLocked: true` on disk.
   */
  lockedPanelIds: ReadonlySet<string>;
  request: (decision: WorktreeMoveDecisionRequest) => void;
  clear: () => void;
  lock: (panelIds: readonly string[]) => void;
  unlock: (panelIds: readonly string[]) => void;
}

export const useWorktreeMoveDecisionStore = create<WorktreeMoveDecisionState>((set) => ({
  pending: null,
  lockedPanelIds: new Set<string>(),
  request: (decision) => set({ pending: decision }),
  clear: () => set({ pending: null }),
  lock: (panelIds) =>
    set((state) => {
      if (panelIds.every((id) => state.lockedPanelIds.has(id))) return state;
      const next = new Set(state.lockedPanelIds);
      for (const id of panelIds) next.add(id);
      return { lockedPanelIds: next };
    }),
  unlock: (panelIds) =>
    set((state) => {
      if (!panelIds.some((id) => state.lockedPanelIds.has(id))) return state;
      const next = new Set(state.lockedPanelIds);
      for (const id of panelIds) next.delete(id);
      return { lockedPanelIds: next };
    }),
}));
