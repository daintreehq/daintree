import path from "path";
import { fileSearchService } from "../FileSearchService.js";
import type { WorktreeSnapshot } from "../../../shared/types/workspace-host.js";

/** The snapshot fields this decision reads. Narrow on purpose — see the class. */
export type FileSearchInvalidationSnapshot = Pick<
  WorktreeSnapshot,
  "path" | "pathMembershipChangedAt" | "generation" | "isCurrent"
>;

/**
 * Which host delivered a snapshot. Both halves come off the routed event:
 * `projectPath` from the pool's process entry, `hostEpoch` from the event's
 * `epoch`, a UUID reminted every time the workspace-host process starts.
 */
export interface FileSearchInvalidationSource {
  projectPath: string;
  hostEpoch: string;
}

interface CoverageRecord {
  projectPath: string;
  worktreePath: string;
  hostEpoch: string;
  generation: number | undefined;
  changedAt: number;
  isCurrent: boolean;
}

/**
 * Turns the workspace host's worktree stream into file-search cache
 * invalidations (#12240).
 *
 * The host already knows when a worktree's path set may have changed —
 * `GitFileWatcher` classifies each debounced flush, its git-internal writes and
 * its watcher re-arms, and `WorktreeMonitor` turns those into
 * `pathMembershipChangedAt` — and that timestamp rides across the
 * utility-process boundary on the ordinary `worktree-update` snapshot. The
 * index is a list of paths, so an in-place edit, which advances only
 * `workingTreeChangedAt`, leaves it warm (#13595); anything the host cannot
 * prove was content-only advances the membership stamp instead.
 *
 * A flush is not the only thing that invalidates, because the flush stream has
 * gaps. `WatcherController` arms the recursive worktree watch only for ELEVATED
 * worktrees, and the host can restart or rebuild a monitor; across any of those
 * the file system can move without a single flush being reported. So this also
 * drops an index whenever the evidence that we were watching is interrupted —
 * see `handleWorktreeUpdate`.
 *
 * Kept out of `WorkspaceHostEventRouter` on purpose: this module imports `path`
 * and the service and nothing else, so the decision can be driven directly by
 * its own tests and by the PERF-197 benchmark without standing up the router's
 * Electron, store and broadcast dependencies.
 */
export class FileSearchCacheInvalidator {
  /**
   * What each producer last told us about each worktree.
   *
   * Keyed by producer AND path, not by path alone. Opening a repository and one
   * of its linked worktrees as separate projects gives the pool two hosts, and
   * both enumerate the same worktree — under a single per-path entry their
   * independent timestamps alternate, and every unrelated snapshot would read
   * as a change and rebuild the index.
   */
  private coverage = new Map<string, CoverageRecord>();

  /**
   * The host incarnation each project was last heard from.
   *
   * Held per project rather than only per worktree so a restart can be
   * reconciled across the whole project at once. A worktree removed while the
   * host was down is never reported again by its replacement, so a per-path
   * epoch check would never run for it and its index would survive on a stale
   * record until the TTL lapsed.
   */
  private projectEpochs = new Map<string, string>();

  private static key(projectPath: string, worktreePath: string): string {
    return `${projectPath}\0${worktreePath}`;
  }

