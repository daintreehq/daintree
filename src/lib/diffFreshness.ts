import type { FileChangeDetail, WorktreeSnapshot } from "@shared/types";
import { isAbsolute, join, normalize } from "@shared/utils/path";

// Distinct from undefined (no signal at all): the worktree is tracked but the
// file is absent from its change list, so a file staged/reverted/committed
// while its diff is open still reads as changed.
export const FRESHNESS_MISSING = "missing";

// Store change paths are absolute (electron/utils/git.ts keys changesMap by
// absolutePath) while hosts pass worktree-relative paths — resolve both
// against the worktree root before comparing.
export function comparablePath(worktreePath: string, path: string): string {
  return isAbsolute(path) ? normalize(path) : join(worktreePath, path);
}

function entryFreshnessKey(entry: FileChangeDetail): string {
  return `${entry.status}:${entry.mtimeMs ?? entry.mtime ?? ""}:${entry.insertions ?? ""}:${entry.deletions ?? ""}`;
}

// Staging a new file flips git's `untracked` to `added` and moves its line
// count from Daintree's own newline count to numstat, which can disagree on
// big, binary or filtered files, so for a new file only the mtime speaks to
// its content. Everything else reads as `entryFreshnessKey` does.
function stagingAgnosticKey(entry: FileChangeDetail): string {
  if (entry.status === "untracked" || entry.status === "added") {
    return `new:${entry.mtimeMs ?? entry.mtime ?? ""}`;
  }
  return entryFreshnessKey(entry);
}

export function findWorktreeByPath(
  worktrees: ReadonlyMap<string, WorktreeSnapshot>,
  worktreePath: string
): WorktreeSnapshot | undefined {
  const worktreeKey = normalize(worktreePath);
  for (const worktree of worktrees.values()) {
    if (normalize(worktree.path) === worktreeKey) return worktree;
  }
  return undefined;
}

/**
 * Primitive freshness key for one file from the live worktree store.
 * `changes` is rebuilt wholesale every poll tick, so returning the found entry
 * would defeat Object.is bail-outs — the scalar collapses re-renders to actual
 * changes of this one file (#8635).
 */
export function selectDiffFreshnessKey(
  state: { worktrees: ReadonlyMap<string, WorktreeSnapshot> },
  worktreePath: string,
  filePath: string
): string | undefined {
  const changes = findWorktreeByPath(state.worktrees, worktreePath)?.worktreeChanges?.changes;
  if (!changes) return undefined;
  const fileKey = comparablePath(worktreePath, filePath);
  const entry = changes.find((change) => comparablePath(worktreePath, change.path) === fileKey);
  return entry ? entryFreshnessKey(entry) : FRESHNESS_MISSING;
}

/**
 * Every file's freshness key for one worktree at once, keyed by
 * {@link comparablePath}, for callers checking many files against one poll.
 * Unlike {@link selectDiffFreshnessKey}, staging or unstaging a file leaves its
 * key alone: the change it carries is the same either side of the index.
 * Undefined when the store has no change list for the worktree.
 */
export function buildFreshnessIndex(
  worktrees: ReadonlyMap<string, WorktreeSnapshot>,
  worktreePath: string
): ReadonlyMap<string, string> | undefined {
  const changes = findWorktreeByPath(worktrees, worktreePath)?.worktreeChanges?.changes;
  if (!changes) return undefined;
  const index = new Map<string, string>();
  for (const change of changes) {
    index.set(comparablePath(worktreePath, change.path), stagingAgnosticKey(change));
  }
  return index;
}
