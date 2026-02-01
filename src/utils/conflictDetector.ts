import type { Worktree, WorktreeState } from "@shared/types/domain";

export interface ConflictInfo {
  /** Relative file path that has conflicts */
  filePath: string;
  /** IDs of worktrees that have modified this file */
  worktreeIds: string[];
}

export interface WorktreeConflictSummary {
  /** Number of files with conflicts in this worktree */
  conflictCount: number;
  /** Details about each conflicting file */
  conflicts: ConflictInfo[];
}

/**
 * Detects files that are modified in multiple worktrees simultaneously.
 * This helps users identify potential merge conflicts before they occur.
 *
 * @param worktrees - Array of worktree states to analyze
 * @returns Array of conflict info, one for each file modified in 2+ worktrees
 */
export function detectConflicts(worktrees: (Worktree | WorktreeState)[]): ConflictInfo[] {
  const fileToWorktrees = new Map<string, Set<string>>();

  for (const wt of worktrees) {
    const worktreeRoot = wt.path;
    const changes = wt.worktreeChanges?.changes ?? wt.changes ?? [];

    for (const change of changes) {
      let normalizedPath = change.path;

      if (normalizedPath.startsWith(worktreeRoot)) {
        normalizedPath = normalizedPath.slice(worktreeRoot.length);
        if (normalizedPath.startsWith("/")) {
          normalizedPath = normalizedPath.slice(1);
        }
      }

      const worktreeSet = fileToWorktrees.get(normalizedPath) ?? new Set<string>();
      worktreeSet.add(wt.id);
      fileToWorktrees.set(normalizedPath, worktreeSet);
    }
  }

  return Array.from(fileToWorktrees.entries())
    .filter(([, wts]) => wts.size > 1)
    .map(([path, wts]) => ({ filePath: path, worktreeIds: Array.from(wts) }));
}

/**
 * Gets conflict summary for a specific worktree.
 *
 * @param worktreeId - ID of the worktree to get conflicts for
 * @param allConflicts - All detected conflicts from detectConflicts()
 * @returns Summary of conflicts affecting this worktree
 */
export function getWorktreeConflicts(
  worktreeId: string,
  allConflicts: ConflictInfo[]
): WorktreeConflictSummary {
  const relevantConflicts = allConflicts.filter((c) => c.worktreeIds.includes(worktreeId));
  return {
    conflictCount: relevantConflicts.length,
    conflicts: relevantConflicts,
  };
}

/**
 * Gets names of other worktrees that share a conflict with the given worktree.
 *
 * @param worktreeId - ID of the worktree to check
 * @param conflict - The conflict info
 * @param worktreeMap - Map of worktree ID to worktree for name lookup
 * @returns Array of worktree names (excluding the current worktree)
 */
export function getConflictingWorktreeNames(
  worktreeId: string,
  conflict: ConflictInfo,
  worktreeMap: Map<string, Worktree | WorktreeState>
): string[] {
  const otherIds = conflict.worktreeIds.filter((id) => id !== worktreeId);
  const branches = new Set<string>();

  return otherIds.map((id) => {
    const wt = worktreeMap.get(id);
    if (!wt) return id;

    const branch = wt.branch ?? wt.name;
    const hasDuplicate = branches.has(branch);
    branches.add(branch);

    if (hasDuplicate && wt.name !== branch) {
      return `${branch} (${wt.name})`;
    }

    return branch;
  });
}
