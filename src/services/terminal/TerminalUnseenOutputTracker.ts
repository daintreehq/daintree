export interface UnseenOutputSnapshot {
  isUserScrolledBack: boolean;
  unseen: number;
}

type Listener = () => void;

export class TerminalUnseenOutputTracker {
  private unseenById = new Map<string, number>();
  private listenersById = new Map<string, Set<Listener>>();
  private snapshotById = new Map<string, UnseenOutputSnapshot>();

  incrementUnseen(id: string, isUserScrolledBack: boolean): void {
    if (!isUserScrolledBack) return;

    const current = this.unseenById.get(id) ?? 0;
    const next = current + 1;
    this.unseenById.set(id, next);

    if (current === 0) {
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

  destroy(id: string): void {
    this.unseenById.delete(id);
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
