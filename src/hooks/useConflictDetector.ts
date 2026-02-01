import { useMemo } from "react";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import {
  detectConflicts,
  getWorktreeConflicts,
  type ConflictInfo,
  type WorktreeConflictSummary,
} from "@/utils/conflictDetector";

const selectAllConflicts = (state: { worktrees: Map<string, unknown> }): ConflictInfo[] => {
  const worktreeArray = Array.from(state.worktrees.values());
  return detectConflicts(worktreeArray as Parameters<typeof detectConflicts>[0]);
};

/**
 * Hook to detect file conflicts across all worktrees.
 * Uses Zustand selector to compute conflicts only once per store update.
 *
 * @returns All detected conflicts (files modified in 2+ worktrees)
 */
export function useAllConflicts(): ConflictInfo[] {
  return useWorktreeDataStore(selectAllConflicts);
}

/**
 * Hook to get conflict summary for a specific worktree.
 *
 * @param worktreeId - ID of the worktree to check for conflicts
 * @returns Conflict summary for this worktree
 */
export function useWorktreeConflicts(worktreeId: string): WorktreeConflictSummary {
  const allConflicts = useAllConflicts();

  return useMemo(() => {
    return getWorktreeConflicts(worktreeId, allConflicts);
  }, [worktreeId, allConflicts]);
}

/**
 * Hook to check if a worktree has any conflicts.
 *
 * @param worktreeId - ID of the worktree to check
 * @returns True if worktree has files conflicting with other worktrees
 */
export function useHasConflicts(worktreeId: string): boolean {
  const { conflictCount } = useWorktreeConflicts(worktreeId);
  return conflictCount > 0;
}