  /**
   * A snapshot arrived. Drop the worktree's indexes when either the file system
   * is known to have moved, or our knowledge of it has a hole:
   *
   * - **The path set may have moved** — `pathMembershipChangedAt` differs from the last
   *   value this producer reported. Compared for difference rather than for
   *   advance: the stamp is `Math.max(Date.now(), prev + 1)` per monitor, so a
   *   monitor restarted behind a backwards clock step reports a lower number,
   *   and an advance-only test would strand that worktree.
   * - **The host restarted or the monitor was rebuilt** — a new `epoch` or
   *   `generation`. The new monitor's stamp starts from zero, so nothing that
   *   happened while the host was down is ever reported; without this the cache
   *   would serve a pre-crash listing until its TTL lapsed.
   * - **The worktree became current** — the recursive watch is armed for
   *   elevated worktrees only, so while this one sat in the background an
   *   external write could land with no flush to report it. Selecting it back is
   *   the moment that gap closes, and it is also the moment the user is about to
   *   search it. Costs one cold load per worktree switch, which is the price of
   *   not having been watching.
   *
   * Only `isCurrent` is observable here; `_agentActive` is the other half of
   * elevation and is not on the snapshot. A worktree that gains coverage purely
   * by an agent starting in it is still covered: the recursive watch going live
   * advances `pathMembershipChangedAt` itself, which matters now that the
   * agent's first write is no longer guaranteed to — an in-place edit leaves the
   * membership stamp alone.
   */
  handleWorktreeUpdate(
    worktree: FileSearchInvalidationSnapshot,
    source: FileSearchInvalidationSource
  ): void {
    if (!worktree.path || !source.projectPath) return;

    const worktreePath = path.resolve(worktree.path);
    const projectPath = path.resolve(source.projectPath);

    // A restart is reconciled for the whole project before this worktree is
    // considered, so scopes the replacement host never mentions again — a
    // worktree removed while it was down — are dropped too.
    if (this.projectEpochs.get(projectPath) !== source.hostEpoch) {
      this.projectEpochs.set(projectPath, source.hostEpoch);
      this.forgetProject(projectPath, { invalidate: true });
    }

    const key = FileSearchCacheInvalidator.key(projectPath, worktreePath);

    const changedAt =
      typeof worktree.pathMembershipChangedAt === "number" && worktree.pathMembershipChangedAt > 0
        ? worktree.pathMembershipChangedAt
        : 0;
    const isCurrent = worktree.isCurrent === true;

    const previous = this.coverage.get(key);
    this.coverage.set(key, {
      projectPath,
      worktreePath,
      hostEpoch: source.hostEpoch,
      generation: worktree.generation,
      changedAt,
      isCurrent,
    });

    if (!previous) {
      // First sighting: having no record is not evidence of freshness. A search
      // can cache a scope before this producer ever mentions it — an MCP query
      // against an arbitrary cwd, or anything cached while the host was still
      // starting — and a `changedAt` of zero would then preserve a listing taken
      // before the watcher existed. At worst this discards an index a search
      // built moments earlier, once per worktree per project load.
      fileSearchService.invalidateUnder(worktreePath);
      return;
    }

    // `hostEpoch` is handled above, for the whole project at once.
    const monitorRebuilt = previous.generation !== worktree.generation;
    const flushed = changedAt > 0 && changedAt !== previous.changedAt;
    const becameCurrent = isCurrent && !previous.isCurrent;

    if (!monitorRebuilt && !flushed && !becameCurrent) return;

    // Synchronous and unbatched. The flush half is already debounced upstream
    // (`WatcherController`: 250ms trailing ramping to 800ms under bursts, with a
    // 25ms leading edge after a quiet second), and the other two fire on
    // lifecycle transitions, so this stays a handful of calls a second even
    // though `worktree-update` itself streams far faster. Deliberately NOT
    // routed through the router's 50ms `sys:worktree:update` coalescer — that
    // window exists for heavy bus consumers, and delaying an invalidation only
    // widens the staleness window it exists to close.
    fileSearchService.invalidateUnder(worktreePath);
  }

  /**
   * A worktree is gone. Covers external removals (`git worktree remove`, IDE
   * cleanup) as well as the UI path, which the `WORKTREE_DELETE` handler's own
   * `invalidate` call already covers.
   *
   * Forgets the path under every producer: the worktree is gone for all of them,
   * and a stale record would let a recreation at the same location look like a
   * continuation of the old one.
   */
  handleWorktreeRemoved(worktreePath: string): void {
    if (!worktreePath) return;
    const resolved = path.resolve(worktreePath);
    for (const [key, record] of this.coverage) {
      if (record.worktreePath === resolved) this.coverage.delete(key);
    }
    fileSearchService.invalidateUnder(resolved);
  }

  /**
   * A project was closed, backgrounded or removed. Its worktrees stop receiving
   * watcher signals, so holding their indexes buys nothing — and on reopen a
   * stale listing would be worse than a cold load.
   *
   * Every worktree the project owns, not just the ones under its directory:
   * Daintree's own trees live in a sibling `-worktrees` folder, and an ancestry
   * test would leave exactly those behind. Ownership comes from the producer
   * that reported them.
   */
  handleProjectClosed(projectPath: string): void {
    if (!projectPath) return;
    const resolved = path.resolve(projectPath);
    this.projectEpochs.delete(resolved);
    this.forgetProject(resolved, { invalidate: true });
    // The project root itself, unconditionally: a search can be rooted at the
    // project directory without any worktree ever reporting it.
    fileSearchService.invalidateUnder(resolved);
  }

  /**
   * Drop every record this project owns, optionally dropping their indexes too.
   * Shared by project teardown and by restart reconciliation, which need the
   * same "everything this producer was responsible for" sweep.
   */
  private forgetProject(projectPath: string, options: { invalidate: boolean }): void {
    const owned: string[] = [];
    for (const [key, record] of this.coverage) {
      if (record.projectPath !== projectPath) continue;
      owned.push(record.worktreePath);
      this.coverage.delete(key);
    }
    if (!options.invalidate) return;
    for (const worktreePath of owned) fileSearchService.invalidateUnder(worktreePath);
  }

  /** Test seam: forget the coverage bookkeeping without touching the cache. */
  reset(): void {
    this.coverage.clear();
    this.projectEpochs.clear();
  }
}

/**
 * Process-wide, matching `fileSearchService` itself: the router owns the
 * worktree stream while project close and removal arrive on unrelated IPC
 * handlers, and all three have to share one view of what has already been seen.
 */
export const fileSearchCacheInvalidator = new FileSearchCacheInvalidator();
