import type { WorktreeState } from "@/types";

/**
 * Whether the sync line has more to say than "level, as before": drift either
 * way against the upstream or the base, or a failed fetch. The comfortable
 * sidebar card gives the line a row only then, and Details carries it otherwise.
 */
export function syncLineHasNews(worktree: WorktreeState): boolean {
  const hasBaseName = worktree.baseBranchName != null;
  return (
    (worktree.aheadCount ?? 0) > 0 ||
    (worktree.behindCount ?? 0) > 0 ||
    (hasBaseName && (worktree.baseAheadCount ?? 0) > 0) ||
    (hasBaseName && (worktree.baseBehindCount ?? 0) > 0) ||
    Boolean(worktree.fetchAuthFailed || worktree.fetchNetworkFailed)
  );
}
