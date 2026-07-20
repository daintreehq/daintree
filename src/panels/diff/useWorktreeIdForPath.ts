import { use, useCallback, useSyncExternalStore } from "react";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { normalize } from "@shared/utils/path";

/**
 * Resolve a worktree's id from its path.
 *
 * Diff panels bind to a worktree by id (like every other panel kind) so a
 * worktree move can't strand them, but the surfaces that open them —
 * `FileChangeList`, the review hub — are handed a root path. Tolerates a
 * missing provider by returning undefined rather than throwing, matching
 * `useDiffContent`.
 */
export function useWorktreeIdForPath(worktreePath: string | undefined): string | undefined {
  const store = use(WorktreeStoreContext);
  return useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => (store ? store.subscribe(onStoreChange) : () => {}),
      [store]
    ),
    useCallback(() => {
      if (!store || !worktreePath) return undefined;
      const target = normalize(worktreePath);
      for (const [id, worktree] of store.getState().worktrees) {
        if (normalize(worktree.path) === target) return id;
      }
      return undefined;
    }, [store, worktreePath])
  );
}
