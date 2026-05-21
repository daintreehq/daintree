import { existsSync } from "fs";
import { join as pathJoin } from "path";
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
 * Returns true if any of the rebase/merge/cherry-pick/revert sentinel files
 * exist in `gitDir`. Synchronous so it's safe to call on hot paths (e.g.
 * before each git status poll) without adding an async round-trip.
 *
 * Fails open on filesystem errors (e.g. EPERM) — if we can't determine
 * the state, let the regular polling/git invocations proceed. Surfacing a
 * permission error here would stall every poll cycle for the worktree.
 */
export function isRepoOperationInProgress(gitDir: string): boolean {
  for (const name of OPERATION_SENTINEL_NAMES) {
    try {
      if (existsSync(pathJoin(gitDir, name))) {
        return true;
      }
    } catch {
      // Treat unreadable sentinel paths as absent and continue.
    }
  }
  return false;
}

/**
 * Synchronously classify the in-progress git operation by checking sentinel
 * files in `gitDir`. Returns the blocking operation type (REBASING, MERGING,
 * CHERRY_PICKING, REVERTING), or `undefined` when no operation is in progress.
 *
 * Order of checks matches the async `detectRepoOperationState`: rebase first
 * (both merge and apply backends), then cherry-pick, revert, merge.
 *
 * Fails open on filesystem errors — a permission error on any sentinel path
 * is treated as absent so the classifier never blocks polling.
 */
export function getRepoOperationStateSync(gitDir: string): RepoState | undefined {
  try {
    if (
      existsSync(pathJoin(gitDir, "rebase-merge")) ||
      existsSync(pathJoin(gitDir, "rebase-apply"))
    ) {
      return "REBASING";
    }
  } catch {
    // Treat unreadable as absent.
  }
  try {
    if (existsSync(pathJoin(gitDir, "CHERRY_PICK_HEAD"))) {
      return "CHERRY_PICKING";
    }
  } catch {
    // Treat unreadable as absent.
  }
  try {
    if (existsSync(pathJoin(gitDir, "REVERT_HEAD"))) {
      return "REVERTING";
    }
  } catch {
    // Treat unreadable as absent.
  }
  try {
    if (existsSync(pathJoin(gitDir, "MERGE_HEAD"))) {
      return "MERGING";
    }
  } catch {
    // Treat unreadable as absent.
  }
  return undefined;
}
