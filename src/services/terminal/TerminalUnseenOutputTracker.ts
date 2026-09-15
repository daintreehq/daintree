export interface UnseenOutputSnapshot {
  isUserScrolledBack: boolean;
  unseen: number;
}

// Minimum unseen lines before the indicator pill is shown. Consumed by
// `useUnseenOutput` and by the tracker itself to bound listener notifications
// (we notify on the threshold crossing, not on every increment).
export const UNSEEN_THRESHOLD = 2;

type Listener = () => void;

export class TerminalUnseenOutputTracker {
  private unseenById = new Map<string, number>();
  private listenersById = new Map<string, Set<Listener>>();
  private snapshotById = new Map<string, UnseenOutputSnapshot>();
  // Terminals mid-way through an ESC[3J redraw: the raw count keeps moving
  // but nothing is published until `releaseUnseen` settles it.
  private heldIds = new Set<string>();

  incrementUnseen(id: string, isUserScrolledBack: boolean): void {
    if (!isUserScrolledBack) return;

    const current = this.unseenById.get(id) ?? 0;
    const next = current + 1;
    this.unseenById.set(id, next);
    if (this.heldIds.has(id)) return;

    // Bound listener notifications to threshold crossings to avoid re-render
    // churn during heavy streaming output while scrolled back. Once the pill
    // is visible (unseen > UNSEEN_THRESHOLD) further increments don't change
    // UI state, so suppress those notifications. The raw count continues to
    // accumulate in `unseenById` and the snapshot is refreshed from it on
    // the next relevant event (clearUnseen / updateScrollState).
    const crossesThreshold = current === 0 || current === UNSEEN_THRESHOLD;
    if (crossesThreshold) {
      this.updateSnapshot(id, isUserScrolledBack, next);
      this.notify(id);
    }
  }

  clearUnseen(id: string, isUserScrolledBack: boolean): void {
    const current = this.unseenById.get(id);
    const hadUnseen = current !== undefined && current > 0;

    if (hadUnseen) {
      this.unseenById.set(id, 0);
    }

    const snapshot = this.snapshotById.get(id);
    const needsUpdate =
      hadUnseen || (snapshot && snapshot.isUserScrolledBack !== isUserScrolledBack);

    if (needsUpdate) {
      this.updateSnapshot(id, isUserScrolledBack, 0);
      this.notify(id);
    }
  }

  updateScrollState(id: string, isUserScrolledBack: boolean): void {
    const unseen = this.unseenById.get(id) ?? 0;
    const current = this.snapshotById.get(id);

    if (current && current.isUserScrolledBack === isUserScrolledBack) {
      return;
    }

    this.updateSnapshot(id, isUserScrolledBack, unseen);
    this.notify(id);
  }

  subscribe(id: string, listener: Listener): () => void {
    let listeners = this.listenersById.get(id);
    if (!listeners) {
      listeners = new Set();
      this.listenersById.set(id, listeners);
    }
    listeners.add(listener);

    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) {
        this.listenersById.delete(id);
      }
    };
  }

  getSnapshot(id: string): UnseenOutputSnapshot {
    let snapshot = this.snapshotById.get(id);
    if (!snapshot) {
      snapshot = { isUserScrolledBack: false, unseen: 0 };
      this.snapshotById.set(id, snapshot);
    }
    return snapshot;
  }

  /**
   * An ESC[3J redraw is starting: keep counting but stop publishing, and hand
   * back the raw count (not the throttled snapshot) the redraw must not raise.
   * Output the reader already had is not new output, and a pill that flashes
   * while it re-lands is as wrong as one that stays.
   */
  holdUnseen(id: string): number {
    this.heldIds.add(id);
    return this.unseenById.get(id) ?? 0;
  }

  /**
   * The redraw is over: lower the count back to `count` and publish once.
   * Never raises it — a scroll-to-bottom that zeroed the count in the meantime
   * stays zeroed rather than resurrecting a stale pill.
   */
  releaseUnseen(id: string, count: number): void {
    this.heldIds.delete(id);
    const current = this.unseenById.get(id) ?? 0;
    const next = Math.min(current, Math.max(0, count));
    this.unseenById.set(id, next);

    const snapshot = this.getSnapshot(id);
    if (snapshot.unseen !== next) {
      this.updateSnapshot(id, snapshot.isUserScrolledBack, next);
      this.notify(id);
    }
  }

  destroy(id: string): void {
    this.unseenById.delete(id);
    this.heldIds.delete(id);
    const listeners = this.listenersById.get(id);
    if (listeners) {
      listeners.clear();
    }
    this.listenersById.delete(id);
    this.snapshotById.delete(id);
  }

  private updateSnapshot(id: string, isUserScrolledBack: boolean, unseen: number): void {
    this.snapshotById.set(id, { isUserScrolledBack, unseen });
  }

  private notify(id: string): void {
    const listeners = this.listenersById.get(id);
    if (!listeners) return;

    for (const listener of listeners) {
      listener();
    }
  }
}
