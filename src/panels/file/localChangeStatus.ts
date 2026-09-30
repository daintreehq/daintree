import type { FileChangeDetail, GitStatus } from "@shared/types/git";
import { normalize, toWorktreeRelative } from "@shared/utils/path";

interface StatusIndex {
  worktreePath: string;
  byRelativePath: Map<string, GitStatus>;
}

// Keyed by the changes array itself: the host replaces it wholesale on every
// status tick and never mutates it (or its entries) in place, so identity is
// the freshness key. Every open file pane runs its
// status selector on every worktree store write, and scanning a large change
// list per pane per write is what this index replaces — one build per tick,
// shared by all panes, then a Map lookup.
const indexByChanges = new WeakMap<readonly FileChangeDetail[], StatusIndex>();

/**
 * The git status of `relativeFilePath` in a worktree's change list, or
 * `undefined` when it has none. Stored change paths are absolute today
 * (electron/utils/git.ts keys changesMap by absolutePath) though the type says
 * relative — both shapes fold to the same relative form. The first entry for a
 * path wins, matching a linear `find`.
 */
export function lookupLocalChangeStatus(
  changes: readonly FileChangeDetail[] | undefined,
  worktreePath: string,
  relativeFilePath: string
): GitStatus | undefined {
  if (!changes) return undefined;
  let index = indexByChanges.get(changes);
  if (!index || index.worktreePath !== worktreePath) {
    const byRelativePath = new Map<string, GitStatus>();
    for (const change of changes) {
      const key = normalize(toWorktreeRelative(change.path, worktreePath));
      if (!byRelativePath.has(key)) byRelativePath.set(key, change.status);
    }
    index = { worktreePath, byRelativePath };
    indexByChanges.set(changes, index);
  }
  return index.byRelativePath.get(relativeFilePath);
}
