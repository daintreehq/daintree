import type { HostStatusTimingMarks } from "../../shared/types/workspace-host.js";

/**
 * Remembers when this host's project load reached each stage and when each
 * monitor first emitted a snapshot carrying a status, so a switched-to view's
 * status report can be answered with where the time went (#12461).
 *
 * Passive: no timers, and O(1) per emitted snapshot, because it sits on the
 * `worktree-update` path. First-status stamps are keyed weakly by monitor, so a
 * removed monitor takes its stamp with it and a recreated one starts over.
 */
export class StatusTimingRecorder {
  private loadStartedAt: number | null = null;
  private enumeratedAt: number | null = null;
  private firstSnapshotAt: number | null = null;
  private enumerating = false;
  private readonly firstStatusAt = new WeakMap<object, number>();

  beginLoad(now = Date.now()): void {
    this.loadStartedAt = now;
    this.enumeratedAt = null;
    this.firstSnapshotAt = null;
    this.enumerating = true;
  }

  markEnumerated(now = Date.now()): void {
    this.enumeratedAt = now;
    this.enumerating = false;
  }

  /** Ends the load whether or not it got as far as listing worktrees. */
  endLoad(): void {
    this.enumerating = false;
  }

  /** A load that has started but not yet listed its worktrees. */
  isEnumerating(): boolean {
    return this.enumerating;
  }

  noteEmit(monitor: object, hasStatus: boolean, now = Date.now()): void {
    if (this.loadStartedAt !== null && this.firstSnapshotAt === null) {
      this.firstSnapshotAt = now;
    }
    if (hasStatus && !this.firstStatusAt.has(monitor)) {
      this.firstStatusAt.set(monitor, now);
    }
  }

  getMarks(monitors: Iterable<object>): HostStatusTimingMarks {
    const firstStatusAt: number[] = [];
    let monitorCount = 0;
    for (const monitor of monitors) {
      monitorCount++;
      const at = this.firstStatusAt.get(monitor);
      if (at !== undefined) firstStatusAt.push(at);
    }
    return {
      loadStartedAt: this.loadStartedAt,
      enumeratedAt: this.enumeratedAt,
      firstSnapshotAt: this.firstSnapshotAt,
      firstStatusAt,
      monitorCount,
    };
  }
}

/**
 * Whether a view's "every worktree has a status" report describes this host's
 * current state. A view can hold a store from a previous host epoch (a cached
 * view whose host was recycled) or an empty pre-load answer, and either would
 * report success before a single status from this load had landed. A deadline
 * report (`appliedAt: null`) is always taken — it claims nothing.
 */
export function isStatusReportCurrent(
  report: { epoch: string; appliedAt: number | null; worktreeCount: number },
  host: { epoch: string; monitorCount: number; enumerating: boolean }
): boolean {
  if (report.appliedAt === null) return true;
  return (
    !host.enumerating && report.epoch === host.epoch && report.worktreeCount === host.monitorCount
  );
}
