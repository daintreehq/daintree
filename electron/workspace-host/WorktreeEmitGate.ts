import type { WorktreeSnapshot, WorktreeTick } from "../../shared/types/workspace-host.js";
import {
  toWorktreeTick,
  worktreeSnapshotContentEqual,
} from "../../shared/utils/worktreeSnapshotTick.js";

/**
 * Decides whether a monitor's snapshot goes out whole or as a
 * {@link WorktreeTick}. Every `worktree-update` is structured-cloned to main and
 * to each renderer port, and most of them — watcher flushes, forced status
 * passes that found nothing new — differ from the previous one only in their
 * volatile stamps. Those go as a tick; every consumer rebuilds the snapshot
 * from the last full one it received for the same monitor.
 *
 * Keyed by monitor object, so a new incarnation at the same path always starts
 * with a full snapshot. Relies on snapshot sub-objects being replaced rather
 * than mutated in place, which `SnapshotBuilder` and its callers already do.
 */
export class WorktreeEmitGate {
  private lastSent = new WeakMap<object, WorktreeSnapshot>();

  /** Returns the tick to send in place of `snapshot`, or null to send it whole. */
  next(monitor: object, snapshot: WorktreeSnapshot): WorktreeTick | null {
    const last = this.lastSent.get(monitor);
    if (last && worktreeSnapshotContentEqual(last, snapshot)) {
      return toWorktreeTick(snapshot);
    }
    this.lastSent.set(monitor, snapshot);
    return null;
  }

  /**
   * A consumer is about to adopt `snapshot` without it going through
   * {@link next} (the `get-all-states` hydration). If it differs from what the
   * other consumers hold, the next emit must go whole so they all converge.
   */
  noteOutOfBand(monitor: object, snapshot: WorktreeSnapshot): void {
    const last = this.lastSent.get(monitor);
    if (last && !worktreeSnapshotContentEqual(last, snapshot)) {
      this.lastSent.delete(monitor);
    }
  }

  forget(monitor: object): void {
    this.lastSent.delete(monitor);
  }

  /**
   * Every monitor's next emit goes whole. Called when a renderer port attaches:
   * a port that reattached after a failed post may have missed full snapshots,
   * and its hydration reply can lose the race to a tick.
   */
  reset(): void {
    this.lastSent = new WeakMap();
  }
}
