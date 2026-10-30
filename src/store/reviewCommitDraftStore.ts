import { create } from "zustand";

/**
 * Commit messages typed into Review & commit, by worktree path (#15007). The
 * hub's own state goes with its panel on every close, promotion and trash, so
 * the draft lives here and the next hub opened on the same worktree picks it
 * up — two hubs on one worktree compose the same commit, so they share it.
 *
 * Only what the user typed or recalled lands here. The worktree note's seed is
 * an open-time hint and is never kept on its own (#7884). Session-scoped like
 * the Viewed marks it sits beside: never persisted, so a fresh app session or
 * an evicted project view starts from an empty composer.
 */
interface ReviewCommitDraftState {
  draftsByWorktree: Record<string, string>;
  /** An empty message clears the draft, so the next open can seed again. */
  setDraft: (worktreePath: string, message: string) => void;
  /**
   * Drops the draft a commit was made from. One edited since — in another hub,
   * or after a close and reopen while the commit ran — is newer work and stays.
   */
  clearCommitted: (worktreePath: string, message: string) => void;
  clearWorktree: (worktreePath: string) => void;
}

function withoutKey(drafts: Record<string, string>, worktreePath: string): Record<string, string> {
  const next = { ...drafts };
  delete next[worktreePath];
  return next;
}

export const useReviewCommitDraftStore = create<ReviewCommitDraftState>()((set) => ({
  draftsByWorktree: {},
  setDraft: (worktreePath, message) =>
    set((state) => {
      const current = state.draftsByWorktree[worktreePath];
      if (message === "") {
        return current === undefined
          ? state
          : { draftsByWorktree: withoutKey(state.draftsByWorktree, worktreePath) };
      }
      if (current === message) return state;
      return { draftsByWorktree: { ...state.draftsByWorktree, [worktreePath]: message } };
    }),
  clearCommitted: (worktreePath, message) =>
    set((state) =>
      state.draftsByWorktree[worktreePath] === message
        ? { draftsByWorktree: withoutKey(state.draftsByWorktree, worktreePath) }
        : state
    ),
  clearWorktree: (worktreePath) =>
    set((state) =>
      state.draftsByWorktree[worktreePath] === undefined
        ? state
        : { draftsByWorktree: withoutKey(state.draftsByWorktree, worktreePath) }
    ),
}));
