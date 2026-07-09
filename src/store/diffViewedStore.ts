import { create } from "zustand";

/**
 * Session-scoped "viewed" markers for changeset review, shared by the diff
 * workspace sidebar and the Review Hub file list so a file checked off in one
 * surface reads as reviewed in the other. Keys are caller-owned strings
 * (Review Hub uses `staged:{path}` / `unstaged:{path}`; the worktree change
 * list uses `{status}:{path}`; base-branch review uses `base:{path}`), scoped
 * per worktree path. Deliberately not persisted: a fresh app session starts a
 * fresh review.
 */

const EMPTY_SET: ReadonlySet<string> = new Set();

interface DiffViewedState {
  viewedByWorktree: Record<string, ReadonlySet<string>>;
  setViewed: (worktreePath: string, key: string, viewed: boolean) => void;
  toggleViewed: (worktreePath: string, key: string) => void;
  clearWorktree: (worktreePath: string) => void;
}

export const useDiffViewedStore = create<DiffViewedState>((set) => ({
  viewedByWorktree: {},
  setViewed: (worktreePath, key, viewed) =>
    set((state) => {
      const current = state.viewedByWorktree[worktreePath] ?? EMPTY_SET;
      if (current.has(key) === viewed) return state;
      const next = new Set(current);
      if (viewed) next.add(key);
      else next.delete(key);
      return { viewedByWorktree: { ...state.viewedByWorktree, [worktreePath]: next } };
    }),
  toggleViewed: (worktreePath, key) =>
    set((state) => {
      const current = state.viewedByWorktree[worktreePath] ?? EMPTY_SET;
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { viewedByWorktree: { ...state.viewedByWorktree, [worktreePath]: next } };
    }),
  // Called on commit success (Review Hub) — a commit starts a new review, so
  // stale markers must not stick to files that change again afterwards. Not
  // wired to worktree deletion; leftover markers there are a few strings
  // until app restart.
  clearWorktree: (worktreePath) =>
    set((state) => {
      if (!(worktreePath in state.viewedByWorktree)) return state;
      const { [worktreePath]: _removed, ...rest } = state.viewedByWorktree;
      return { viewedByWorktree: rest };
    }),
}));

/** Stable empty-set selector helper so components don't allocate per render. */
export function selectViewedSet(state: DiffViewedState, worktreePath: string): ReadonlySet<string> {
  return state.viewedByWorktree[worktreePath] ?? EMPTY_SET;
}
