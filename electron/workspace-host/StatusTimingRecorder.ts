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
  private loaded = false;
  private readonly firstStatusAt = new WeakMap<object, number>();

  beginLoad(now = Date.now()): void {
    this.loadStartedAt = now;
    this.enumeratedAt = null;
    this.firstSnapshotAt = null;
    this.loaded = false;
  }

  markEnumerated(now = Date.now()): void {
    this.enumeratedAt = now;
  }

  /** The load succeeded with every worktree's monitor installed. */
  markLoaded(): void {
    this.loaded = true;
  }

  isLoaded(): boolean {
    return this.loaded;
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
 * Whether a view's "every worktree has a status" report can describe this
 * host. A view can be answered `[]` before the load has installed any monitor
 * (its port is brokered as soon as the host exists), and after a host restart
 * its store can mix the new epoch with rows the old host last described; both
 * look complete before a single status from this host has landed. So the load
 * must have settled, and this host must itself have emitted a status for every
 * worktree it has. A deadline report (`appliedAt: null`) claims nothing and is
 * always taken.
 */
export function isStatusReportCurrent(
  report: { epoch: string; appliedAt: number | null; worktreeCount: number },
  host: { epoch: string; loaded: boolean; marks: HostStatusTimingMarks }
): boolean {
  if (report.appliedAt === null) return true;
  const { monitorCount, firstStatusAt } = host.marks;
  return (
    host.loaded &&
    report.epoch === host.epoch &&
    report.worktreeCount === monitorCount &&
    firstStatusAt.length === monitorCount
  );
}
