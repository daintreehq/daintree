// eager-import-allow: reads/writes the git-operation lock via sync fs
import { readdirSync } from "fs";
import type { RepoState } from "../../shared/types/git.js";

/**
 * Sentinel files/directories git creates while a multi-step operation is
 * in progress. While any of these are present, running `git status` competes
 * with the user's git client for `.git/index.lock`.
 *
 * `index.lock` is intentionally excluded — it's too transient to drive
 * polling decisions and `WorktreeMonitor` already has a dedicated retry
 * path for `index.lock` errors raised by `git status`.
 */
export const OPERATION_SENTINEL_NAMES = [
  "MERGE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
] as const;

/**
 * List `gitDir`'s entries once so sentinel checks cost a single syscall
 * instead of one `existsSync` per sentinel — these run in front of every
 * status poll for every worktree, where the per-poll fast path is otherwise
 * a handful of async stats.
 *
 * Returns null on filesystem errors (e.g. EPERM) so callers fail open — if we
 * can't determine the state, let the regular polling/git invocations proceed.
 * Surfacing a permission error here would stall every poll cycle for the
 * worktree. Sentinel names are matched exactly as git writes them; git never
 * varies their case.
 */
function readGitDirEntries(gitDir: string): Set<string> | null {
  try {
    return new Set(readdirSync(gitDir));
  } catch {
    return null;
  }
}

/**
 * Returns true if any of the rebase/merge/cherry-pick/revert sentinel files
 * exist in `gitDir`. Synchronous so it's safe to call on hot paths (e.g.
 * before each git status poll) without adding an async round-trip.
 */
export function isRepoOperationInProgress(gitDir: string): boolean {
  const entries = readGitDirEntries(gitDir);
  if (!entries) return false;
  return OPERATION_SENTINEL_NAMES.some((name) => entries.has(name));
}

/**
 * Synchronously classify the in-progress git operation by checking sentinel
 * files in `gitDir`. Returns the blocking operation type (REBASING, MERGING,
 * CHERRY_PICKING, REVERTING), or `undefined` when no operation is in progress.
 *
 * Order of checks matches the async `detectRepoOperationState`: rebase first
 * (both merge and apply backends), then cherry-pick, revert, merge.
 */
export function getRepoOperationStateSync(gitDir: string): RepoState | undefined {
  const entries = readGitDirEntries(gitDir);
  if (!entries) return undefined;
  if (entries.has("rebase-merge") || entries.has("rebase-apply")) {
    return "REBASING";
  }
  if (entries.has("CHERRY_PICK_HEAD")) {
    return "CHERRY_PICKING";
  }
  if (entries.has("REVERT_HEAD")) {
    return "REVERTING";
  }
  if (entries.has("MERGE_HEAD")) {
    return "MERGING";
  }
  return undefined;
}
