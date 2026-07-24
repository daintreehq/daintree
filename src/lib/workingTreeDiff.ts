import type { DiffChangeSetEntry, FileChangeDetail, GitStatus } from "@shared/types/git";
import { isAbsolute, normalize } from "@shared/utils/path";

/**
 * Tie-break order for changes with identical churn. Modified-first matches how
 * a reviewer reads a working tree: edits to existing code before new files,
 * with untracked/ignored noise last.
 */
const STATUS_PRIORITY: Record<GitStatus, number> = {
  modified: 0,
  added: 1,
  deleted: 2,
  renamed: 3,
  copied: 4,
  untracked: 5,
  ignored: 6,
  conflicted: 7,
};

export interface WorkingTreeFileChange extends FileChangeDetail {
  /** `path` resolved against the worktree root, for display and diff lookup. */
  relativePath: string;
}

export interface WorkingTreeDiffModel {
  /** Every change, highest-churn first. Index 0 is what "open changes" opens. */
  sortedChanges: WorkingTreeFileChange[];
  /** The same set in the same order, in the shape the diff panel consumes. */
  diffChangeSet: DiffChangeSetEntry[];
  /** Row key -> position in `sortedChanges`, so stepping spans the whole set. */
  indexByKey: Map<string, number>;
}

function getRelativePath(from: string, to: string): string {
  const normalizedFrom = normalize(from);
  const normalizedTo = normalize(to);

  if (normalizedTo.startsWith(normalizedFrom + "/")) {
    return normalizedTo.slice(normalizedFrom.length + 1);
  }

  return normalizedTo;
}

/**
 * Row identity for a change. Status is part of the key because the same path can
 * appear twice (staged + unstaged), and those are distinct rows.
 */
export function getWorkingTreeChangeKey(change: Pick<FileChangeDetail, "path" | "status">): string {
  return `${change.path}-${change.status}`;
}

/**
 * The single derivation of "this worktree's changes as the diff viewer sees
 * them". Shared so every opener — the Changed Files list and the
 * `worktree.openChanges` action, which runs with no component mounted — agrees
 * on both the ordering and which file counts as first.
 */
export function buildWorkingTreeDiffModel(
  changes: readonly FileChangeDetail[],
  rootPath: string
): WorkingTreeDiffModel {
  const sortedChanges = changes
    .map((change) => ({
      ...change,
      relativePath: isAbsolute(change.path) ? getRelativePath(rootPath, change.path) : change.path,
    }))
    .sort((a, b) => {
      const churnA = (a.insertions ?? 0) + (a.deletions ?? 0);
      const churnB = (b.insertions ?? 0) + (b.deletions ?? 0);
      if (churnA !== churnB) {
        return churnB - churnA;
      }

      const priorityA = STATUS_PRIORITY[a.status] ?? 99;
      const priorityB = STATUS_PRIORITY[b.status] ?? 99;
      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }

      return a.path.localeCompare(b.path);
    });

  // Viewed keys are status-scoped: this set mixes staged and unstaged changes,
  // so it can't use the Review Hub's `section:path` namespace.
  const diffChangeSet: DiffChangeSetEntry[] = sortedChanges.map((change) => ({
    path: change.relativePath,
    status: change.status,
    insertions: change.insertions,
    deletions: change.deletions,
    viewedKey: `${change.status}:${change.relativePath}`,
  }));

  const indexByKey = new Map<string, number>();
  sortedChanges.forEach((change, index) => indexByKey.set(getWorkingTreeChangeKey(change), index));

  return { sortedChanges, diffChangeSet, indexByKey };
}
