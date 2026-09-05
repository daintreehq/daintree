import path from "path";
import { fileSearchService } from "../FileSearchService.js";
import { isPathInside } from "../../../shared/utils/path.js";
import type { WorktreeSnapshot } from "../../../shared/types/workspace-host.js";

/** The snapshot fields this decision reads. Narrow on purpose — see the class. */
export type FileSearchInvalidationSnapshot = Pick<
  WorktreeSnapshot,
  "path" | "workingTreeChangedAt"
>;

/**
 * Turns the workspace host's worktree stream into file-search cache
 * invalidations (#12240).
 *
 * The host already knows when a worktree's files changed — `GitFileWatcher`'s
 * debounced flush drives `WorktreeMonitor.handleWorktreeFilesChanged`, which
 * advances `workingTreeChangedAt` — and that timestamp rides across the
 * utility-process boundary on the ordinary `worktree-update` snapshot. Nothing
 * read it for the file-search cache, so the index's freshness rested entirely
 * on its TTL and a pause in the picker cost a full cold rebuild.
 *
 * Kept out of `WorkspaceHostEventRouter` on purpose: this module imports `path`
 * and the service and nothing else, so the decision can be driven directly by
 * its own tests and by the PERF-197 benchmark without standing up the router's
 * Electron, store and broadcast dependencies.
 */
export class FileSearchCacheInvalidator {
  /**
   * Last `workingTreeChangedAt` seen per resolved worktree path.
   *
   * `worktree-update` also fires for branch, PR-state and rate-limit changes,
   * which repeat the previous timestamp. Invalidating on every snapshot would
   * be correct but would defeat the cache on churn that never touched a file,
   * so only a CHANGE counts: the monitor stamps `Math.max(Date.now(), prev + 1)`
   * on each flush, so a differing value is exactly "the watcher fired again".
   * Compared for difference rather than for advance, because a monitor
   * restarted behind a backwards clock step would otherwise strand the cache.
   */
  private lastFilesChangedAt = new Map<string, number>();

  handleWorktreeUpdate(worktree: FileSearchInvalidationSnapshot): void {
    if (!worktree.path) return;

    const changedAt = worktree.workingTreeChangedAt;
    // `0` is the monitor's initial value — the recursive watcher has not fired
    // for this worktree — and `undefined` is a snapshot that does not report
    // one. Neither is evidence that anything changed.
    if (typeof changedAt !== "number" || changedAt <= 0) return;

    const resolved = path.resolve(worktree.path);
    if (this.lastFilesChangedAt.get(resolved) === changedAt) return;
    this.lastFilesChangedAt.set(resolved, changedAt);

    // Synchronous and unbatched. The signal is already debounced upstream
    // (`WatcherController`: 250ms trailing ramping to 800ms under bursts, with a
    // 25ms leading edge after a quiet second), so this is a handful of calls a
    // second at worst and each one is a map delete. Deliberately NOT routed
    // through the router's 50ms `sys:worktree:update` coalescer — that window
    // exists for heavy bus consumers, and delaying an invalidation only widens
    // the staleness window it exists to close.
    fileSearchService.invalidateUnder(resolved);
  }

  /**
   * A worktree is gone. Covers external removals (`git worktree remove`, IDE
   * cleanup) as well as the UI path, which the `WORKTREE_DELETE` handler's own
   * `invalidate` call already covers.
   */
  handleWorktreeRemoved(worktreePath: string): void {
    if (!worktreePath) return;
    const resolved = path.resolve(worktreePath);
    this.lastFilesChangedAt.delete(resolved);
    fileSearchService.invalidateUnder(resolved);
  }

  /**
   * A project was closed, backgrounded or removed. Its worktrees stop receiving
   * watcher signals, so holding their indexes buys nothing and only keeps the
   * memory — and on reopen a stale listing would be worse than a cold load.
   *
   * Scoped to the project tree. A worktree parked outside it (Daintree's own
   * sibling `-worktrees` directory, say) is left to the sweep, which reclaims it
   * within the TTL, and to its own `worktree-removed` when it actually goes.
   */
  handleProjectClosed(projectPath: string): void {
    if (!projectPath) return;
    const resolved = path.resolve(projectPath);
    for (const key of [...this.lastFilesChangedAt.keys()]) {
      if (isPathInside(key, resolved)) this.lastFilesChangedAt.delete(key);
    }
    fileSearchService.invalidateUnder(resolved);
  }

  /** Test seam: forget the timestamp bookkeeping without touching the cache. */
  reset(): void {
    this.lastFilesChangedAt.clear();
  }
}

/**
 * Process-wide, matching `fileSearchService` itself: the router owns the
 * worktree stream while project close and removal arrive on unrelated IPC
 * handlers, and all three have to share one view of what has already been seen.
 */
export const fileSearchCacheInvalidator = new FileSearchCacheInvalidator();
